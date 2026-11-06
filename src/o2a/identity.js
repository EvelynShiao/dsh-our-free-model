/**
 * opencode2api `internal/identity/request.go` 移植：会话慢钟铸造、相位解码、projectID
 * @module src/o2a/identity.js
 */
import crypto from 'node:crypto'

/** `ses_` + 12 hex + 14 base62 —— 免费道接受的形状（2026-09-16 起） */
export const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** 降序时间部：9 位自由 hex + `f[c-f]` + 1 位自由 hex —— 即 counter 1–63 窗口 */
export const DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 合成会话时间戳最多回溯 30 天 */
export const SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** 进程级会话盐：重启重铸、单进程内稳定 */
const BOOT_NONCE = crypto.randomBytes(16)

/** 判断是否为官方 CLI 铸造的合法会话 ID */
export function isOfficialSessionID(signal) {
  return typeof signal === 'string'
    && CANONICAL_SESSION_RE.test(signal)
    && DESCENDING_TIME_RE.test(signal.slice(4, 16))
}

/**
 * 规范会话 ID：官方 CLI 的保留原样；其它信号按慢钟重铸
 * @param {string} signal - 会话信号（conversation ID 等）
 * @param {number} [now] - 当前时间，默认 Date.now()
 * @returns {string} 合法的 `ses_` 会话 ID
 */
export function canonicalSessionID(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from('ses\0'), BOOT_NONCE, Buffer.from([0]), Buffer.from(String(signal))]))
    .digest()
  const timePart = descendingTimePart(now, digest)
  const randomPart = base62Fixed(digest.subarray(6, 16), 14)
  return `ses_${timePart}${randomPart}`
}

/** 会话 ID 承载的时间相位宽度（36 位毫秒，约 795 天一周期） */
export const SESSION_PHASE_MS = 2n ** 36n

/** 从会话 ID 解码出毫秒时间相位 */
export function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null
  const inverted = BigInt(`0x${id.slice(4, 16)}`)
  const current = ~inverted & 0xffffffffffffn
  return Number(current >> 12n)
}

/** 当前时钟的 36 位毫秒相位 */
export function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS)
}

/** 计算某相位距今有多久（相位周期内） */
export function phaseAgeMs(phase, now = Date.now()) {
  const nowPhase = BigInt(now % Number(SESSION_PHASE_MS))
  const age = (nowPhase - BigInt(phase)) % SESSION_PHASE_MS
  return Number((age + SESSION_PHASE_MS) % SESSION_PHASE_MS)
}

/**
 * 渲染合理的近期时间戳（降序编码）：
 * 今日 UTC 零点 - 哈希派生偏移（≤30天）<< 12 | 1，取反
 */
export function descendingTimePart(now = Date.now(), hash) {
  const offset = (((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0) % SESSION_TIMESTAMP_WINDOW_MS
  const midnight = Math.floor(now / 86400000) * 86400000
  const base = midnight - offset
  const inverted = ~((BigInt(base) << 12n) | 1n) & 0xffffffffffffn
  return inverted.toString(16).padStart(12, '0')
}

/** 定宽 base62 编码 */
export function base62Fixed(bytes, width) {
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET[Number(n % 62n)]
    n /= 62n
  }
  return out.join('')
}

/** 任意前缀随机 ID */
export function randomID(prefix, size) {
  return `${prefix}_${crypto.randomBytes(size).toString('hex')}`
}

/**
 * 项目 ID：git commit 40-hex 或 `global` 直通；其它哈希成 40-hex
 * 免费道按 `projectID × 出口` 记账
 */
export function randomProjectID() {
  return crypto.randomBytes(20).toString('hex')
}

const GIT_COMMIT_RE = /^[0-9a-f]{40}$/
export function projectID(project) {
  if (project === 'global' || GIT_COMMIT_RE.test(String(project))) return project
  const sum = crypto.createHash('sha256').update(`opencode-project\0${project}`).digest()
  return sum.subarray(0, 20).toString('hex')
}