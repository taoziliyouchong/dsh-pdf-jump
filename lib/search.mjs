/**
 * 文字检索的纯函数层：页码正文与页面版面两种输入，共用同一套「忽略空白、不区分大小写」的匹配。
 *
 * 为什么忽略空白：PDF 里的正文不是一个整体字符串，而是被切成一段段文字片段
 * （中文手册常常几个字一段）。按字面匹配，「变频器 操作说明」这类跨片段的词永远搜不到。
 * 去掉空白再匹配，再把命中位置映射回原片段，既能搜到，也能算出高亮框。
 */

/**
 * 查询词归一：去掉所有空白、转小写。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeQuery(raw) {
  return String(raw ?? '').replace(/\s+/g, '').toLowerCase()
}

const isBlank = (ch) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\u00a0' || ch === '\u3000'

/**
 * 把一页文字压成可检索串，同时记住每个字符在原串里的位置（高亮要靠它反查）。
 * @param {string} text
 * @returns {{norm: string, offsets: number[]}}
 */
export function normalizeText(text) {
  const norm = []
  const offsets = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (isBlank(ch)) continue
    const lower = ch.toLowerCase()
    for (let k = 0; k < lower.length; k += 1) {
      norm.push(lower[k])
      offsets.push(i)
    }
  }
  return { norm: norm.join(''), offsets }
}

/**
 * 装好一页的版面：文字、可检索串、以及每段文字在串里的字符区间。
 * @param {{width: number, height: number, items: Array<{s: string, x: number, y: number, w: number, h: number}>}} raw
 */
export function prepareLayout(raw) {
  const items = []
  let text = ''
  for (const item of raw.items || []) {
    if (!item || typeof item.s !== 'string' || item.s.length === 0) continue
    items.push({ ...item, start: text.length, end: text.length + item.s.length })
    text += item.s
  }
  const { norm, offsets } = normalizeText(text)
  return { width: raw.width, height: raw.height, items, text, norm, offsets }
}

/**
 * 命中位置映射成页面坐标（scale=1 视口坐标）上的矩形。
 * 一段文字被多个片段切开时，一段一个框，最后同行的相邻框合并。
 */
function rectsFor(layout, start, end) {
  const rects = []
  for (const item of layout.items) {
    if (item.end <= start) continue
    if (item.start >= end) break
    const span = item.end - item.start
    if (span <= 0) continue
    if (item.w <= 0.4) continue
    // 纯空白片段没有可看的范围（pdf.js 量出来的空格高度是 0），画出来是个零高的框；
    // 空白两侧的文字片段各自出框，中间的间隙由相邻合并规则补上。
    if (!item.s.trim()) continue
    if (!(item.h > 0)) continue
    const from = Math.max(start, item.start) - item.start
    const to = Math.min(end, item.end) - item.start
    const f0 = from / span
    const f1 = to / span
    const width = Math.max(0.8, item.w * (f1 - f0))
    rects.push({ x: item.x + item.w * f0, y: item.y, w: width, h: item.h })
  }
  const merged = []
  for (const rect of rects) {
    const prev = merged[merged.length - 1]
    const sameLine = prev && Math.abs(prev.y - rect.y) < Math.max(1, rect.h * 0.35)
    const close = prev && rect.x - (prev.x + prev.w) < Math.max(1, rect.h * 0.5)
    if (sameLine && close) {
      const right = Math.max(prev.x + prev.w, rect.x + rect.w)
      prev.w = right - prev.x
      prev.h = Math.max(prev.h, rect.h)
    } else {
      merged.push({ ...rect })
    }
  }
  return merged.map((r) => [round(r.x), round(r.y), round(r.w), round(r.h)])
}

const round = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * 在页面版面上找全部命中。
 * @param {ReturnType<typeof prepareLayout>} layout
 * @param {string} query 原始查询词
 * @param {number} [limit] 单页最多几处
 * @returns {Array<{start: number, end: number, text: string, rects: number[][]}>}
 */
export function findInLayout(layout, query, limit = 200) {
  const needle = normalizeQuery(query)
  if (!needle || !layout || !layout.norm) return []
  const hits = []
  let from = 0
  while (hits.length < limit) {
    const at = layout.norm.indexOf(needle, from)
    if (at < 0) break
    const start = layout.offsets[at]
    const end = layout.offsets[at + needle.length - 1] + 1
    hits.push({
      start,
      end,
      text: layout.text.slice(start, end),
      rects: rectsFor(layout, start, end),
    })
    from = at + Math.max(1, needle.length)
  }
  return hits
}

/**
 * 在一页正文里数命中（全文搜索用，不落矩形）。
 * @param {string} text 页码正文
 * @param {string} needle 归一后的查询词
 * @returns {{count: number, first: number, end: number}} 命中数、第一处的起止位置（原串偏移，没有则 -1）
 */
export function countInText(text, needle) {
  if (!needle) return { count: 0, first: -1, end: -1 }
  const { norm, offsets } = normalizeText(text)
  let count = 0
  let first = -1
  let firstEnd = -1
  let from = 0
  for (;;) {
    const at = norm.indexOf(needle, from)
    if (at < 0) break
    if (first < 0) {
      first = offsets[at]
      firstEnd = offsets[at + needle.length - 1] + 1
    }
    count += 1
    from = at + needle.length
  }
  return { count, first, end: firstEnd }
}

/**
 * 命中处前后的摘要：搜索结果列表里给人看的那一小截。
 * @param {string} text 页码正文
 * @param {number} start 命中起点（原串偏移）
 * @param {number} end 命中终点（原串偏移）
 * @param {number} [pad] 前后各留多少字
 */
export function snippetOf(text, start, end, pad = 24) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const a = Math.max(0, start - pad)
  const b = Math.min(text.length, end + pad)
  return {
    before: (a > 0 ? '…' : '') + clean(text.slice(a, start)),
    match: clean(text.slice(start, end)),
    after: clean(text.slice(end, b)) + (b < text.length ? '…' : ''),
  }
}
