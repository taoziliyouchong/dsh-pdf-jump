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
 *   /l/<id>/<页>        该页的文字版面（前端铺透明文本层，供拖选与复制）
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

/** 两个查看器共用的透明文本层：只负责选中与复制，不参与页图渲染。 */
const TEXTLAYER_CSS = `
.pdftext-layer{position:absolute;inset:0;z-index:2;line-height:1;text-align:left;cursor:text;user-select:text;-webkit-user-select:text;overflow:hidden}
.pdftext-layer span{position:absolute;color:transparent;white-space:pre;transform-origin:0 0;cursor:text;user-select:text;-webkit-user-select:text}
.pdftext-layer span::selection{background:rgba(47,129,247,.38);color:transparent}
.pdfcopy-btn{position:fixed;z-index:9998;display:none;height:30px;padding:0 12px;border:1px solid #4a4a4a;border-radius:6px;background:#1f6feb;color:#fff;font:13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4)}
.pdfcopy-btn.on{display:inline-flex;align-items:center}
.pdfmenu{position:fixed;z-index:9999;min-width:150px;padding:4px;border:1px solid #4a4a4a;border-radius:8px;background:#222;box-shadow:0 8px 24px rgba(0,0,0,.55)}
.pdfmenu button{display:block;width:100%;height:28px;padding:0 10px;border:0;border-radius:5px;background:none;color:#eee;font:13px/1 system-ui,sans-serif;text-align:left;cursor:pointer;white-space:nowrap}
.pdfmenu button:hover{background:#333}
.pdfmenu button:disabled{opacity:.45;cursor:default}
.pdfmenu button:disabled:hover{background:none}
`

/**
 * 文本层：拿服务端给出的 scale=1 版面坐标，在页图上铺一层透明文字。
 * 底图仍是渲染出来的页图，这一层只负责浏览器的拖选与复制；搜索高亮另有一层。
 * 字号按页宽比例换算；每段文字量一次自然宽度，再用 scaleX 对到 PDF 片段宽度，
 * 这样选中框和页图上的字对得齐（与 PDF.js TextLayer 是同一套做法）。
 */
const TEXTLAYER_JS = `
var pdfText = (function () {
  var layers = [];
  var copyButton = null;
  var menu = null;
  var copyTimer = null;
  var suppressUntil = 0;
  var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i].target.__pdfText;
      if (entry) layoutEntry(entry);
    }
  }) : null;

  function layoutEntry(entry) {
    var width = entry.layer.clientWidth;
    if (!width || !entry.data || !entry.data.width) return;
    var scale = width / entry.data.width;
    for (var i = 0; i < entry.spans.length; i += 1) {
      var span = entry.spans[i];
      span.style.fontSize = (span.__height * scale) + 'px';
    }
  }

  function forget(layer) {
    var entry = layer.__pdfText;
    if (!entry) return;
    var at = layers.indexOf(entry);
    if (at >= 0) layers.splice(at, 1);
    layer.__pdfText = null;
  }

  function build(layer, data) {
    layer.textContent = '';
    forget(layer);
    if (!data || !data.items || !data.items.length || !(data.width > 0) || !(data.height > 0)) return false;
    var fragment = document.createDocumentFragment();
    var spans = [];
    for (var i = 0; i < data.items.length; i += 1) {
      var item = data.items[i];
      if (!item || typeof item.s !== 'string' || !item.s) continue;
      var span = document.createElement('span');
      span.textContent = item.s.replace(/[\\r\\n]+/g, ' ');
      span.setAttribute('role', 'presentation');
      span.__height = item.h > 0 ? item.h : 10;
      span.__width = item.w > 0 ? item.w : 0;
      span.style.left = (100 * item.x / data.width).toFixed(3) + '%';
      span.style.top = (100 * item.y / data.height).toFixed(3) + '%';
      span.style.fontSize = span.__height + 'px';
      fragment.appendChild(span);
      spans.push(span);
    }
    if (!spans.length) return false;
    layer.appendChild(fragment);
    for (var j = 0; j < spans.length; j += 1) {
      var sp = spans[j];
      var natural = sp.getBoundingClientRect().width;
      if (natural > 0.01 && sp.__width > 0.01) {
        var sx = sp.__width / natural;
        if (sx > 0.05 && sx < 20) sp.style.transform = 'scaleX(' + sx + ')';
      }
    }
    var entry = { layer: layer, data: data, spans: spans };
    layer.__pdfText = entry;
    layers.push(entry);
    if (observer) observer.observe(layer);
    layoutEntry(entry);
    return true;
  }

  function clear(layer) {
    if (!layer) return;
    if (layer.__pdfTextAbort) {
      try { layer.__pdfTextAbort.abort(); } catch (error) {}
      layer.__pdfTextAbort = null;
    }
    forget(layer);
    layer.textContent = '';
    hideCopy();
    hideMenu();
  }

  function load(layer, id, page, callbacks) {
    callbacks = callbacks || {};
    clear(layer);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    layer.__pdfTextAbort = controller;
    return fetch('/l/' + id + '/' + page, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (controller && controller.signal.aborted) return;
        if (!build(layer, data) && callbacks.onEmpty) callbacks.onEmpty(page);
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return;
        if (callbacks.onError) callbacks.onError(page, error);
      })
      .then(function () {
        if (layer.__pdfTextAbort === controller) layer.__pdfTextAbort = null;
      });
  }

  function selectAll() {
    var first = null;
    var last = null;
    for (var i = 0; i < layers.length; i += 1) {
      var spans = layers[i].spans;
      if (!spans.length || !spans[0].isConnected) continue;
      if (!first) first = spans[0];
      last = spans[spans.length - 1];
    }
    if (!first || !last || !first.firstChild || !last.firstChild) return false;
    var range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(last.firstChild, last.firstChild.length);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function layerOf(node) {
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    return element && element.closest ? element.closest('.pdftext-layer') : null;
  }

  function selectionIn(layer) {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    var anchorLayer = layerOf(selection.anchorNode);
    if (!anchorLayer) return '';
    if (layer && anchorLayer !== layer) return '';
    return selection.toString().replace(/\\u0000/g, '');
  }

  function notify(name, text) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: { length: text ? text.length : 0 } }));
    } catch (error) {}
  }

  function copied(text) {
    suppressUntil = Date.now() + 500;
    hideCopy();
    hideMenu();
    notify('pdf-text-copied', text);
  }

  function failed() {
    suppressUntil = Date.now() + 500;
    hideCopy();
    hideMenu();
    notify('pdf-text-copy-failed', '');
  }

  function fallbackCopy(text) {
    var selection = window.getSelection();
    var saved = [];
    for (var i = 0; selection && i < selection.rangeCount; i += 1) saved.push(selection.getRangeAt(i).cloneRange());
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
    if (area.parentNode) area.parentNode.removeChild(area);
    try {
      if (selection) {
        selection.removeAllRanges();
        for (var j = 0; j < saved.length; j += 1) selection.addRange(saved[j]);
      }
    } catch (error) {}
    if (ok) copied(text); else failed();
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () { copied(text); }, function () { fallbackCopy(text); });
      return;
    }
    fallbackCopy(text);
  }

  function ensureCopyButton() {
    if (copyButton && copyButton.isConnected) return copyButton;
    copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'pdfcopy-btn';
    copyButton.textContent = '复制';
    copyButton.setAttribute('aria-label', '复制选中的文字');
    copyButton.addEventListener('mousedown', function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
    copyButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      copyText(selectionIn(null));
    });
    document.body.appendChild(copyButton);
    return copyButton;
  }

  function hideCopy() {
    if (copyButton) copyButton.classList.remove('on');
  }

  function hideMenu() {
    if (!menu) return;
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }

  function updateCopyButton() {
    if (Date.now() < suppressUntil) { hideCopy(); return; }
    if (menu) { hideCopy(); return; }
    var text = selectionIn(null);
    if (!text) { hideCopy(); return; }
    var selection = window.getSelection();
    var rects = selection.getRangeAt(0).getClientRects();
    var rect = null;
    for (var i = rects.length - 1; i >= 0; i -= 1) {
      var box = rects[i];
      if (box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight) { rect = box; break; }
    }
    if (!rect) { hideCopy(); return; }
    var button = ensureCopyButton();
    button.classList.add('on');
    var left = rect.right + 8;
    var top = rect.bottom + 8;
    if (left + 64 > window.innerWidth) left = Math.max(8, window.innerWidth - 72);
    if (top + 38 > window.innerHeight) top = Math.max(8, rect.top - 38);
    button.style.left = left + 'px';
    button.style.top = top + 'px';
  }

  function showMenu(x, y, layer) {
    hideMenu();
    hideCopy();
    var selected = selectionIn(layer);
    var copyItem = document.createElement('button');
    copyItem.type = 'button';
    copyItem.textContent = '复制';
    copyItem.disabled = selected.length === 0;
    copyItem.addEventListener('mousedown', function (event) { event.preventDefault(); event.stopPropagation(); });
    copyItem.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (selected) copyText(selected);
      hideMenu();
    });

    var pageItem = document.createElement('button');
    pageItem.type = 'button';
    pageItem.textContent = '复制本页文字';
    pageItem.addEventListener('mousedown', function (event) { event.preventDefault(); event.stopPropagation(); });
    pageItem.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var pageText = layer ? layer.textContent.replace(/\\u0000/g, '') : '';
      if (pageText) copyText(pageText); else failed();
      hideMenu();
    });

    var allItem = document.createElement('button');
    allItem.type = 'button';
    allItem.textContent = '全选';
    allItem.addEventListener('mousedown', function (event) { event.preventDefault(); event.stopPropagation(); });
    allItem.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      selectAll();
      hideMenu();
    });

    menu = document.createElement('div');
    menu.className = 'pdfmenu';
    menu.appendChild(copyItem);
    menu.appendChild(pageItem);
    menu.appendChild(allItem);
    document.body.appendChild(menu);
    var left = Math.min(x + 2, window.innerWidth - menu.offsetWidth - 8);
    var top = Math.min(y + 2, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
  }

  document.addEventListener('selectionchange', function () {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(updateCopyButton, 80);
  });
  document.addEventListener('mouseup', function () {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(updateCopyButton, 30);
  });
  document.addEventListener('mousedown', function (event) {
    if (copyButton && copyButton.contains(event.target)) return;
    if (menu && menu.contains(event.target)) return;
    hideCopy();
    hideMenu();
  });
  document.addEventListener('contextmenu', function (event) {
    var layer = layerOf(event.target);
    if (!layer) return;
    event.preventDefault();
    showMenu(event.clientX, event.clientY, layer);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    hideCopy();
    hideMenu();
  });
  window.addEventListener('scroll', function () { hideCopy(); hideMenu(); }, true);
  document.addEventListener('scroll', function () { hideCopy(); hideMenu(); }, true);
  window.addEventListener('resize', function () { hideCopy(); hideMenu(); });

  document.addEventListener('copy', function (event) {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    var node = selection.anchorNode;
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!element || !element.closest || !element.closest('.pdftext-layer')) return;
    var text = selection.toString().replace(/\\u0000/g, '');
    if (!text) return;
    try {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      copied(text);
    } catch (error) { /* 交回浏览器默认复制 */ }
  });

  document.addEventListener('keydown', function (event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key !== 'a' && event.key !== 'A') return;
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (selectAll()) event.preventDefault();
  });

  return { load: load, clear: clear, build: build, selectAll: selectAll, hideCopy: hideCopy };
})();
`

function buildHtml({ id, file, printed, total }) {
  const title = `${basename(file)} · 第 ${printed} 页`
  const src = `/p/${id}/${printed}.png`
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
html,body{margin:0;height:100%;overflow:hidden}
*{box-sizing:border-box}
body{background:#2b2b2b;color:#ddd;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{position:relative;z-index:9;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:#1e1e1e;border-bottom:1px solid #3a3a3a;box-shadow:0 2px 8px rgba(0,0,0,.25)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:30px;padding:0 10px;border:1px solid #4a4a4a;border-radius:6px;background:#333;color:#eee;font:inherit;cursor:pointer}
button:hover,.btn:hover{background:#414141}
button:active{transform:translateY(1px)}
.zoom{display:inline-flex;align-items:center;gap:2px}
.zoom button{padding:0 8px}
.zoom .zlabel{min-width:52px;font-variant-numeric:tabular-nums}
#page{width:72px;height:30px;text-align:center;border:1px solid #4a4a4a;border-radius:6px;background:#111;color:#eee;font:inherit}
.total{opacity:.65}
.meta{margin-left:auto;opacity:.65;white-space:nowrap}
a.open{color:#8cc4ff;text-decoration:none;border-bottom:1px dotted currentColor;margin-left:auto}
main{display:block;overflow:auto;padding:14px 12px 40px;height:calc(100vh - 48px)}
.wrap{position:relative;width:100%;max-width:100%;margin:0 auto}
img{display:block;width:100%;max-width:none;height:auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.55);border-radius:2px}
#spinner{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:rgba(0,0,0,.7);color:#eee;font-size:12px;display:none}
#spinner.on{display:block}
#toast{position:fixed;left:50%;bottom:18px;z-index:10000;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:8px;background:#111;border:1px solid #555;color:#ffb4b4;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;display:none}
#toast.on{display:block}
#toast.ok{color:#b7f0c0;border-color:#3d6b4a}
${FIND_CSS}
${TEXTLAYER_CSS}
@media (max-width:560px){.meta{display:none}a.open{margin-left:0}}
</style></head><body>
<header class="bar">
  <button id="prev" title="上一页（←）">‹</button>
  <input id="page" inputmode="numeric" value="${printed}" aria-label="页码">
  <span class="total">/ ${total}</span>
  <button id="jump" title="跳到填写页码">跳</button>
  <button id="next" title="下一页（→）">›</button>
  <button id="findBtn" title="全文搜索（Ctrl+F）">搜索</button>
  <span class="zoom"><button id="zoomOut" title="缩小（Ctrl+- / Ctrl+滚轮）">−</button><button id="zoomReset" class="zlabel" title="100% 为适应宽度，点击重置（Ctrl+0）">100%</button><button id="zoomIn" title="放大（Ctrl+= / Ctrl+滚轮）">+</button></span>
  <span class="meta" id="meta">第 ${printed} 页 / 共 ${total} 页</span>
  <a class="open" href="/d/${id}" title="在侧栏里整本翻阅">整本浏览</a>
  ${FIND_HTML}
</header>
<main><div class="wrap"><img id="img" src="${src}" alt="第 ${printed} 页"><div id="text" class="pdftext-layer"></div><div id="hl" class="pdfhl-layer"></div><div id="spinner" class="on">渲染中…</div></div></main>
<div id="toast"></div>
<script>
${TEXTLAYER_JS}
var ID = ${JSON.stringify(id)};
var TOTAL = ${total};
var printed = ${printed};
var img = document.getElementById('img');
var input = document.getElementById('page');
var spinner = document.getElementById('spinner');
var toast = document.getElementById('toast');
var hlLayer = document.getElementById('hl');
var textEl = document.getElementById('text');
var textPage = 0;
var zoom = 1;
var wrapEl = document.querySelector('.wrap');
var mainEl = document.querySelector('main');
var zoomLabel = document.getElementById('zoomReset');
var loadToken = 0;
var pendingLoad = null;

function showToast(text, ok) {
  toast.textContent = text;
  toast.classList.toggle('ok', !!ok);
  toast.classList.add('on');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(function () { toast.classList.remove('on'); }, 4000);
}

document.addEventListener('pdf-text-copied', function (event) {
  showToast('已复制 ' + event.detail.length + ' 字', true);
});
document.addEventListener('pdf-text-copy-failed', function () {
  showToast('复制没成功：按 Ctrl+C 复制选中的文字');
});

function load() {
  if (printed < 1) printed = 1;
  if (printed > TOTAL) printed = TOTAL;
  input.value = printed;
  var token = ++loadToken;
  var url = '/p/' + ID + '/' + printed + '.png';
  hlLayer.textContent = '';
  pdfText.clear(textEl);
  textPage = 0;
  spinner.classList.add('on');
  var job = new Promise(function (resolve) {
    var probe = new Image();
    probe.onload = function () {
      if (token !== loadToken) return resolve();
      img.src = url;
      img.setAttribute('data-page', String(printed));
      // 跳回同一页时 img.src 不变、load 事件不会再发；这时图片已经完整，直接补文字层。
      if (img.complete && img.naturalWidth > 0) { applyZoom(); loadTextLayer(); }
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

function fitWidth() {
  var available = Math.max(160, mainEl.clientWidth - 24);
  var natural = img.naturalWidth || 0;
  return natural > 0 ? Math.min(natural, available) : available;
}

function fitViewport() {
  var bar = document.querySelector('.bar');
  mainEl.style.height = Math.max(120, window.innerHeight - bar.offsetHeight) + 'px';
}

function applyZoom() {
  var base = fitWidth();
  wrapEl.style.width = Math.round(base * zoom) + 'px';
  wrapEl.style.maxWidth = 'none';
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
}

function setZoom(next, clientX, clientY) {
  next = Math.max(0.5, Math.min(4, next));
  if (Math.abs(next - zoom) < 0.001) return;
  var rect = wrapEl.getBoundingClientRect();
  var inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  if (!inside) {
    clientX = rect.left + rect.width / 2;
    clientY = rect.top + rect.height / 2;
  }
  var ratioX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  var ratioY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  zoom = next;
  applyZoom();
  var after = wrapEl.getBoundingClientRect();
  var dx = (after.left + ratioX * after.width) - clientX;
  var dy = (after.top + ratioY * after.height) - clientY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) mainEl.scrollBy(dx, dy);
}

function loadTextLayer() {
  if (textPage === printed) return;
  textPage = printed;
  pdfText.load(textEl, ID, printed, {
    onError: function (page, error) { showToast('第 ' + page + ' 页文字层取不到，暂时不能选中复制：' + error.message); }
  });
}

img.addEventListener('load', function () {
  spinner.classList.remove('on');
  applyZoom();
  loadTextLayer();
});
img.addEventListener('error', function () {
  spinner.classList.remove('on');
  fetch(img.src).then(function (r) { return r.text(); }).then(function (t) { showToast('这一页没渲染出来：' + t); })
    .catch(function () { showToast('这一页没渲染出来（请求失败）'); });
});
// 首屏：图片可能比脚本先加载完，complete 时直接补一次文字层。
if (img.complete && img.naturalWidth > 0) { applyZoom(); loadTextLayer(); }
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

document.addEventListener('wheel', function (event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  setZoom(zoom * Math.exp(-event.deltaY * 0.0012), event.clientX, event.clientY);
}, { passive: false });

document.addEventListener('keydown', function (event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  var tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  var key = event.key;
  var cx = window.innerWidth / 2;
  var cy = window.innerHeight / 2;
  if (key === '=' || key === '+') { event.preventDefault(); setZoom(zoom + 0.1, cx, cy); }
  else if (key === '-' || key === '_') { event.preventDefault(); setZoom(zoom - 0.1, cx, cy); }
  else if (key === '0') { event.preventDefault(); setZoom(1, cx, cy); }
});

document.getElementById('zoomIn').addEventListener('click', function () { setZoom(zoom + 0.1, window.innerWidth / 2, window.innerHeight / 2); });
document.getElementById('zoomOut').addEventListener('click', function () { setZoom(zoom - 0.1, window.innerWidth / 2, window.innerHeight / 2); });
document.getElementById('zoomReset').addEventListener('click', function () { setZoom(1, window.innerWidth / 2, window.innerHeight / 2); });
window.addEventListener('resize', function () { fitViewport(); applyZoom(); });
if (typeof ResizeObserver === 'function') new ResizeObserver(fitViewport).observe(document.querySelector('.bar'));
fitViewport();
applyZoom();

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
html,body{margin:0;height:100%;overflow:hidden;background:#2b2b2b;color:#ddd;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{position:relative;z-index:9;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;background:#1e1e1e;border-bottom:1px solid #3a3a3a;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.bar b{font-weight:600;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar a{color:#8cc4ff;text-decoration:none;border-bottom:1px dotted currentColor}
.bar .count{opacity:.65}
.bar .jump{display:inline-flex;gap:4px;align-items:center}
.bar input{width:64px;height:26px;text-align:center;border:1px solid #4a4a4a;border-radius:6px;background:#111;color:#eee;font:inherit}
.bar button{height:26px;padding:0 10px;border:1px solid #4a4a4a;border-radius:6px;background:#333;color:#eee;font:inherit;cursor:pointer}
.bar button:hover{background:#414141}
.bar .zoom{display:inline-flex;align-items:center;gap:2px}
.bar .zoom button{padding:0 8px}
.bar .zoom .zlabel{min-width:52px;font-variant-numeric:tabular-nums}
main{display:block;overflow:auto;padding:16px 12px 48px;height:calc(100vh - 48px)}
a.page{display:block;width:var(--page-w,min(760px,100%));margin:0 auto 18px;text-decoration:none;color:#bbb;position:relative;background:#fff;border-radius:2px;box-shadow:0 3px 18px rgba(0,0,0,.55);scroll-margin-top:8px}
a.page img{display:block;width:100%;height:auto;border-radius:2px}
a.page img.thumb{min-height:120px}
a.page img.hd{position:absolute;left:0;top:0;opacity:0;transition:opacity .12s}
a.page img.hd.ok{opacity:1}
a.page .pn{position:sticky;bottom:8px;float:right;margin-top:-30px;margin-right:8px;padding:2px 10px;border-radius:999px;background:rgba(0,0,0,.7);font-size:12px;z-index:2}
a.page:hover{outline:2px solid #2f81f7;outline-offset:-2px}
a.page.miss::after{content:"点开单独看";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.7);font-size:12px}
${FIND_CSS}
${TEXTLAYER_CSS}
a.page{-webkit-user-drag:none;user-drag:none}
a.page img{-webkit-user-drag:none}
.bar .findbar input{width:auto;text-align:left}
#toast{position:fixed;left:50%;bottom:18px;z-index:10000;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:8px;background:#111;border:1px solid #555;color:#ffb4b4;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;display:none}
#toast.on{display:block}
#toast.ok{color:#b7f0c0;border-color:#3d6b4a}
</style></head><body>
<header class="bar">
  <b>${escapeHtml(basename(file))}</b>
  <span class="count">共 ${total} 页</span>
  <span class="jump"><input id="jumpPage" inputmode="numeric" placeholder="页码" aria-label="跳到第几页"><button id="jumpGo">跳</button></span>
  <button id="findBtn" title="全文搜索（Ctrl+F）">搜索</button>
  <span class="zoom"><button id="zoomOut" title="缩小（Ctrl+- / Ctrl+滚轮）">−</button><button id="zoomReset" class="zlabel" title="100% 为适应宽度，点击重置（Ctrl+0）">100%</button><button id="zoomIn" title="放大（Ctrl+= / Ctrl+滚轮）">+</button></span>
  <a href="/v/${id}/1">单页模式</a>
  ${FIND_HTML}
</header>
<main>${pages.join('')}</main>
<div id="toast"></div>
<script>
${TEXTLAYER_JS}
var ID = ${JSON.stringify(id)};
var TOTAL = ${total};
var toast = document.getElementById('toast');
var zoom = 1;
var mainEl = document.querySelector('main');
function showToast(text, ok) {
  toast.textContent = text;
  toast.classList.toggle('ok', !!ok);
  toast.classList.add('on');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(function () { toast.classList.remove('on'); }, 4000);
}
document.addEventListener('pdf-text-copied', function (event) {
  showToast('已复制 ' + event.detail.length + ' 字', true);
});
document.addEventListener('pdf-text-copy-failed', function () {
  showToast('复制没成功：按 Ctrl+C 复制选中的文字');
});

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

// 文字层按页懒建：页进入视口时才取这一页的版面，翻到哪取到哪；扫描件返回空，不建层。
function textLayerIn(link) {
  if (!link || link.querySelector('.pdftext-layer')) return;
  var layer = document.createElement('div');
  layer.className = 'pdftext-layer';
  link.appendChild(layer);
  var page = Number(link.id.slice(1));
  pdfText.load(layer, ID, page, {
    onError: function (n, error) { console.warn('[pdf-jump] 第 ' + n + ' 页文字层失败：' + error.message); }
  });
}

var links = Array.prototype.slice.call(document.querySelectorAll('a.page'));
if ('IntersectionObserver' in window) {
  // 提前 400px 开始换清晰版，滚到该页时通常已经换好。
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      swap(entry.target);
      textLayerIn(entry.target);
    });
  }, { rootMargin: '400px 0px' });
  links.forEach(function (link) { io.observe(link); });
} else {
  links.forEach(function (link) { swap(link); textLayerIn(link); });
}
// 缩略图没出来（渲染失败）时给个提示，别留一块白。
links.forEach(function (link) {
  var thumb = link.querySelector('img.thumb');
  if (!thumb) return;
  thumb.addEventListener('error', function () { link.classList.add('miss'); });
});

// 拖选文字后松手会顺带触发 <a> 的点击；选区落在这一页里就不跳转，免得选完就跳走。
links.forEach(function (link) {
  link.addEventListener('click', function (event) {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    var range = selection.getRangeAt(0);
    if (link.contains(range.startContainer) || link.contains(range.endContainer)) event.preventDefault();
  });
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
  var mid = mainEl.getBoundingClientRect().top + mainEl.clientHeight / 2;
  for (var i = 0; i < links.length; i += 1) {
    var rect = links[i].getBoundingClientRect();
    if (rect.bottom > mid) return i + 1;
  }
  return 1;
}

function fitPageWidth() {
  var available = Math.max(180, mainEl.clientWidth - 24);
  return Math.min(760, available);
}

function fitViewport() {
  var bar = document.querySelector('.bar');
  mainEl.style.height = Math.max(120, window.innerHeight - bar.offsetHeight) + 'px';
}

function applyZoom() {
  var width = Math.round(fitPageWidth() * zoom);
  mainEl.style.setProperty('--page-w', width + 'px');
  document.getElementById('zoomReset').textContent = Math.round(zoom * 100) + '%';
}

function pageAt(x, y) {
  var element = document.elementFromPoint(x, y);
  var page = element && element.closest ? element.closest('a.page') : null;
  if (page) return page;
  var mid = mainEl.getBoundingClientRect().top + mainEl.clientHeight / 2;
  for (var i = 0; i < links.length; i += 1) {
    var rect = links[i].getBoundingClientRect();
    if (rect.bottom >= mid) return links[i];
  }
  return links[0] || null;
}

function setZoom(next, clientX, clientY) {
  next = Math.max(0.5, Math.min(4, next));
  if (Math.abs(next - zoom) < 0.001) return;
  var page = pageAt(clientX, clientY);
  var rect = page ? page.getBoundingClientRect() : null;
  var ratioX = rect && rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0.5;
  var ratioY = rect && rect.height > 0 ? Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) : 0.5;
  zoom = next;
  applyZoom();
  if (!page) return;
  var after = page.getBoundingClientRect();
  var dx = (after.left + ratioX * after.width) - clientX;
  var dy = (after.top + ratioY * after.height) - clientY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) mainEl.scrollBy(dx, dy);
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

document.addEventListener('wheel', function (event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  setZoom(zoom * Math.exp(-event.deltaY * 0.0012), event.clientX, event.clientY);
}, { passive: false });

document.addEventListener('keydown', function (event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  var tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  var key = event.key;
  var cx = window.innerWidth / 2;
  var cy = window.innerHeight / 2;
  if (key === '=' || key === '+') { event.preventDefault(); setZoom(zoom + 0.1, cx, cy); }
  else if (key === '-' || key === '_') { event.preventDefault(); setZoom(zoom - 0.1, cx, cy); }
  else if (key === '0') { event.preventDefault(); setZoom(1, cx, cy); }
});

document.getElementById('zoomIn').addEventListener('click', function () { setZoom(zoom + 0.1, window.innerWidth / 2, window.innerHeight / 2); });
document.getElementById('zoomOut').addEventListener('click', function () { setZoom(zoom - 0.1, window.innerWidth / 2, window.innerHeight / 2); });
document.getElementById('zoomReset').addEventListener('click', function () { setZoom(1, window.innerWidth / 2, window.innerHeight / 2); });
window.addEventListener('resize', function () { fitViewport(); applyZoom(); });
if (typeof ResizeObserver === 'function') new ResizeObserver(fitViewport).observe(document.querySelector('.bar'));
fitViewport();
applyZoom();

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
    const textLayer = /^\/l\/([a-f0-9]{12})\/(\d+)$/.exec(pathname)
    const search = /^\/search\/([a-f0-9]{12})$/.exec(pathname)
    const raw = /^\/f\/([a-f0-9]{12})$/.exec(pathname)
    if (!single && !document && !png && !hd && !thumb && !layout && !textLayer && !search && !raw) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }
    const id = (single ?? document ?? png ?? hd ?? thumb ?? layout ?? textLayer ?? search ?? raw)[1]
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

    // 文字层：页面坐标 + 每段文字，前端按页宽比例铺透明文字，供拖选与复制。
    if (textLayer) {
      const n = Math.max(1, Math.round(Number(textLayer[2]) || 1))
      try {
        const total = await pagesOf(file)
        const page = Math.max(1, Math.min(total, n))
        const prepared = await pageLayout(file, page)
        const items = prepared.items
          .filter((item) => !item.v)
          .map((item) => ({ s: item.s, x: item.x, y: item.y, w: item.w, h: item.h }))
        sendJson(res, 200, {
          page, width: prepared.width, height: prepared.height,
          empty: items.length === 0, items,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
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
