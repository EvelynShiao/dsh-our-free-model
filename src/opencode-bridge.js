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
import net from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 给用户看的失败提示（插件界面/错误里引用）。 */
export const BRIDGE_HINT =
  '需要本机 opencode v2 后台服务：npm i -g @opencode/cli（装好后会按需自动拉起，首次用免费模型多等约 0.5 秒；也可手动 opencode service start）';

/** 服务没跑时的探针说明——按需启动模式下这是正常状态，不是故障。 */
export const BRIDGE_IDLE_HINT =
  '本机 opencode 服务未启动（按需启动：第一次用免费模型时自动拉起，约 0.5 秒；闲置后按设置自动退出）';

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

/* ------------------------------------------------------------------ *
 * 按需启动（2026-10-15）
 *
 * 常驻的 opencode 后台服务要占 145~250 MB 内存，而它自己又没有开机自启，
 * 机器一重启免费车道就整体失效。于是改成：平时不跑，谁要用免费车道就把
 * 它拉起来（真机实测 start → 端口可用约 0.4 秒），代价只是那一轮慢半秒。
 *
 * 探针走 autostart:false，只查不启——否则 15 分钟一轮的自动探测会把服务
 * 变回常驻，"按需"就白做了。
 *
 * 注意：DSH 沙箱下 child_process 必须 stdio:'ignore'（走管道会被 EPERM 拒），
 * 而且要 detached + unref，否则服务会跟着父进程一起退出。
 * ------------------------------------------------------------------ */

const START_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ *
 * 桥接服务行为配置 + 闲置自动退出（2026-10-16）
 *
 * 服务一旦被拉起就常驻（实测工作集 254 MB / 私有 552 MB，用户不想白养）。
 *   - configureBridge({ autostart, idleStopMinutes })：设置页注入，即时生效；
 *     autostart=false 绝不自动拉起；idleStopMinutes=0 不自动关；>0 闲置即收。
 *   - 看门狗在每次真实使用后重排：闲置 N 分钟 → 先查服务上有没有**别人**的
 *     会话在窗口内活动（用户自己在用 opencode 就不能杀），没有才
 *     `opencode service stop`。下次要用由 ensureService 约 0.4 秒拉起。
 * ------------------------------------------------------------------ */

let bridgeConfig = { autostart: true, idleStopMinutes: 10 };

/** 设置页/宿主注入桥接行为；传 {} 只读当前值。即时生效（重排/取消看门狗）。 */
export function configureBridge(next = {}) {
  if (typeof next.autostart === 'boolean') bridgeConfig.autostart = next.autostart;
  if (next.idleStopMinutes !== undefined) {
    const n = Number(next.idleStopMinutes);
    bridgeConfig.idleStopMinutes = Number.isFinite(n) && n >= 0
      ? Math.min(240, Math.trunc(n))
      : (Number.isFinite(bridgeConfig.idleStopMinutes) ? bridgeConfig.idleStopMinutes : 10);
  }
  applyIdlePolicy();
  return { ...bridgeConfig };
}

/** 当前桥接行为（设置页回显用）。 */
export function bridgeConfigNow() {
  return { ...bridgeConfig };
}

let idleTimer = null;
let lastBridgeUseAt = 0;

/** 服务上最近 windowMs 内有没有会话活动——有就是「别人在用」，不能停。 */
async function serviceBusyWithin(svc, windowMs) {
  try {
    const res = await fetch(`${svc.url}/api/session`, { headers: headers(svc), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const doc = await res.json();
    const list = Array.isArray(doc) ? doc : doc?.data ?? [];
    const cutoff = Date.now() - windowMs;
    for (const s of list) {
      const updated = Number(s?.time?.updated ?? s?.time?.created ?? 0);
      if (Number.isFinite(updated) && updated > cutoff) return true;
    }
  } catch { /* 服务已不在/瞬时抖动 → 视为不忙 */ }
  return false;
}

/** 按当前 idleStopMinutes 重排（或取消）闲置计时。 */
function scheduleIdleStop() {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  const waitMs = bridgeConfig.idleStopMinutes * 60_000;
  if (!(waitMs > 0)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void (async () => {
      if (Date.now() - lastBridgeUseAt < waitMs - 1500) { scheduleIdleStop(); return; }
      const svc = readService();
      if (svc === null) return; /* 已经停了，无事可做 */
      if (await serviceBusyWithin(svc, waitMs)) { scheduleIdleStop(); return; }
      const cli = opencodeCli();
      try {
        const child = spawn(cli.file, ['service', 'stop'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: cli.viaShell,
        });
        child.unref();
      } catch { /* 停失败也无害：下次使用时 ensureService 会自己处理 */ }
    })();
  }, waitMs);
  // 看门狗绝不许把 DSH 进程拖住。
  idleTimer.unref?.();
}

/** 每次真实使用桥接时调用：记活跃时刻 + 重排计时。 */
function noteBridgeUse() {
  lastBridgeUseAt = Date.now();
  scheduleIdleStop();
}

/** 配置变化后立即按新策略生效（改成 0 立即取消；改成 >0 立即重排）。 */
function applyIdlePolicy() {
  if (!(bridgeConfig.idleStopMinutes > 0)) {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    return;
  }
  if (lastBridgeUseAt > 0) scheduleIdleStop();
}

/** 找 opencode 可执行文件；都找不到就退回 PATH 里的 `opencode`。 */
function opencodeCli() {
  const home = homedir();
  const candidates = [
    process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter(candidate => candidate !== '');
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return { file: candidate, viaShell: false }; } catch { /* 试下一个 */ }
  }
  return { file: 'opencode', viaShell: true };
}

/** 本机装没装 opencode 客户端——决定「能不能按需拉起」。 */
export function hasOpencodeCli() {
  const cli = opencodeCli();
  if (cli.viaShell === false) return true;
  const separator = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode'];
  for (const dir of String(process.env.PATH ?? '').split(separator)) {
    if (dir === '') continue;
    for (const name of names) {
      try { if (fs.statSync(join(dir, name)).isFile()) return true; } catch { /* 继续找 */ }
    }
  }
  return false;
}

/** 端口通不通——判断服务是否真活着，而不是只看 service.json 还在不在。 */
function portOpen(url, timeoutMs = 700) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve(false); return }
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port) });
    const settle = value => { socket.destroy(); resolve(value) };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

let pendingStart = null;

/**
 * 拿一个**确实活着**的服务连接；不在跑就按需拉起来（幂等，并发只起一次）。
 * @param {{autostart?:boolean}} options autostart:false = 只查不启动（探针用）
 * @returns {Promise<{url:string,password:string}|null>}
 */
export async function ensureService({ autostart = bridgeConfig.autostart } = {}) {
  const current = readService();
  if (current !== null && await portOpen(current.url)) return current;
  if (autostart !== true) return null;
  if (!hasOpencodeCli()) return null;
  if (pendingStart !== null) return pendingStart;
  pendingStart = (async () => {
    const cli = opencodeCli();
    try {
      const child = spawn(cli.file, ['service', 'start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: cli.viaShell,
      });
      child.unref();
    } catch { /* 起不来就走下面的超时分支 */ }
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const svc = readService();
      if (svc !== null && await portOpen(svc.url)) return svc;
    }
    return null;
  })().finally(() => { pendingStart = null });
  return pendingStart;
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
 * 桥接专用 agent 名。
 *
 * 2026-10-16 实锤（「调不动工具」根因）：opencode 服务给每个会话注入自己的系统
 * 提示词 + 一整套原生工具（shell/read/write/execute…）。模型面对「DSH 的文本格式
 * 调用」和「opencode 的原生工具」两头看，经常叛变到原生通道——在 opencode 内部
 * 执行完毕，我们一个字节都看不到，DSH 只收到空文本。
 *
 * 解法：在 ~/.config/opencode/opencode.json 里养一个专用 agent（mute2），
 * 用 tools 开关把危险原生工具砍掉（只留 glob/grep/read 这些无害只读件），
 * 模型没有爪子，只能老老实实按文本格式输出。agent 不存在或配置被删时退回
 * 默认 build——管道仍能用，只是工具协议可能再次失灵（可自愈见 ensurePipeAgent）。
 */
export const BRIDGE_AGENT = 'mute2'

/** mute2 的 agent 配置（写进用户 opencode.json 的形状）。 */
const PIPE_AGENT_CONFIG = {
  description: 'dsh our-free-model bridge: dumb pipe, dangerous tools off',
  mode: 'primary',
  tools: { shell: false, write: false, edit: false, bash: false, webfetch: false, websearch: false, subagent: false, skill: false, execute: false },
  permissions: [{ action: '*', resource: '*', effect: 'allow' }],
}

/**
 * 确保 ~/.config/opencode/opencode.json 里有桥接 agent。
 * 幂等：已存在且配置一致就不动用户文件；存在但形状不对才补写。
 * 失败不抛——agent 缺席时管道退回 build，功能还在。
 */
export function ensurePipeAgent() {
  try {
    const cfgPath = join(homedir(), '.config', 'opencode', 'opencode.json')
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { /* 首次创建 */ }
    const agents = (cfg.agent = cfg.agent && typeof cfg.agent === 'object' ? cfg.agent : {})
    const existing = agents[BRIDGE_AGENT]
    const wanted = JSON.stringify(PIPE_AGENT_CONFIG)
    if (existing !== undefined && JSON.stringify(existing) === wanted) return true
    agents[BRIDGE_AGENT] = PIPE_AGENT_CONFIG
    fs.mkdirSync(join(cfgPath, '..'), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    return true
  } catch { return false }
}

/**
 * 建一个真实会话（走桥接专用 mute2 agent）。
 * @param {{url:string,password:string}} svc
 * @param {string} modelId - zen 模型 id（如 mimo-v2.6-flash-free）
 * @param {string} directory - 工作目录（服务要求一个 location）
 */
export async function createSession(svc, modelId, directory, signal) {
  ensurePipeAgent()
  const res = await fetch(`${svc.url}/api/session`, {
    method: 'POST',
    headers: headers(svc),
    body: JSON.stringify({ agent: BRIDGE_AGENT, location: { directory }, model: { providerID: 'opencode', id: modelId } }),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  let doc = await parseJsonResponse(res, 'opencode 建会话失败');
  let id = doc?.data?.id;
  /* agent 刚写入时服务端注册表可能没热好（实测"Agent not found"一次）：
     退回 build 重试一次，管道保命。 */
  if (res.status === 503 && typeof doc?.message === 'string' && doc.message.includes('Agent not found')) {
    const retry = await fetch(`${svc.url}/api/session`, {
      method: 'POST',
      headers: headers(svc),
      body: JSON.stringify({ agent: 'build', location: { directory }, model: { providerID: 'opencode', id: modelId } }),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    doc = await parseJsonResponse(retry, 'opencode 建会话失败');
    id = doc?.data?.id;
  }
  if (typeof id !== 'string' || !id.startsWith('ses_')) throw new Error('opencode 建会话没有返回会话 id');
  return { id, projectID: doc?.data?.projectID ?? '' };
}

/** 共用的响应解析：非 2xx 抛错，非 JSON 抛错，返回 doc。 */
async function parseJsonResponse(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} 返回非 JSON: ${text.slice(0, 120)}`); }
}

/** 会话内一次性生成文本（免费车道代发）。 */
export async function generateInSession(svc, sessionId, modelId, prompt, signal) {
  const res = await fetch(`${svc.url}/api/session/${encodeURIComponent(sessionId)}/generate`, {
    method: 'POST',
    headers: headers(svc),
    body: JSON.stringify({ prompt }),
    signal: signal ?? AbortSignal.timeout(300000),
  });
  const doc = await parseJsonResponse(res, 'opencode generate 失败');
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
export async function bridgeStream({ modelId, prompt, directory, signal, onDelta, onReasoning, onUsage, autostart = bridgeConfig.autostart }) {
  const id = assertFreeModel(modelId)
  const svc = await ensureService({ autostart })
  if (svc === null) throw new Error(BRIDGE_HINT);
  noteBridgeUse()
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
export async function bridgeGenerate({ modelId, prompt, directory, signal, autostart = bridgeConfig.autostart }) {
  const id = assertFreeModel(modelId);
  const svc = await ensureService({ autostart });
  if (svc === null) throw new Error(BRIDGE_HINT);
  noteBridgeUse()
  const dir = directory ?? process.env.DSH_HOME ?? homedir();
  const session = await createSession(svc, id, dir, signal);
  return generateInSession(svc, session.id, id, prompt, signal);
}
