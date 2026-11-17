# Worker 控制传输 v1

HTTP 线格式取自 `protocol/openapi.yaml`；出处及摘要在 `protocol/provenance.json`。
这是单 owner 节点，签名来源 token `v1.*` 只可请求 ICE；节点 access token 使用独立用途的 `a1.*`，两者不能互换。

公开 capabilities 声明 `rtc_control_ws_v1` 后，手机可用自己的 Bearer access token 升级 `GET /v1/rtc/control/ws`。
未声明的节点保留 HTTP；`/v1/ws` 继续只发送原有 wake hint，收到应用数据关闭连接。
双方使用原生协议 ping，`client_ping_v1` 不接受应用层 ping 充当续租。

```json
{"version":1,"request_id":"opaque-id","method":"POST","path":"/rtc/control/calls/UUID/operations","body":{"version":1,"operation_id":"UUID","revision":2,"kind":"hangup"}}
```

```json
{"version":1,"request_id":"opaque-id","status":200,"body":{"version":1,"call_id":"UUID","state":"ended"}}
```

示例 body 为节选，实际遵守 HTTP schema。方法为 GET/POST/PUT/DELETE；路径相对于 `/v1`，仅允许实现的节点接口，不可访问管理/任意 URL。
消息不超过 256 KiB；手机接收不超过 512 KiB。同一连接可并行 request_id；request_id 只用于关联，业务去重仍用 operation_id/Idempotency-Key。
刷新或短信操作的 `idempotency_key` 原样映射 HTTP header；超时/断网以同一业务 ID、载荷和请求 key 回退 HTTP，不能换 ID 重新执行。

服务器在建立连接和相关状态变化后发送：

```json
{"version":1,"event":"snapshot","calls":[]}
```

此帧是持久状态快照及同步提示；手机清空空列表缓存，再通过认证接口拉短信数据。它不刷新业务租约。
空呼叫/命令/事件列表可在连接存活时缓存，状态提示、写操作、会话变化或断连使缓存失效。
活动呼叫至少每 5 秒实际提交一次 GET control/calls；推送再频繁也不能重置这个续租间隔。
候选占用 20 秒，媒体协商 30 秒、媒体授权 60 秒、网关新鲜度 90 秒；所有处理检查持久 deadline，不依赖 alarm 准点。

每条消息从 SQL 重新核验会话。连接内 refresh 成功后先更新该连接的鉴权 attachment，再回 ACK；旧 access 及其他旧连接失效。
掉线时可按同一 refresh/key 从 HTTP 恢复原令牌代际。撤销 ACK 后关闭连接；撤销或过期的 attachment 不能继续读取快照。

每设备最多 3 条连接；握手超额为 429 `CONTROL_CONNECTION_LIMIT`，Retry-After 只退避握手，HTTP 业务续租继续。
设备日操作超额为 429 `RATE_LIMITED`，普通操作等待 Retry-After；结束操作及必要的单呼叫 CAS 读取使用独立受限预算。
能力回滚/握手 404 或 426 撤销该进程的可选传输能力，回到旧 HTTP 行为。快速开关连接及令牌更新不重置退避，稳定 60 秒后才重置。

`cold_standby_v1`：主节点健康时不对非活动冷备周期探测；主节点失败的同一轮重新认证并探测冷备，再按既有选择策略激活和同步。
无推送仍有周期主节点检查及 HTTP/wake 恢复。网关约每 60 秒真实提交心跳，持久 ACK 后才推进本地 sequence；不伪造缓存心跳 ACK。

## 测试通话（`test_call_v1`）

与 SoulGem 相同：主机 `POST /v1/rtc/control/test-calls` 请求一次测试通话，请求保留 30 秒、每个网关同时只允许一个。
网关在 `GET /v1/rtc/control/calls` 和控制 WebSocket 的 snapshot 事件里收到 `test_call_requests`（创建请求时会主动唤醒网关的控制连接，不向主机发推送），
再用带 `test_request_id` 的普通来电创建测试通话。该通话标记 `test: true`，只振铃发起请求的主机；用过或过期的请求不能再创建通话。


### Review fixes: termination, revocation and rate limits

A committed `end_requested` blocks new winner/dispatch/active transitions; only
termination operations may advance that call. Existing operation replays remain
idempotent. `/v1/auth/revoke` accepts the refresh token without an access header,
including the previous refresh token during the 15-minute recovery window.
Repeated revocation returns 204. Revocation removes push registration and cached
ICE credentials and queues outstanding TURN credentials for durable revocation.
Rate-limit responses carry the actual window deadline: push probes cool down for
at most 60 seconds, while hourly and daily budgets use their own reset boundaries.

### Push endpoints (Kyubey)

`PUT /v1/devices/self/push-endpoint` follows SoulGem: after the relay accepts the
`check` hint it answers 200 `{push: "ready", endpoint_generation}`, keeps the
generation for the same endpoint, and records the check as the last delivery, so
`GET` reports a working relay right after registration. A 404, 410, redirect or
other 4xx from the relay is 422 `PUSH_ENDPOINT_REJECTED` (the phone then asks
Kyubey for a new endpoint); 429, 5xx, a Cloudflare challenge or a network failure
is a retryable 503 `PUSH_UNAVAILABLE`.
