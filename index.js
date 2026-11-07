/**
 * 类型：工具；解决：侧栏 iframe 不渲染 PDF，手册要按页翻、按页跳；
 * 作用：本地把页面渲成图，给出带翻页 / 跳页 / 整本浏览的网页地址（页码按 PDF 页序）。
 *
 * 不 import 任何 DSH 包：工具定义按 ctx.tools.register 的形状直接写，换 DSH 版本不受影响。
 */

import { basename, resolve } from 'node:path'

import { resolvePdf } from './lib/resolve.mjs'
import { createViewer, registerFile } from './lib/server.mjs'

/** Cordis 插件名。 */
export const name = 'dsh-pdf-jump'
/** 需要的服务：工具注册表 + 系统提示（让模型知道什么时候该用它）+ 命令注册表（/pdf）。 */
export const inject = ['tools', 'systemPrompt', 'commands']

/** 报错尾行：插件出问题时，使用者第一眼看的就是错误文本。 */
const FEEDBACK_HINT = '遇到问题：加 QQ 号 2171960697，或开 Issue https://github.com/taoziliyouchong/dsh-pdf-jump/issues'

/**
 * 每轮都在模型上下文里的使用说明。工具描述只在工具列表里出现一次，
 * 这段公告把「什么时候用 / 什么时候不用」说清楚，保证模型选得对。
 */
const GUIDANCE = [
  '本机装了 dsh-pdf-jump（在侧栏里看 PDF，两个独立入口）：',
  '- 默认用 pdf-view（单页跳转模式）：带页码打开，页面带「上一页/下一页/跳页码/整本浏览」。用户只说「打开/看一眼某本 PDF」「打开第 N 页」也一律用它。',
  '- pdf-open 只在明确要求「原生预览、不生成图片、最快」时才用，不作为默认。',
  '- 用户要提取 PDF 文字、读元数据或比较字体时，用 dsh-pdf 插件（需另装）的 pdf_info / pdf_extract_text，不要用这两个工具。',
  '- 不要绕过这两个工具自己用 sidebar_open 打开 PDF 文件：那样没有跳页、没有整本浏览。pdf-open 会自己调 sidebar_open 用原生预览打开——本会话没有 sidebar_open（第三方侧栏插件没装、或它的「模型打开侧栏」开关没开）时，它会回落到 pdf-view 的渲染查看器并给一个可点的链接。',
  '- 两个工具都返回本机路径或本地 url：不要把裸路径/裸 url 贴给用户，用「📄 文件名」做链接文字。pdf-view 的 url 要 sidebar_open 打开才落到侧栏；没有 sidebar_open 时直接在回复里给可点的链接。',
  '- 只给了文件名片段、不知道路径时直接传进去：先按会话工作目录找，再按片段搜。',
  '- 用户说「点了链接没反应 / 打不开」时，说明是侧栏浏览器默认拦截本机地址：建议把「网页链接默认打开方式」改成默认浏览器，或把 127.0.0.1:<端口> 加进侧栏设置里的本机地址白名单。',
  '- 旧对话里的 url 在服务空闲退出后会失效，不要复用；每次重新调用取新地址。',
].join('\n')

const parameters = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'PDF 绝对/相对路径，或文件名片段（如 "VFD-EL-W 手册"）' },
    page: { type: 'number', description: 'PDF 页序（从 1 开始），不是页脚印的印刷页码' },
    cwd: { type: 'string', description: '搜索根目录；默认用当前会话的工作目录' },
  },
  required: ['file', 'page'],
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      url: { type: 'string' },
      file: { type: 'string' },
      page: { type: 'number' },
    },
    required: ['ok', 'url', 'file', 'page'],
  },
  render: (_args, value) => [{
    type: 'text',
    text: `[📄 ${basename(value.file)} · 第 ${value.page} 页](<${value.url}>)`,
  }],
}

/** 当前会话的工作目录；取不到时退回进程目录。 */
async function sessionCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    if (workingDirectory && exec?.agent) {
      // ensure() 按 Agent 取会话目录（get() 要的是 Session 对象，工具上下文只有 Agent）。
      return await workingDirectory.ensure(exec.agent, exec?.signal)
    }
    if (workingDirectory?.defaultDirectory) return workingDirectory.defaultDirectory
  } catch { /* 服务不可用或目录已被删除，用进程目录 */ }
  return process.cwd()
}

export function apply(ctx, config = {}) {
  const viewer = createViewer({
    port: config.port,
    scale: config.scale,
    idleMinutes: config.idleMinutes,
    prefetch: config.prefetch,
    prefetchWindow: config.prefetchWindow,
  })
  const extraRoots = Array.isArray(config.roots) ? config.roots.map(String) : []

  let starting = null
  const ensureViewer = () => {
    // start() 自己会复用已在跑的服务；服务因空闲退出后再次调用会重新拉起。
    if (!starting) starting = viewer.start().finally(() => { starting = null })
    return starting
  }

  ctx.effect?.(() => () => { viewer.stop().catch(() => {}) })

  // 插件加载就把服务起起来。DSH 重启后还是同一个默认端口、同一份路径注册表，
  // 旧对话里的 /v、/d 链接可以直接重新打开；端口被占用时工具调用会再试。
  viewer.start().catch(() => {})

  const hasTool = (name) => {
    try {
      return typeof ctx.tools.get === 'function' && ctx.tools.get(name) !== undefined
    } catch {
      return false
    }
  }

  if (!hasTool('pdf-view')) {
    try {
      ctx.tools.register({
        name: 'pdf-view',
        description:
          '在侧栏里看本地 PDF（默认入口）：单页跳转模式，页面带「上一页/下一页/跳页码/整本浏览」；'
          + '打开某本 PDF、翻到第 N 页、整本浏览都用它。pdf-open 只在明确要原生预览时用；要提取文字或元数据用 dsh-pdf 插件（需另装）的 pdf_info / pdf_extract_text。'
          + '本地服务把该页渲染成图，返回带「上一页/下一页/跳页码/整本浏览」的侧栏网页地址。'
          + 'file 给 PDF 路径或文件名片段（相对路径按会话工作目录解析），page 给 PDF 页序（从 1 开始，不从页脚推断印刷页码）。'
          + '返回 url：有 sidebar_open 就交给它打开；不要把裸 url 贴给用户。首次调用自动拉起本地服务（只绑 127.0.0.1）。',
        parameters,
        output,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = args.cwd ? resolve(String(args.cwd)) : await sessionCwd(ctx, exec)
          const pdf = resolvePdf(args.file, cwd, extraRoots)
          const port = await ensureViewer()
          const requested = Math.max(1, Math.round(Number(args.page) || 1))
          // 超出总页数时钳到最后一页——和查看器里显示的一致，返回文案不报一个看不到的页码。
          const total = await viewer.pageCount(pdf).catch(() => 0)
          const page = total > 0 ? Math.min(total, requested) : requested
          const id = registerFile(pdf)
          // 工具一返回就在后台把这一页和附近几页渲进缓存，用户点开时直接取图。
          if (config.prefetch !== false) viewer.prefetch(pdf, page)
          const url = `http://127.0.0.1:${port}/v/${id}/${page}`
          return { ok: true, url, file: pdf, page }
        },
      })
    } catch (err) {
      console.warn(`[dsh-pdf-jump] 未注册 pdf-view：${err.message}`)
    }
  }

  // 常驻说明：描述两个工具的分工；没有 systemPrompt 服务时静默跳过。
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect?.(
      () => systemPrompt.section({ name: 'plugin:dsh-pdf-jump', order: 161, text: GUIDANCE }),
      'dsh-pdf-jump: guidance',
    )
  }

  // 命令层：完全不经过模型判断，用户输入 /pdf 就一定走这两个工具。
  try {
    const commands = ctx.commands ?? ctx.get?.('commands')
    if (commands && typeof commands.register === 'function') {
      commands.register({
        name: 'pdf',
        description: '在侧栏打开 PDF（参数：<路径或文件名片段> [页码]）；默认走 pdf-view 单页跳转模式，页码省略时从第 1 页起',
        input: { hint: '<PDF 路径或文件名片段> [页码]' },
        handler: async ({ rawInput }) => {
          try {
            const raw = String(rawInput ?? '').trim()
            if (!raw) return { kind: 'error', text: '用法：/pdf <PDF 路径或文件名片段> [页码]' }
            const matched = raw.match(/^(.*?)\s+(\d+)$/)
            const target = matched ? matched[1].trim() : raw
            const requested = matched ? Math.max(1, Math.round(Number(matched[2]))) : 1
            const pdf = resolvePdf(target, process.cwd(), extraRoots)
            const port = await ensureViewer()
            const total = await viewer.pageCount(pdf).catch(() => 0)
            const page = total > 0 ? Math.min(total, requested) : requested
            const id = registerFile(pdf)
            if (config.prefetch !== false) viewer.prefetch(pdf, page)
            return { kind: 'success', text: `[📄 ${basename(pdf)} · 第 ${page} 页](<http://127.0.0.1:${port}/v/${id}/${page}>)` }
          } catch (error) {
            return { kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT }
          }
        },
      })
    }
  } catch (err) {
    console.warn(`[dsh-pdf-jump] 未注册 /pdf 命令：${err.message}`)
  }
}
