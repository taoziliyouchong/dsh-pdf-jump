/**
 * 把工具参数 file 落成一个真实存在的 PDF 路径。
 *
 * 优先按路径解析（相对路径按调用方给的工作目录）；找不到时把 file 当文件名片段，
 * 在搜索根里广度优先找（浅层优先，带数量与时间上限）。搜索根默认是会话工作目录，
 * 再加上用户主目录下常见的桌面 / 文档 / 下载——只给片段时桌面上的 PDF 也能找到。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, basename, isAbsolute, join, resolve } from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.pnpm', '_backup', '$RECYCLE.BIN',
  'System Volume Information', '.cache', '__pycache__',
])

const SHELL_FOLDERS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'

/** 读 Windows 已知文件夹的真实路径（桌面可能被重定向到别的盘）。 */
function readShellFolder(name) {
  try {
    // reg.exe 按系统 OEM 代码页输出（中文 Windows 是 GBK），不能按 UTF-8 解码。
    const raw = execFileSync('reg', ['query', SHELL_FOLDERS_KEY, '/v', name], {
      timeout: 1500, windowsHide: true,
    })
    let text
    try {
      text = new TextDecoder('gbk').decode(raw)
    } catch {
      text = raw.toString('utf8')
    }
    const match = text.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)
    if (!match) return null
    return match[1].replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? '')
  } catch {
    return null
  }
}

let cachedHomeRoots

/** 用户主目录下常见的几处（桌面 / 文档 / 下载，按系统实际路径，存在才收）。 */
function homeRoots() {
  if (cachedHomeRoots) return cachedHomeRoots
  const home = homedir()
  const onWindows = process.platform === 'win32'
  const roots = [
    (onWindows && readShellFolder('Desktop')) || join(home, 'Desktop'),
    (onWindows && readShellFolder('Personal')) || join(home, 'Documents'),
    (onWindows && readShellFolder('{374DE290-123F-4565-9164-39C4925E467B}')) || join(home, 'Downloads'),
  ]
  cachedHomeRoots = roots.filter(Boolean)
  return cachedHomeRoots
}

/** Windows 盘符路径 / UNC 路径都算绝对路径（path.isAbsolute 认前者，不认 UNC 的写法差异）。 */
function isAbsolutePath(raw) {
  return isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)
}

/**
 * @param {string} root 搜索根
 * @param {number} limit 最多收多少个 PDF
 * @param {number} budgetMs 时间上限
 * @returns {string[]} PDF 绝对路径
 */
export function collectPdfs(root, limit = 20000, budgetMs = 8000) {
  const out = []
  const queue = [root]
  const deadline = Date.now() + budgetMs
  for (let i = 0; i < queue.length && out.length < limit; i += 1) {
    if (Date.now() > deadline) break
    let entries
    try {
      entries = readdirSync(queue[i], { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(queue[i], entry.name)
      if (entry.isDirectory()) {
        // 只跳过确定没有 PDF 的大目录；隐藏目录（如 .build）不再一律跳过——
        // 构建产物里也可能放 PDF。
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        out.push(full)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

/**
 * @param {string} input file 参数
 * @param {string} cwd 搜索根
 * @param {string[]} [extraRoots] 额外的搜索根
 * @returns {string} PDF 绝对路径
 */
export function resolvePdf(input, cwd, extraRoots = []) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('file 不能为空')
  const direct = resolve(cwd, raw)
  if (existsSync(direct) && statSync(direct).isFile()) return direct
  // 绝对路径不存在就是不存在，不再按片段去扫目录，错误信息也不带搜索根噪音。
  if (isAbsolutePath(raw)) throw new Error(`文件不存在：${raw}`)

  const needle = basename(raw).toLowerCase()
  const roots = [...extraRoots.filter(Boolean)]
  const envRoots = process.env.PDF_JUMP_ROOTS
  if (envRoots) roots.push(...envRoots.split(delimiter).filter(Boolean))
  roots.push(cwd)
  roots.push(...homeRoots())
  const seen = new Set()
  const base = resolve(cwd)
  for (const root of roots) {
    const abs = resolve(root)
    if (seen.has(abs) || !existsSync(abs)) continue
    seen.add(abs)
    // 工作目录优先，额度给足；桌面 / 文档 / 下载是兜底，限时短一些。
    const budgetMs = abs === base ? 8000 : 4000
    const hits = collectPdfs(abs, 20000, budgetMs)
      .filter((file) => basename(file).toLowerCase().includes(needle))
      .sort((a, b) => a.length - b.length)
    if (hits.length > 0) return hits[0]
  }
  throw new Error(`没找到 PDF：${raw}（找过：${[...seen].join(' ; ')}）`)
}
