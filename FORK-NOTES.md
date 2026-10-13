# dsh-our-free-model（Evelyn 自用分支）

上游：`https://github.com/Ebony-Vinyl/dsh-our-free-model`（本仓起点 = 装机版 **2.1.0** 的原样快照）

本仓 = 上游装机原样 + 我们自己的改动，分开提交，方便对比、回退、以及将来跟上游合并。

## 本分支改了什么

1. **fix(session)** — `src/upstream.js` 的 `sessionForConversation()`
   OpenCode Zen 从 2026-10-13 起要求 session id 的头 12 位 hex 能解出时间戳。原实现用的是
   sha256 摘要前缀，解出来是个不存在的时刻，于是聊天（`adapter.js:338`）、目录
   （`core/runtime.js:242`）、探测（`probe.js:51`）三处全被 403 `FreeTierError` 拒收，
   界面上整个免费车道显示「不可用」。
   改法：改用 `mintSessionId()` 的时间前缀，按会话缓存复用（TTL 12h，过期重铸），
   规范且新鲜的 id 仍原样透传。
   注意 `mintSessionId` 只写 48 位，而 `~(ts*4096+seq)` 需要 53 位，所以解码只能得到
   `ts mod 2^36`（≈795 天），必须取「离 now 最近的代表值」，否则新鲜度判定恒假、
   缓存永不命中、每次请求换新 session（配额被打散 → 429）。

2. **perf(client)** — `client.js`
   清空 14 个被 `infinite` 引用的 `@keyframes`（鱼、波浪、气泡、极光、射线、扫描线、
   呼吸点、骨架闪光…）。持续动效会一直重绘并常驻合成层，是手机端内存与电量的真正大头。
   元素的静态样式一个没动，一次性入场动画（fadein/popin/toast-rise/pagein/risein/
   pl5-tick/swimrev 之外的）保留。9 个 `setInterval` 是数据轮询，功能性，没动。
   覆盖两种写法：`animation:` 简写与分开写的 `animation-name:`（鱼 f2 用后者）。

## 版本

`2.1.1-ofmfix.2`（预发布号，避免和上游的正式版本号撞车）

## 安装

```powershell
# GitHub
dsh plugin --profile web add github:EvelynShiao/dsh-our-free-model#main
# GitCode（国内）
dsh plugin --profile web add https://gitcode.com/gcw_wXIDw07q/dsh-our-free-model.git#main
```

## 更新

- **应用内更新已关闭**（数据目录 `settings.json` 的 `updateCheckHours = 0`）。
  它的更新清单是从**上游**仓库拉的 Ed25519 签名清单，公钥写死在 `src/updater.js`，
  私钥在作者手里 —— 一旦点「更新」，`src/` 会被上游整份覆盖，本仓改动全没。
- 想跟上游同步：

  ```powershell
  git fetch upstream
  git merge upstream/main
  ```

  `upstream` 远端已登记（只登记，未拉取）；合并后重新检查本文件第 1、2 条的改动是否还在。
