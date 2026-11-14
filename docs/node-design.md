# T6：单 owner 节点设计与实现门槛

设计冻结：2026-11-12。实现与验证见 [协议扩展](worker-protocol.md)、[请求预算](request-budget.md) 和 [验收边界](validation.md)。

## 边界与存储

节点与 T5 来源服务使用同一部署级 SQLite Durable Object；同一对象内的同步 SQL 事务承担一致性边界。
外部 TURN/推送 fetch 不在事务中等待，使用持久化 outbox；事务提交后才返回短信事件 ACK。
每个部署一个持久 owner_id。节点接口的 device/session 鉴权与来源 token 鉴权分离；来源 token 不能调用短信、配对或呼叫接口。
所有记录和游标均携带 owner/device scope，不因单 owner 而取消身份校验。

逐表保存设备、会话与刷新恢复记录、双角色加入码、网关/SIM 映射、SIM 两阶段操作、消息/命令/分片、
事件幂等 tombstone、owner 事件序号、客户端 durable receipt、呼叫状态/占用/操作、媒体腿/SDP/ICE、Reception 选择及推送 outbox。
需要唯一约束的身份和幂等键不得只藏在 JSON blob 中。配置升级不改变部署、设备、SIM 或 token 身份。

## HTTP 兼容与验证

以 SoulGem 的 OpenAPI 和协议 fixtures 为输入，逐接口记录响应、错误码和状态语义。配对角色隔离、会话轮换及响应丢失恢复、
SIM revision 和 install_id、短信 claim/unknown、防跨设备读取、多主机抢接和媒体授权都必须有真实 SQLite 事务集成测试。
未知接口、未知能力不得返回伪造成功或提前声明支持；Worker 仅转发明确列出的节点路由到 DO。
迁移/恢复保留幂等 tombstone，不能把 dispatching、unknown 还原为 queued。

## 活动连接与租约

旧 `/v1/ws` 保持 wake-only 语义；通过另外的能力声明协商控制通道，消息有版本、request_id、call_id、operation_id 和 revision。
应用层续租由经过重新认证的设备身份提交；协议 ping 不延长业务租约。通话双方 20 秒失联处理、网关 90 秒新鲜度、
媒体 30 秒协商期限和来电剩余窗口保留其安全语义。已 dispatch 的电话失联进入 unknown 并保留网关槽，收到蜂窝结束确认才释放。
重连先重新认证，再读取持久快照和未确认事件；重复 operation_id 同载荷返回原结果、不同载荷冲突。旧端继续 HTTP。
DO 通过 WebSocket hibernation attachment 保留设备/会话标识，唤醒后重新查询会话有效性；不能只相信连接初始鉴权。
每次处理请求、命令和 alarm 均验证持久 deadline。alarm 可延迟、重复；超时处理与副作用必须幂等。

## 冷备、退避与额度

主节点失联触发冷备激活；无推送时仍有明确恢复路径，不通过停止必要续租达到预算目标。
Homura 稳定 60 秒后才重置退避，验证两端在抖动、网络切换和 token 更新后的行为。
分别测量空闲冷备、空闲主节点、通话与重连风暴，列出 Workers/DO 请求、消息、唤醒时长、SQLite 读写和 outbox 重试。
1,440 次/日只是每分钟一次重连的预算情景。普通限流返回 Retry-After，关键结束确认有受限预算；平台 1027 仍可能阻断全部访问。

## 验收清单

- 并发兑换一次性加入码，每个角色至多成功一次；来源 token 无节点权限；撤销/过期会话立即失效。
- 刷新响应丢失可恢复原令牌代际；同 refresh/request key 不同载荷拒绝。
- SIM propose/confirm、换卡失效、revision、跨节点稳定 SIM ID 与 install_id 行为一致。
- command 创建与 message/event/outbox 原子；claim 响应丢失不重新发送；unknown 保留占用且不自动执行。
- 事件重复、设备 sequence 冲突、同 ID 不同 payload、跨设备游标与 receipt 均按契约拒绝或幂等。
- 两主机抢接唯一 winner、全局拒接、推送迟到、长振铃、续租中断、媒体失败与蜂窝结束竞态。
- SQLite 故障/恢复、DO 冷启动、休眠、alarm 重试、旧端 HTTP 与新端 WebSocket 混用。

这些不是只靠 schema 校验即可替代的行为测试。T6 未通过上述集成测试前，不能将 GriefSeed 宣称为可配对节点。
