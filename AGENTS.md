# AGENTS.md

- 本仓库是只读五链扫描器：EVM（Ethereum、Base、BSC、Robinhood）与 Solana 分开运行，共享评分和推送策略。
- 保持 `watch`、`scan`、`check` 三个命令；禁止加入私钥、钱包创建、签名、授权、模拟交易或广播交易代码。
- 每条链必须隔离 RPC、状态、游标、锁和 Telegram chat；不得用一个链的数据作为另一条链的安全证据。
- 首次恢复和 shadow 模式不发 Telegram。live 模式仅推 `blocked`，或 `confirmed + score >= minScore`；`unknown` 必须静默。
- WebSocket 只能作为提示，确定性 HTTP reconciliation 才是完整性来源；游标仅在整段处理成功后推进。
- 新增或修改协议解析必须有固定版本来源、程序/合约归属校验和回归夹具；无法绑定卖出证据的协议保持 discovery-only。
