/**
 * 类型：工具；解决：只想「打开看一眼」PDF 时不应走图片渲染；作用：直接调 sidebar_open
 * 用 DSH 原生 PDF 预览打开（客户端渲染，最快）；本会话没有 sidebar_open 时回落到
 * pdf-view 的渲染查看器，给出可点的链接。
 *
 * sidebar_open 是第三方侧栏插件（dsh-better-sidebar）提供的工具，而且默认关闭；
 * 别的会话里未必存在，所以这里不假定它一定在。
 */

import { basename, resolve } from 'node:path'

import { resolvePdf } from './lib/resolve.mjs'
import { createViewer, registerFile } from './lib/server.mjs'

/** Cordis 插件名。 */
export const name = 'dsh-pdf-jump-native'
/** 需要的服务：工具注册表。 */
export const inject = ['tools']

const parameters = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'PDF 绝对/相对路径，或文件名片段（如 "VFD-EL-W 手册"）' },
    cwd: { type: 'string', description: '搜索根目录；默认用当前会话的工作目录' },
  },
  required: ['file'],
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      file: { type: 'string' },
      opened: { type: 'boolean' },
      url: { type: 'string' },
    },
    required: ['ok', 'file', 'opened'],
  },
  render: (_args, value) => [{
    type: 'text',
    text: value.opened
      ? `[📄 ${basename(value.file)}](<${value.file}>) · 已用原生预览请求在侧栏打开`
      : `本会话没有可用的 sidebar_open（第三方侧栏插件未装，或它的「模型打开侧栏」开关没开），已回落到渲染查看器：[📄 ${basename(value.file)}](<${value.url}>)`,
  }],
}

function sessionCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    if (workingDirectory && exec?.agent?.id) {
      // ensure() 按 Agent 取会话目录；它是异步的，调用方 await。
      return Promise.resolve(workingDirectory.ensure(exec.agent, exec?.signal)).catch(() => process.cwd())
    }
    if (workingDirectory?.defaultDirectory) return workingDirectory.defaultDirectory
  } catch { /* 服务不可用或目录已被删除，用进程目录 */ }
  return process.cwd()
}

/**
 * 调 sidebar_open 把 PDF 在侧栏用原生预览打开。
 * 工具不存在（第三方插件未装 / 开关没开）或调用失败都返回 false，交给调用方回落。
 */
async function openInSidebar(ctx, exec, pdf) {
  try {
    if (typeof ctx.tools.get !== 'function' || typeof ctx.tools.execute !== 'function') return false
    if (!ctx.tools.get('sidebar_open', exec?.agent)) return false
    const result = await ctx.tools.execute({
      callId: `pdf-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'sidebar_open',
      arguments: { target: pdf, title: basename(pdf) },
      signal: exec?.signal ?? new AbortController().signal,
      ...(exec?.agent ? { agent: exec.agent } : {}),
      ...(exec?.token ? { parent: exec.token } : {}),
    })
    return result?.isError !== true
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const extraRoots = Array.isArray(config.roots) ? config.roots.map(String) : []
  // 只在需要回落时启动；index.js 那半边通常已经把同端口的服务拉起来了，start() 会复用它。
  const viewer = createViewer({
    port: config.port,
    scale: config.scale,
    idleMinutes: config.idleMinutes,
    prefetch: config.prefetch,
    prefetchWindow: config.prefetchWindow,
  })
  ctx.effect?.(() => () => { viewer.stop().catch(() => {}) })

  try {
    if (typeof ctx.tools.get === 'function' && ctx.tools.get('pdf-open')) return
  } catch { /* 老版本没有 get()，交给 register 的重名错误兜底 */ }

  try {
    ctx.tools.register({
      name: 'pdf-open',
      description:
        '在侧栏用 DSH 原生的 PDF 预览打开本地 PDF——客户端直接渲染，不生成图片、不起本地服务、有文字层；'
        + '只在明确要原生预览时用；默认入口是 pdf-view（按页码跳页、整本浏览）。'
        + '打开 PDF 文件先过这个工具（或 pdf-view），不要自己拼 sidebar_open 路径——这里还要解析文件名片段和会话工作目录。'
        + 'file 给 PDF 路径或文件名片段（相对路径按会话工作目录解析）。'
        + '这个工具会自己调 sidebar_open 打开原生预览；本会话没有 sidebar_open 时，回落到 pdf-view 的渲染查看器并返回可点的 url（opened=false）。',
      parameters,
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = args.cwd ? resolve(String(args.cwd)) : await sessionCwd(ctx, exec)
        const pdf = resolvePdf(args.file, cwd, extraRoots)
        if (await openInSidebar(ctx, exec, pdf)) return { ok: true, file: pdf, opened: true }
        const port = await viewer.start()
        const id = registerFile(pdf)
        return { ok: true, file: pdf, opened: false, url: `http://127.0.0.1:${port}/v/${id}/1` }
      },
    })
  } catch (err) {
    console.warn(`[dsh-pdf-jump-native] 未注册 pdf-open：${err.message}`)
  }
}
