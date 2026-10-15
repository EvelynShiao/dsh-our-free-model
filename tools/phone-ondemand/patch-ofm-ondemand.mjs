#!/usr/bin/env node
/**
 * patch-ofm-ondemand.mjs —— 给 dsh-our-free-model 打「opencode 服务按需启动」补丁。
 *
 * 为什么不用哈希守卫：PC 与手机的插件版本可能不同（PC 上就刚见过 9999.9.11→.12
 * 与 adapter.js 哈希变化），按哈希硬认会直接拒绝。这里改成**按锚点精确匹配**：
 * 每个改点都先确认锚点唯一存在，再替换；对不上就拒绝，绝不改坏。
 *
 * 幂等：已经打过（能见到标记）就直接报「已打过」并退出。
 * 安全：改前自动备份到 <插件目录>/.ondemand-backup-<时间戳>/。
 *
 * 用法（手机上跑）：
 *   node patch-ofm-ondemand.mjs            # 干跑，只报告不修改
 *   node patch-ofm-ondemand.mjs --apply    # 真的写入
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');

/** 插件 src 目录：优先命令行给的，其次按常见位置找。 */
function findSrcDir() {
  const fromArgv = process.argv.slice(2).find(a => !a.startsWith('--'));
  const candidates = [
    fromArgv,
    process.env.OFM_PLUGIN_DIR,
    path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? '/root', '.dsh'),
      'profiles', 'web', 'node_modules', 'dsh-our-free-model', 'src'),
    path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? '/root', '.dsh'),
      'plugin-src', 'dsh-our-free-model', 'src'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch { /* 试下一个 */ }
  }
  return null;
}

const srcDir = findSrcDir();
if (srcDir === null) {
  console.error('找不到插件 src 目录。请手动指定：node patch-ofm-ondemand.mjs /root/.dsh/profiles/web/node_modules/dsh-our-free-model/src --apply');
  process.exit(1);
}
console.log('[插件 src]', srcDir);

const backupDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backups', `ondemand-${Date.now()}`);

const MARKERS = {
  'opencode-bridge.js': ['ensureService', 'hasOpencodeCli', 'BRIDGE_IDLE_HINT'],
  'adapter.js': ['hasOpencodeCli'],
  'probe.js': ['BRIDGE_IDLE_HINT'],
};

/** 每个文件：一组 [锚点, 替换] 规则。锚点必须出现且仅出现一次。 */
const PATCHES = {
  'opencode-bridge.js': [
    {
      // 1) imports：加 net / spawn
      find: "import fs from 'node:fs';\nimport { join } from 'node:path';",
      replace: "import fs from 'node:fs';\nimport net from 'node:net';\nimport { spawn } from 'node:child_process';\nimport { join } from 'node:path';",
    },
    {
      // 2) 新增 BRIDGE_IDLE_HINT（跟在 BRIDGE_HINT 定义之后）
      find: "const UA_FALLBACK = 'opencode/latest/",
      replace: "/** 服务没跑时的探针说明——按需启动模式下这是正常状态，不是故障。 */\nexport const BRIDGE_IDLE_HINT =\n  '本机 opencode 服务未启动（按需启动：第一次用免费模型时自动拉起，约 0.5 秒）';\n\nconst UA_FALLBACK = 'opencode/latest/",
    },
    {
      // 3) 在 readService 之后插入按需启动三件套
      find: "  return null;\n}\n\n/** 服务是否可用（不抛错，供设置页/探针显示）。 */",
      replace: `  return null;
}

/* ------------------------------------------------------------------ *
 * 按需启动 —— 常驻的 opencode 服务要占 145~250 MB，平时不跑，谁要用
 * 免费车道就把它拉起来（实测 start → 端口可用约 0.4 秒）。
 *
 * 探针走 autostart:false，只查不启——否则 15 分钟一轮的自动探测会把
 * 服务变回常驻，"按需"就白做了。
 *
 * 注意：DSH 沙箱下 child_process 必须 stdio:'ignore'（走管道会被 EPERM
 * 拒），而且要 detached + unref，否则服务会跟着父进程一起退出。
 * ------------------------------------------------------------------ */

const START_TIMEOUT_MS = 10_000;

/** 找 opencode 可执行文件；都找不到就退回 PATH 里的 \`opencode\`。 */
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
export async function ensureService({ autostart = true } = {}) {
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

/** 服务是否可用（不抛错，供设置页/探针显示）。 */`,
    },
    {
      // 4) bridgeStream 改为按需
      find: "export async function bridgeStream({ modelId, prompt, directory, signal, onDelta, onReasoning, onUsage }) {\n  const id = assertFreeModel(modelId)\n  const svc = readService()",
      replace: "export async function bridgeStream({ modelId, prompt, directory, signal, onDelta, onReasoning, onUsage, autostart = true }) {\n  const id = assertFreeModel(modelId)\n  const svc = await ensureService({ autostart })",
    },
    {
      // 5) bridgeGenerate 改为按需
      find: "export async function bridgeGenerate({ modelId, prompt, directory, signal }) {\n  const id = assertFreeModel(modelId);\n  const svc = readService();",
      replace: "export async function bridgeGenerate({ modelId, prompt, directory, signal, autostart = true }) {\n  const id = assertFreeModel(modelId);\n  const svc = await ensureService({ autostart });",
    },
  ],

  'adapter.js': [
    {
      find: "import { bridgeStream, readService, BRIDGE_HINT } from './opencode-bridge.js'",
      replace: "import { bridgeStream, readService, hasOpencodeCli, BRIDGE_HINT } from './opencode-bridge.js'",
    },
    {
      find: "if (readService() === null) {",
      replace: "if (readService() === null && !hasOpencodeCli()) {",
    },
  ],

  'probe.js': [
    {
      find: "import { bridgeGenerate, readService } from './opencode-bridge.js'",
      replace: "import { bridgeGenerate, readService, hasOpencodeCli, BRIDGE_IDLE_HINT } from './opencode-bridge.js'",
    },
    {
      // 只查不启：服务没跑且装了客户端时，直接报 unknown，别去拉起服务。
      // 锚点取最短的两行（中间不夹注释），避免上游在注释上改动就失配。
      find: "  if (readService() !== null) {\n    try {\n      await bridgeGenerate({ modelId: model.id, prompt: 'ping', signal })",
      replace: "  if (readService() === null && hasOpencodeCli()) {\n    return { state: STATE.unknown, detail: BRIDGE_IDLE_HINT, latencyMs: Date.now() - started }\n  }\n  if (readService() !== null) {\n    try {\n      await bridgeGenerate({ modelId: model.id, prompt: 'ping', signal, autostart: false })",
    },
  ],
};

/** 出现次数统计（用于「锚点唯一」校验）。 */
function count(haystack, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) break;
    n += 1;
    i = at + needle.length;
  }
  return n;
}

/**
 * 行尾归一化后再找锚点。
 *
 * 为什么必须做：PC 上那份是 CRLF（autocrlf 历史遗留），手机那份多半是 LF。
 * 脚本里的锚点按 \n 写，直接 indexOf 在 CRLF 文件上永远失配——这不是版本不同，
 * 只是行尾不同，不该因此拒绝（也不该误判成「已打过」）。
 */
function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

let planned = 0;
let skipped = 0;
let refused = 0;
const writes = [];

for (const [name, rules] of Object.entries(PATCHES)) {
  const file = path.join(srcDir, name);
  if (!fs.existsSync(file)) {
    console.log(`[缺失] ${name}`);
    refused += 1;
    continue;
  }
  const rawBefore = fs.readFileSync(file, 'utf8');
  const usesCrlf = rawBefore.includes('\r\n');
  const before = normalizeEol(rawBefore);

  // 幂等检查（同样在归一化文本上做）
  const markers = MARKERS[name] ?? [];
  const required = {
    'opencode-bridge.js': ['export async function ensureService(', 'export function hasOpencodeCli(', 'const svc = await ensureService({ autostart })'],
    'adapter.js': ['if (readService() === null && !hasOpencodeCli()) {', 'import { bridgeStream, readService, hasOpencodeCli, BRIDGE_HINT }'],
    'probe.js': ['if (readService() === null && hasOpencodeCli()) {', 'autostart: false', 'detail: BRIDGE_IDLE_HINT'],
  }[name];
  const already = required.every(m => before.includes(m)) && (name !== 'opencode-bridge.js' || count(before, 'const svc = await ensureService({ autostart })') === 2);
  if (already) {
    console.log(`[已打过] ${name}`);
    skipped += 1;
    continue;
  }
  if (markers.some(m => before.includes(m))) {
    console.log(`[半打过] ${name} —— 只认得一部分标记，为避免改坏，跳过。请人工看。`);
    refused += 1;
    continue;
  }

  let after = before;
  let ruleFailed = null;
  for (const rule of rules) {
    const hits = count(after, rule.find);
    if (hits !== 1) {
      ruleFailed = `锚点出现 ${hits} 次（应为 1 次）：${rule.find.slice(0, 60).replace(/\n/g, '⏎')}…`;
      break;
    }
    after = after.replace(rule.find, rule.replace);
  }
  if (ruleFailed !== null) {
    console.log(`[拒绝] ${name} —— ${ruleFailed}`);
    console.log('        说明这份与 PC 版本不同，需要人工对一遍，不能盲打。');
    refused += 1;
    continue;
  }

  // 还原原来的行尾——只改该改的行，不把整个文件的行尾换掉（否则 git diff 会炸）
  const out = usesCrlf ? after.replace(/\n/g, '\r\n') : after;

  console.log(`[待打] ${name}  ${rawBefore.length} -> ${out.length} 字节  (${usesCrlf ? 'CRLF' : 'LF'})`);
  planned += 1;
  writes.push({ file, out, rawBefore });
}

console.log('');
if (refused > 0) {
  console.log(`==> 有 ${refused} 个文件没能处理，先别继续。`);
  process.exitCode = 2;
} else if (planned === 0) {
  console.log('==> 三处改动都在，不用做什么。');
} else if (!APPLY) {
  console.log(`==> 干跑完成：可以打 ${planned} 个文件。加 --apply 真正写入。`);
} else {
  // 先验证全部候选；不在插件目录创建临时源码。
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-check-'));
  try {
    for (const { file, out, rawBefore } of writes) {
      if (fs.readFileSync(file, 'utf8') !== rawBefore) throw new Error(`并发修改：${file}`);
      const checkFile = path.join(scratch, path.basename(file) + '.mjs');
      fs.writeFileSync(checkFile, out);
      const check = spawnSync(process.execPath, ['--check', checkFile], { stdio: 'inherit' });
      if (check.error || check.status !== 0) throw new Error(`语法检查失败：${file}`);
    }
    fs.mkdirSync(backupDir, { recursive: true });
    // 所有备份先成功，再写任何一个目标文件。
    for (const { file } of writes) fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
    try {
      for (const { file, out } of writes) fs.writeFileSync(file, out);
    } catch (error) {
      for (const { file, rawBefore } of writes) fs.writeFileSync(file, rawBefore);
      throw error;
    }
    console.log(`备份在 ${backupDir}`);
    console.log('==> 已应用。重启 DSH 才加载新代码；本脚本不启动 OpenCode 服务。');
  } finally {
    // scratch 是本次 mkdtemp 创建的绝对目录，仅清理它。
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
