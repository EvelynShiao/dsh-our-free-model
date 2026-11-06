/**
 * Upstream wire for the免密 free lane — o2a v1.4.6 整形层接入版
 *
 * 关键变更（vs 旧版）：
 * - UA: opencode/latest/2.1.1/cli (v2 客户端)
 * - 头集: v2 四会话头 + x-opencode-project(40-hex/请求) + 无 x-opencode-request
 * - 会话: 慢钟铸造(UTC零点-≤30天哈希偏移)，进程盐分离重启，过期自动重铸
 * - 端点: 族路径 /inference/<family>/v1/...；Anthropic 加 ?beta=true
 * - 工具: 客户工具全改名 clint_<sha12> + 响应侧还原（幂等）
 * - Body: stream_options.include_usage:true + max_completion_tokens:32000
 * - 指纹: 仅改名，不再注入 13 官方工具/系统提示（第二批启用）
 *
 * @module src/upstream.js
 */
import crypto from 'node:crypto'
import {
  CLIENT_UA,
  ANONYMOUS_CREDENTIAL,
  V2_COMPLETION_LIMIT,
  canonicalSessionID,
  sessionPhaseMs,
  phaseAgeMs,
  projectID,
  randomProjectID,
  gatewayHeaders as o2aGatewayHeaders,
  renameAndCompleteTools,
  rewriteToolReferences,
  renamableToolName,
  officialToolDefinition,
  V2_OFFICIAL_TOOL_ORDER,
} from './o2a/index.js'

/** 可覆盖基址（selftest 用） */
export const UPSTREAM_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'

/** 会话/请求 ID 正则 */
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const ANTHROPIC_API_VERSION = '2023-06-01'

/** v1 指纹工具四重奏（供 forward 等兼容层使用） */
export const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

/** Responses 线模型 */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Messages 线模型 */
const MESSAGES_MODELS = new Set(['union-alpha'])

/** 去掉尾部 "(level)" 思维链后缀 */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

function isMuseSpark(modelId) {
  const clean = baseModelId(modelId)
  const base = clean.includes('/') ? clean.split('/').pop() : clean
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base)
}

export function isResponsesModel(modelId) {
  return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId)
}

export function isMessagesModel(modelId) {
  return MESSAGES_MODELS.has(baseModelId(modelId))
}

/**
 * 端点族路径（v2 形状）：/inference/<family>/v1/...
 * 旧扁平 /zen/v1/... 仍可用，但族路径是 2.1 客户端标准
 */
export function endpointFor(modelId) {
  const base = baseModelId(modelId)
  let family = 'openai'
  if (isMessagesModel(base)) family = 'anthropic'
  else if (isResponsesModel(base)) family = 'openai' // Responses 也走 openai 族
  const path = `/inference/${family}/v1/${isMessagesModel(base) ? 'messages' : isResponsesModel(base) ? 'responses' : 'chat/completions'}`
  return isMessagesModel(base) ? `${path}?beta=true` : path
}

/** 线形状：chat | responses | messages */
export function wireFor(modelId) {
  if (isMessagesModel(modelId)) return 'messages'
  if (isResponsesModel(modelId)) return 'responses'
  return 'chat'
}

/**
 * v2 网关头集（含项目级配额隔离）——兼容旧签名
 * 旧签名: { session, requestId, stream, accept }
 * 新签名: { session, childSession, project, stream, accept }
 * @returns {Record<string, string>}
 */
export function gatewayHeaders(opts = {}) {
  const { session, childSession, project, stream, accept, requestId } = opts
  // 旧签名检测：有 requestId 且无 childSession/project
  const isLegacy = requestId !== undefined && childSession === undefined && project === undefined
  return o2aGatewayHeaders({
    session: truncateSession(session),
    childSession: isLegacy ? undefined : childSession,
    project: isLegacy ? randomProjectID() : (project ?? randomProjectID()),
    anthropic: false,
    accept: isLegacy ? (stream ? 'text/event-stream' : '*/*') : accept,
    userAgent: CLIENT_UA,
  })
}

/** 规范会话 ID（慢钟铸造，进程盐，过期自动重铸） */
export function sessionForConversation(sessionId) {
  if (typeof sessionId === 'string' && SESSION_RE.test(sessionId.trim())) {
    const trimmed = sessionId.trim()
    // 已是合法官方 ID 则保留；但若相位过期则重铸
    if (phaseAgeMs(sessionPhaseMs(trimmed)) > 400 * 24 * 60 * 60 * 1000) {
      return canonicalSessionID(sessionId)
    }
    return trimmed
  }
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'global'
  return canonicalSessionID(seed)
}

/** 每轮稳定请求 ID：同一 turn 重试共享 */
export function requestIdFor(sessionId, turnSeed) {
  if (typeof turnSeed !== 'string' || turnSeed === '') return mintRequestId()
  const digest = crypto.createHash('sha256').update(`our-free-model-req\0${sessionId}\0${turnSeed}`).digest()
  const hex = digest.subarray(0, 6).toString('hex')
  const b62 = base62From(digest.subarray(6, 20))
  return `msg_${hex}${b62}`
}

/** 简单请求 ID 铸造（时间前缀 + 随机） */
function mintRequestId(timestamp = Date.now()) {
  const value = BigInt(timestamp) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `msg_${hex}${base62From(crypto.randomBytes(14))}`
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

/**
 * 完整整形入口：头 + Body（工具改名 + 引用重写 + Body 补齐）
 * @param {object} body - 请求体，原地修改
 * @param {string} modelId - 模型 ID
 * @param {string} sessionId - 规范会话 ID
 * @param {string} [project] - 项目信号
 * @returns {{ renames: Map, shape: string }} 重命名映射 + 线形状
 */
export function applyFingerprint(body, modelId, sessionId, project) {
  const shape = wireFor(modelId)
  const isChat = shape === 'chat'
  const isMessages = shape === 'messages'

  // 1. 工具改名 + 引用重写（幂等：clint_ 前缀跳过）
  const { renames } = renameAndCompleteTools(body, shape)

  // 2. Body 补齐（仅 Chat 线）
  if (isChat) {
    // stream_options.include_usage: true
    if (body.stream === true) {
      if (body.stream_options && typeof body.stream_options === 'object' && !Array.isArray(body.stream_options)) {
        if (body.stream_options.include_usage !== true) body.stream_options = { ...body.stream_options, include_usage: true }
      } else {
        body.stream_options = { include_usage: true }
      }
    }
    // max_completion_tokens: 32000（无上限时）
    if (body.max_completion_tokens === undefined && body.max_tokens === undefined) {
      body.max_completion_tokens = V2_COMPLETION_LIMIT
    }
    // tool_choice: 'none' 兜底清除（v2 门禁见即 403）
    if (body.tool_choice !== undefined) {
      const tc = body.tool_choice
      if (tc === 'none' || (tc && typeof tc === 'object' && tc.type === 'none')) delete body.tool_choice
    }
  }

  // 3. Anthropic beta 头在 gatewayHeaders 里按 model 加

  return { renames, shape }
}

/** 恢复调用方工具拼写（流式 delta / 最终载荷） */
export function restoreToolName(name, renames) {
  if (!renames || renames.size === 0) return name
  // renames 可能是 ToolRenameMap 或普通 Map
  if (typeof renames.resolve === 'function') return renames.resolve(name)
  return renames.get(name) ?? name
}

/** 取 body 中声明的工具名集合 */
export function declaredToolNames(body) {
  const names = new Set()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const n = renamableToolName('chat', tool) // 形状不影响名提取
    if (n) names.add(n)
  }
  return names
}

function truncateSession(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed
}

export { truncateSession, ANTHROPIC_API_VERSION }