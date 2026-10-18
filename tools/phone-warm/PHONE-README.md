# 手机补丁包：切到免费模型即预热本机 opencode 服务

对应提交：`36c9a9e feat(bridge): 切到免费模型即预热本机 opencode 服务`
打包时间：2026-10-18

## 这个补丁解决什么

以前只有在**发消息**时才会去拉起本机 opencode 服务。你在下拉里选完免费模型、
到真正发出请求之间那段空窗，服务一直是停的。跨夜或闲置后第一次切换模型，这一轮
会先撞一次 `BRIDGE_FAILED` / `fetch failed`，看起来就像「一选这个模型就断线」。

装上之后：**选模型的那一刻**就把服务拉起来（实测冷启动约 0.5s），等你敲完第一句话
再发出去，服务早就好了。

## 手机上怎么装

把本目录整个传到手机（adb push / 文件管理器 / 任意方式），在手机里进到这个目录：

```bash
bash phone-warm-setup.sh          # 先干跑，只报告不改文件
bash phone-warm-setup.sh --apply  # 确认后真正安装
```

脚本会：

1. 检查插件目录、Node、5 个源文件是否齐全，缺一个就停手；
2. 把要被覆盖的文件备份到 `<插件目录>/.warm-patch-backup-<时间戳>/`；
3. 覆盖 5 个文件；
4. 逐个 `node --check` 做语法校验 + 检查关键锚点，**任何一步失败自动全量回滚**；
5. 报告当前 `idleStopMinutes`，如果是 `1` 或 `0` 会提示你改。

装完**重启手机 DSH** 生效。

## 手机没装 opencode 会怎样

不会有任何副作用。预热逻辑在检测不到本地服务时会直接返回 `null`，不报错、
不启动进程、不占内存，行为跟打补丁之前完全一样。

手机上真要跑免费车道，还是得先按《手机接免费车道清单》把 `@opencode/cli` 装上。

## 一定要顺手检查的一项

`idleStopMinutes` 如果是 `1`，**预热会被它抵消**——服务起来一分钟又收回去，
你切完模型去倒杯水回来发消息，照样失败。建议设成 `10`。

改法：DSH 设置 → our free model → 闲置自动关闭，填 `10`。

## 包里是什么

| 文件 | 作用 |
|---|---|
| `index.js` | 新增 `model/selection` 监听器，切到 `*-free` 模型即 `ensureService` |
| `src/opencode-bridge.js` | `configureBridge` + 按需启动 + 闲置看门狗（此前未入库，缺它插件加载失败） |
| `src/adapter.js` | bridge 失败分支补日志：耗时 / service.json / CLI / aborted / reason |
| `src/store.js` | `bridge` 设置的默认值 `{ autostart: true, idleStopMinutes: 10 }` |
| `client.js` | 设置页的「使用时自动拉起」「闲置自动关闭」两个控件 |
| `phone-warm-setup.sh` | 安装脚本（备份 / 覆盖 / 校验 / 回滚） |

## 怎么确认真的生效了

重启 DSH 后，在手机上把模型切到一个 `-free` 结尾的，然后看服务状态：

```bash
opencode service status
```

看到一行 `http://127.0.0.1:xxxxx` 就说明预热在跑（如果原本是停的）。

PC 端还可以看日志里有没有这条失败记录：

```
our-free-model: bridge 失败 model=... elapsedMs=... service=... cli=... aborted=... reason=...
```

## 回滚

```bash
cp -p <插件目录>/.warm-patch-backup-<时间戳>/index.js <插件目录>/index.js
cp -p <插件目录>/.warm-patch-backup-<时间戳>/src/*.js <插件目录>/src/
```

然后重启 DSH。
