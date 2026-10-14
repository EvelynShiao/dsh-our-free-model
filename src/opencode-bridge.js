/**
 * opencode-bridge —— OpenCode v2 免费车道的**合法通道**。
 *
 * # 为什么需要它（2026-10-14 实锤）
 *
 * OpenCode v2 的 zen 网关改为校验「`x-opencode-session` 必须是服务端注册过的
 * 真实会话」。任何伪造的会话/身份（不管 UA 写什么版本、四个 session 头齐发、
 * project 带真值）都一律 `403 FreeTierError`。作者 2.2.0 也没跟上。
 *
 * 唯一可行解：**借本机真实 opencode 客户端的后台服务代发**——它是真客户端，
 * 身份天然合法。协议（本机 v2.0.29 实测）：
 *
 *   服务连接信息：%USERPROFILE%\.local\state\opencode\service.json（url + password）
 *                ~/.config/opencode/service.json（只有 password，备胎）
 *                macOS: ~/Library/Application Support/opencode/service.json
 *   Basic 鉴权：  base64("opencode:<password>")
 *   UA：         opencode/latest/<版本>/cli
 *   建会话：      POST {url}/api/session
 *                {location:{directory}, model:{providerID:'opencode', id:'<模型id>'}}
 *                → {data:{id:'ses_…', projectID}}
 *   生成文本：    POST {url}/api/session/{sid}/generate {prompt, model}
 *                → {data:{text}}      ← 无工具、无流式、一次性纯文本
 *
 * 反例（实测）：不带会话的 `/api/experimental/generate` 一样 503 门禁，
 * 所以必须走「会话内」调用。
 *
 * @module src/opencode-bridge.js
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 给用户看的失败提示（插件界面/错误里引用）。 */
export const BRIDGE_HINT =
  '需要本机 opencode v2 后台服务：npm i -g @opencode/cli && opencode service start（免费车道走它代发）';

const UA_FALLBACK = 'opencode/latest/2.0.29/cli';

/** service.json 的候选路径（按平台）。 */
function serviceCandidates() {
  const home = homedir();
  const out = [];
  if (process.platform === 'darwin') {
    out.push(join(home, 'Library', 'Application Support', 'opencode', 'service.json'));
  }
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) out.push(join(xdg, 'opencode', 'service.json'));
  // Linux 默认 + Windows（opencode 在 Windows 也用 ~/.local/state）
  out.push(join(home, '.local', 'state', 'opencode', 'service.json'));
  out.push(join(home, '.config', 'opencode', 'service.json'));
  return out;
}

/**
 * 读本地 opencode 服务的连接信息。
 * @returns {{url:string, password:string}|null} url 形如 http://127.0.0.1:49374
 */
export function readService() {
  const override = process.env.OPENCODE_SERVER_URL?.trim();
  if (override) {
    return { url: override.replace(/\/+$/, ''), password: process.env.OPENCODE_SERVER_PASSWORD ?? '' };
  }
  for (const p of serviceCandidates()) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof j?.url === 'string' && j.url.length > 0) {
        return { url: j.url.replace(/\/+$/, ''), password: String(j?.password ?? '') };
      }
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 服务是否可用（不抛错，供设置页/探针显示）。 */
export async function bridgeStatus(signal) {
  const svc = readService();
  if (svc === null) return { ok: false, reason: 'no-service-json', hint: BRIDGE_HINT };
  try {
    const res = await fetch(`${svc.url}/api/info`, { headers: headers(svc), signal });
    if (!res.ok) return { ok: false, reason: `info HTTP ${res.status}`, url: svc.url, hint: BRIDGE_HINT };
    const info = await res.json().catch(() => null);
    return { ok: true, url: svc.url, version: info?.version ?? '' };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), url: svc.url, hint: BRIDGE_HINT };
  }
}

function headers(svc) {
  const auth = 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64');
  return {
    Authorization: auth,
    'Content-Type': 'application/json',
    'User-Agent': UA_FALLBACK,
    Accept: 'application/json',
  };
}

/**
 * 建一个真实会话。
 * @param {{url:string,password:string}} svc
 * @param {string} modelId - zen 模型 id（如 mimo-v2.6-flash-free）
 * @param {string} directory - 工作目录（服务要求一个 location）
 */
export async function createSession(svc, modelId, directory, signal) {
  const res = await fetch(`${svc.url}/api/session`, {
    method: 'POST',
    headers: headers(svc),
    body: JSON.stringify({ location: { directory }, model: { providerID: 'opencode', id: modelId } }),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`opencode 建会话失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error(`opencode 建会话返回非 JSON: ${text.slice(0, 120)}`); }
  const id = doc?.data?.id;
  if (typeof id !== 'string' || !id.startsWith('ses_')) throw new Error('opencode 建会话没有返回会话 id');
  return { id, projectID: doc?.data?.projectID ?? '' };
}

/** 会话内一次性生成文本（免费车道代发）。 */
export async function generateInSession(svc, sessionId, modelId, prompt, signal) {
  const res = await fetch(`${svc.url}/api/session/${encodeURIComponent(sessionId)}/generate`, {
    method: 'POST',
    headers: headers(svc),
    body: JSON.stringify({ prompt, model: { providerID: 'opencode', id: modelId } }),
    signal: signal ?? AbortSignal.timeout(300000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`opencode generate 失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error(`opencode generate 返回非 JSON: ${text.slice(0, 120)}`); }
  const out = doc?.data?.text;
  if (typeof out !== 'string') throw new Error('opencode generate 没有返回文本');
  return out;
}

/** 免费档模型 id 的形状：zen 的免费车道全部带 `-free` 后缀。 */
export const FREE_MODEL_RE = /-free$/i;

/**
 * 硬闸：这条桥**只准放行免费档模型**。
 *
 * 走的是用户本机 opencode（匿名、无账号），但万一哪天插件把付费档 id 送进来，
 * 那就会真的产生账单。宁可直接拒绝，也不给"意外花钱"留口子。
 */
export function assertFreeModel(modelId) {
  if (typeof modelId !== 'string' || !FREE_MODEL_RE.test(modelId.trim())) {
    throw new Error(`本地 opencode 代发通道只服务免费档模型（id 需以 -free 结尾），拒绝：${String(modelId)}`);
  }
  return modelId.trim();
}

/**
 * 流式版：建会话 → 订阅 /api/event → 发 prompt → 逐字回调 → 执行结束返回全文。
 *
 * 事件形状（v2.0.29 实测）：
 *   session.text.delta      {sessionID, assistantMessageID, ordinal, delta:"…"}
 *   session.reasoning.delta {…, delta:"…"}
 *   session.text.ended      {…, text:"完整文本"}
 *   session.step.ended      {…, finish, cost, tokens:{input,output,reasoning}}
 *   session.execution.succeeded / .failed   ← 收尾信号
 *
 * @param {{modelId:string, prompt:string, directory?:string, signal?:AbortSignal,
 *          onDelta?:(delta:string, full:string)=>void,
 *          onReasoning?:(delta:string, full:string)=>void,
 *          onUsage?:(tokens:object)=>void}} options
 * @returns {Promise<string>} 全文
 */
export async function bridgeStream({ modelId, prompt, directory, signal, onDelta, onReasoning, onUsage }) {
  const id = assertFreeModel(modelId)
  const svc = readService()
  if (svc === null) throw new Error(BRIDGE_HINT);
  const dir = directory ?? process.env.DSH_HOME ?? homedir();
  const session = await createSession(svc, id, dir, signal);

  const ac = new AbortController();
  const onOuter = () => ac.abort(signal?.reason);
  if (signal?.aborted === true) onOuter(); else signal?.addEventListener('abort', onOuter, { once: true });

  let full = '';
  let reasoning = '';
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });

  /* 事件订阅（失败即让本次调用失败，绝不静默卡住） */
  const sub = await fetch(`${svc.url}/api/event`, {
    headers: { ...headers(svc), Accept: 'text/event-stream' },
    signal: ac.signal,
  });
  if (!sub.ok || sub.body === null) throw new Error(`opencode 事件流打不开 HTTP ${sub.status}`);
  const reader = sub.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done === true) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '') continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          const data = event?.data ?? {};
          if (data.sessionID !== session.id) continue;
          if (event.type === 'session.text.delta' && typeof data.delta === 'string') {
            full += data.delta;
            onDelta?.(data.delta, full);
          } else if (event.type === 'session.reasoning.delta' && typeof data.delta === 'string') {
            reasoning += data.delta;
            onReasoning?.(data.delta, reasoning);
          } else if (event.type === 'session.step.ended') {
            if (data.tokens !== undefined) onUsage?.(data.tokens);
          } else if (event.type === 'session.execution.succeeded') {
            settle.resolve(full); return;
          } else if (event.type === 'session.execution.failed' || event.type === 'session.execution.errored') {
            settle.reject(new Error(String(data?.error?.message ?? 'opencode 会话执行失败'))); return;
          }
        }
      }
      settle.resolve(full);
    } catch (error) {
      settle.reject(error);
    }
  })();

  const guard = setTimeout(() => settle.reject(new Error('本地 opencode 会话超过 300 秒未结束')), 300000);
  try {
    const res = await fetch(`${svc.url}/api/session/${encodeURIComponent(session.id)}/prompt`, {
      method: 'POST',
      headers: headers(svc),
      body: JSON.stringify({ text: prompt }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`opencode 发消息失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await finished;
  } finally {
    clearTimeout(guard);
    ac.abort();
    signal?.removeEventListener('abort', onOuter);
  }
}

/**
 * 一步到位：建会话 → 生成 → 回收会话。
 * 每次请求一个新会话（本地调用，零成本），避免上下文累积/串味。
 * @param {{modelId:string, prompt:string, directory?:string, signal?:AbortSignal}} options
 * @returns {Promise<string>} 模型输出文本
 */
export async function bridgeGenerate({ modelId, prompt, directory, signal }) {
  const id = assertFreeModel(modelId);
  const svc = readService();
  if (svc === null) throw new Error(BRIDGE_HINT);
  const dir = directory ?? process.env.DSH_HOME ?? homedir();
  const session = await createSession(svc, id, dir, signal);
  return generateInSession(svc, session.id, id, prompt, signal);
}
