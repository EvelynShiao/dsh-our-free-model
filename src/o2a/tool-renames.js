/**
 * opencode2api `internal/protocol/tools.go` 移植：
 * `clint_<sha256[:12]>` 不透明改名 + ToolRenameMap（正反映射 + 折叠解析）
 * @module src/o2a/tool-renames.js
 */
import crypto from 'node:crypto'

export const CLIENT_TOOL_PREFIX = 'clint_'
export const CLIENT_TOOL_DIGEST_LENGTH = 12
export const TOOL_WIRE_NAME_LIMIT = 64
const TOOL_NAME_SEPARATORS = '_.- \t\r\n'
const SEPARATOR_SET = new Set(TOOL_NAME_SEPARATORS)

/** 折叠工具名：小写、去分隔符，用于模糊匹配 */
export function foldToolName(name) {
  let out = ''
  for (const char of String(name ?? '').toLowerCase()) {
    if (!SEPARATOR_SET.has(char)) out += char
  }
  return out
}

/** 生成客户端工具的线名：clint_<sha256[:12]>，冲突加 _2、_3... */
export function clientToolWireName(name, used = new Set()) {
  const digest = crypto.createHash('sha256').update(String(name)).digest('hex')
  let clean = digest.slice(0, CLIENT_TOOL_DIGEST_LENGTH)
  const max = TOOL_WIRE_NAME_LIMIT - CLIENT_TOOL_PREFIX.length
  if (clean.length > max) clean = clean.slice(0, max)
  const base = CLIENT_TOOL_PREFIX + clean
  if (!used.has(base)) { used.add(base); return base }
  for (let suffix = 2; ; suffix += 1) {
    const tag = `_${suffix}`
    const cut = Math.min(TOOL_WIRE_NAME_LIMIT - tag.length, base.length)
    const candidate = base.slice(0, cut) + tag
    if (!used.has(candidate)) { used.add(candidate); return candidate }
  }
}

/**
 * 双向重命名表：client 名 ↔ wire 名，支持精确、大小写、分隔符折叠解析
 */
export class ToolRenameMap extends Map {
  constructor() {
    super()
    this.#byClient = new Map()
    this.#byCase = new Map()
    this.#byShape = new Map()
  }

  /** 记录一对 client→wire 映射（冲突保留首次） */
  add(client, wire) {
    if (!client || !wire || client === wire) return
    if (this.#byClient.has(client)) return
    if (this.has(wire)) return
    this.#byClient.set(client, wire)
    this.set(wire, client)
    bindFolded(this.#byCase, client.toLowerCase(), client)
    bindFolded(this.#byShape, foldToolName(client), client)
  }

  /** 精确 client 名查 wire 名 */
  wireOf(client) { return this.#byClient.get(client) }

  /** 是否有以 prefix 开头的 wire 名 */
  hasPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) if (wire.startsWith(prefix)) return true
    return false
  }

  /** 解析上游返回的 wire 名回 client 名 */
  resolve(wire) {
    if (!wire) return wire
    const exact = this.get(wire)
    if (exact !== undefined) return exact
    let client = wire
    if (client.startsWith(CLIENT_TOOL_PREFIX)) {
      const rest = client.slice(CLIENT_TOOL_PREFIX.length)
      if (rest !== '') client = rest
    }
    if (this.#byClient.has(client)) return client
    const caseMatch = this.#byCase.get(client.toLowerCase())
    if (caseMatch !== undefined) return caseMatch !== '' ? caseMatch : client
    const shapeMatch = this.#byShape.get(foldToolName(client))
    if (shapeMatch !== undefined && shapeMatch !== '') return shapeMatch
    return client
  }

  #byClient
  #byCase
  #byShape
}

function bindFolded(folded, key, client) {
  if (!key) return
  const existing = folded.get(key)
  if (existing === undefined) { folded.set(key, client); return }
  if (existing !== client) folded.set(key, '')
}