#!/usr/bin/env node
/**
 * 常驻渲染进程：一本 PDF 只解析一次，按行收 JSON 请求、按行回 JSON 结果。
 *
 * 为什么常驻：旧版是「一页一进程」，每页都要重开 PDF（进程启动 + 解析 + 首帧），
 * 实测 0.9–1.3 秒一页；翻得稍快一点，页图就还在队列里排着，看到的就是没渲染好。
 * 改成常驻后同一台机器上单页 0.15–0.3 秒。
 *
 * 为什么仍在子进程里：pdfjs 通过 globalThis.pdfjsWorker 找 worker，宿主里还有别的
 * 插件带不同版本 pdf.js 时会把全局换成自己的，同进程混用会报
 * 「API version … does not match Worker version …」。子进程有独立 module graph。
 *
 * 协议（stdin 一行一条）：
 *   {"id":1,"op":"info","file":"C:\\a.pdf"}
 *   {"id":2,"op":"render","file":…,"page":3,"scale":2,"format":"png","quality":0.8,"out":"C:\\x.png"}
 *   {"id":3,"op":"text","file":…,"page":3}
 *   {"id":4,"op":"drop","file":…}
 *   {"id":5,"op":"ping"}
 * 回包（stdout 一行一条）：
 *   {"id":2,"ok":true,"bytes":123,"width":1190,"height":1684,"rss":123456789}
 *   {"id":2,"ok":false,"error":"…"}
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')

/** 同时保留几本文档。翻来翻去时上一次开的文档大概率还用得上。 */
const MAX_DOCS = 2

// stdout 是协议通道：库或我们自己任何一行散装日志都会把 JSON 行冲坏，一律改道 stderr。
const toStderr = (...parts) => process.stderr.write(parts.map(String).join(' ') + '\n')
console.log = toStderr
console.info = toStderr
console.debug = toStderr

class CanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)))
    return { canvas, context: canvas.getContext('2d') }
  }

  reset({ canvas }, width, height) {
    canvas.width = Math.max(1, Math.floor(width))
    canvas.height = Math.max(1, Math.floor(height))
  }

  destroy() {}
}

/** 文档表：file → { task, doc, lastUsed }。 */
const docs = new Map()

function evictDocs() {
  while (docs.size > MAX_DOCS) {
    const oldest = [...docs.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
    if (!oldest) return
    docs.delete(oldest[0])
    oldest[1].task.destroy().catch(() => {})
  }
}

async function openDoc(file) {
  const hit = docs.get(file)
  if (hit) {
    hit.lastUsed = Date.now()
    return hit.doc
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
    isEvalSupported: false,
    verbosity: 0,
    useSystemFonts: true,
    cMapUrl: `${PDFJS_ROOT}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
    canvasFactory: new CanvasFactory(),
  })
  const doc = await task.promise
  docs.set(file, { task, doc, lastUsed: Date.now() })
  evictDocs()
  return doc
}

/**
 * 一页的文字版面。坐标统一换成 scale=1 的视口坐标——上层按页宽比例缩放，
 * 与渲染倍率无关，图片多大都能精确压在上面。
 */
async function textOf(file, pageNo) {
  const doc = await openDoc(file)
  const total = doc.numPages
  const n = Math.max(1, Math.min(total, Number(pageNo) || 1))
  const page = await doc.getPage(n)
  try {
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = []
    let lineHeight = 0
    for (const item of content.items) {
      const str = typeof item.str === 'string' ? item.str : ''
      if (!str) continue
      // 视口变换 × 文字变换 = 这段文字在页面上的位置与朝向。
      const tx = pdfjs.Util.transform(viewport.transform, item.transform)
      // item.width / item.height 已经是「PDF 用户单位」量级（含字号），只需再乘视口倍率。
      const w = (item.width || 0) * viewport.scale
      const h = (item.height || 0) * viewport.scale
      const vertical = Math.abs(tx[1]) > Math.abs(tx[0]) * 1.5
      if (vertical) {
        // 竖排文字（日文/古籍）坐标轴换了向，文本层不铺它；搜索矩形照旧按交换后的宽高画。
        items.push({ s: str, x: round(tx[4]), y: round(tx[5]), w: round(h), h: round(w), v: 1 })
        continue
      }
      // 纯空格片段量出来的高度是 0；文本层要靠它撑出可选区域，借同一行前一段的字高补上。
      // 搜索高亮本来就跳过纯空白片段，补高度不影响搜索结果。
      const height = h > 0.5 ? h : (lineHeight || 10)
      if (h > 0.5) lineHeight = h
      items.push({ s: str, x: round(tx[4]), y: round(tx[5] - height), w: round(w), h: round(height) })
    }
    return { pages: total, page: n, width: round(viewport.width), height: round(viewport.height), items }
  } finally {
    page.cleanup()
  }
}

const round = (value) => Math.round((Number(value) || 0) * 100) / 100

async function renderPage(msg) {
  const doc = await openDoc(msg.file)
  const total = doc.numPages
  const n = Math.max(1, Math.min(total, Number(msg.page) || 1))
  const scale = Number(msg.scale) > 0 ? Number(msg.scale) : 2
  const format = msg.format === 'jpg' ? 'jpg' : 'png'
  const quality = Number(msg.quality) > 0 ? Number(msg.quality) : 0.8
  const page = await doc.getPage(n)
  try {
    const viewport = page.getViewport({ scale })
    const factory = new CanvasFactory()
    const { canvas, context } = factory.create(viewport.width, viewport.height)
    try {
      // JPEG 没有透明通道，先铺白底，和查看器的白纸效果一致。
      if (format === 'jpg') {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
      }
      await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise
      const bytes = format === 'jpg'
        ? canvas.toBuffer('image/jpeg', { quality })
        : canvas.toBuffer('image/png')
      writeFileSync(msg.out, bytes)
      return { pages: total, bytes: bytes.length, width: Math.round(viewport.width), height: Math.round(viewport.height) }
    } finally {
      factory.destroy({ canvas, context })
    }
  } finally {
    page.cleanup()
  }
}

async function handle(msg) {
  switch (msg.op) {
    case 'ping':
      return {}
    case 'info': {
      const doc = await openDoc(msg.file)
      return { pages: doc.numPages }
    }
    case 'render':
      return renderPage(msg)
    case 'text':
      return textOf(msg.file, msg.page)
    case 'drop': {
      const entry = docs.get(msg.file)
      if (!entry) return {}
      docs.delete(msg.file)
      await entry.task.destroy().catch(() => {})
      return {}
    }
    default:
      throw new Error(`未知操作：${msg.op}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let chain = Promise.resolve()

rl.on('line', (line) => {
  const raw = line.trim()
  if (!raw) return
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  chain = chain.then(async () => {
    let reply
    try {
      const value = await handle(msg)
      reply = { id: msg.id, ok: true, ...value, rss: process.memoryUsage().rss }
    } catch (error) {
      reply = { id: msg.id, ok: false, error: String(error && error.message ? error.message : error) }
    }
    process.stdout.write(JSON.stringify(reply) + '\n')
  }).catch(() => {})
})

rl.on('close', () => {
  for (const entry of docs.values()) entry.task.destroy().catch(() => {})
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  toStderr('[render-worker] 未捕获异常：' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
