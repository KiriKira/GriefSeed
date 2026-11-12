# GriefSeed 计划

更新：2026-11-12。状态：**计划阶段，尚未开始实施**。

**GriefSeed 是 Worker 版的 SoulGem**：同一套手机协议，跑在 Cloudflare Workers + Durable Objects 上，
可以一键部署。SoulGem 自带 coturn，GriefSeed 自带的 TURN 就是 Cloudflare Realtime TURN，
相关代码（申请凭据、发放来源 token、管理页）都放在本仓库里。

- 没有服务器的人：把它当唯一节点，就能使用 Madoka + Homura 这套系统。
- 已有 SoulGem 的人：把它当冷备节点；也可以只用它的 TURN，作为独立中继来源配给手机。

三端整体目标、已核实的 Cloudflare 额度和 TURN 来源协议，见 SoulGem 的
[TURN 与节点解耦计划](https://github.com/KiriKira/SoulGem/blob/main/docs/plan-turn-sources.md)。
[SoulGem #35](https://github.com/KiriKira/SoulGem/pull/35) 已合入，来源协议链接跟随 main。本文对应整体计划里的 T5 和 T6。

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
- **T5 首次交付即使用带签名的来源 token**，不先发布无签名格式。来源 token 由部署者发放和吊销，可以发给多个人；
  每个 token 有名字，服务端只保存完整 token 的哈希及管理元数据，原文仅在发放时显示一次。
- **格式与签名**：采用版本化格式 `v1.<kid>.<token_id>.<mac>`，`token_id` 为安全随机生成的 32 字节，
  `mac` 为完整 HMAC-SHA-256；二进制字段使用无填充 base64url。`kid` 只索引本地已配置密钥，禁止动态获取密钥或由 token 指定算法。
  签名输入包含固定用途标识、稳定的部署 ID，以及版本、kid 和 token_id；编码与分隔规则在 T5 协议中冻结并提供固定测试向量。
  Worker 先检查长度、字段数量、版本、编码和 kid，再使用 Web Crypto 验证 MAC；不接受无签名降级或非规范编码。
  手机将来源 token 视为不透明 Bearer 字符串，不解析签名，不持有签名密钥；这不改变 SoulGem 的会话 token 格式。
- **签名密钥生命周期**：每部署使用独立随机密钥（至少 32 字节），作为 Worker secret 保存，不复用管理密码、Cloudflare API token 或 TURN 密钥。
  初次部署配置密钥和稳定部署 ID，升级不得重新生成；缺失配置时拒绝签发与验证。密钥环按 kid 管理，当前密钥签发新 token，
  正常轮换期间保留旧验证密钥，待其 token 全部换发或吊销后退役；泄漏时可紧急移除对应 kid，并明确该批 token 会失效、需要换发。
  密钥、部署 ID 与 DO 数据的备份恢复要配套，不能仅恢复 token 哈希却丢失验证能力。
- **T5 起使用 SQLite Durable Object 持久化管理状态**：声明一个部署级 DO（例如 `idFromName("deployment")`），
  保存 token ID、哈希、名称、创建/吊销时间、签发记录、统计和限速状态。Worker secret 保存管理密码、上游凭据和来源 token 签名密钥环。
  Wrangler 从首次部署就声明 SQLite DO binding 与 migration tag，DO 内使用有版本的 schema 迁移。
  发放、吊销及限流状态需原子更新；DO 是 token 有效性与吊销状态的权威来源，不能用 Worker 内存或过期缓存替代。
  存储不可用时拒绝新签发。每次通过签名预检的来源鉴权仍需访问 DO，计入请求预算；本阶段不引入 D1。
- **主动撤销是 T5 必做项**：[官方接口](https://developers.cloudflare.com/realtime/turn/generate-credentials/)为
  `POST https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/{username}/revoke`，成功返回 204。
  每次签发保存来源 token ID、TURN key ID、username、到期时间及撤销状态，按签发限速约束记录数量；到期后按保留策略清理。
  吊销来源 token 时，在同一 DO 事务内标记吊销并创建其名下未过期凭据的持久化撤销任务，立即拒绝新申请；
  对 Cloudflare 的调用在事务外执行，失败任务保留并退避重试，DO 重启后继续处理。管理页区分 token 已吊销与上游撤销待完成/已完成。
- **签发与吊销竞态**：签发流程为检查 token 并登记申请 → 调 Cloudflare → 记录 username/到期时间并复核 token → 返回。
  外部调用期间允许其他请求推进，不能假定跨 await 自动串行；若复核发现 token 已吊销，同事务登记撤销任务，立即尝试撤销且拒绝返回凭据。
  上游签发成功但本地记录失败时不得向手机返回凭据；若仍持有 username，尝试撤销，并在存储恢复后补记任务。
  若响应丢失或进程退出导致 username 无法恢复，该孤立凭据只能按上游 TTL 到期，不能宣称能立即撤销所有上游签发结果。
- **吊销效果验收**：分别验证撤销后新的 Allocate 被拒绝、已建立中继何时停止；后者以实测为准，不能把 204 当作已有通话立即中断的保证。
  撤销任务尚未成功时，已签发凭据可能仍可用至 TTL 到期，管理页应如实显示状态。
- **统计口径**：T5 管理页展示每 token 的签发请求数、成功/失败和最近使用时间，不把它们称为实际 TURN 字节流量。
  实际流量以 Cloudflare 指标为准；若不能归因到 token，不能展示虚构的个人流量或据此承诺流量配额。
- **Worker 自带管理页**（已决定）：部署时设置一个管理密码（secret），打开网页就能发放、吊销 token、看用量，
  并显示给手机扫的 `gsm2sip://relay` 链接和二维码。不需要命令行。链接含 token，只在发放时显示一次。
  管理登录设尝试限速、会话过期和 CSRF 防护；签发接口按 token 与部署总量限速。响应禁止共享缓存，日志屏蔽 Authorization、
  完整配对链接和 TURN 凭据；管理页不加载会接收到这些信息的第三方分析资源。
- 凭据和通话无关，TTL 暂定 24 小时，部署者可降低以缩短泄漏窗口；响应 `expires_at` 不晚于上游凭据实际到期时间，
  使用 `Cache-Control: no-store`，允许手机按统一来源协议进行受控本地缓存。缓存命中减少正常请求，但不能替代服务端限速。
- T6 的单 owner 节点复用同一部署级 DO，在同一套 SQLite schema 中加表；保留已有 token 和对象身份，不做 D1 → DO 跨存储迁移。

完成门槛：从“Deploy to Cloudflare”按钮全新部署，在管理页发放 token，手机扫码添加来源后，经 Cloudflare TURN 强制中继完成通话；
实测一天的 Workers 请求、DO 请求及 SQLite 读写量；日志里不出现凭据和 token。
另验收重复/并发发放与吊销、Worker 重启及升级后的持久性、DO/存储故障时拒绝签发、上游超时/限流、同 TURN URL 不同凭据的手机回退；
吊销测试覆盖新签发拒绝、未过期 username 的主动撤销与失败重试、签发/吊销竞态和记录失败窗口；分别记录新 Allocate 拒绝及已有中继的停止时间。

## 阶段二（T6）：节点本体

开始前另写设计文档，至少覆盖下面几点：

- **只服务一个 owner**（已决定）：一个部署只服务一个 owner，短信只存在部署者自己的账号里。
  分享给别人时，阶段一的 TURN token 本来就支持多人；节点让每个人自己点一次部署。
- **自带的 TURN 就是 Cloudflare**：媒体准入里的 `ice_servers` 下发 Cloudflare TURN 凭据，并声明 `ice_servers_v1`，
  所以手机把 GriefSeed 加为节点时会自动带上它的 TURN。

- **协议子集**：手机实际用到的 SoulGem 接口——配对、令牌、SIM 绑定、短信 command/event、RTC 呼叫控制 v1、
  Reception v2、唤醒 WebSocket、`/v1/capabilities`。用 SoulGem 的 fixtures 和 OpenAPI 做契约测试，行为逐项对齐。
- **数据模型**：单 owner 部署复用 T5 的部署级 Durable Object（SQLite），token 与节点状态在同一对象内；状态变更仍需事务、唯一约束和幂等账本，不能仅凭单个 DO
  假定跨异步操作不会交错。短信 command/event、执行状态与 outbox 同事务持久化，提交后才返回 durable ACK；
  DO 重启、重复投递或回滚恢复均不得重发已执行或结果未知的短信。
- **请求预算**：免费版 Workers 和 DO 各每天 10 万次请求，DO 付费版每月只含 100 万次。必须改用下面的方式：
  - 冷备时主手机不探测这个节点；
  - 旧手机保持可休眠 WebSocket，协议 ping 仅用于连接保活；应用层续租、能力更新及同步单独设计和计费；
  - 新能力协商成功后才启用 WebSocket 控制，减少 250ms/750ms 轮询；旧端仍走 HTTP，不能修改已有 wake-only WebSocket 的含义；
  - 用推送唤醒主手机，Worker 向外 fetch 不计费。

  每用户每天一百次左右仅是无通话、少量事件的冷备目标。这需要 Madoka、Homura 配合改动。
  预算分别列 Workers 请求、DO 请求/消息及唤醒时长、SQLite 读写、alarm、应用层续租、令牌刷新、短信同步和重连；
  分开实测冷备空闲、主节点空闲、通话和重连风暴，不以停掉安全续租来满足预算。
- **弱网重连：修正 Homura，并验证两端**。当前 Homura `GatewayService.onOpen` 在连接成功时立即重置退避；
  Madoka `HostBackgroundService` 已在连接稳定 60 秒后才重置。Homura 改为稳定窗口达标后再重置，初始按 60 秒与 Madoka 对齐，
  保留指数退避和 jitter；验证两端在快速断连、网络切换、令牌刷新后都不会绕过退避反复握手。
  “全天每分钟重连一次约 1,440 次”仅是每设备、每节点的预算场景，在实施明确限频前不能称为上限；
  每次握手的 Workers/DO 请求以及鉴权、补拉同步、SQLite 写入须单独计入。明确连接阶段限频不会替代活动通话的业务租约。
- **业务租约与恢复**：当前 SoulGem 的轮询同时续期呼叫参与者租约，超过 20 秒失联会触发处理；网关在线和 RTC 能力
  另有 90 秒新鲜度检查。免费协议 ping 不更新这些状态。T6 设计必须冻结应用层续租、断线检测、鉴权过期/吊销、
  重连重新认证与快照同步、幂等重试及 HTTP 回退；已拨出后失联进入 unknown 并保留占用，网关确认蜂窝结束才释放。
  冷备停止周期探测后，要明确主节点故障时如何激活，以及推送不可用时如何恢复。DO 休眠/重启、alarm 延迟或重复触发时，
  操作入口仍须核验持久化 deadline，不能延长过期授权。
- **T6 开工门槛**：先完成上述设计与预算，列出多主机抢接、20 秒续租中断、90 秒网关信息过期、断线重连、
  alarm 重试、短信重复投递、HTTP 旧端兼容、弱网快速断连和额度耗尽的预期结果；实现后逐项验收，不能只用 JSON fixtures 宣称行为等价。
- **以后支持多个 owner**：必须先做旧手机和主手机之间的短信端到端加密，GriefSeed 只转发密文。
- **作为 mesh 节点**：要通过 Madoka 加节点时的 `mesh` 扩展检查和 `install_id` 一致性检查。

## 额度与滥用防护

- **T5 在 Worker 验签后才访问 DO**：格式错误、未知版本/kid、被篡改或 MAC 无效的 token 在 Worker 层拒绝，不调用 DO，
  也不为这些失败写 DO 审计或限流计数，避免通过副作用重新消耗 DO 额度。使用不含 token 原文的 Worker 日志/指标观察这些拒绝。
  签名通过后，仍由 DO 核验完整 token 哈希、已登记状态和吊销状态；签名不授予绕过 DO 的权限。
  被窃取、重放或已吊销的真实签名 token 仍可能消耗 DO 请求，因此只能承诺部分无效请求进不了 DO，不能承诺所有垃圾流量都被提前挡住。
- 命中 Worker 的请求即使被鉴权或限流拒绝也会消耗 Workers 请求额度；Worker 内限速不能防止该额度被刷尽。
  推荐自定义域名配合当前套餐可用的 WAF 限流，关闭不需要的 `workers.dev` 及其他绕过 WAF 的入口，并验收实际入口覆盖。
  对有 fail-open/fail-closed 选项的路由使用 fail closed，不能在超额时绕过鉴权；这些措施降低风险，不保证免费额度不会耗尽。
- T6 为设备设置可配置的每日请求预算，普通请求超额返回带 `Retry-After` 的拒绝，并在管理页显示。
  为已认证的挂断、蜂窝结束确认、状态收敛保留受限预算，避免普通限额阻止通话结束；不能借此形成无限免费通道。
  [平台总额度](https://developers.cloudflare.com/workers/platform/limits/)耗尽后的 1027 不受应用预留控制，客户端须退避，
  按已有失联规则处理，不能承诺仍可访问 Worker；免费日额度在 UTC 零点重置。
- 验收格式错误、篡改字段、未知版本/kid、错误密钥/部署、非规范编码及无签名 token：均应在 Worker 拒绝且 DO 调用数为零。
  正确签名但未登记、已吊销或被重放的 token 走 DO 核验与限流；同时覆盖正常签发、升级保持有效、密钥轮换和紧急退役。
  对失控设备和重连风暴分别统计 Workers 与 DO 请求；
  确认客户端遵守 `Retry-After`，遇 1027 不紧密重试，预算耗尽不会导致未知短信自动重发或猜测蜂窝已结束。

## 一键部署与升级

- README 放 “Deploy to Cloudflare” 按钮。仓库必须公开，正式让别人部署前改为公开。
- 需要用户填写的 secret 在 `.dev.vars.example` 里声明，并在 `package.json` 的 `cloudflare.bindings` 里写明从哪里获取。
- 按钮创建的是**复制出来的仓库，不是 fork**，不会自动跟随上游更新。要写清楚升级方法，或者提供一个同步上游的 GitHub Action。
- 升级文档包括 DO 的版本化 SQLite schema 迁移、备份与恢复、失败回退；T5 → T6 保留部署级 DO 身份、来源 token、签名验证配置、未完成撤销任务和节点身份。
- 中国大陆：`workers.dev` 有被 SNI 阻断的报告，README 要说明绑定自定义域名，并且不保证大陆可达。

## 不做的事

- 不在 Worker 里中转媒体：Workers 不能中转 UDP，中继只用 Cloudflare Realtime TURN。
- 不和 Kyubey 合并：Kyubey 里放的是 App 的 Firebase 推送凭据，只能由维护者运营；GriefSeed 由每个用户部署到自己的账号。
- 不替代 SoulGem：有服务器的人仍然推荐自建 SoulGem。

## 已决定（2026-11-12）

- Cloudflare API token 只保存在 Worker 里，不放在手机上。
- 来源 token 用 Worker 自带的管理页管理，T5 首次交付即采用版本化签名格式；验签后仍由 DO 核验登记与吊销状态。
- 节点阶段先只支持一个 owner。
- 手机加节点时自动带上它的 TURN，也可以扫码单独配对中继来源。

## 待确认

1. 使用 Cloudflare Realtime 是否必须绑定付款方式（文档没写，需要实际注册确认）。
