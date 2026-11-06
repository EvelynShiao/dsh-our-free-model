/**
 * opencode2api `gateway.setV2Headers` 移植：v2 网关指纹头集
 * @module src/o2a/headers.js
 */
import { ANONYMOUS_CREDENTIAL, CLIENT_UA } from './version.js'
import { randomProjectID, projectID } from './identity.js'

/**
 * v2 请求头集（setV2Headers）
 * @param {object} opts
 * @param {string} opts.session - 规范会话 ID（亲和性）
 * @param {string} [opts.childSession] - 子会话 ID（x-opencode-session-id），默认同 session
 * @param {string} [opts.project] - 项目信号；非 global/40-hex 则哈希成 40-hex
 * @param {boolean} [opts.anthropic] - 是否 Anthropic Messages 线（加 beta 头）
 * @param {string} [opts.accept] - 显式 accept（仅 GET 文档抓取时需求），默认不发
 * @param {string} [opts.userAgent] - UA 覆盖，默认锁死 CLIENT_UA
 * @returns {Record<string, string>}
 */
export function gatewayHeaders({ session, childSession, project, anthropic, accept, userAgent } = {}) {
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${ANONYMOUS_CREDENTIAL}`,
    'user-agent': userAgent ?? CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-session': session,
    'x-opencode-session-id': childSession ?? session,
    'x-opencode-project': projectID(project ?? randomProjectID()),
  }
  if (accept) headers['accept'] = accept
  if (anthropic) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  return headers
}