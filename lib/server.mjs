/**
 * 本地 PDF 查看服务：只绑 127.0.0.1。
 *
 * 页图都是渲染出来的图片，浏览器自带的 Ctrl+F 搜不到里面的字，所以这里自己做了一套：
 * 全书抽文字 → 建索引 → 命中列表 → 命中处画高亮框（坐标按页宽比例缩放，与渲染倍率无关）。
 *
 *   /v/<id>/<页>        单页查看器（翻页 / 跳页 / 全文搜索 Ctrl+F）
 *   /d/<id>             整本浏览（缩略图先铺，滚到哪页换高清；同样带搜索）
 *   /p/<id>/<n>.png     该页 PNG（单页查看器，倍率 2）
 *   /h/<id>/<n>.png     该页 PNG（整本浏览的清晰版，倍率 1.5，省一半字节）
 *   /t/<id>/<n>.jpg     缩略图
 *   /x/<id>/<页>?q=     该页的命中矩形（画高亮用）
 *   /search/<id>?q=     全书搜索，NDJSON 流式返回：先索引进度、再一页一页吐命中
 *   /f/<id>             原始 PDF
 *   /health             健康标识
 *
 * URL 用短 id（路径注册表存在系统临时目录），页面地址不带查询串。
 */

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, get as httpGet } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import {
  cancelPrefetch, closeDocuments, documentInfo, documentTexts, isPageCached, isThumbCached,
  pageLayout, prewarm, readCachedPage, readCachedThumb, renderPage, renderThumb, THUMB_SCALE,
} from './pdf.mjs'
import { PRIORITY } from './worker-host.mjs'
import { countInText, findInLayout, normalizeQuery, snippetOf } from './search.mjs'

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
/** 整本浏览里一页的清晰版倍率：760px 显示宽度下 1.5 倍（≈893px）已经够锐，字节只有 2 倍版的三分之一。 */
const DOC_SCALE = 1.5

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

/** 两个查看器共用的样式：搜索栏、命中列表、命中高亮框。 */
const FIND_CSS = `
.findbar{flex:1 1 100%;display:flex;align-items:center;gap:6px}
.findbar[hidden]{display:none}
.findbar input{flex:1 1 auto;min-width:110px;height:30px;padding:0 10px;border:1px solid #4a4a4a;border-radius:6px;background:#111;color:#eee;font:inherit}
.fcount{opacity:.65;white-space:nowrap;font-size:12px}
.findlist{flex:1 1 100%;max-height:38vh;overflow:auto;border-top:1px solid #3a3a3a}
.findlist[hidden]{display:none}
.findlist .hit{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;width:100%;min-width:0;height:auto;padding:5px 2px;border:0;border-bottom:1px solid #303030;border-radius:0;background:none;color:#ddd;font:inherit;text-align:left;cursor:pointer}
.findlist .hit:hover{background:#2a2a2a}
.findlist .hit.cur{background:#2c3440}
.hit .hn{color:#8cc4ff;white-space:nowrap}
.hit .hc{opacity:.55;font-size:12px;margin-left:auto;white-space:nowrap}
.hit .hs{flex:1 1 100%;opacity:.78;font-size:12px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hit b{color:#ffd479;font-weight:600}
.findempty{padding:10px 2px;opacity:.6;font-size:12px}
.pdfhl-layer{position:absolute;inset:0;z-index:3;pointer-events:none}
.pdfhl{position:absolute;background:rgba(255,214,10,.32);border-radius:2px;box-shadow:inset 0 0 0 1px rgba(255,214,10,.5)}
.pdfhl.cur{background:rgba(255,150,20,.6);box-shadow:inset 0 0 0 1px rgba(255,190,70,.95)}
`

/**
 * 两个查看器共用的搜索逻辑：Ctrl+F 打开、边打边搜、命中列表、上下条、高亮。
 * 视图相关的三件事由调用方给：showPage(page)、currentPage()、layerFor(page)。
 */
const FIND_JS = `
function createFinder(view) {
  var bar = document.getElementById('findbar');
  var list = document.getElementById('findList');
  var input = document.getElementById('findInput');
  var countEl = document.getElementById('findCount');
  var S = { q: '', flat: [], idx: -1, ctl: null, cache: {}, timer: null };

  function setCount(text) { countEl.textContent = text; }
  function empty(text) {
    list.textContent = '';
    var d = document.createElement('div');
    d.className = 'findempty';
    d.textContent = text;
    list.appendChild(d);
  }

  function open() {
    bar.hidden = false;
    list.hidden = false;
    input.focus();
    input.select();
  }

  function close() {
    if (S.ctl) { S.ctl.abort(); S.ctl = null; }
    clearTimeout(S.timer);
    bar.hidden = true;
    list.hidden = true;
    list.textContent = '';
    view.clearHighlights();
    S.q = ''; S.flat = []; S.idx = -1; S.cache = {};
    input.value = '';
    setCount('0 处');
    input.blur();
  }

  function renderRow(msg) {
    var row = document.createElement('button');
    row.className = 'hit';
    row.setAttribute('data-page', msg.page);
    var head = document.createElement('span');
    head.className = 'hn';
    head.textContent = '第 ' + msg.page + ' 页';
    var num = document.createElement('span');
    num.className = 'hc';
    num.textContent = msg.count + ' 处';
    var snip = document.createElement('span');
    snip.className = 'hs';
    if (msg.snippet) {
      // 摘要两头的空格会被行内元素吃掉，换成不换行空格，命中词才不贴着前后文。
      snip.appendChild(document.createTextNode(msg.snippet.before.replace(/ $/, '\\u00a0')));
      var mark = document.createElement('b');
      mark.textContent = msg.snippet.match;
      snip.appendChild(mark);
      snip.appendChild(document.createTextNode(msg.snippet.after.replace(/^ /, '\\u00a0')));
    }
    row.appendChild(head);
    row.appendChild(snip);
    row.appendChild(num);
    row.addEventListener('click', function () {
      var at = 0;
      for (var i = 0; i < S.flat.length; i++) { if (S.flat[i].page === msg.page) { at = i; break; } }
      go(at);
    });
    list.appendChild(row);
  }

  function markRows() {
    var current = S.idx >= 0 && S.flat[S.idx] ? S.flat[S.idx].page : -1;
    var rows = list.querySelectorAll('.hit');
    for (var i = 0; i < rows.length; i++) {
      var on = Number(rows[i].getAttribute('data-page')) === current;
      rows[i].classList[on ? 'add' : 'remove']('cur');
    }
  }

  function paint(page, k) {
    var q = S.q;
    var key = q + '|' + page;
    var ready = S.cache[key]
      ? Promise.resolve(S.cache[key])
      : fetch('/x/' + ID + '/' + page + '?q=' + encodeURIComponent(q), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (data) { S.cache[key] = data; return data; });
    return ready.then(function (data) {
      if (!data || q !== S.q) return;
      var layer = view.layerFor(page);
      if (!layer) return;
      layer.textContent = '';
      if (data.empty) { view.showToast('第 ' + page + ' 页没有文字层（多半是扫描件），搜不到也画不出高亮'); return; }
      var hits = data.hits || [];
      for (var i = 0; i < hits.length; i++) {
        var rects = hits[i].rects || [];
        for (var j = 0; j < rects.length; j++) {
          var r = rects[j];
          var box = document.createElement('div');
          box.className = 'pdfhl' + (i === k ? ' cur' : '');
          box.style.left = (r[0] / data.width * 100) + '%';
          box.style.top = (r[1] / data.height * 100) + '%';
          box.style.width = (r[2] / data.width * 100) + '%';
          box.style.height = (r[3] / data.height * 100) + '%';
          layer.appendChild(box);
        }
      }
      var cur = layer.querySelector('.pdfhl.cur');
      if (cur) {
        // 命中已经在视野里就不动滚动——只有看不见时滚过去。
        var box = cur.getBoundingClientRect();
        var vh = window.innerHeight;
        if (box.top < 56 || box.bottom > vh - 24) cur.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      view.showToast('高亮取不到：' + err.message);
    });
  }

  function go(i) {
    if (!S.flat.length) return;
    if (i < 0) i = S.flat.length - 1;
    if (i >= S.flat.length) i = 0;
    S.idx = i;
    var hit = S.flat[i];
    setCount((i + 1) + '/' + S.flat.length);
    markRows();
    view.clearHighlights();
    Promise.resolve(view.showPage(hit.page)).then(function () { return paint(hit.page, hit.k); });
  }

  function next() { if (S.flat.length) go(S.idx + 1); }
  function prev() { if (S.flat.length) go(S.idx - 1); }

  function onLine(msg) {
    if (msg.type === 'indexing') { setCount('建索引 ' + msg.page + '/' + msg.total); return; }
    if (msg.type === 'progress') { setCount('搜索 ' + msg.page + '/' + msg.total + ' 页'); return; }
    if (msg.type === 'page') {
      for (var i = 0; i < msg.count; i++) S.flat.push({ page: msg.page, k: i });
      renderRow(msg);
      setCount(S.flat.length + ' 处');
      return;
    }
    if (msg.type === 'error') { setCount('搜索失败'); empty('搜索失败：' + msg.message); return; }
    if (msg.type !== 'done') return;
    if (!S.flat.length) {
      setCount('0 处');
      empty(msg.scanned ? ('没找到「' + S.q + '」（查了 ' + msg.scanned + ' 页）') : ('没找到「' + S.q + '」'));
      return;
    }
    var cur = view.currentPage();
    var at = 0;
    for (var j = 0; j < S.flat.length; j++) { if (S.flat[j].page >= cur) { at = j; break; } }
    go(at);
  }

  function start(q) {
    if (S.ctl) { S.ctl.abort(); S.ctl = null; }
    S.q = q; S.flat = []; S.idx = -1; S.cache = {};
    view.clearHighlights();
    list.textContent = '';
    if (!q) { setCount('0 处'); list.hidden = true; return; }
    list.hidden = false;
    setCount('搜索中…');
    var ctl = new AbortController();
    S.ctl = ctl;
    fetch('/search/' + ID + '?q=' + encodeURIComponent(q), { signal: ctl.signal, cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            var nl;
            while ((nl = buffer.indexOf('\\n')) >= 0) {
              var line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (!line.trim()) continue;
              try { onLine(JSON.parse(line)); } catch (e) { /* 半行 */ }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        setCount('搜索失败');
        empty('搜索失败：' + err.message);
      })
      .then(function () { if (S.ctl === ctl) S.ctl = null; });
  }

  input.addEventListener('input', function () {
    clearTimeout(S.timer);
    var q = input.value.trim();
    S.timer = setTimeout(function () { start(q); }, 220);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prev(); else next(); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.getElementById('findPrev').addEventListener('click', function () { prev(); input.focus(); });
  document.getElementById('findNext').addEventListener('click', function () { next(); input.focus(); });
  document.getElementById('findClose').addEventListener('click', function () { close(); });
  var btn = document.getElementById('findBtn');
  if (btn) btn.addEventListener('click', function () { open(); });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      open();
      return;
    }
    if (e.key === 'F3') { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
  });

  return { open: open, close: close, next: next, prev: prev, start: start };
}
`

/** 把搜索栏与命中列表的 HTML 拼一次，两个查看器共用。 */
const FIND_HTML = `
<div id="findbar" class="findbar" hidden>
  <input id="findInput" type="search" placeholder="全篇搜索（Ctrl+F）" autocomplete="off" spellcheck="false" aria-label="全文搜索">
  <span id="findCount" class="fcount">0 处</span>
  <button id="findPrev" title="上一处（Shift+Enter）">‹</button>
  <button id="findNext" title="下一处（Enter）">›</button>
  <button id="findClose" title="关闭（Esc）">×</button>
</div>
<div id="findList" class="findlist" hidden></div>
`

function buildHtml({ id, file, printed, total }) {
  const title = `${basename(file)} · 第 ${printed} 页`
  const src = `/p/${id}/${printed}.png`
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:#2b2b2b;color:#ddd;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:#1e1e1e;border-bottom:1px solid #3a3a3a;box-shadow:0 2px 8px rgba(0,0,0,.25)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:30px;padding:0 10px;border:1px solid #4a4a4a;border-radius:6px;background:#333;color:#eee;font:inherit;cursor:pointer}
button:hover,.btn:hover{background:#414141}
button:active{transform:translateY(1px)}
#page{width:72px;height:30px;text-align:center;border:1px solid #4a4a4a;border-radius:6px;background:#111;color:#eee;font:inherit}
.total{opacity:.65}
.meta{margin-left:auto;opacity:.65;white-space:nowrap}
a.open{color:#8cc4ff;text-decoration:none;border-bottom:1px dotted currentColor;margin-left:auto}
main{display:flex;justify-content:center;padding:14px 12px 40px}
.wrap{position:relative;width:fit-content;max-width:100%}
img{display:block;max-width:100%;height:auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.55);border-radius:2px}
#spinner{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:rgba(0,0,0,.7);color:#eee;font-size:12px;display:none}
#spinner.on{display:block}
#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:8px;background:#111;border:1px solid #555;color:#ffb4b4;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;display:none}
#toast.on{display:block}
${FIND_CSS}
@media (max-width:560px){.meta{display:none}a.open{margin-left:0}}
</style></head><body>
<header class="bar">
  <button id="prev" title="上一页（←）">‹</button>
  <input id="page" inputmode="numeric" value="${printed}" aria-label="页码">
  <span class="total">/ ${total}</span>
  <button id="jump" title="跳到填写页码">跳</button>
  <button id="next" title="下一页（→）">›</button>
  <button id="findBtn" title="全文搜索（Ctrl+F）">搜索</button>
  <span class="meta" id="meta">第 ${printed} 页 / 共 ${total} 页</span>
  <a class="open" href="/d/${id}" title="在侧栏里整本翻阅">整本浏览</a>
  ${FIND_HTML}
</header>
<main><div class="wrap"><img id="img" src="${src}" alt="第 ${printed} 页"><div id="hl" class="pdfhl-layer"></div><div id="spinner" class="on">渲染中…</div></div></main>
<div id="toast"></div>
<script>
var ID = ${JSON.stringify(id)};
var TOTAL = ${total};
var printed = ${printed};
var img = document.getElementById('img');
var input = document.getElementById('page');
var spinner = document.getElementById('spinner');
var toast = document.getElementById('toast');
var hlLayer = document.getElementById('hl');
var loadToken = 0;
var pendingLoad = null;

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('on');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(function () { toast.classList.remove('on'); }, 4000);
}

function load() {
  if (printed < 1) printed = 1;
  if (printed > TOTAL) printed = TOTAL;
  input.value = printed;
  var token = ++loadToken;
  var url = '/p/' + ID + '/' + printed + '.png';
  hlLayer.textContent = '';
  spinner.classList.add('on');
  var job = new Promise(function (resolve) {
    var probe = new Image();
    probe.onload = function () {
      if (token !== loadToken) return resolve();
      img.src = url;
      img.setAttribute('data-page', String(printed));
      spinner.classList.remove('on');
      document.getElementById('meta').textContent = '第 ' + printed + ' 页 / 共 ' + TOTAL + ' 页';
      history.replaceState(null, '', '/v/' + ID + '/' + printed);
      resolve();
    };
    probe.onerror = function () {
      if (token === loadToken) { spinner.classList.remove('on'); showToast('第 ' + printed + ' 页没渲染出来，点上一页/下一页重试一次'); }
      resolve();
    };
    probe.src = url;
  });
  pendingLoad = job;
  job.then(function () { if (pendingLoad === job) pendingLoad = null; });
  return job;
}

function step(delta) { printed += delta; load(); }
function jump() {
  var n = parseInt(input.value, 10);
  if (isFinite(n) && n >= 1 && n <= TOTAL) { printed = n; load(); } else { input.value = printed; }
}

img.addEventListener('load', function () { spinner.classList.remove('on'); });
img.addEventListener('error', function () {
  spinner.classList.remove('on');
  fetch(img.src).then(function (r) { return r.text(); }).then(function (t) { showToast('这一页没渲染出来：' + t); })
    .catch(function () { showToast('这一页没渲染出来（请求失败）'); });
});
document.getElementById('prev').addEventListener('click', function () { step(-1); });
document.getElementById('next').addEventListener('click', function () { step(1); });
document.getElementById('jump').addEventListener('click', jump);
input.addEventListener('keydown', function (e) { if (e.key === 'Enter') jump(); });

document.addEventListener('keydown', function (e) {
  var tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'Home') { printed = 1; load(); }
  else if (e.key === 'End') { printed = TOTAL; load(); }
});

${FIND_JS}
var finder = createFinder({
  currentPage: function () { return printed; },
  showPage: function (page) {
    if (page === printed) return pendingLoad || Promise.resolve();
    printed = page;
    return load();
  },
  layerFor: function (page) { return page === printed ? hlLayer : null; },
  clearHighlights: function () { hlLayer.textContent = ''; },
  showToast: showToast
});

// 带 ?q=词 打开时直接开搜：链接可以带着搜索词分享，也方便验证。
var initialQuery = new URLSearchParams(location.search).get('q');
if (initialQuery) { finder.open(); document.getElementById('findInput').value = initialQuery; finder.start(initialQuery); }
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
      todo: '重启 DSH（渲染在独立进程里跑，重启后不会再撞）。重启后仍报这句，就把下面的原始错误一起发出来。',
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
          why: '这一页在限定时间内没渲染完，通常是大页面或字体缺失拖慢的。渲染进程已换掉，下一页会重新起一个。',
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
 * 整本浏览页：先用缩略图铺满（每页几十毫秒），滚到哪页再把那页换成清晰版。
 * 点某页进单页查看器；全部在侧栏里完成，不打开外部浏览器。
 */
function buildDocumentHtml({ id, file, total }) {
  const title = `${basename(file)} · 整本`
  const pages = []
  for (let n = 1; n <= total; n += 1) {
    pages.push(
      `<a class="page" id="p${n}" href="/v/${id}/${n}" data-hd="/h/${id}/${n}.png">`
      + `<img class="thumb" loading="lazy" decoding="async" src="/t/${id}/${n}.jpg" alt="第 ${n} 页">`
      + `<span class="pn">第 ${n} 页</span></a>`,
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
a.page img{display:block;width:100%;height:auto;border-radius:2px}
a.page img.thumb{min-height:120px}
a.page img.hd{position:absolute;left:0;top:0;opacity:0;transition:opacity .12s}
a.page img.hd.ok{opacity:1}
a.page .pn{position:sticky;bottom:8px;float:right;margin-top:-30px;margin-right:8px;padding:2px 10px;border-radius:999px;background:rgba(0,0,0,.7);font-size:12px;z-index:2}
a.page:hover{outline:2px solid #2f81f7;outline-offset:-2px}
a.page.miss::after{content:"点开单独看";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.7);font-size:12px}
${FIND_CSS}
.bar .findbar input{width:auto;text-align:left}
#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:8px;background:#111;border:1px solid #555;color:#ffb4b4;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;display:none}
#toast.on{display:block}
</style></head><body>
<header class="bar">
  <b>${escapeHtml(basename(file))}</b>
  <span class="count">共 ${total} 页</span>
  <span class="jump"><input id="jumpPage" inputmode="numeric" placeholder="页码" aria-label="跳到第几页"><button id="jumpGo">跳</button></span>
  <button id="findBtn" title="全文搜索（Ctrl+F）">搜索</button>
  <a href="/v/${id}/1">单页模式</a>
  ${FIND_HTML}
</header>
<main>${pages.join('')}</main>
<div id="toast"></div>
<script>
var ID = ${JSON.stringify(id)};
var TOTAL = ${total};
var toast = document.getElementById('toast');
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('on');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(function () { toast.classList.remove('on'); }, 4000);
}
function swap(link) {
  if (!link || link.querySelector('img.hd')) return;
  var hd = document.createElement('img');
  hd.className = 'hd';
  hd.alt = '';
  hd.addEventListener('load', function () { hd.classList.add('ok'); });
  hd.addEventListener('error', function () {
    hd.remove();
    link.classList.add('miss');
  });
  hd.src = link.getAttribute('data-hd');
  link.appendChild(hd);
}
var links = Array.prototype.slice.call(document.querySelectorAll('a.page'));
if ('IntersectionObserver' in window) {
  // 提前 400px 开始换清晰版，滚到该页时通常已经换好。
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
// 缩略图没出来（渲染失败）时给个提示，别留一块白。
links.forEach(function (link) {
  var thumb = link.querySelector('img.thumb');
  if (!thumb) return;
  thumb.addEventListener('error', function () { link.classList.add('miss'); });
});

function layerIn(link) {
  var layer = link.querySelector('.pdfhl-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'pdfhl-layer';
    link.appendChild(layer);
  }
  return layer;
}

function currentPage() {
  var mid = window.innerHeight / 2;
  for (var i = 0; i < links.length; i += 1) {
    var rect = links[i].getBoundingClientRect();
    if (rect.bottom > mid) return i + 1;
  }
  return 1;
}

var input = document.getElementById('jumpPage');
function jumpTo(n) {
  if (!isFinite(n) || n < 1 || n > TOTAL) { input.value = ''; return; }
  var target = document.getElementById('p' + n);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: 'auto' });
  swap(target);
  var a = document.getElementById('p' + (n - 1));
  var b = document.getElementById('p' + (n + 1));
  if (a) swap(a);
  if (b) swap(b);
  history.replaceState(null, '', '#p' + n);
}
document.getElementById('jumpGo').addEventListener('click', function () { jumpTo(parseInt(input.value, 10)); });
input.addEventListener('keydown', function (e) { if (e.key === 'Enter') jumpTo(parseInt(input.value, 10)); });

// 跳到某页后等这一页的图有尺寸，再画高亮——图没撑开时百分比坐标会算错。
function pageReady(n) {
  var link = document.getElementById('p' + n);
  if (!link) return Promise.resolve();
  var thumb = link.querySelector('img.thumb');
  return new Promise(function (resolve) {
    var tries = 0;
    function check() {
      var ready = thumb && thumb.complete && thumb.naturalWidth > 0;
      if (ready || tries >= 80) {
        requestAnimationFrame(function () { requestAnimationFrame(resolve); });
        return;
      }
      tries += 1;
      setTimeout(check, 40);
    }
    check();
  });
}

${FIND_JS}
var finder = createFinder({
  currentPage: currentPage,
  showPage: function (page) {
    jumpTo(page);
    return pageReady(page);
  },
  layerFor: function (page) {
    var link = document.getElementById('p' + page);
    return link ? layerIn(link) : null;
  },
  clearHighlights: function () {
    var layers = document.querySelectorAll('.pdfhl-layer');
    for (var i = 0; i < layers.length; i += 1) layers[i].textContent = '';
  },
  showToast: showToast
});

var entry = /^#p\\d+$/.test(location.hash) ? document.getElementById(location.hash.slice(1)) : null;
if (entry) entry.scrollIntoView({ block: 'start', behavior: 'auto' });

// 带 ?q=词 打开时直接开搜。
var initialQuery = new URLSearchParams(location.search).get('q');
if (initialQuery) { finder.open(); document.getElementById('findInput').value = initialQuery; finder.start(initialQuery); }
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
 * @param {{port?: number, scale?: number, docScale?: number, idleMinutes?: number, prefetch?: boolean, prefetchWindow?: number}} options
 */
export function createViewer(options = {}) {
  const basePort = Number(options.port) > 0 ? Number(options.port) : 8731
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 2
  const docScale = Number(options.docScale) > 0 ? Number(options.docScale) : DOC_SCALE
  const idleMs = Number(options.idleMinutes) >= 0 ? Number(options.idleMinutes) * 60_000 : 0
  const prefetchWindow = Number(options.prefetchWindow) >= 0 ? Number(options.prefetchWindow) : 3
  const allowWarm = options.prefetch !== false

  let server = null
  let port = 0
  let owned = false
  let idleTimer = null
  let prefetch = null
  const pageCounts = new Map()

  const touch = () => {
    if (idleMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { stop().catch(() => {}) }, idleMs)
    idleTimer.unref?.()
  }

  /** 页数缓存：同一个文件只问一次，请求页数时不用等渲染。 */
  async function pagesOf(file) {
    const knownPages = pageCounts.get(file)
    if (knownPages) return knownPages
    const info = await documentInfo(file)
    const total = Math.max(1, info.pages)
    pageCounts.set(file, total)
    return total
  }

  /**
   * 后台预渲染：以当前页为中心，按「中心 → +1 → -1 → +2 → -2 …」向外扩散。
   * 用户一翻页，上一轮的预渲染任务立刻作废，队列里只留正在画的那一页。
   */
  function warmAround(file, center, radius = prefetchWindow) {
    if (!allowWarm) return
    const job = { file, center }
    prefetch = job
    cancelPrefetch()
    ;(async () => {
      try {
        const total = await pagesOf(file)
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
          await renderPage(file, page, scale, { priority: PRIORITY.prefetch, group: 'prefetch' })
        }
      } catch { /* 预渲染失败不影响按需渲染 */ }
    })()
  }

  /** 用户主动翻页：停掉这一轮预渲染，队列让给用户要的页。 */
  function stopWarm() {
    prefetch = null
    cancelPrefetch()
  }

  /** 全书搜索：NDJSON 流式返回，索引进度、逐页命中、结束各一行。 */
  async function streamSearch(req, res, file, rawQuery) {
    const needle = normalizeQuery(rawQuery)
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    let closed = false
    res.on('close', () => { closed = true })
    const write = (value) => { if (!closed) res.write(JSON.stringify(value) + '\n') }
    try {
      if (!needle) { write({ type: 'done', scanned: 0, matched: 0 }); return }
      const texts = await documentTexts(file, (done, total) => write({ type: 'indexing', page: done, total }))
      const total = texts.length
      write({ type: 'start', pages: total })
      let matched = 0
      for (let i = 0; i < total; i += 1) {
        if (closed) return
        const text = texts[i] || ''
        const { count, first, end } = countInText(text, needle)
        if (count > 0) {
          matched += count
          write({
            type: 'page',
            page: i + 1,
            count,
            snippet: first >= 0 ? snippetOf(text, first, end) : null,
          })
        }
        if (i % 40 === 39) write({ type: 'progress', page: i + 1, total })
      }
      write({ type: 'done', scanned: total, matched, pages: total })
    } catch (error) {
      write({ type: 'error', message: String(error && error.message ? error.message : error) })
    } finally {
      if (!closed) res.end()
    }
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
    const hd = /^\/h\/([a-f0-9]{12})\/(\d+)\.png$/.exec(pathname)
    const thumb = /^\/t\/([a-f0-9]{12})\/(\d+)\.jpg$/.exec(pathname)
    const layout = /^\/x\/([a-f0-9]{12})\/(\d+)$/.exec(pathname)
    const search = /^\/search\/([a-f0-9]{12})$/.exec(pathname)
    const raw = /^\/f\/([a-f0-9]{12})$/.exec(pathname)
    if (!single && !document && !png && !hd && !thumb && !layout && !search && !raw) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }
    const id = (single ?? document ?? png ?? hd ?? thumb ?? layout ?? search ?? raw)[1]
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

    if (search) {
      await streamSearch(req, res, file, url.searchParams.get('q') || '')
      return
    }

    // 命中矩形：搜索时给当前页画高亮用。
    if (layout) {
      const n = Math.max(1, Math.round(Number(layout[2]) || 1))
      try {
        const total = await pagesOf(file)
        const page = Math.max(1, Math.min(total, n))
        const prepared = await pageLayout(file, page)
        const hits = findInLayout(prepared, url.searchParams.get('q') || '')
        sendJson(res, 200, {
          page, width: prepared.width, height: prepared.height,
          empty: prepared.items.length === 0, hits,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
      return
    }

    // 缩略图：整本列表先铺这一层。优先级高于预渲染，滚动时新进视口的页不会被排队拖住。
    if (thumb) {
      const n = Math.max(1, Math.round(Number(thumb[2]) || 1))
      try {
        const total = await pagesOf(file)
        const page = Math.max(1, Math.min(total, n))
        const cached = readCachedThumb(file, page, THUMB_SCALE)
        if (cached) {
          send(res, 200, 'image/jpeg', cached, { 'Cache-Control': 'public, max-age=3600' })
          return
        }
        const jpg = await renderThumb(file, page, THUMB_SCALE, 0.8, { priority: PRIORITY.thumb, group: 'thumb' })
        if (!jpg) { send(res, 503, 'text/plain; charset=utf-8', '缩略图任务被取消，重载即可'); return }
        send(res, 200, 'image/jpeg', jpg, { 'Cache-Control': 'public, max-age=3600' })
      } catch (error) {
        send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed: n, message: error && error.message ? error.message : error }))
      }
      return
    }

    const printed = single ? Math.max(1, Math.round(Number(single[2]) || 1))
      : png ? Math.max(1, Math.round(Number(png[2]) || 1))
        : hd ? Math.max(1, Math.round(Number(hd[2]) || 1))
          : 1

    // 整本浏览页：先出缩略图，清晰版按视口补。
    if (document) {
      try {
        const total = await pagesOf(file)
        send(res, 200, 'text/html; charset=utf-8', buildDocumentHtml({ id, file, total }))
      } catch (error) {
        send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed, message: error && error.message ? error.message : error }))
      }
      return
    }

    if (single) {
      try {
        const total = await pagesOf(file)
        const page = Math.max(1, Math.min(total, printed))
        warmAround(file, page, prefetchWindow)
        send(res, 200, 'text/html; charset=utf-8', buildHtml({ id, file, printed: page, total }))
      } catch (error) {
        send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed, message: error && error.message ? error.message : error }))
      }
      return
    }

    // 页图：清晰版给整本浏览，普通版给单页查看器。已缓存直接回，不进渲染队列。
    const isDoc = Boolean(hd)
    const pageScale = isDoc ? docScale : scale
    const pageNo = printed
    const cached = readCachedPage(file, pageNo, pageScale)
    if (cached) {
      send(res, 200, 'image/png', cached, { 'Cache-Control': 'public, max-age=3600' })
      return
    }
    if (!isDoc) stopWarm()
    renderPage(file, pageNo, pageScale, {
      priority: isDoc ? PRIORITY.doc : PRIORITY.user,
      group: isDoc ? 'doc' : 'user',
    }).then((data) => {
      if (!data) { if (!res.headersSent) send(res, 503, 'text/plain; charset=utf-8', '渲染任务被取消，重载即可'); return }
      if (!res.headersSent) send(res, 200, 'image/png', data, { 'Cache-Control': 'public, max-age=3600' })
    }).catch((error) => {
      if (!res.headersSent) send(res, 500, 'text/html; charset=utf-8', buildErrorHtml({ file, printed: pageNo, message: error && error.message ? error.message : error }))
    })
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
        prewarm()
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
        prewarm()
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
