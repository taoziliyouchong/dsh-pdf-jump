/**
 * PDF 渲染与全文索引的宿主侧接口。
 *
 * 渲染交给常驻子进程（见 worker-host.mjs / render-worker.mjs）：文档只解析一次，
 * 单页 0.15–0.3 秒；出图后落磁盘缓存，翻过的页不再付。
 * 全文索引交给一次性子进程（text-child.mjs）建，建完落盘，搜索直接用。
 *
 * 为什么都隔着进程：pdfjs 通过 globalThis.pdfjsWorker 找 worker，宿主里只要还有
 * 另一个插件带不同版本的 pdfjs，后写的会把全局改成自己的，同进程直接报
 * 「API version … does not match Worker version …」。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PRIORITY, cancelGroup, request, shutdown } from './worker-host.mjs'
import { prepareLayout } from './search.mjs'

const TEXT_CHILD = fileURLToPath(new URL('./text-child.mjs', import.meta.url))
const CACHE_DIR = join(tmpdir(), 'dsh-pdf-jump-cache')

/** 整本浏览用的缩略图倍率：0.8 约等于 476px 宽，列表里放大到 760px 内可辨版式。 */
export const THUMB_SCALE = 0.8
/** 版面缓存最多留几页（高亮查命中时用，翻回去不必再问进程）。 */
const LAYOUT_CACHE_MAX = 80

/** { file → { pages, mtimeMs, size } }：同一个文件只问一次页数。 */
const infoCache = new Map()
/** `${file}|${page}|${mtime}` → 已装好的版面。 */
const layoutCache = new Map()
/** 索引路径 → 正在建的 Promise，避免两次搜索各起一个进程。 */
const building = new Map()

function statOf(file) {
  return statSync(file)
}

function cachePathFor(file, pdfPage, scale, ext = 'png') {
  const stat = statOf(file)
  const key = createHash('md5')
    .update(`${file}|${stat.mtimeMs}|${stat.size}|${pdfPage}|${scale}`)
    .digest('hex')
  return join(CACHE_DIR, `${key}.${ext}`)
}

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

/**
 * 清理 7 天前的缓存（页图、缩略图、全文索引）。
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

/**
 * 页数。页码一律按 PDF 页序，不从页脚推断印刷页码——很多手册混用全书页码和
 * 「章-页」编号，推断出来的差值会把正文页整体错位。
 * @param {string} file PDF 绝对路径
 * @returns {Promise<{pages: number}>}
 */
export async function documentInfo(file) {
  const stat = statOf(file)
  const hit = infoCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { pages: hit.pages }
  const reply = await request('info', { file }, { key: `info:${file}:${stat.mtimeMs}`, priority: PRIORITY.user, timeout: 20_000 })
  const pages = Number(reply.pages)
  if (!Number.isFinite(pages) || pages < 1) throw new Error('读取页数失败')
  infoCache.set(file, { pages, mtimeMs: stat.mtimeMs, size: stat.size })
  return { pages }
}

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
 * @param {{priority?: number, group?: string}} [options]
 * @returns {Promise<Buffer|null>} PNG 字节；预渲染被作废时返回 null
 */
export async function renderPage(file, pdfPage, scale = 2, options = {}) {
  ensureCacheDir()
  pruneCache()
  const cachePath = cachePathFor(file, pdfPage, scale)
  if (existsSync(cachePath)) return readFileSync(cachePath)
  const reply = await request(
    'render',
    { file, page: pdfPage, scale, format: 'png', out: cachePath },
    {
      key: `render:${cachePath}`,
      priority: options.priority ?? PRIORITY.user,
      group: options.group ?? 'user',
      timeout: 60_000,
    },
  )
  if (reply.cancelled) return null
  return existsSync(cachePath) ? readFileSync(cachePath) : null
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
 * @param {{priority?: number, group?: string}} [options]
 * @returns {Promise<Buffer|null>} JPEG 字节；被作废时返回 null
 */
export async function renderThumb(file, pdfPage, scale = THUMB_SCALE, quality = 0.8, options = {}) {
  ensureCacheDir()
  pruneCache()
  const cachePath = cachePathFor(file, pdfPage, scale, 'jpg')
  if (existsSync(cachePath)) return readFileSync(cachePath)
  const reply = await request(
    'render',
    { file, page: pdfPage, scale, format: 'jpg', quality, out: cachePath },
    {
      key: `render:${cachePath}`,
      priority: options.priority ?? PRIORITY.thumb,
      group: options.group ?? 'thumb',
      timeout: 60_000,
    },
  )
  if (reply.cancelled) return null
  return existsSync(cachePath) ? readFileSync(cachePath) : null
}

/**
 * 一页的文字版面（scale=1 视口坐标）：搜索高亮用。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序
 * @returns {Promise<ReturnType<typeof prepareLayout>>}
 */
export async function pageLayout(file, pdfPage) {
  const stat = statOf(file)
  const key = `${file}|${pdfPage}|${stat.mtimeMs}`
  const hit = layoutCache.get(key)
  if (hit) {
    layoutCache.delete(key)
    layoutCache.set(key, hit)
    return hit
  }
  const reply = await request(
    'text',
    { file, page: pdfPage },
    { key: `text:${key}`, priority: PRIORITY.doc, timeout: 20_000 },
  )
  const layout = prepareLayout({ width: reply.width, height: reply.height, items: reply.items })
  layoutCache.set(key, layout)
  while (layoutCache.size > LAYOUT_CACHE_MAX) layoutCache.delete(layoutCache.keys().next().value)
  return layout
}

/** 全文索引文件路径（跟页图缓存放一起，按 7 天规则一起清）。 */
function indexPathFor(file) {
  const stat = statOf(file)
  const key = createHash('md5')
    .update(`index|${file}|${stat.mtimeMs}|${stat.size}`)
    .digest('hex')
  return join(CACHE_DIR, `${key}.idx.json`)
}

/**
 * 全书正文（按页）。有索引文件直接读；没有就起一次性进程抽一遍并落盘。
 * @param {string} file PDF 绝对路径
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<string[]>} 每页正文
 */
export async function documentTexts(file, onProgress) {
  ensureCacheDir()
  pruneCache()
  const indexPath = indexPathFor(file)
  if (existsSync(indexPath)) {
    try {
      const saved = JSON.parse(readFileSync(indexPath, 'utf8'))
      if (saved && Array.isArray(saved.texts) && saved.texts.length > 0) return saved.texts
    } catch { /* 索引坏了就重建 */ }
  }
  const pending = building.get(indexPath)
  if (pending) return pending
  const job = buildIndex(file, indexPath, onProgress).finally(() => building.delete(indexPath))
  building.set(indexPath, job)
  return job
}

function buildIndex(file, indexPath, onProgress) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const child = spawn(process.execPath, [TEXT_CHILD, '--file', file], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const texts = []
    let total = 0
    let buffer = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (Number.isFinite(msg.page)) texts[msg.page - 1] = typeof msg.text === 'string' ? msg.text : ''
          if (Number.isFinite(msg.total)) total = msg.total
          onProgress?.(msg.page, msg.total)
        } catch { /* 半行或杂音，跳过 */ }
      }
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `全文抽取进程退出码 ${code}`))
        return
      }
      for (let i = 0; i < (total || texts.length); i += 1) if (typeof texts[i] !== 'string') texts[i] = ''
      try {
        writeFileSync(indexPath, JSON.stringify({ pages: texts.length, texts }), 'utf8')
      } catch { /* 写不了索引下次再抽一遍 */ }
      resolve(texts)
    })
  })
}

/** 作废排队中的预渲染任务（用户翻到新页时调用）。 */
export function cancelPrefetch() {
  return cancelGroup('prefetch')
}

/**
 * 预热渲染进程：插件加载时先起好进程，第一页就不必再等进程启动。
 * 失败无所谓——下次真正请求时会重新起。
 */
export function prewarm() {
  request('ping', {}, { priority: PRIORITY.prefetch, timeout: 15_000 }).catch(() => {})
}

/**
 * 释放资源：关掉渲染进程、清空缓存。
 */
export async function closeDocuments() {
  shutdown()
  infoCache.clear()
  layoutCache.clear()
}

/** 渲染缓存目录，供文档与诊断使用。 */
export const cacheDir = CACHE_DIR
