# 双 RPC 路由与熔断设计

## 目标

将高频链上发现请求优先发送到 Robinhood Chain 官方公共 RPC，将候选深度分析发送到 Alchemy。官方 RPC 出现可恢复故障时，发现请求可在有限熔断期内使用 Alchemy 备用节点，从而降低 Alchemy 月度 CU 消耗，同时避免官方节点短暂故障导致扫描循环中断。

系统继续保持只扫描、只推送，不增加交易功能。

## 配置

新增以下环境变量：

```dotenv
DISCOVERY_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ANALYSIS_RPC_URL=
DISCOVERY_RPC_CUPS=150
ANALYSIS_RPC_CUPS=250
DISCOVERY_RPC_COOLDOWN_MS=60000
```

解析规则：

1. `DISCOVERY_RPC_URL` 未配置时使用 Robinhood Chain 官方主网 RPC。
2. `ANALYSIS_RPC_URL` 未配置时优先使用旧的 `RPC_URL`。
3. `ANALYSIS_RPC_URL` 与旧 `RPC_URL` 都未配置时使用官方主网 RPC。
4. `RPC_URL` 保留为兼容字段，不再作为新配置文档中的首选字段。
5. 三个数值配置必须是正整数，非法值在启动阶段明确报错。
6. 日志只显示节点角色和切换状态，不输出完整 RPC URL，避免泄露 Alchemy 密钥。

现有服务器若只配置了 `RPC_URL=<Alchemy URL>`，升级后会自动形成“官方发现、Alchemy 分析和备用”的双 RPC 布局，无需立即改写密钥配置。

## Provider 边界

`src/chain.js` 提供两个明确入口：

- `getDiscoveryProvider()`：官方节点作为主节点，分析节点作为备用节点，带熔断路由。
- `getAnalysisProvider()`：只使用分析节点。

现有 `getProvider()` 保留为 `getAnalysisProvider()` 的兼容别名，避免未迁移的深度分析函数意外改走官方节点。

两个底层 Provider 使用独立调度器：

- 官方发现节点使用 `DISCOVERY_RPC_CUPS`。
- Alchemy 分析节点使用 `ANALYSIS_RPC_CUPS`。

发现请求回退到 Alchemy 时，必须复用分析节点及其调度器。不得创建第三个 Provider 或独立备用限速器，否则深检和回退可能叠加突破 Alchemy 吞吐限制。

## 请求路由

发现 Provider 负责：

- 最新区块高度和发现游标所需区块读取；
- Uniswap V2、V3、V4 Factory 日志扫描；
- Pons 生命周期日志、启动校验和观察名单对账；
- 新候选的 Pons 身份分类；
- 基于链上发现数据的市场热度读取。

分析 Provider 负责：

- ERC-20 元数据、字节码和 owner 读取；
- V2 池绑定、余额、Transfer、Swap 和交易回执证据；
- 蜜罐及真实卖出能力检查；
- 创建者持仓和候选深度分析；
- 普通候选的 2、5、10 分钟持久化复查。

GeckoTerminal、DexScreener、Blockscout 和 DexPaprika 等 HTTP 数据源不经过 RPC 路由器。

## 熔断与恢复

发现 Provider 初始状态为 `closed`，请求先调用官方节点。

可触发回退的故障包括：

- HTTP 408、429 和全部 500–599；
- JSON-RPC 429；
- `NETWORK_ERROR`、`SERVER_ERROR`、`TIMEOUT`；
- 已有错误链中可识别的限流、吞吐、连接和超时错误。

以下错误不得触发回退：

- 合约执行回滚或 `CALL_EXCEPTION`；
- 无效参数、方法不支持、解析失败；
- 合约或业务数据不存在；
- 代码主动抛出的校验错误。

状态转换：

1. `closed`：官方请求成功，继续使用官方节点。
2. `closed -> open`：官方请求出现可回退故障；同一次请求改由分析节点执行，并记录熔断开始时间。
3. `open`：冷却期内的新发现请求直接使用分析节点，不重复请求官方节点。
4. `open -> half-open`：冷却期结束后的第一项发现请求成为官方节点探测请求；同一时刻其余发现请求继续使用分析节点。
5. `half-open -> closed`：探测成功，恢复官方节点。
6. `half-open -> open`：探测仍为可回退故障，本次请求使用分析节点并重新开始 60 秒冷却。
7. 探测遇到不可回退错误时，将错误返回调用方，不延长熔断时间。

备用节点请求失败时保留其完整错误链并返回调用方，不吞错，也不再次回到官方节点。
范围查询恢复只依据当前实际失败的节点错误；旧主节点错误仍保留用于诊断和限流退避，但不得阻止备用节点的 `block range too large` 触发二分。

底层 HTTP 请求最长等待 15 秒，并禁用 ethers 自带的 HTTP 429 重试；429 必须立即交给外层熔断和有界退避处理，避免单次请求在官方节点内部停留数分钟。

## 并发与日志

熔断器在单进程内共享状态。半开状态最多允许一个官方探测请求，防止多个扫描循环同时试探导致请求峰值。

只在状态变化时记录日志：

- 官方发现 RPC 进入熔断，发现请求临时使用备用节点；
- 官方发现 RPC 恢复。

连续处于熔断期间不逐请求打印相同警告。日志包含安全化后的错误摘要，不包含 RPC URL、API key、Token 或请求正文。

## 启动与失败行为

- 分析 RPC 配置非法时启动失败，因为深度安全检查不能降级为未经验证。
- 官方发现 RPC 配置非法时启动失败，不静默改用 Alchemy 承担全部发现流量。
- 两个 URL 相同时允许启动，但日志应提示当前没有形成节省 CU 的双节点布局。
- 官方节点故障且备用节点成功时，扫描循环继续运行。
- 两个节点都失败时，沿用现有调用方的错误处理和重试策略；路由层只补充节点角色上下文，不把失败伪装成空结果。
- `watch` 启动校验遇到可恢复 RPC 故障时持续按固定上限间隔重试；双节点都失败时以当前备用节点错误判定是否重试，旧主节点错误不得掩盖部署不匹配、参数或数据校验错误，这些永久错误仍立即退出。

## 测试

单元测试覆盖：

1. 新配置的默认值、旧 `RPC_URL` 兼容和显式 `ANALYSIS_RPC_URL` 优先级。
2. 发现请求默认只调用官方 Provider。
3. 分析请求只调用分析 Provider。
4. 官方可恢复故障触发同请求备用执行并进入 60 秒熔断。
5. 熔断期内发现请求不调用官方 Provider。
6. 冷却结束后只允许一个半开探测请求。
7. 探测成功关闭熔断，后续请求恢复官方 Provider。
8. 探测失败重新开始冷却。
9. 合约回滚、参数错误和业务校验错误不触发备用请求。
10. 备用失败保留错误上下文。
11. 发现回退与深检共享同一个分析调度器。
12. 日志状态去重且不包含 RPC URL。
13. Scanner、Pons 和候选复查调用各自正确的 Provider。

完整测试继续使用 `npm test`，并用 `git diff --check` 检查补丁格式。

## 文档与部署

更新 `.env.example` 和 `README.md`，说明新旧变量关系、默认路由、熔断行为以及官方公共 RPC 的限流属性。

服务器升级后可保留原配置：

```dotenv
RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>
```

也可以改为显式配置：

```dotenv
DISCOVERY_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ANALYSIS_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>
```

修改 RPC 配置后必须重启 `npm run watch`。

## 不在本次范围

- 不实时读取 Alchemy 用量或账单 API；
- 不实现月度 CU 硬限额；
- 不接入第三个 RPC 服务商；
- 不改为 WebSocket 或自建节点；
- 不改变候选评分、推送门槛、卖出安全规则或生命周期规则；
- 不增加自动交易能力。
