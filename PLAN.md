# GriefSeed 计划

更新：2026-11-12。状态：**计划阶段，尚未开始实施**。

**GriefSeed 是 Worker 版的 SoulGem**：同一套手机协议，跑在 Cloudflare Workers + Durable Objects 上，
可以一键部署。SoulGem 自带 coturn，GriefSeed 自带的 TURN 就是 Cloudflare Realtime TURN，
相关代码（申请凭据、发放来源 token、管理页）都放在本仓库里。

- 没有服务器的人：把它当唯一节点，就能使用 Madoka + Homura 这套系统。
- 已有 SoulGem 的人：把它当冷备节点；也可以只用它的 TURN，作为独立中继来源配给手机。

三端整体目标、已核实的 Cloudflare 额度和 TURN 来源协议，见 SoulGem 的
[TURN 与节点解耦计划](https://github.com/KiriKira/SoulGem/blob/11d1aac197a416d7401ded71b83f627c21421c4b/docs/plan-turn-sources.md)。
该链接固定到本轮审阅版本，避免主线尚未合并时出现死链。本文只写 GriefSeed 自己的范围，对应那份计划里的 T5 和 T6。

## 平台选择：只做 Cloudflare

讨论过 Vercel 一键部署，结论是不做，也不两者都做：

- 自带的 TURN 是 Cloudflare 的，用户无论如何都要有 Cloudflare 账号；放到 Vercel 只会多一个账号。
- 节点需要每个 owner 一份串行状态、一条长连接、持久化定时。Durable Objects 正好对应：自带 SQLite、
  WebSocket 可休眠、alarm 可用于超时清理（必须容忍延迟和重复触发）。Vercel Hobby 没有自带数据库；WebSocket 2026-06 才公开测试，
  单个连接最长 300 秒；cron 每天最多一次。要拼三四个服务才能接近。
- 同时支持两个平台会让存储、连接管理和测试都变成两套，维护成本翻倍。

保留余地：协议逻辑写成和平台无关的纯 TypeScript 模块（配对、短信账本、呼叫状态机），通过存储接口读写；
Worker/DO 只是其中一种适配器。以后如果需要，再加别的适配器，不用重写。这样也方便直接在 Node 里跑单元测试。

## 阶段一（T5）：自带的 Cloudflare TURN

先做 GriefSeed 的 TURN 部分，它最小、能单独交付，阶段二的节点也直接复用。对外实现 SoulGem 计划里的“中继来源协议 v1”：

```
GET /v1/rtc/ice-servers
Authorization: Bearer <来源 token>

200 {"ice_servers":[{"urls":[...],"username":"...","credential":"..."}],"expires_at":"..."}
```

- Cloudflare TURN key ID 和 API token 作为 Worker secret 保存，**永远不下发给手机**。
- 调用 `generate-ice-servers` 申请凭据；仅在 Cloudflare 适配器中过滤端口 53，每类传输方式保留一个地址（UDP 3478、TCP 3478、TLS 443）。这不是手机通用来源的端口白名单，自建 TURN 的自定义端口仍需保留。
- 来源 token 由部署者发放和吊销，可以发给多个人；每个 token 有名字，token 只存哈希。
- **T5 使用 D1 持久化管理状态**：保存 token ID、哈希、名称、创建/吊销时间及签发请求统计，Worker secret 仅保存管理密码和上游凭据。
  Wrangler 声明 D1 binding 与有版本的迁移；发放、吊销及限流状态需原子更新。鉴权读取必须能观察已提交的吊销，
  不把最终一致缓存或 Worker 内存当作授权依据；存储不可用时拒绝新签发。升级不得重新初始化已有 token。
- **吊销边界**：吊销来源 token 后拒绝新的凭据申请；已签发 TURN 凭据可能继续有效到 TTL 结束，不能承诺立即停止中继。
  定义并发签发与吊销的线性化点，记录已开始签发的请求并在返回前复核吊销状态。需要紧急撤销已签发凭据时，
  另行验证 Cloudflare 的撤销接口及所需标识；未实现前在管理页说明剩余有效期风险，不宣称具有即时撤销能力。
- **统计口径**：T5 管理页展示每 token 的签发请求数、成功/失败和最近使用时间，不把它们称为实际 TURN 字节流量。
  实际流量以 Cloudflare 指标为准；若不能归因到 token，不能展示虚构的个人流量或据此承诺流量配额。
- **Worker 自带管理页**（已决定）：部署时设置一个管理密码（secret），打开网页就能发放、吊销 token、看用量，
  并显示给手机扫的 `gsm2sip://relay` 链接和二维码。不需要命令行。链接含 token，只在发放时显示一次。
  管理登录设尝试限速、会话过期和 CSRF 防护；签发接口按 token 与部署总量限速。响应禁止共享缓存，日志屏蔽 Authorization、
  完整配对链接和 TURN 凭据；管理页不加载会接收到这些信息的第三方分析资源。
- 凭据和通话无关，TTL 暂定 24 小时，部署者可降低以缩短泄漏窗口；响应 `expires_at` 不晚于上游凭据实际到期时间，
  使用 `Cache-Control: no-store`，允许手机按统一来源协议进行受控本地缓存。缓存命中减少正常请求，但不能替代服务端限速。
- 这一阶段使用 Worker + D1，不需要 Durable Objects；阶段二新增 DO binding 和迁移，复用 D1 token 管理，不重发或丢失已有 token。

完成门槛：从“Deploy to Cloudflare”按钮全新部署，在管理页发放 token，手机扫码添加来源后，经 Cloudflare TURN 强制中继完成通话；
实测一天的 Workers 请求及 D1 读写量；日志里不出现凭据和 token。
另验收重复/并发发放与吊销、Worker 重启及升级后的持久性、D1 故障时拒绝签发、上游超时/限流、同 TURN URL 不同凭据的手机回退；
吊销测试分别记录新签发拒绝和已签发凭据的实际到期行为。

## 阶段二（T6）：节点本体

开始前另写设计文档，至少覆盖下面几点：

- **只服务一个 owner**（已决定）：一个部署只服务一个 owner，短信只存在部署者自己的账号里。
  分享给别人时，阶段一的 TURN token 本来就支持多人；节点让每个人自己点一次部署。
- **自带的 TURN 就是 Cloudflare**：媒体准入里的 `ice_servers` 下发 Cloudflare TURN 凭据，并声明 `ice_servers_v1`，
  所以手机把 GriefSeed 加为节点时会自动带上它的 TURN。

- **协议子集**：手机实际用到的 SoulGem 接口——配对、令牌、SIM 绑定、短信 command/event、RTC 呼叫控制 v1、
  Reception v2、唤醒 WebSocket、`/v1/capabilities`。用 SoulGem 的 fixtures 和 OpenAPI 做契约测试，行为逐项对齐。
- **数据模型**：每个 owner 一个 Durable Object（SQLite），状态变更仍需事务、唯一约束和幂等账本；不能仅凭单个 DO
  假定跨异步操作不会交错。短信 command/event、执行状态与 outbox 同事务持久化，提交后才返回 durable ACK；
  DO 重启、重复投递或回滚恢复均不得重发已执行或结果未知的短信。
- **请求预算**：免费版 Workers 和 DO 各每天 10 万次请求，DO 付费版每月只含 100 万次。必须改用下面的方式：
  - 冷备时主手机不探测这个节点；
  - 旧手机保持可休眠 WebSocket，协议 ping 仅用于连接保活；应用层续租、能力更新及同步单独设计和计费；
  - 新能力协商成功后才启用 WebSocket 控制，减少 250ms/750ms 轮询；旧端仍走 HTTP，不能修改已有 wake-only WebSocket 的含义；
  - 用推送唤醒主手机，Worker 向外 fetch 不计费。

  每用户每天一百次左右仅是无通话、少量事件的冷备目标。这需要 Madoka、Homura 配合改动。
  预算分别列 Workers 请求、DO 请求/消息及唤醒时长、D1/SQLite 读写、alarm、应用层续租、令牌刷新、短信同步和重连；
  分开实测冷备空闲、主节点空闲、通话和重连风暴，不以停掉安全续租来满足预算。
- **业务租约与恢复**：当前 SoulGem 的轮询同时续期呼叫参与者租约，超过 20 秒失联会触发处理；网关在线和 RTC 能力
  另有 90 秒新鲜度检查。免费协议 ping 不更新这些状态。T6 设计必须冻结应用层续租、断线检测、鉴权过期/吊销、
  重连重新认证与快照同步、幂等重试及 HTTP 回退；已拨出后失联进入 unknown 并保留占用，网关确认蜂窝结束才释放。
  冷备停止周期探测后，要明确主节点故障时如何激活，以及推送不可用时如何恢复。DO 休眠/重启、alarm 延迟或重复触发时，
  操作入口仍须核验持久化 deadline，不能延长过期授权。
- **T6 开工门槛**：先完成上述设计与预算，列出多主机抢接、20 秒续租中断、90 秒网关信息过期、断线重连、
  alarm 重试、短信重复投递、HTTP 旧端兼容的预期结果；实现后逐项验收，不能只用 JSON fixtures 宣称行为等价。
- **以后支持多个 owner**：必须先做旧手机和主手机之间的短信端到端加密，GriefSeed 只转发密文。
- **作为 mesh 节点**：要通过 Madoka 加节点时的 `mesh` 扩展检查和 `install_id` 一致性检查。

## 一键部署与升级

- README 放 “Deploy to Cloudflare” 按钮。仓库必须公开，正式让别人部署前改为公开。
- 需要用户填写的 secret 在 `.dev.vars.example` 里声明，并在 `package.json` 的 `cloudflare.bindings` 里写明从哪里获取。
- 按钮创建的是**复制出来的仓库，不是 fork**，不会自动跟随上游更新。要写清楚升级方法，或者提供一个同步上游的 GitHub Action。
- 升级文档包括 D1 迁移、备份与恢复、失败回退和 T5 → T6 的 DO binding 迁移；保留来源 token 和节点身份。
- 中国大陆：`workers.dev` 有被 SNI 阻断的报告，README 要说明绑定自定义域名，并且不保证大陆可达。

## 不做的事

- 不在 Worker 里中转媒体：Workers 不能中转 UDP，中继只用 Cloudflare Realtime TURN。
- 不和 Kyubey 合并：Kyubey 里放的是 App 的 Firebase 推送凭据，只能由维护者运营；GriefSeed 由每个用户部署到自己的账号。
- 不替代 SoulGem：有服务器的人仍然推荐自建 SoulGem。

## 已决定（2026-11-11）

- Cloudflare API token 只保存在 Worker 里，不放在手机上。
- 来源 token 用 Worker 自带的管理页管理。
- 节点阶段先只支持一个 owner。
- 手机加节点时自动带上它的 TURN，也可以扫码单独配对中继来源。

## 待确认

1. 使用 Cloudflare Realtime 是否必须绑定付款方式（文档没写，需要实际注册确认）。
