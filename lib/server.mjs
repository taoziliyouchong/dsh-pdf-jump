/**
 * 本地 PDF 查看服务：只绑 127.0.0.1。
 *
 * 所有页面都用渲染出来的图片模拟 PDF，浏览全程留在侧栏 iframe 里：
 *   /v/<id>/<印刷页>    单页查看器（翻页 / 跳页）
 *   /d/<id>             整本浏览（所有页懒加载，点某页进单页）
 *   /p/<id>/<n>.png     第 n 个印刷页的 PNG
 *   /f/<id>             原始 PDF（浏览器自带阅读器 / 下载）
 *   /health             健康标识
 *
 * URL 用短 id（路径注册表存在系统临时目录），不带查询串——侧栏浏览器不会丢掉长查询参数。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, get as httpGet } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import {
  closeDocuments, documentInfo, isPageCached,
  readCachedPage, readCachedThumb, renderPage, renderThumb,
} from './pdf.mjs'

const require = createRequire(import.meta.url)
const VERSION = (() => {
  try {
    return require('../package.json').version
  } catch {
    return '0.0.0'
  }
})()

export const SERVICE = 'dsh-pdf-jump'
const MAX_PORT_TRIES = 20
const REGISTRY = join(tmpdir(), 'dsh-pdf-jump-paths.json')
const MAX_REGISTRY = 300

function send(res, code, type, body, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function sendJson(res, code, value) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(value))
}

function readRegistry() {
  try {
    const value = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

const known = new Map()

/**
 * 把 PDF 路径登记成一个短 id；返回的 id 用来拼 /v/<id>/<页>、/d/<id> 这类地址。
 * @param {string} file PDF 绝对路径
 * @returns {string} 12 位十六进制 id
 */
export function registerFile(file) {
  const id = createHash('sha1').update(file).digest('hex').slice(0, 12)
  known.set(id, file)
  try {
    const map = readRegistry()
    map[id] = file
    const keys = Object.keys(map)
    if (keys.length > MAX_REGISTRY) {
      for (const key of keys.slice(0, keys.length - MAX_REGISTRY)) delete map[key]
    }
    writeFileSync(REGISTRY, JSON.stringify(map), 'utf8')
  } catch { /* 写不了注册表就靠进程内缓存 */ }
  return id
}

function isPdf(file) {
  if (!file || extname(file).toLowerCase() !== '.pdf') return false
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function resolveId(id) {
  const cached = known.get(id)
  if (cached && isPdf(cached)) return cached
  const file = readRegistry()[id]
  if (typeof file === 'string' && isPdf(file)) {
    known.set(id, file)
    return file
  }
  return null
}

/** 探测一个端口：ours＝本服务；free＝没人监听；busy＝别的服务。 */
function probe(port) {
  return new Promise((done) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk })
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const info = JSON.parse(body)
            if (info && info.service === SERVICE) return done('ours')
          } catch { /* 非本服务的响应 */ }
        }
        done('busy')
      })
    })
    req.on('timeout', () => { req.destroy(); done('busy') })
    req.on('error', (err) => done(err && err.code === 'ECONNREFUSED' ? 'free' : 'busy'))
  })
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function buildHtml({ id, file, printed, total, pdfPage }) {
  const title = `${basename(file)} · 第 ${printed} 页`
  const src = `/p/${id}/${printed}.png`
  const fileJson = JSON.stringify(id).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#2b2b2b;color:#ddd;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:#1e1e1e;border-bottom:1px solid #3a3a3a;box-shadow:0 2px 8px rgba(0,0,0,.25)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:30px;padding:0 10px;border:1px solid #4a4a4a;border-radius:6px;background:#333;color:#eee;font:inherit;cursor:pointer}
button:hover,.btn:hover{background:#414141}
button:active{transform:translateY(1px)}
#page{width:72px;height:30px;text-align:center;border:1px solid #4a4a4a;border-radius:6px;background:#111;color:#eee;font:inherit}
.total{opacity:.65}
.meta{margin-left:auto;opacity:.65;white-space:nowrap}
a.open{color:#8cc4ff;text-decoration:none;border-bottom:1px dotted currentColor}
main{display:flex;justify-content:center;padding:14px 12px 40px}
.wrap{position:relative;max-width:100%}
img{display:block;max-width:100%;height:auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.55);border-radius:2px;transition:opacity .15s}
img.loading{opacity:.35}
#spinner{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:rgba(0,0,0,.65);color:#eee;font-size:12px;display:none}
#spinner.on{display:block}
#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:8px;background:#111;border:1px solid #555;color:#ffb4b4;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;display:none}
#toast.on{display:block}
@media (max-width:560px){.meta{margin-left:0}}
</style></head><body>
<header class="bar">
  <button id="prev" title="上一页（←）">‹</button>
  <input id="page" inputmode="numeric" value="${printed}" aria-label="页码">
  <span class="total">/ ${total}</span>
  <button id="jump" title="跳到填写页码">跳</button>
  <button id="next" title="下一页（→）">›</button>
  <span class="meta">第 ${pdfPage} 页 / 共 ${total} 页</span>
  <a class="open" href="/d/${id}" title="在侧栏里整本翻阅">整本浏览</a>
</header>
<main><div class="wrap"><img id="img" class="loading" src="${src}" alt="第 ${printed} 页"><div id="spinner" class="on">渲染中…</div></div></main>
<div id="toast"></div>
<script>
const ID = ${fileJson};
const total = ${total};
let printed = ${printed};
const img = document.getElementById('img');
const input = document.getElementById('page');
const spinner = document.getElementById('spinner');
const toast = document.getElementById('toast');
function showToast(text){ toast.textContent = text; toast.classList.add('on'); clearTimeout(showToast.t); showToast.t = setTimeout(() => toast.classList.remove('on'), 4000); }
function load(){
  if (printed < 1) printed = 1;
  if (printed > total) printed = total;
  input.value = printed;
  img.classList.add('loading');
  spinner.classList.add('on');
  img.src = '/p/' + ID + '/' + printed + '.png';
  history.replaceState(null, '', '/v/' + ID + '/' + printed);
}
function step(delta){ printed += delta; load(); }
function jump(){ const n = parseInt(input.value, 10); if (Number.isFinite(n) && n >= 1 && n <= total) { printed = n; load(); } else { input.value = printed; } }
img.addEventListener('load', () => { img.classList.remove('loading'); spinner.classList.remove('on'); });
img.addEventListener('error', () => {
  spinner.classList.remove('on');
  fetch(img.src).then((r) => r.text()).then((t) => showToast('这一页没渲染出来：' + t)).catch(() => showToast('这一页没渲染出来（请求失败）'));
});
document.getElementById('prev').addEventListener('click', () => step(-1));
document.getElementById('next').addEventListener('click', () => step(1));
document.getElementById('jump').addEventListener('click', jump);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });
document.addEventListener('keydown', (e) => {
  if (e.target === input) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'Home') { printed = 1; load(); }
  if (e.key === 'End') { printed = total; load(); }
});
</script></body></html>`
}

/**
 * 渲染/读取失败时给人看的说明页。白屏和裸报错都等于没说清原因，
 * 所以这里按错误内容给「原因 + 怎么办」，原始错误折叠在下面备查。
 */
function buildErrorHtml({ file, printed, message }) {
  const raw = String(message || '未知错误')
  const name = String(file || '').replace(/^.*[\\/]/, '')
  const cause = /does not match the Worker version/i.test(raw)
    ? {
      title: '渲染库版本冲突',
      why: '这台 DSH 里还有另一个插件带着不同版本的 pdf.js。两个版本在同一个进程里共用「渲染器」登记位，后加载的那份会把它改写成自己的版本，本插件再渲染时两边版本对不上。',
      todo: '重启 DSH（新版已把渲染挪到独立进程，重启后不会再撞）。重启后仍报这句，就把下面的原始错误一起发出来。',
    }
    : /ENOENT|no such file|cannot find|找不到/i.test(raw)
      ? {
        title: '文件不在了或读不了',
        why: '按这个路径找不到 PDF，或者当前用户没有读权限。',
        todo: '确认文件还在原位置；被移动过就重新用 pdf-view 打开一次。',
      }
      : /超时|timeout/i.test(raw)
        ? {
          title: '渲染超时',
          why: '这一页在 60 秒内没渲染完，通常是大页面或字体缺失拖慢的。',
          todo: '点「重试」再翻一次；连续失败把下面的原始错误发出来。',
        }
        : {
          title: '这一页没渲染出来',
          why: '渲染进程返回了错误。',
          todo: '点「重试」；还在失败就把下面的原始错误发出来。',
        }
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)} · 渲染失败</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100%;background:#2b2b2b;color:#ddd;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:28px 22px}
.card{max-width:720px;margin:0 auto;background:#242424;border:1px solid #3a3a3a;border-radius:10px;padding:18px 20px}
h1{font-size:16px;margin:0 0 10px;color:#ffb4b4}
.meta{opacity:.65;font-size:12px;margin-bottom:14px}
h2{font-size:13px;margin:16px 0 4px;color:#8cc4ff;font-weight:600}
p{margin:0;white-space:pre-wrap}
details{margin-top:16px;border-top:1px dashed #3a3a3a;padding-top:10px}
summary{cursor:pointer;opacity:.75;font-size:12px}
code{display:block;margin-top:8px;padding:8px 10px;border-radius:6px;background:#111;color:#ffc9c9;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
button{margin-top:16px;height:32px;padding:0 14px;border:1px solid #4a4a4a;border-radius:6px;background:#333;color:#eee;font:inherit;cursor:pointer}
button:hover{background:#414141}
</style></head><body><div class="card">
<h1>${escapeHtml(cause.title)}</h1>
<div class="meta">${escapeHtml(name)}${printed ? ` · 第 ${printed} 页` : ''}</div>
<h2>原因</h2><p>${escapeHtml(cause.why)}</p>
<h2>怎么办</h2><p>${escapeHtml(cause.todo)}</p>
<details><summary>原始错误</summary><code>${escapeHtml(raw)}</code></details>
<button onclick="location.reload()">重试</button>
</div></body></html>`
}

/**
 * 整本浏览页：先用缩略图铺满（每页十几毫秒），滚到哪页再把那页换成全尺寸。
 * 点某页进单页查看器；全部在侧栏里完成，不打开外部浏览器。
 */
function buildDocumentHtml({ id, file, total }) {
  const title = `${basename(file)} · 整本`
  const pages = []
  for (let n = 1; n <= total; n += 1) {
    pages.push(
      `<a class="page" id="p${n}" href="/v/${id}/${n}" data-hd="/p/${id}/${n}.png">`
      + `<img class="thumb" loading="lazy" decoding="async" src="/t/${id}/${n}.jpg" alt="第 ${n} 页">`
      + `<span>第 ${n} 页</span></a>`,
    )
  }
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;background:#2b2b2b;color:#ddd;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;background:#1e1e1e;border-bottom:1px solid #3a3a3a;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.bar b{font-weight:600;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar a{color:#8cc4ff;text-decoration:none;border-bottom:1px dotted currentColor}
.bar .count{opacity:.65}
.bar .jump{display:inline-flex;gap:4px;align-items:center}
.bar input{width:64px;height:26px;text-align:center;border:1px solid #4a4a4a;border-radius:6px;background:#111;color:#eee;font:inherit}
.bar button{height:26px;padding:0 10px;border:1px solid #4a4a4a;border-radius:6px;background:#333;color:#eee;font:inherit;cursor:pointer}
.bar button:hover{background:#414141}
main{display:flex;flex-direction:column;align-items:center;gap:18px;padding:16px 12px 48px}
a.page{display:block;width:min(760px,100%);text-decoration:none;color:#bbb;position:relative;background:#fff;border-radius:2px;box-shadow:0 3px 18px rgba(0,0,0,.55);scroll-margin-top:56px}
a.page img{display:block;width:100%;height:auto;aspect-ratio:auto 595/842;border-radius:2px}
a.page img.hd{position:absolute;left:0;top:0;opacity:0;transition:opacity .12s}
a.page img.hd.ok{opacity:1}
a.page span{position:sticky;bottom:8px;float:right;margin-top:-30px;margin-right:8px;padding:2px 10px;border-radius:999px;background:rgba(0,0,0,.7);font-size:12px;z-index:2}
a.page:hover{outline:2px solid #2f81f7;outline-offset:-2px}
</style></head><body>
<header class="bar">
  <b>${escapeHtml(basename(file))}</b>
  <span class="count">共 ${total} 页</span>
  <span class="jump"><input id="jumpPage" inputmode="numeric" placeholder="页码" aria-label="跳到第几页"><button id="jumpGo">跳</button></span>
  <a href="/v/${id}/1">单页模式</a>
</header>
<main>${pages.join('')}</main>
<script>
(function () {
  var TOTAL = ${total};
  function swap(link) {
    if (link.querySelector('img.hd')) return;
    var hd = document.createElement('img');
    hd.className = 'hd';
    hd.alt = '';
    hd.addEventListener('load', function () { hd.classList.add('ok'); });
    hd.src = link.getAttribute('data-hd');
    link.appendChild(hd);
  }
  var links = Array.prototype.slice.call(document.querySelectorAll('a.page'));
  if ('IntersectionObserver' in window) {
    // 提前 400px 开始换全尺寸，滚到该页时通常已经换好。
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        swap(entry.target);
      });
    }, { rootMargin: '400px 0px' });
    links.forEach(function (link) { io.observe(link); });
  } else {
    links.forEach(swap);
  }

  // 跳到第 N 页：滚到该页锚点；进入视口后由 IntersectionObserver 换成全尺寸。
  var input = document.getElementById('jumpPage');
  function jump() {
    var n = parseInt(input.value, 10);
    if (!isFinite(n) || n < 1 || n > TOTAL) { input.value = ''; return; }
    var target = document.getElementById('p' + n);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    history.replaceState(null, '', '#p' + n);
  }
  document.getElementById('jumpGo').addEventListener('click', jump);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') jump(); });
  var entry = /^#p\d+$/.test(location.hash) ? document.getElementById(location.hash.slice(1)) : null;
  if (entry) entry.scrollIntoView({ block: 'start', behavior: 'auto' });
})();
</script>
</body></html>`
}

const HELP_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>dsh-pdf-jump</title>
<style>body{margin:0;padding:32px;background:#2b2b2b;color:#ddd;font:14px/1.6 system-ui,sans-serif}code{background:#111;padding:2px 6px;border-radius:4px}</style>
</head><body><h3>dsh-pdf-jump 本地查看服务</h3>
<p>这个地址是给 pdf-view 工具生成的链接用的。请让 agent 打开某本 PDF：它会返回 <code>/v/&lt;id&gt;/&lt;页码&gt;</code> 形式的地址。</p>
<p>直接访问根路径没有 PDF 可看。</p></body></html>`

/**
 * 创建查看服务。start() 会先复用本机已在跑的同款服务，没有再拉起新端口。
 * @param {{port?: number, scale?: number, idleMinutes?: number}} options
 */
export function createViewer(options = {}) {
  const basePort = Number(options.port) > 0 ? Number(options.port) : 8731
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 2
  const idleMs = Number(options.idleMinutes) >= 0 ? Number(options.idleMinutes) * 60_000 : 0
  const prefetchWindow = Number(options.prefetchWindow) >= 0 ? Number(options.prefetchWindow) : 6
  const allowWarm = options.prefetch !== false

  let server = null
  let port = 0
  let owned = false
  let idleTimer = null
  let prefetch = null
  let taskSeq = 0
  const tasks = []
  const pageCounts = new Map()
  let pumping = false

  const touch = () => {
    if (idleMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { stop().catch(() => {}) }, idleMs)
    idleTimer.unref?.()
  }

  /**
   * 单线程任务队列：请求任务优先级高（10），预渲染低（0/1），
   * 保证用户点开某页时不会被后台预渲染排队拖慢。
   */
  function schedule(task, priority = 5) {
    return new Promise((resolve, reject) => {
      tasks.push({ task, priority, seq: taskSeq++, resolve, reject })
      pump()
    })
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (tasks.length > 0) {
        tasks.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq))
        const item = tasks.shift()
        try {
          item.resolve(await item.task())
        } catch (err) {
          item.reject(err)
        }
      }
    } finally {
      pumping = false
    }
  }

  /** 页数缓存：同一个文件只解析一次，请求页数时不排队等渲染。 */
  async function pagesOf(file) {
    const known = pageCounts.get(file)
    if (known) return known
    const info = await schedule(() => documentInfo(file), 10)
    const total = Math.max(1, info.pages)
    pageCounts.set(file, total)
    return total
  }

  /**
   * 后台预渲染：以当前页为中心，按「中心 → +1 → -1 → +2 → -2 …」向外扩散渲染。
   * 只覆盖 radius 页，不整本渲；切到别页时新任务替换旧任务，旧循环立刻停。
   */
  function warmAround(file, center, radius = prefetchWindow) {
    if (!allowWarm) return
    const job = { file, center }
    prefetch = job
    ;(async () => {
      try {
        const info = await schedule(() => documentInfo(file), 1)
        const total = Math.max(1, info.pages)
        pageCounts.set(file, total)
        const current = Math.max(1, Math.min(total, center))
        const order = []
        const push = (page) => {
          if (page >= 1 && page <= total && !order.includes(page)) order.push(page)
        }
        push(current)
        for (let distance = 1; distance <= radius; distance += 1) {
          push(current + distance)
          push(current - distance)
        }
        for (const page of order) {
          if (prefetch !== job) return
          touch()
          if (isPageCached(file, page, scale)) continue
          await schedule(() => renderPage(file, page, scale), 0)
        }
      } catch { /* 预渲染失败不影响按需渲染 */ }
    })()
  }

  const handler = async (req, res) => {
    touch()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, service: SERVICE, version: VERSION, pid: process.pid })
      return
    }
    if (pathname === '/') {
      send(res, 200, 'text/html; charset=utf-8', HELP_HTML)
      return
    }

    const single = /^\/v\/([a-f0-9]{12})\/(\d+)$/.exec(pathname)
    const document = /^\/d\/([a-f0-9]{12})$/.exec(pathname)
    const png = /^\/p\/([a-f0-9]{12})\/(\d+)\.png$/.exec(pathname)
    const thumb = /^\/t\/([a-f0-9]{12})\/(\d+)\.jpg$/.exec(pathname)
    const raw = /^\/f\/([a-f0-9]{12})$/.exec(pathname)
    if (!single && !document && !png && !thumb && !raw) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }
    const id = (single ?? document ?? png ?? thumb ?? raw)[1]
    const file = resolveId(id)
    if (!file) {
      send(res, 404, 'text/plain; charset=utf-8', '这个链接已失效：请重新调用 pdf-view 取新地址')
      return
    }

    if (raw) {
      const stat = statSync(file)
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
        'Cache-Control': 'no-store',
      })
      createReadStream(file).pipe(res)
      return
    }

    // 缩略图：整本列表先铺这一层。优先级高于全尺寸，滚动时新进视口的页不会被高清堵住。
    if (thumb) {
      const n = Math.max(1, Math.round(Number(thumb[2]) || 1))
      try {
        const total = await pagesOf(file)
        const page = Math.max(1, Math.min(total, n))
        const cached = readCachedThumb(file, page)
        if (cached) {
          send(res, 200, 'image/jpeg', cached, { 'Cache-Control': 'public, max-age=3600' })
          return
        }
        const jpg = await schedule(() => renderThumb(file, page), 15)
        send(res, 200, 'image/jpeg', jpg, { 'Cache-Control': 'public, max-age=3600' })
      } catch (err) {
        send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed, message: err && err.message ? err.message : err }))
      }
      return
    }

    const printed = single ? Math.max(1, Math.round(Number(single[2]) || 1))
      : png ? Math.max(1, Math.round(Number(png[2]) || 1))
        : 1

    // 整本页先出缩略图，全尺寸按视口补；这里不再预热全尺寸。
    if (document) {
      try {
        const total = await pagesOf(file)
        send(res, 200, 'text/html; charset=utf-8', buildDocumentHtml({ id, file, total }))
      } catch (err) {
        send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed, message: err && err.message ? err.message : err }))
      }
      return
    }

    if (single) {
      try {
        const total = await pagesOf(file)
        const page = Math.max(1, Math.min(total, printed))
        warmAround(file, page, prefetchWindow)
        send(res, 200, 'text/html; charset=utf-8', buildHtml({ id, file, printed: page, total, pdfPage: page }))
      } catch (err) {
        send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed, message: err && err.message ? err.message : err }))
      }
      return
    }

    // 页图：已缓存就直接回（不进渲染队列），没缓存才排队渲染。
    warmAround(file, printed, prefetchWindow)
    const cached = readCachedPage(file, printed, scale)
    if (cached) {
      send(res, 200, 'image/png', cached, { 'Cache-Control': 'public, max-age=3600' })
      return
    }
    schedule(() => renderPage(file, printed, scale), 10)
      .then((pngData) => { if (!res.headersSent) send(res, 200, 'image/png', pngData, { 'Cache-Control': 'public, max-age=3600' }) })
      .catch((err) => { if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', String(err)) })
  }

  let startPromise = null

  async function startOnce() {
    const firstFree = []
    for (let candidate = basePort; candidate < basePort + MAX_PORT_TRIES; candidate += 1) {
      const state = await probe(candidate)
      if (state === 'ours') {
        port = candidate
        owned = false
        touch()
        return port
      }
      if (state === 'free') firstFree.push(candidate)
    }
    for (const candidate of firstFree) {
      const ok = await new Promise((done) => {
        const next = createHttpServer(handler)
        next.once('error', () => done(false))
        next.listen(candidate, '127.0.0.1', () => {
          server = next
          port = candidate
          owned = true
          done(true)
        })
      })
      if (ok) {
        touch()
        return port
      }
    }
    throw new Error(`端口 ${basePort}-${basePort + MAX_PORT_TRIES - 1} 全被占用，PDF 查看服务起不来`)
  }

  /** 幂等启动：并发调用（插件加载时的预启动 + 工具调用）共用同一个启动过程。 */
  function start() {
    if (server) return Promise.resolve(port)
    if (!startPromise) startPromise = startOnce().finally(() => { startPromise = null })
    return startPromise
  }

  async function stop() {
    prefetch = null
    pageCounts.clear()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (server) {
      const closing = new Promise((done) => server.close(() => done()))
      server.closeAllConnections?.()
      await closing
      server = null
    }
    port = 0
    owned = false
    await closeDocuments()
  }

  return {
    start,
    stop,
    /** 页数（与查看器同一份缓存）；工具层用它把超出范围的页码钳到最后一页。 */
    pageCount: (file) => pagesOf(file),
    prefetch: (file, page) => warmAround(file, page, Math.min(2, prefetchWindow)),
    get port() { return port },
    get owned() { return owned },
  }
}
