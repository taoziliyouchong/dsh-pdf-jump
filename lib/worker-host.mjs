/**
 * 常驻渲染进程的宿主侧：起进程、排队、去重、超时、崩溃重启、空闲退出。
 *
 * 三条规则决定了翻页体验：
 *   1. 同一页只渲一次——同一 (文件, 页, 倍率) 的并发请求合并成一个任务；
 *   2. 用户要的页永远排在预渲染前面——队列按优先级取，新页请求一到就插队；
 *   3. 用户一翻页，之前没开始的预渲染任务直接作废——不然它们会把队列堵满。
 *
 * 渲染进程串行处理（同一时刻只画一页），所以宿主侧也保持单请求在途，
 * 顺序就是唯一能表达的优先级。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('./render-worker.mjs', import.meta.url))
const DEFAULT_TIMEOUT = 60_000
const IDLE_MS = 10 * 60_000
/** 渲染进程常驻会攒内存，超过这个量就换一个（下次请求时自动重启）。 */
const RSS_LIMIT = 1_200 * 1024 * 1024

/** 优先级：用户正看的那页 > 整本浏览的清晰页 > 缩略图 > 预渲染。 */
export const PRIORITY = { user: 10, doc: 8, thumb: 6, prefetch: 1 }

let child = null
let starting = null
let inflight = null
let idleTimer = null
let seq = 0
let gen = 0
let stderrTail = ''

/** 排队中的任务：{ id, key, group, priority, pinned, msg, waiters, timer } */
const queue = []
/** key → 任务（排队中或在途），用于合并重复请求。 */
const byKey = new Map()

function dropIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdle() {
  dropIdleTimer()
  idleTimer = setTimeout(() => kill('空闲退出'), IDLE_MS)
  idleTimer.unref?.()
}

function settle(entry, error, value) {
  if (inflight === entry) inflight = null
  if (entry.timer) clearTimeout(entry.timer)
  if (byKey.get(entry.key) === entry) byKey.delete(entry.key)
  for (const waiter of entry.waiters.splice(0)) {
    if (error) waiter.reject(error)
    else waiter.resolve(value)
  }
}

/**
 * 结束渲染进程：在途与排队的全部失败，进程杀掉；下一次请求自动重启。
 * 渲染进程一旦卡住，留着比换掉更糟——换掉只多花一次进程启动（约 0.15 秒）。
 */
function kill(reason) {
  gen += 1
  dropIdleTimer()
  const dying = child
  child = null
  if (dying) {
    try { dying.kill() } catch { /* 已经没了 */ }
  }
  const error = new Error(reason)
  if (inflight) settle(inflight, error)
  for (const entry of queue.splice(0)) settle(entry, error)
}

function ensureProc() {
  if (child) return Promise.resolve(child)
  if (starting) return starting
  const myGen = ++gen
  starting = new Promise((resolve, reject) => {
    // 宿主是 Electron：process.execPath 是 exe，要靠 ELECTRON_RUN_AS_NODE 才按 Node 跑脚本。
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const proc = spawn(process.execPath, [WORKER], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let spawned = false
    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000) })
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        onReply(msg)
      }
    })
    proc.once('spawn', () => {
      spawned = true
      if (myGen !== gen) {
        try { proc.kill() } catch { /* 已经没了 */ }
        reject(new Error('渲染进程已被替换'))
        return
      }
      child = proc
      resolve(proc)
    })
    proc.once('error', (error) => {
      if (myGen === gen) child = null
      if (!spawned) {
        spawned = true
        reject(error)
      } else {
        kill('渲染进程出错：' + error.message)
      }
    })
    proc.once('exit', (code, signal) => {
      if (myGen !== gen) return
      child = null
      const reason = stderrTail.trim().split('\n').pop() || `渲染进程退出（${code ?? signal}）`
      if (!spawned) {
        spawned = true
        reject(new Error(reason))
      } else {
        kill(reason)
      }
    })
    // 进程自己退出时 stdin 会报错，不接住会把宿主带崩。
    proc.stdin.on('error', () => {})
  }).finally(() => {
    starting = null
  })
  return starting
}

function onReply(msg) {
  const entry = inflight
  if (!entry || entry.id !== msg.id) return
  settle(entry, msg.ok ? null : new Error(String(msg.error || '渲染失败')), msg)
  if (typeof msg.rss === 'number' && msg.rss > RSS_LIMIT) {
    kill('渲染进程内存超限，换进程')
    return
  }
  scheduleIdle()
  pump()
}

function pump() {
  if (inflight || queue.length === 0) return
  queue.sort((a, b) => (b.priority - a.priority) || (a.id - b.id))
  const entry = queue.shift()
  inflight = entry
  ensureProc()
    .then((proc) => {
      if (!proc.stdin.writable) throw new Error('渲染进程已关闭')
      proc.stdin.write(JSON.stringify(entry.msg) + '\n')
    })
    .catch((error) => {
      settle(entry, error)
      pump()
    })
}

/**
 * 发一个渲染进程请求。
 * @param {string} op info | render | text | drop | ping
 * @param {object} payload 请求体（不含 id/op）
 * @param {{key?: string, priority?: number, group?: string, timeout?: number}} [options]
 *   key 相同即合并；group 用于批量作废（预渲染）；timeout=0 表示不限时。
 * @returns {Promise<object>} 渲染进程的回包
 */
export function request(op, payload, options = {}) {
  const key = options.key || `${op}:${JSON.stringify(payload)}`
  const priority = Number(options.priority) || 5
  const existing = byKey.get(key)
  if (existing) {
    // 用户插到预渲染头上时，整条目提权，别被后来的作废规则带走。
    if (priority > existing.priority) existing.priority = priority
    if (priority >= PRIORITY.doc) existing.pinned = true
    return new Promise((resolve, reject) => existing.waiters.push({ resolve, reject }))
  }
  const id = ++seq
  const entry = {
    id,
    key,
    group: options.group || 'user',
    priority,
    pinned: priority >= PRIORITY.doc,
    msg: { id, op, ...payload },
    waiters: [],
    timer: null,
  }
  byKey.set(key, entry)
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  if (timeout > 0) {
    entry.timer = setTimeout(() => {
      // 目标页渲染超时说明这页把进程卡住了：换一个进程，免得后面所有请求一起卡。
      if (inflight === entry) kill(`渲染超时（${Math.round(timeout / 1000)} 秒）`)
      else settle(entry, new Error(`渲染超时（${Math.round(timeout / 1000)} 秒）`))
    }, timeout)
    entry.timer.unref?.()
  }
  return new Promise((resolve, reject) => {
    entry.waiters.push({ resolve, reject })
    queue.push(entry)
    pump()
  })
}

/**
 * 作废排队中、还没开始的那一批任务（用户翻页时用来扔掉旧预渲染）。
 * 在途任务不动——它马上就好，打断反而更慢。
 * @param {string} group 任务分组
 * @returns {number} 作废条数
 */
export function cancelGroup(group) {
  let cancelled = 0
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const entry = queue[i]
    if (entry.group !== group || entry.pinned) continue
    queue.splice(i, 1)
    settle(entry, null, { cancelled: true })
    cancelled += 1
  }
  return cancelled
}

/** 立刻结束渲染进程（插件停用、宿主退出时用）。 */
export function shutdown() {
  kill('渲染进程已关闭')
}

process.once('exit', () => {
  if (child) {
    try { child.kill() } catch { /* 已经没了 */ }
  }
})
