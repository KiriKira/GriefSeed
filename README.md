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
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License">
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

### 用命令行部署

不走按钮时，用 Wrangler 也一样。三项初始密钥可以不用 `setup.html`，按同样格式自己生成（`ADMIN_PASSWORD` 至少 16 位）：

```sh
npm ci
npx wrangler login
b64url() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }
b64url 24 | npx wrangler secret put DEPLOYMENT_ID
printf '{"primary":"%s"}' "$(b64url 32)" | npx wrangler secret put TOKEN_KEYS
b64url 24 | npx wrangler secret put ADMIN_PASSWORD     # 先记下来，登录管理页要用
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
npx wrangler deploy
```

不需要 D1，Wrangler 会自动创建 SQLite Durable Object。部署后打开 `https://<你的 worker 地址>/` 登录管理页即可。

## 🔧 配置与运维

- **变量（`wrangler.jsonc` 的 `vars`）：** `NODE_ENABLED`（默认 `true`，设 `false` 只当 TURN 来源）、`CREDENTIAL_TTL`（TURN 凭据有效期，默认 `7200` 秒，可设 60–86400）、`PUSH_ALLOWED_HOSTS`（允许推送的 Kyubey 主机名，逗号分隔，默认官方的 `kyubey.openkiri.zip`）。自建 Kyubey 时改成你的主机名。
- **升级：** 必须保留原有的 `DEPLOYMENT_ID` 和完整 `TOKEN_KEYS`，切勿重新生成。按钮部署会复制一份仓库，之后要自己把上游提交合进来再部署。
- **轮换签名密钥：** 先往 `TOKEN_KEYS` 加一个新 kid，再把 `TOKEN_KID` 切过去；旧 kid 等手机换发完成后再删。
- **备份：** 管理页导出的备份含短信明文，不含 Worker secrets，要和 secrets 一起妥善保存；上限 4 MiB / 20,000 行。恢复会撤销所有旧会话，手机需要重新配对。
- **CI 部署：** `.github/workflows/deploy.yml` 需要仓库 secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，可选仓库变量 `PUSH_ALLOWED_HOSTS`。
- **本地开发（Node.js 24）：** `npm ci && npm run schemas && npm run check && npm test`；复制 `.dev.vars.example` 为 `.dev.vars` 后运行 `npm run dev`，勿使用生产密钥。

更多细节：[控制协议](docs/worker-protocol.md) · [请求额度说明](docs/request-budget.md) · [验收边界](docs/validation.md) · [节点设计](docs/node-design.md)

## 📄 许可证

[MIT](LICENSE)
