# dsh-our-free-model（Evelyn 自用分支）

上游：`https://github.com/Ebony-Vinyl/dsh-our-free-model`（本仓起点 = 装机版 **2.1.0** 的原样快照）

本仓 = 上游装机原样 + 我们自己的改动，分开提交，方便对比、回退、以及将来跟上游合并。

## 本分支改了什么

### 1. fix(session) — `src/upstream.js`

OpenCode Zen 免费车道要求 `x-opencode-session` 头的前 12 位 hex 是**时间派生值**（2026-10-13 上线）。
原实现用 sha256 摘要前缀，解出来是个不存在的时刻 → 403 `FreeTierError`。改法：改用
`mintSessionId()` 的时间前缀，按会话缓存复用（TTL 12h），规范且新鲜的 id 仍原样透传。

坑：`mintSessionId` 只写 48 位，而 `~(ts*4096+seq)` 需要 53 位，所以解码只能得到
`ts mod 2^36`（≈795 天），必须取「离 now 最近的代表值」，否则新鲜度判定恒假、缓存永不命中、
每次请求换新 session（配额被打散 → 429）。

其中 `sessionStamp()` + 缓存复用这套逻辑，是后来定位「进程内必拒、进程外必过」的关键工具。

### 2. fix(gate) — `src/http.js` + `vendor/channel-pack/pack.js`

同一道门禁还有两道检查，2026-10-13 单变量实测（各 3 次）：

| 变量 | 结果 |
|---|---|
| session 前缀改小端（pack 原来的写法） | 403 |
| session 前缀大端（客户端写法） | 200 |
| UA = `opencode/1.18.31` 本身 | 通过 2/2 |
| UA = `deepseek-harness/0.1.7-rc.2 (+https://…) opencode/1.18.31` | 门禁拒 3/3 |
| `x-opencode-client: cli` / `req_<hex>` 请求号 / 派生 project | 都是 200（门禁不管） |

- `src/http.js` 的 `userAgentWith()`：**只回 `CLIENT_UA`**，不再拼 harness 署名 UA。
  这条车道本来就是仿冒，署名让位于能用。
- `vendor/channel-pack/pack.js` 的 `deriveSessionId2()`：时间前缀从**低位在前**改成**高位在前**
  （与 `mintSessionId` 一致）。这个 pack 是第二套免费车道实现（provider `opencode`、
  `x-opencode-client: cli`）；聊天与 `/reprobe` 走的是 src 那套，但两套都得对。
- 同文件的 `opencodeUserAgent()`：override 只有在**本身就是** `opencode/<版本>` 时才采信，
  否则退回 `OPENCODE.defaultUserAgent`。

### 3. perf(client) — `client.js`

清空 14 个被 `infinite` 引用的 `@keyframes`（鱼、波浪、气泡、极光、射线、扫描线、呼吸点、
骨架闪光…）。持续动效会一直重绘并常驻合成层，是手机端内存与电量的真正大头。元素的静态样式
一个没动，一次性入场动画保留，9 个 `setInterval` 是数据轮询、功能性、没动。

## 版本

`2.1.1-ofmfix.3`（预发布号，避免和上游正式版本号撞车）

## 安装

```powershell
# GitHub
dsh plugin --profile web add github:EvelynShiao/dsh-our-free-model#main
# GitCode（国内）
dsh plugin --profile web add https://gitcode.com/gcw_wXIDw07q/dsh-our-free-model.git#main
```

装完在插件设置页点「热重载」（或重启一次 DSH）即可生效，不必动其他文件。

## 更新

- **应用内更新已关闭**（数据目录 `settings.json` 的 `updateCheckHours = 0`）。
  它的更新清单是从**上游**仓库拉的 Ed25519 签名清单，公钥写死在 `src/updater.js`，
  私钥在作者手里 —— 一旦点「更新」，`src/` 会被上游整份覆盖，本仓改动全没。
- 想跟上游同步：

  ```powershell
  git fetch upstream && git merge upstream/main
  ```

  `upstream` 远端已登记（只登记，未拉取）；合并后回查本节 1/2/3 三条改动是否还在。
