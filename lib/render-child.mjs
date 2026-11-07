#!/usr/bin/env node
/**
 * 单页渲染子进程：一页一进程，渲染完就退出。
 *
 * 为什么不在宿主进程里直接渲染：pdfjs 用它挂在 globalThis 上的
 * `pdfjsWorker.WorkerMessageHandler` 找 worker；宿主里如果还有别的插件带另一个
 * pdfjs 版本（比如 4.10.38），后写的那份会把全局改成自己的，于是本插件 6.x 的
 * API 拿到 4.x 的 worker，报「API version 6.4.299 does not match Worker version 4.10.38」。
 * 子进程有自己的 module graph 和全局，谁也不影响谁。
 *
 * 用法：
 *   node render-child.mjs --info --file <pdf>
 *   node render-child.mjs --file <pdf> --page <n> --scale <s> --out <png/jpg> [--format png|jpg] [--quality 0.8]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}

const file = opt('--file')
if (!file) {
  console.error('render-child: 缺少 --file')
  process.exit(2)
}

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

function open() {
  return pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
    isEvalSupported: false,
    verbosity: 0,
    useSystemFonts: true,
    cMapUrl: `${PDFJS_ROOT}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
    canvasFactory: new CanvasFactory(),
  })
}

try {
  const task = open()
  const doc = await task.promise
  if (flag('--info')) {
    process.stdout.write(JSON.stringify({ pages: doc.numPages }) + '\n')
    await task.destroy().catch(() => {})
    process.exit(0)
  }

  const pageNo = Math.max(1, Math.min(doc.numPages, Number(opt('--page', '1')) || 1))
  const scale = Number(opt('--scale', '2')) || 2
  const format = opt('--format', 'png') === 'jpg' ? 'jpg' : 'png'
  const quality = Number(opt('--quality', '0.8')) || 0.8
  const out = opt('--out')
  if (!out) {
    console.error('render-child: 缺少 --out')
    process.exit(2)
  }

  const page = await doc.getPage(pageNo)
  const viewport = page.getViewport({ scale })
  const factory = new CanvasFactory()
  const { canvas, context } = factory.create(viewport.width, viewport.height)
  try {
    // JPEG 没有透明通道，先铺白底，和单页查看器的白纸效果一致。
    if (format === 'jpg') {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise
    const bytes = format === 'jpg'
      ? canvas.toBuffer('image/jpeg', { quality })
      : canvas.toBuffer('image/png')
    writeFileSync(out, bytes)
    process.stdout.write(JSON.stringify({ pages: doc.numPages, bytes: bytes.length }) + '\n')
  } finally {
    factory.destroy({ canvas, context })
  }
  await task.destroy().catch(() => {})
  process.exit(0)
} catch (error) {
  console.error(String(error && error.message || error))
  process.exit(1)
}
