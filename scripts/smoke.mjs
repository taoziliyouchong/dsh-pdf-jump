/**
 * 本机冒烟测试：起服务，跑一遍全部路由——单页 HTML、页图、清晰页图、缩略图、整本页、
 * 命中矩形、全书搜索（NDJSON）、原始文件。
 *
 * 用法：node scripts/smoke.mjs <pdf 路径> [PDF 页序] [搜索词]
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { createViewer, registerFile } from '../lib/server.mjs'

const file = resolve(process.argv[2] ?? '')
const page = Number(process.argv[3] ?? 1) || 1
const keyword = process.argv[4] ?? ''

if (!existsSync(file) || statSync(file).isDirectory()) {
  console.error('用法：node scripts/smoke.mjs <pdf 路径> [PDF 页序] [搜索词]')
  process.exit(2)
}

const viewer = createViewer({ port: 8781, idleMinutes: 1, prefetch: true, prefetchWindow: 2 })
const fail = (message) => { throw new Error(message) }

try {
  const port = await viewer.start()
  const base = `http://127.0.0.1:${port}`
  const id = registerFile(file)
  const timed = async (label, run) => {
    const t0 = performance.now()
    const value = await run()
    console.log(`${label.padEnd(22)} ${Math.round(performance.now() - t0)} ms`)
    return value
  }

  // 1. 单页 HTML
  const html = await timed('page html', async () => {
    const res = await fetch(`${base}/v/${id}/${page}`)
    if (!res.ok) fail(`/v 返回 ${res.status}`)
    return res.text()
  })
  const total = Number(/共 (\d+) 页/.exec(html)?.[1] ?? 0)
  if (!total) fail('/v 里没有页数')
  for (const needle of ['findInput', 'createFinder', 'pdfhl-layer', '/search/']) {
    if (!html.includes(needle)) fail(`/v 缺少搜索相关片段：${needle}`)
  }

  // 2. 页图（冷缓存）
  const png = await timed('page png (cold)', async () => {
    const res = await fetch(`${base}/p/${id}/${page}.png`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!res.ok || bytes.length < 1000) fail(`/p 返回 ${res.status}，${bytes.length} 字节`)
    return bytes
  })

  // 3. 页图（磁盘缓存）
  await timed('page png (cached)', async () => {
    const res = await fetch(`${base}/p/${id}/${page}.png`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!res.ok || bytes.length < 1000) fail('/p 第二次返回异常')
    return bytes
  })

  // 4. 翻到另一页：常驻进程应当明显快于冷启动
  const other = Math.min(total, page + 20)
  const png2 = await timed(`page png (p${other})`, async () => {
    const res = await fetch(`${base}/p/${id}/${other}.png`)
    if (!res.ok) fail(`/p 第 ${other} 页返回 ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  })

  // 5. 整本浏览的清晰版
  await timed('page hd (1.5x)', async () => {
    const res = await fetch(`${base}/h/${id}/${page}.png`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!res.ok || bytes.length < 1000) fail(`/h 返回 ${res.status}，${bytes.length} 字节`)
    if (bytes.length >= png.length) console.log(`  ! 清晰版比 2 倍版还大：${bytes.length} vs ${png.length}`)
    return bytes
  })

  // 6. 缩略图
  const thumb = await timed('thumbnail (0.8x)', async () => {
    const res = await fetch(`${base}/t/${id}/${page}.jpg`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!res.ok || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail(`/t 返回 ${res.status}，不是 JPEG`)
    return bytes
  })

  // 7. 整本页
  const docHtml = await timed('document html', async () => {
    const res = await fetch(`${base}/d/${id}`)
    if (!res.ok) fail('/d 返回 ' + res.status)
    return res.text()
  })
  const anchors = (docHtml.match(/id="p\d+"/g) || []).length
  if (anchors !== total) fail(`/d 页锚点 ${anchors} 与总页数 ${total} 不一致`)
  if (!docHtml.includes('findList')) fail('/d 缺少搜索列表容器')

  // 8. 命中矩形 + 全书搜索
  let matched = 0
  if (keyword) {
    const layout = await timed('/x 命中矩形', async () => {
      const res = await fetch(`${base}/x/${id}/${page}?q=${encodeURIComponent(keyword)}`)
      if (!res.ok) fail(`/x 返回 ${res.status}`)
      return res.json()
    })
    if (!Number.isFinite(layout.width) || layout.width <= 0) fail('/x 没有页宽')
    if (layout.empty) console.log('  ! 这一页没有文字层')
    for (const hit of layout.hits) {
      for (const rect of hit.rects) {
        if (!(rect[0] >= 0 && rect[1] >= 0 && rect[2] > 0 && rect[3] > 0)) fail(`/x 矩形异常：${JSON.stringify(rect)}`)
        if (rect[0] + rect[2] > layout.width + 2) fail('/x 矩形超出页宽')
        if (rect[1] + rect[3] > layout.height + 2) fail('/x 矩形超出页高')
      }
    }

    const started = performance.now()
    const res = await fetch(`${base}/search/${id}?q=${encodeURIComponent(keyword)}`)
    if (!res.ok) fail(`/search 返回 ${res.status}`)
    const text = await res.text()
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const pages = lines.filter((line) => line.type === 'page')
    const done = lines.find((line) => line.type === 'done')
    const error = lines.find((line) => line.type === 'error')
    if (error) fail('搜索出错：' + error.message)
    if (!done) fail('搜索没有结束标记')
    if (done.scanned !== total) fail(`搜索扫了 ${done.scanned} 页，总页数 ${total}`)
    matched = done.matched
    console.log(`search "${keyword}"     ${Math.round(performance.now() - started)} ms，${matched} 处 / ${pages.length} 页`)
    if (pages.length && !pages[0].snippet) fail('命中页没有摘要')
    for (const row of pages) {
      if (!(row.page >= 1 && row.page <= total)) fail('命中页码越界：' + row.page)
      if (!(row.count > 0)) fail('命中计数异常：' + row.count)
    }
    // 再搜一次：索引已落盘，应当明显更快
    const t2 = performance.now()
    const second = await fetch(`${base}/search/${id}?q=${encodeURIComponent(keyword)}`).then((r) => r.text())
    const done2 = second.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.type === 'done')
    if (!done2 || done2.matched !== matched) fail('两次搜索结果不一致')
    console.log(`search 复跑             ${Math.round(performance.now() - t2)} ms（索引命中）`)
  }

  console.log('')
  console.log(`viewer ok   http://127.0.0.1:${port}`)
  console.log(`pages       ${total}；整本页锚点 ${anchors}`)
  console.log(`png ${png.length} 字节；p${other} ${png2.length} 字节；缩略图 ${thumb.length} 字节`)
  if (keyword) console.log(`命中共 ${matched} 处`)
} finally {
  await viewer.stop()
}
