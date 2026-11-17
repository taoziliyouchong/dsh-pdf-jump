#!/usr/bin/env node
/**
 * 一次性全文抽取：把每页的文字按行吐给宿主，宿主攒成索引文件（搜索用）。
 *
 * 单独一个进程、不是常驻：建索引要把全书逐页读一遍（几百页 3–8 秒），
 * 放进常驻渲染进程会把翻页请求一起堵住；一次性进程跑完就退出，互不干扰。
 *
 * 用法：node text-child.mjs --file <pdf>
 * 输出（stdout 每行一条）：{"page":12,"total":522,"text":"…"}
 * 出错：stderr 写原因、退出码 1。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')

const argv = process.argv.slice(2)
const at = argv.indexOf('--file')
const file = at >= 0 ? argv[at + 1] : null
if (!file) {
  process.stderr.write('text-child: 缺少 --file\n')
  process.exit(2)
}

/** 页内文字：逐项拼接，空白压成一个空格——搜索与摘要都按这份正文。 */
function joinItems(items) {
  const parts = []
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    if (item.hasEOL) parts.push('\n')
    parts.push(item.str)
  }
  return parts.join('').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
}

let task = null
try {
  task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
    isEvalSupported: false,
    verbosity: 0,
    useSystemFonts: true,
    cMapUrl: `${PDFJS_ROOT}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
  })
  const doc = await task.promise
  const total = doc.numPages
  for (let n = 1; n <= total; n += 1) {
    const page = await doc.getPage(n)
    let text = ''
    try {
      const content = await page.getTextContent()
      text = joinItems(content.items)
    } finally {
      page.cleanup()
    }
    process.stdout.write(JSON.stringify({ page: n, total, text }) + '\n')
  }
  await task.destroy().catch(() => {})
  process.exit(0)
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error) + '\n')
  await task?.destroy().catch(() => {})
  process.exit(1)
}
