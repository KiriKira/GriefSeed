# GriefSeed

Cloudflare Workers + SQLite Durable Objects 版 SoulGem：同一个部署提供单 owner 节点和 Cloudflare TURN 来源。
当前实现位于待审 PR，尚未发布。设计见 [PLAN.md](PLAN.md)、[节点设计](docs/node-design.md) 和 [控制协议](docs/worker-protocol.md)。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/KiriKira/GriefSeed)

按钮使用主线，须先合入本批实现。需要 Cloudflare 账号、Realtime TURN key 和对应 API token；是否需要付款方式以实际账号为准。

1. 下载并在本地浏览器打开 [setup.html](setup.html)，生成首次配置并妥善保存。该页面不访问网络。
2. 在部署表单的 secrets 中填写 `DEPLOYMENT_ID`、`TOKEN_KEYS`、`ADMIN_PASSWORD`、`TURN_KEY_ID`、`TURN_API_TOKEN`。
   前三项使用生成值，后两项来自 Realtime TURN。Cloudflare API 凭据始终保留在 Worker，不进入手机。
3. Wrangler 创建固定名称 `deployment` 的 SQLite DO；无需 D1。`NODE_ENABLED=true` 默认开启节点，设为 false 可仅提供 TURN 来源。
4. 登录部署地址的管理页：生成一个加入码，让 Homura、Madoka 各扫码一次；同一码每个角色只能兑换一次，15 分钟有效。
   现有节点的用户也可发放独立来源 token，在手机“中继来源”设置里导入 `mahogsm://relay` 链接。
5. 选用推送时，将 `PUSH_ALLOWED_HOSTS` 设为手机所用 Kyubey 服务的精确 HTTPS 主机名，逗号分隔。
   默认不发推送；控制 WebSocket 与周期恢复仍可工作。没有声明推送能力时，手机不会误判已覆盖推送。

管理页能发放/吊销来源 token、显示签发及撤销任务、撤销设备、查看设备操作计数、下载和恢复备份。
链接与二维码只在生成时显示，服务端保存 token 哈希。来源 token 与节点会话分离，不能用于读取短信或控制通话。
凭据 TTL 默认 24 小时，可设 `CREDENTIAL_TTL=60..86400`；端口 53 仅在 Cloudflare 适配器中过滤。

## 手机兼容与状态

新手机协商 `rtc_control_ws_v1`、`client_ping_v1` 和 `cold_standby_v1`；旧手机继续使用 HTTP 与原 wake-only `/v1/ws`。
每条控制消息重新核验会话和持久化 deadline。协议 ping 不续业务租约；活动呼叫仍每 5 秒续租，失联 20 秒按安全状态处理。
已下拨的呼叫进入 unknown 后保留占用，直到网关确认蜂窝结束；短信未知执行结果不会被重新排队发送。

一个部署只有一个 owner。短信明文只属于部署者；这不是多用户公共节点。收发短信、SIM 两阶段映射、事件幂等账本、
RTC 媒体授权、Reception v2、双主机赢家和全局拒接都使用同一 SQLite 事务边界。

## 升级、密钥与恢复

按钮复制仓库，不自动跟随上游；在自己的复制仓库中合入已审阅上游提交，再由 Workers Builds 部署。
升级保留 `DEPLOYMENT_ID`、完整 `TOKEN_KEYS` 密钥环、DO 类/固定名称、migration tag 和已有数据；不要重新生成首次配置。
未知 schema 版本拒绝启动。重新部署不清空会话、token、消息或去重记录。

正常轮换先向 `TOKEN_KEYS` 增加新 kid，再切换 `TOKEN_KID`；保留旧验证密钥直到换发完成。
紧急移除旧 kid 会拒绝其签名，但已有 TURN allocation 仍须通过管理页撤销任务处理。
旧 TURN key 的撤销任务需要 API token 仍有权限；确认完成后再撤销旧权限。

备份含短信明文、哈希和去重记录，不含 Worker secrets；请在安全位置与 secrets 配套保存。
当前管理页备份上限 4 MiB/20,000 行，超限明确拒绝；更大的部署需使用 Cloudflare 支持的数据库导出工具。
灾难恢复要求确认，会撤销所有旧会话和来源 token，将未完成命令隔离为 unknown、关闭旧媒体/呼叫并清空推送任务。
保留幂等 tombstone；恢复不会自动重发短信。需重新配对、确认 SIM 和发放来源 token。

## 开发与验证

Node.js 24：`npm ci`、`npm run schemas`、`npm run check`、`npm test`。
本地用 `.dev.vars.example` 配置 `npm run dev`；勿使用生产密钥测试。
[协议来源清单](protocol/provenance.json) 固定 SoulGem 提交和文件摘要；CI 检查来源文件和预生成校验器没有漂移，Worker 不执行动态代码生成。

测试使用 Miniflare/workerd 真实 SQLite 与假密钥、模拟的 Cloudflare 上游：覆盖签名、重启、撤销竞态、会话刷新、
事件批回滚、分片状态、分页、抢接、媒体协商门槛、租约过期、限额与恢复隔离。
Chromium 管理页验收：安装 Python Playwright 后运行 `python test/browser_smoke.py`（使用 `/usr/bin/chromium`，仅假数据）。

实际 Deploy 按钮/升级、真实 key 权限、TURN 吊销后的 Allocate/已有中继效果，以及真实一天的 Cloudflare 指标尚需部署者账号验收。
设备侧强制中继、SDK 选路、Doze 和蜂窝竞态仍需模拟器/真机；详见 [验收边界](docs/validation.md)。

## 额度与网络入口

[请求预算](docs/request-budget.md) 区分 Workers 请求、DO 消息/请求和 SQLite 写入；本地压缩测试不等于 24 小时平台账单。
无效签名在 Worker 拒绝，真实签名仍查询 DO；不能承诺全部垃圾请求不消耗 DO 或 Workers 额度。
为普通设备操作返回 Retry-After，为结束及其 CAS 读取保留受限预算；平台 1027 仍会阻断访问。
部署者可使用自定义域名、适用的 WAF 限流和 fail closed，关闭不需要的 workers.dev/预览入口。
Cloudflare 在中国大陆的可达性需要实测；自建 SoulGem/TURN 始终可保留。
