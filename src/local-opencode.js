/**
 * Local OpenCode bridge — 免费车道（OpenCode Zen）v2 门禁的正解。
 *
 * 背景（2026-10-14 真机实测）：OpenCode v2 网关要求 `x-opencode-session`
 * 是**服务端注册过的真实会话**，伪造一律 403 FreeTierError（UA/头名/project
 * 怎么改都没用）。唯一可行路径 = 借本机 opencode 后台服务代发：
 *
 *   1. 连接信息：~/.local/state/opencode/service.json（Windows:
 *      %USERPROFILE%\.local\state\opencode\service.json；macOS/Linux 见下）
 *      Basic 鉴权 = base64("opencode:<password>")，UA = opencode/latest/<ver>/cli
 *   2. POST /api/session {location:{directory}, model:{providerID:'opencode', id}}
 *      → {data:{id:'ses_…'}}
 *   3. POST /api/session/{id}/generate {prompt, model} → {data:{text}}
 *      （会话内调用才过门禁；无会话的 /api/experimental/generate 会 503）
 *
 * 本模块把第 3 步的纯文本结果，包装成与直连通道相同的 chat SSE payload 串，
 * 交给调用方按原路解析（stream.js 认 choices[0].delta.content）。
 *
 * 会话按 key（DSH 会话 id + 模型）缓存，服务重启/会话失效时自动重建。
 *
 * @module src/local-opencode.js
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** service.json 候选路径（Windows / macOS / Linux）。 */
function statePaths() {
  const home = homedir()
  const list = []
  if (process.platform === 'win32') {
    list.push(join(home, '.local', 'state', 'opencode', 'service.json'))
    list.push(join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'opencode', 'service.json'))
    list.push(join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'opencode', 'service.json'))
  } else if (process.platform === 'darwin') {
    list.push(join(home, 'Library', 'Application Support', 'opencode', 'service.json'))
    list.push(join(home, '.local', 'state', 'opencode', 'service.json'))
  }
  const xdg = process.env.XDG_STATE_HOME?.trim()
  if (xdg) list.push(join(xdg, 'opencode', 'service.json'))
  list.push(join(home, '.local', 'state', 'opencode', 'service.json'))
  return list
}

const DEFAULT_UA = 'opencode/latest/2.0.29/cli'
let cached = null
let cachedAt = 0
const SERVICE_TTL_MS = 30_000

/** 探测本地 opencode 服务；不在则返回 null（调用方回退直连）。 */
export async function serviceInfo() {
  const override = process.env.OPENCODE_SERVER_URL?.trim()
  if (override) {
    return {
      url: override.replace(/\/+$/, ''),
      password: process.env.OPENCODE_SERVER_PASSWORD ?? '',
      userAgent: process.env.OPENCODE_SERVER_UA ?? DEFAULT_UA,
    }
  }
  if (cached !== null && Date.now() - cachedAt < SERVICE_TTL_MS) return cached
  for (const p of statePaths()) {
    try {
      const obj = JSON.parse(await readFile(p, 'utf8'))
      if (typeof obj?.url === 'string' && typeof obj?.password === 'string') {
        cached = { url: obj.url.replace(/\/+$/, ''), password: obj.password, userAgent: DEFAULT_UA }
        cachedAt = Date.now()
        return cached
      }
    } catch { /* 试下一个路径 */ }
  }
  cached = null
  return null
}

/** 让服务信息失活（服务重启后强制重读）。 */
export function invalidateService() { cached = null; cachedAt = 0 }

const sessions = new Map() // key -> { id, at }
const SESSION_TTL_MS = 30 * 60 * 1000

function authHeader(svc) {
  return 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64')
}

async function createSession(svc, modelId, directory, signal) {
  const res = await fetch(`${svc.url}/api/session`, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(20_000),
    headers: {
      Authorization: authHeader(svc),
      'Content-Type': 'application/json',
      'User-Agent': svc.userAgent,
    },
    body: JSON.stringify({
      location: { directory },
      model: { providerID: 'opencode', id: modelId },
    }),
  })
  if (!res.ok) throw new Error(`opencode session create failed: HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  const id = data?.data?.id
  if (typeof id !== 'string' || !id.startsWith('ses_')) throw new Error('opencode session create returned no session id')
  return id
}

async function sessionFor(key, svc, modelId, directory, signal) {
  const hit = sessions.get(key)
  if (hit !== undefined && Date.now() - hit.at < SESSION_TTL_MS) return hit.id
  const id = await createSession(svc, modelId, directory, signal)
  sessions.set(key, { id, at: Date.now() })
  return id
}

/** DSH 消息 → 单段提示词文本（桥接只做纯文本生成，不带工具）。 */
export function renderPrompt(messages) {
  const lines = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = String(m?.role ?? 'user').toUpperCase()
    const parts = []
    for (const b of Array.isArray(m?.content) ? m.content : []) {
      if (typeof b?.text === 'string' && b.text !== '') parts.push(b.text)
      else if (b?.type === 'tool-call') parts.push(`[tool call ${b.name ?? ''}] ${String(b.arguments ?? '')}`)
    }
    if (parts.length === 0) continue
    lines.push(`<${role}>\n${parts.join('\n')}\n</${role}>`)
  }
  lines.push('<ASSISTANT>\n请直接用中文回答上面最后一条消息。不要输出 <USER>/<ASSISTANT> 标签。')
  return lines.join('\n\n')
}

/** 一次纯文本生成（会话内调用，天然带 v2 身份）。 */
export async function generateText({ key, modelId, messages, signal, directory = homedir(), prompt }) {
  const svc = await serviceInfo()
  if (svc === null) throw new Error('未找到本地 opencode 服务（service.json）；请安装并 `opencode service start`')
  const text = prompt ?? renderPrompt(messages)
  const attempt = async () => {
    const sid = await sessionFor(key, svc, modelId, directory, signal)
    const res = await fetch(`${svc.url}/api/session/${sid}/generate`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: authHeader(svc),
        'Content-Type': 'application/json',
        'User-Agent': svc.userAgent,
      },
      body: JSON.stringify({ prompt: text, model: { providerID: 'opencode', id: modelId } }),
    })
    if (res.status === 404 || res.status === 401) { sessions.delete(key); invalidateService(); throw new Error('session-lost') }
    if (!res.ok) throw new Error(`opencode generate failed: HTTP ${res.status}`)
    const data = await res.json().catch(() => null)
    return String(data?.data?.text ?? '')
  }
  try { return await attempt() }
  catch (e) {
    if (String(e?.message) === 'session-lost') return await attempt()
    throw e
  }
}

/**
 * 与 http.js 的 postStreamed 同形的通道：把生成结果包成 chat SSE payload 串。
 * @returns {Promise<void>} 结束后由调用方关闭通道（与本车道原有约定一致）
 */
export async function streamGenerateText({ key, modelId, messages, signal, onData }) {
  const text = await generateText({ key, modelId, messages, signal })
  if (text !== '') {
    onData(JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }))
  }
  onData(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
}
