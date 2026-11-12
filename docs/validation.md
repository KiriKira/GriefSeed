# 本批验证

本地自动化使用测试专用密钥，Cloudflare 上游为模拟服务；没有部署生产 Worker。

- `npm run check`、`npm run schemas`、`npm test`：签名向量、不同用途/部署隔离、无效签名零 DO、真实 workerd/SQLite 重启与撤销队列。
- 节点测试校验 SoulGem 冻结契约响应，并覆盖配对、可恢复刷新、SIM 两阶段、原子事件批、短信分片推进、同时间分页、持久 claim、双主机候选 CAS、唯一赢家及失败方媒体授权、长振铃、租约/网关超时与 unknown 占用。
- 限额、重复/转义 JSON 键、不合法 Unicode/整数、推送 allowlist/不跟随重定向/单调 generation、备份隔离及恢复 tombstone。
- Chromium 管理页：登录、文字安全渲染、二维码、吊销、节点加入码、备份下载、恢复后旧会话失效。
- 两端：构建 APK、应用/rtcmedia 单元测试、lint；真实 UDP STUN/TURN 应答、不同凭据回退、HTTPS 链接边界、加密存储、账户/鉴权失效、共同截止时间、候选分组预算、连接内刷新、空缓存、HTTP 回退与业务续租。

仍待设备/真实平台验收：固定 SDK 的强制中继、UDP/TLS 故障切换、来源显示、双网卡/IPv6、Doze/网络切换、蜂窝 END 与多主机/推送竞态。
当前机器无 `/dev/kvm`。Cloudflare 账号的 Deploy/升级、真实 TURN key 权限、吊销 Allocate/已有 allocation 的效果和 24 小时账单仍需部署者账号。

设备构建：两端执行 `./gradlew -PrtcEmulator=true -PforceRtcRelay=true :app:assembleDebug`。
该开关仅影响 debug；默认构建和 release 保留直连优先，不强制中继。构建可同时包含 arm64/x86_64。
