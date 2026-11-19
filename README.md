<p align="center">
  <img src="icon.png" width="112" alt="GriefSeed">
</p>
<h1 align="center">GriefSeed</h1>
<p align="center"><b>免买 VPS，一键部署在 Cloudflare Workers 上的个人 SoulGem 节点 + TURN 中继。</b></p>
<p align="center">
  <a href="#-一键部署">一键部署</a> ·
  <a href="#-为什么选-griefseed">核心特性</a> ·
  <a href="docs/node-design.md">节点设计</a> ·
  <a href="docs/request-budget.md">额度预算</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20DO-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Storage-SQLite%20DO-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/TURN-Cloudflare%20Realtime-blue?style=flat-square" alt="TURN">
  <img src="https://img.shields.io/badge/Version-1.0.1-ff69b4?style=flat-square" alt="Version">
</p>

不想为了跑一套私有通信服务端专门租一台 VPS？**GriefSeed** 是运行在 Cloudflare Workers + SQLite Durable Objects 上的单人版 SoulGem 节点，顺带还能充当 Cloudflare Realtime TURN 中继来源，一次部署搞定信令、短信同步与媒体穿透。

## ✨ 为什么选 GriefSeed？

- **零服务器维护，点一下就能跑：** 直接使用 Cloudflare Workers 与 Durable Objects 自带的 SQLite 存储，连 D1 都不用额外开。
- **既是节点，也是 TURN 中继源：** 默认同时提供单人通信节点与 TURN 凭据签发；如果已有 SoulGem 服务器，也能把 `NODE_ENABLED` 设为 `false`，只把它当纯 TURN 中继源用（支持生成 `mahogsm://relay` 导入链接）。
- **API 密钥绝不进手机：** Cloudflare TURN API Token 只留在 Worker 内部，手机端拿到的只是限时临时凭据，随时可在管理页一键吊销。
- **完整兼容最新三端能力：** 支持 WebSocket 通话控制、Reception v2 省电待机、双主机抢接、短信幂等账本，以及与 [Kyubey](https://github.com/KiriKira/Kyubey) 配合推送唤醒。
- **自带 Web 管理台与灾难恢复：** 登录管理页即可生成扫码加入码、签发/吊销中继 token、导出或恢复加密备份（恢复时自动隔离未决状态，绝不重发历史短信）。

## 🚀 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/KiriKira/GriefSeed)

1. **生成初始密钥：** 下载并在本地浏览器打开仓库里的 `setup.html`（纯离线运行，不联网），生成并妥善保存 `DEPLOYMENT_ID`、`TOKEN_KEYS` 与管理员密码。
2. **填入 Secrets：** 在部署表单填入上面生成的三项，以及 Cloudflare Realtime TURN 的 `TURN_KEY_ID` 和 `TURN_API_TOKEN`。
3. **扫码配对：** 打开部署好的地址进入管理页，生成一个 15 分钟有效的加入码，让 Homura 和 Madoka 各扫一次即可使用。

<details>
<summary>🔧 推送白名单、升级须知与本地开发</summary>

- **推送域名白名单：** 默认允许官方 Madoka 使用的 `kyubey.openkiri.zip`；如果自建了 Kyubey，把环境变量 `PUSH_ALLOWED_HOSTS` 改为你的域名即可。
- **升级注意：** 升级时务必保留原有的 `DEPLOYMENT_ID` 和完整 `TOKEN_KEYS`，切勿重新生成首次配置。
- **本地开发（Node.js 24）：** `npm ci && npm run schemas && npm run check && npm test`，复制 `.dev.vars.example` 后运行 `npm run dev`。
- 更多细节：[控制协议](docs/worker-protocol.md) · [请求额度说明](docs/request-budget.md) · [验收边界](docs/validation.md)

</details>
