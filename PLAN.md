# GriefSeed 计划

更新：2026-11-11。状态：**计划阶段，尚未开始实施**。

GriefSeed 是可以一键部署到 Cloudflare 的轻量服务端，面向两类人：

- 已有 SoulGem 节点的人：拿它当 Cloudflare TURN 的凭据来源，或者当冷备节点。
- 没有服务器的人：拿它当唯一节点，加上 Cloudflare TURN，就能使用 Madoka + Homura 这套系统。

三端整体目标、已核实的 Cloudflare 额度和 TURN 来源协议，见 SoulGem 的
[TURN 与节点解耦计划](https://github.com/KiriKira/SoulGem/blob/main/docs/plan-turn-sources.md)。
本文只写 GriefSeed 自己的范围，对应那份计划里的 T5 和 T6。

## 平台选择：只做 Cloudflare

讨论过 Vercel 一键部署，结论是不做，也不两者都做：

- 凭据来源（G3a）发的是 Cloudflare TURN 凭据，用户无论如何都要有 Cloudflare 账号；放到 Vercel 只会多一个账号。
- 节点（G3b）需要每个 owner 一份串行状态、一条长连接、精确定时。Durable Objects 正好对应：自带 SQLite、
  WebSocket 可休眠、alarm 能精确触发。Vercel Hobby 没有自带数据库；WebSocket 2026-06 才公开测试，
  单个连接最长 300 秒；cron 每天最多一次。要拼三四个服务才能接近。
- 同时支持两个平台会让存储、连接管理和测试都变成两套，维护成本翻倍。

保留余地：协议逻辑写成和平台无关的纯 TypeScript 模块（配对、短信账本、呼叫状态机），通过存储接口读写；
Worker/DO 只是其中一种适配器。以后如果需要，再加别的适配器，不用重写。这样也方便直接在 Node 里跑单元测试。

## 阶段一（T5）：TURN 凭据来源

实现 SoulGem 计划里的“中继来源协议 v1”：

```
GET /v1/rtc/ice-servers
Authorization: Bearer <来源 token>

200 {"ice_servers":[{"urls":[...],"username":"...","credential":"..."}],"expires_at":"..."}
```

- Cloudflare TURN key ID 和 API token 作为 Worker secret 保存，**永远不下发给手机**。
- 调用 `generate-ice-servers` 申请凭据；过滤端口 53 的地址；每类传输方式只保留一个地址（UDP 3478、TCP 3478、TLS 443）。
- 来源 token 由部署者发放和吊销，可以发给多个人；每个 token 有名字，便于吊销和看用量。
  token 只存哈希。具体的管理方式（管理页、命令行或 API）实施时再定。
- 凭据和通话无关，TTL 暂定 24 小时；手机端缓存，所以每部手机每天只需要很少几次请求。
- 这一阶段不需要 Durable Objects，但 wrangler 配置要为阶段二预留，避免以后迁移部署。

完成门槛：从“Deploy to Cloudflare”按钮全新部署，不用命令行；手机配上来源后，经 Cloudflare TURN 强制中继完成通话；
实测一天的请求量；日志里不出现凭据和 token。

## 阶段二（T6）：Worker 版节点

开始前另写设计文档，至少覆盖下面几点：

- **协议子集**：手机实际用到的 SoulGem 接口——配对、令牌、SIM 绑定、短信 command/event、RTC 呼叫控制 v1、
  Reception v2、唤醒 WebSocket、`/v1/capabilities`。用 SoulGem 的 fixtures 和 OpenAPI 做契约测试，行为逐项对齐。
- **数据模型**：每个 owner 一个 Durable Object（SQLite），保证同一 owner 的操作串行。
- **请求预算**：免费版 Workers 和 DO 各每天 10 万次请求，DO 付费版每月只含 100 万次。必须改用下面的方式：
  - 冷备时主手机不探测这个节点；
  - 旧手机只保持一条可休眠的 WebSocket，用协议层 ping 保活（明确免费），不依赖 `setWebSocketAutoResponse`（是否计请求数文档未说明）；
  - 通话控制走 WebSocket，不再 250ms/750ms 轮询（否则一通 5 分钟的电话约 1,600 次请求）；
  - 用推送唤醒主手机，Worker 向外 fetch 不计费。

  目标：冷备时每个用户每天一百次左右。这需要 Madoka、Homura 配合改动。
- **多人共用的隐私**：一个部署给多人用时，短信内容需要旧手机和主手机之间端到端加密，GriefSeed 只转发密文。
- **作为 mesh 节点**：要通过 Madoka 加节点时的 `mesh` 扩展检查和 `install_id` 一致性检查。

## 一键部署与升级

- README 放 “Deploy to Cloudflare” 按钮。仓库必须公开，正式让别人部署前改为公开。
- 需要用户填写的 secret 在 `.dev.vars.example` 里声明，并在 `package.json` 的 `cloudflare.bindings` 里写明从哪里获取。
- 按钮创建的是**复制出来的仓库，不是 fork**，不会自动跟随上游更新。要写清楚升级方法，或者提供一个同步上游的 GitHub Action。
- 中国大陆：`workers.dev` 有被 SNI 阻断的报告，README 要说明绑定自定义域名，并且不保证大陆可达。

## 不做的事

- 不在 Worker 里中转媒体：Workers 不能中转 UDP，中继只用 Cloudflare Realtime TURN。
- 不和 Kyubey 合并：Kyubey 里放的是 App 的 Firebase 推送凭据，只能由维护者运营；GriefSeed 由每个用户部署到自己的账号。
- 不替代 SoulGem：有服务器的人仍然推荐自建 SoulGem。

## 待决定的问题

1. 来源 token 的管理方式：管理页、wrangler 命令还是管理 API。
2. 使用 Cloudflare Realtime 是否必须绑定付款方式（文档没写，需要实际注册确认）。
3. 阶段二是否允许一个部署服务多个 owner，还是一个部署只服务一个 owner（后者更简单，隐私问题也更小）。
