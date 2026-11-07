/**
 * PDF 页面渲染：**在子进程里**用 pdfjs-dist 取页、@napi-rs/canvas 出图，宿主进程只负责调度与缓存。
 *
 * 为什么隔进程：pdfjs 通过 globalThis.pdfjsWorker.WorkerMessageHandler 找 worker。
 * 宿主里只要还有另一个插件带不同版本的 pdfjs（例如 4.10.38），后写的会把全局改成自己的，
 * 本插件 6.x 的 API 就会拿到 4.x 的 worker，渲染直接失败
 * （「API version 6.4.299 does not match Worker version 4.10.38」）。
 * 子进程有自己的 module graph 与全局，版本永远不会被别的插件换掉。
 *
 * 代价：每页首次渲染多一次进程启动（约 0.3–0.8 秒）；出图后落磁盘缓存，翻过的页不再付。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CHILD = fileURLToPath(new URL('./render-child.mjs', import.meta.url))
const CACHE_DIR = join(tmpdir(), 'dsh-pdf-jump-cache')
const MAX_CHILDREN = 2

/** 子进程并发闸门：缩略图会连着请求，不设上限会一次拉起几十个进程。 */
let running = 0
const waiting = []

function acquire() {
  if (running < MAX_CHILDREN) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else running -= 1
}

/**
 * 跑一次渲染子进程。
 * @param {string[]} args 子进程参数
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runChild(args) {
  await acquire()
  try {
    return await new Promise((resolve, reject) => {
      // 宿主是 Electron：process.execPath 是 exe，要靠 ELECTRON_RUN_AS_NODE 才按 Node 跑脚本。
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      const child = spawn(process.execPath, [CHILD, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('渲染超时（子进程没有在 60 秒内返回）'))
      }, 60_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error((stderr || stdout || `渲染子进程退出码 ${code}`).trim().slice(0, 400)))
      })
    })
  } finally {
    release()
  }
}

/** 页数缓存：{ pages, mtimeMs, size }，文件变了就重新问。 */
const infoCache = new Map()

function cachePathFor(file, pdfPage, scale, ext = 'png') {
  const stat = statSync(file)
  const key = createHash('md5')
    .update(`${file}|${stat.mtimeMs}|${stat.size}|${pdfPage}|${scale}`)
    .digest('hex')
  return join(CACHE_DIR, `${key}.${ext}`)
}

/**
 * 页数。页码一律按 PDF 页序，不从页脚推断印刷页码——很多手册混用全书页码和
 * 「章-页」编号，推断出来的差值会把正文页整体错位。
 * @param {string} file PDF 绝对路径
 * @returns {Promise<{pages: number}>}
 */
export async function documentInfo(file) {
  const stat = statSync(file)
  const hit = infoCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { pages: hit.pages }
  const { stdout } = await runChild(['--info', '--file', file])
  const pages = Number(JSON.parse(stdout.trim()).pages)
  if (!Number.isFinite(pages) || pages < 1) throw new Error('读取页数失败')
  infoCache.set(file, { pages, mtimeMs: stat.mtimeMs, size: stat.size })
  return { pages }
}

/**
 * 清理 7 天前的渲染缓存（只在第一次渲染时执行一次）。
 */
let pruned = false
function pruneCache() {
  if (pruned) return
  pruned = true
  try {
    const cutoff = Date.now() - 7 * 24 * 3_600_000
    for (const name of readdirSync(CACHE_DIR)) {
      const target = join(CACHE_DIR, name)
      try {
        if (statSync(target).mtimeMs < cutoff) rmSync(target, { force: true })
      } catch { /* 单个文件清理失败不影响渲染 */ }
    }
  } catch { /* 缓存目录还不存在 */ }
}

/** 整本浏览用的缩略图倍率：0.8 约等于 476px 宽，列表里放大到 760px 内可辨版式。 */
export const THUMB_SCALE = 0.8

/**
 * 某页是否已经有渲染缓存（预渲染循环用它跳过已完成的页）。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序
 * @param {number} scale 渲染倍率
 * @returns {boolean}
 */
export function isPageCached(file, pdfPage, scale = 2) {
  try {
    return existsSync(cachePathFor(file, pdfPage, scale))
  } catch {
    return false
  }
}

/**
 * 直接读已渲染的页图；没有缓存返回 null（不触发渲染）。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序
 * @param {number} scale 渲染倍率
 * @returns {Buffer|null}
 */
export function readCachedPage(file, pdfPage, scale = 2) {
  try {
    const cachePath = cachePathFor(file, pdfPage, scale)
    return existsSync(cachePath) ? readFileSync(cachePath) : null
  } catch {
    return null
  }
}

/**
 * 把一页渲染成 PNG（带磁盘缓存）。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序（从 1 起）
 * @param {number} scale 渲染倍率，2 约等于 144 dpi
 * @returns {Promise<Buffer>} PNG 字节
 */
export async function renderPage(file, pdfPage, scale = 2) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  pruneCache()
  const cachePath = cachePathFor(file, pdfPage, scale)
  if (existsSync(cachePath)) return readFileSync(cachePath)
  await runChild(['--file', file, '--page', String(pdfPage), '--scale', String(scale), '--format', 'png', '--out', cachePath])
  return readFileSync(cachePath)
}

/** 缩略图是否已有缓存（整本浏览用，避免重复渲染）。 */
export function isThumbCached(file, pdfPage, scale = THUMB_SCALE) {
  try {
    return existsSync(cachePathFor(file, pdfPage, scale, 'jpg'))
  } catch {
    return false
  }
}

/** 直接读已渲染的缩略图；没有缓存返回 null。 */
export function readCachedThumb(file, pdfPage, scale = THUMB_SCALE) {
  try {
    const cachePath = cachePathFor(file, pdfPage, scale, 'jpg')
    return existsSync(cachePath) ? readFileSync(cachePath) : null
  } catch {
    return null
  }
}

/**
 * 把一页渲染成整本浏览用的缩略图（JPEG，白底）。
 * 缩略图只求版式可辨，编码比全尺寸 PNG 快一个数量级。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序（从 1 起）
 * @param {number} scale 倍率，默认 0.8（约 476px 宽）
 * @param {number} quality JPEG 质量，默认 0.8
 * @returns {Promise<Buffer>} JPEG 字节
 */
export async function renderThumb(file, pdfPage, scale = THUMB_SCALE, quality = 0.8) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  pruneCache()
  const cachePath = cachePathFor(file, pdfPage, scale, 'jpg')
  if (existsSync(cachePath)) return readFileSync(cachePath)
  await runChild(['--file', file, '--page', String(pdfPage), '--scale', String(scale), '--format', 'jpg', '--quality', String(quality), '--out', cachePath])
  return readFileSync(cachePath)
}

/**
 * 释放资源。渲染在子进程里做，宿主侧没有常驻文档；这里保留接口给调用方，
 * 顺便清掉页数缓存。
 */
export async function closeDocuments() {
  infoCache.clear()
}

/** 渲染缓存目录，供文档与诊断使用。 */
export const cacheDir = CACHE_DIR
