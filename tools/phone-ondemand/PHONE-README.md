# 手机部署包：已安装插件的按需启动补丁

目标环境：用户回报 aarch64 / Ubuntu 24.04.3 / glibc 2.39 / Node 24.19.0。此组合匹配 Linux ARM64 构建方向，但不替代手机真实运行验收。

## 使用
将本目录中的 `phone-setup.sh`、`patch-ofm-ondemand.mjs`、`phone-verify.mjs` 放到手机同一个目录，在该目录执行：

```bash
bash phone-setup.sh
```

脚本先检查本机已安装的 OpenCode 和 OFM 插件，不下载、不添加开机自启、不启动后台服务。若缺 OpenCode，会明确 BLOCKED 并停止；它不是自动安装 OpenCode 的脚本。

成功后重启手机 DSH，再执行：

```bash
node phone-verify.mjs
```

这是只查不启。要验证一次真实请求（会启动服务并发送最短提示）：

```bash
node phone-verify.mjs --chat
```

测试后不需要服务时：

```bash
opencode service stop
```

## 边界
- 按需启动 ≠ 用完自动退出。首次使用后，服务仍会驻留，直到手动停止或系统结束它。没有实现空闲自动停止。
- 定时探针不启动服务；未启动时模型可显示 unknown，但不因此从可选列表消失。
- 备份写到补丁器所在目录的 backups/，在 node_modules 之外。保留备份以便人工回滚。
- 只修改锚点匹配的已安装文件；不整文件覆盖，保留额外修改（例如 adapter 输出 token 上限修复）。拒绝不认识或半修复的版本。
- 此包已通过电脑隔离副本 LF/CRLF、额外功能保留、重复执行、失败不写入检查；并不表示手机实机已经通过。
- 本目录随仓库发布，不包含账号令牌。
