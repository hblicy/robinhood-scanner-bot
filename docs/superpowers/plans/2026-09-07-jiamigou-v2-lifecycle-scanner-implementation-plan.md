# 加密狗 V2 生命周期扫链器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持“只扫描、只推送、绝不交易”的边界下，把现有 Robinhood Chain 扫描器升级为以 Pons V2 Factory 为主事实源、可恢复、可去重、可解释的生命周期监控器。

**Architecture:** Pons Factory 事件负责身份与协议阶段，Curve 交易负责早期行为，Hook/市场数据负责毕业后的市场就绪度；纯函数 reducer 生成下一状态，Store 以一次原子提交同时写入 token、事件去重、游标、通知 outbox 和延迟检查。Telegram 与外部 API 都在游标提交之后异步重试，任何外部故障不得阻塞 Pons 主游标。

**Tech Stack:** Node.js 18+、ES Modules、ethers v6、原生 `node:test`、JSON 原子文件存储、Telegram HTTP API、GeckoTerminal、DexScreener、DexPaprika、Robinhood Chain JSON-RPC。

---

## 实施边界与统一数据契约

- 只保留 `scan`、`watch`、`check` 三种可执行模式；`paper`、`live` 继续明确拒绝。
- 不引入 `Wallet`、私钥、签名器、交易构造或广播代码。
- `protocolPhase` 只表示 Pons 协议事实：`not_graduated | swept | pool_created | rescued | not_applicable`。
- `monitorState` 只表示机器人状态：`observed | watchlisted | curve_dead | decay | killed`。
- `marketReady` 是独立三态值 `true | false | unknown`，不能反向改写 `protocolPhase`。
- Factory 的 `PoolGraduated`/链上 `phase=PoolCreated` 是毕业权威事实；Gecko、DexScreener、DexPaprika 只证明市场数据是否可用。
- 统一 token 状态：

```js
{
  token,
  pad,                         // "pons-v2" | "pons-v1" | "long" | "uniswap-native" | "unknown"
  protocolPhase,
  monitorState,
  marketReady,                 // true | false | "unknown"
  pairToken,
  curve,
  deployer,
  factory,
  hook,
  birthBlock,
  birthAt,
  poolId,
  positionId,
  poolRegisteredAt,
  watchlist,
  killReason,
  riskDataStatus,              // "known" | "unknown"
  admissionHeatDecision,       // "打" | "不打"
  facts: {},
  decay: [],
  updatedAt
}
```

- Store schema 固定为 v4：

```js
{
  schemaVersion: 4,
  seen: {},
  positions: {},
  trades: [],
  cursors: { onchain: null, ponsV2: null },
  tokens: {},
  watchlist: [],
  heat: null,
  appliedEvents: {},
  outbox: {},
  pendingChecks: {}
}
```

- 事件 ID 固定为 `${chainId}:${transactionHash}:${logIndex}`；ethers v6 日志索引统一从 `log.index ?? log.logIndex` 取得。
- outbox ID 固定为 `${eventId}:${transitionType}`；网络超时可能造成 Telegram 至少一次投递，但同一条消息携带稳定 ID，便于人工识别重复。
- P3 Bitquery 为可选数据源，本计划不实施，也不作为 V2 核心验收条件；需要时另立计划。

## Task 1：锁定配置、ABI 与部署不变量

**Files:**
- Modify: `src/abis.js`
- Modify: `src/config.js`
- Modify: `.env.example`
- Test: `test/config.test.js`
- Create: `test/pons-config.test.js`

- [ ] **Step 1：先写失败测试，固定 Pons 地址和 quote token 规则**

```js
// test/pons-config.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { ADDRESSES, SETTINGS, QUOTE_TOKEN_ADDRESSES } from "../src/config.js";

test("Pons V2 deployment addresses are explicit", () => {
  assert.equal(ADDRESSES.PONS_FACTORY, "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  assert.equal(ADDRESSES.PONS_ROUTER, "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948");
  assert.equal(ADDRESSES.PONS_HOOK, "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044");
  assert.equal(ADDRESSES.PONS_LOCKER, "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952");
  assert.equal(ADDRESSES.PONS_EXECUTOR, "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046");
});

test("resolved quote allowlist stores addresses, never display symbols", () => {
  assert.ok(QUOTE_TOKEN_ADDRESSES.every((value) => /^0x[0-9a-fA-F]{40}$/.test(value)));
  assert.equal(SETTINGS.HIGH_HEAT_LAUNCHES_24H, 20_000);
});
```

- [ ] **Step 2：运行测试并确认因缺少导出而失败**

Run: `node --test test/pons-config.test.js`

Expected: FAIL，提示 `QUOTE_TOKEN_ADDRESSES` 或 Pons 地址尚未定义。

- [ ] **Step 3：补充最小 ABI 和配置**

在 `src/abis.js` 导出：

```js
export const PONS_FACTORY_ABI = [
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
  "event LaunchSwept(address indexed token,uint256 quoteOut,uint256 tokenOut)",
  "event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)",
  "event GraduationTokensPermanentlyLocked(address indexed token,uint256 amount)",
  "function memeHook() view returns (address)",
  "function locker() view returns (address)",
  "function graduationExecutor() view returns (address)",
  "function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
];

export const PONS_CURVE_ABI = [
  "event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)",
  "event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)"
];

export const PONS_HOOK_ABI = [
  "event PoolRegistered(bytes32 indexed poolId,address memecoin,address quoteToken,address creator)"
];
```

在 `src/config.js`：

- 加入上述 5 个固定部署地址。
- `QUOTE_TOKENS` 保留内置标识 `WETH,ETH,USDG`；除此之外的值只接受完整 20-byte 地址。解析后生成地址集合，与已核验的 WETH、USDG、NVDA 地址表合并、checksum 归一化、去重。
- 未知 symbol 启动即抛出可识别错误；symbol 只允许映射内置地址和用于输出标签，最终分类只比较地址。
- 新增 `HIGH_HEAT_LAUNCHES_24H`，默认 `20000`。
- 新增 `LINE_A_MAX_AGE_MINUTES=20`、`LINE_A_IGNORE_SECONDS=10`、`MIN_FLOW_TRADES=5`、`MIN_FLOW_UNIQUE_TRADERS=3`、`MAX_SINGLE_TRADER_PCT=80`、`MAX_DEPLOYER_LAUNCHES_24H=20`。
- 新增 `WATCHLIST_CAP_NORMAL=3`、`WATCHLIST_CAP_HIGH_HEAT=1`、`CURVE_DEAD_GRACE_MS=14400000`、`PONS_CONFIRMATIONS`、`PONS_RECONCILE_INTERVAL_MS`、`OUTBOX_POLL_MS`。

在 `.env.example` 只记录地址格式和默认值，不加入任何密钥示例。

- [ ] **Step 4：验证新旧配置测试**

Run: `node --test test/config.test.js test/pons-config.test.js`

Expected: PASS，且 `QUOTE_TOKENS=WETH,ETH,USDG` 可解析；非法 `QUOTE_TOKENS=NVDA_FAKE` 的子进程测试以非零状态退出并打印 `QUOTE_TOKENS contains an unknown symbol`。

- [ ] **Step 5：提交**

```bash
git add src/abis.js src/config.js .env.example test/config.test.js test/pons-config.test.js
git commit -m "配置 Pons V2 部署与报价币白名单"
```

## Task 2：升级 Store v4，并提供原子生命周期提交

**Files:**
- Modify: `src/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1：写 v3→v4 迁移与崩溃恢复测试**

新增用例覆盖：

```js
test("migrates schema v3 to v4 without losing legacy fields", async () => {
  // 写入真实 v3 fixture，重新加载后断言 seen/positions/trades/cursors.onchain 保留；
  // tokens/watchlist/appliedEvents/outbox/pendingChecks 初始化为空。
});

test("commitPonsRange atomically advances cursor and deduplicates events", async () => {
  await store.commitPonsRange({
    toBlock: 120,
    transitions: [{
      eventId: "4663:0xabc:7",
      token: "0x1111111111111111111111111111111111111111",
      nextToken: tokenState,
      notifications: [{ id: "4663:0xabc:7:launched", text: "new" }],
      checks: []
    }]
  });
  await store.commitPonsRange({ toBlock: 120, transitions: [sameTransition] });
  assert.equal(Object.keys(store.snapshot().outbox).length, 1);
  assert.equal(store.snapshot().cursors.ponsV2, 120);
});
```

再通过故障注入让临时文件 rename 失败，断言内存快照和正式 JSON 都没有出现“token 已更新但 cursor 未更新”的半状态。

补充 retention 用例：`appliedEvents` 保留至少 7 天、覆盖最大回扫窗口，且仍被 pending/delivered outbox 引用的 event 不得被提前裁剪。

- [ ] **Step 2：运行测试确认失败**

Run: `node --test test/store.test.js`

Expected: FAIL，schema 仍为 3 或不存在 `commitPonsRange`。

- [ ] **Step 3：实现 v4 默认值与严格迁移**

实现并导出以下接口：

```js
export function migrateState(raw) {}

export class Store {
  snapshot() {}
  async commitPonsRange({ toBlock, transitions }) {}
  listDueOutbox(now, limit = 20) {}
  async markOutboxDelivered(id, deliveredAt) {}
  async rescheduleOutbox(id, retry) {}
  listDueChecks(now, limit = 20) {}
  async completeCheck(id) {}
  async rescheduleCheck(id, retry) {}
}
```

`commitPonsRange` 必须在内存副本上完成下列动作，再沿用现有“临时文件 + rename”机制一次落盘：

1. 按 transitions 输入顺序处理；已存在于 `appliedEvents` 的事件直接跳过。
2. 更新 `tokens[token.toLowerCase()]`。
3. 依据 `nextToken.watchlist` 同步 `watchlist`，去重且只存小写地址。
4. 写入 keyed `outbox` 与 `pendingChecks`。
5. 写入 `appliedEvents[eventId]`。
6. 最后更新 `cursors.ponsV2=toBlock`。

任何序列化或 rename 错误均抛给调用方，并保留旧内存状态和旧正式文件。

- [ ] **Step 4：补充 outbox/check 状态转换测试并运行**

Run: `node --test test/store.test.js`

Expected: PASS；失败重试只更新目标条目，不丢其他 pending 条目。

- [ ] **Step 5：提交**

```bash
git add src/store.js test/store.test.js
git commit -m "升级状态存储并原子提交生命周期事件"
```

## Task 3：实现 Pons 身份、事件与部署校验

**Files:**
- Create: `src/pons.js`
- Create: `test/pons.test.js`
- Modify: `src/chain.js`
- Modify: `test/chain.test.js`

- [ ] **Step 1：写纯解析与身份分类失败测试**

固定以下行为：

```js
assert.deepEqual(classifyPonsRecord(query, {
  token: query, curve, deployer, exists: true, phase: 0
}), { identity: "pons", protocolPhase: "not_graduated" });

assert.equal(classifyPonsRecord(query, {
  token: ZeroAddress, curve: ZeroAddress, deployer: ZeroAddress,
  exists: false, phase: 0
}).identity, "not_pons");

assert.throws(() => classifyPonsRecord(query, {
  token: other, curve, deployer, exists: true, phase: 0
}), /identity mismatch/);
```

覆盖 phase `0/1/2/3` 到 `not_graduated/swept/pool_created/rescued`；未知 phase 必须抛错，不能猜测。

- [ ] **Step 2：运行并确认模块不存在**

Run: `node --test test/pons.test.js`

Expected: FAIL，`src/pons.js` 尚不存在。

- [ ] **Step 3：实现部署不变量、日志扫描和规范化事件**

`src/pons.js` 导出：

```js
export async function verifyPonsDeployment(provider, addresses) {}
export async function scanPonsRange(provider, fromBlock, toBlock) {}
export function parsePonsFactoryLog(log) {}
export async function readPonsLaunch(provider, token) {}
export function classifyPonsRecord(queryToken, record) {}
export function computePonsPoolId(record) {}
export async function reconcilePonsToken(provider, token) {}
```

部署检查在 `watch`/`scan` 启动时执行一次：

- factory、hook、locker、executor 地址 `getCode()` 均不能为 `0x`。
- Factory getter `memeHook()`、`locker()`、`graduationExecutor()` 必须与配置逐字节一致。
- 任一不变量失败时抛出包含字段名、期望地址、实际地址的错误，禁止启动 Pons 扫描。

`scanPonsRange` 复用 `src/chain.js` 的分块 `getLogs`，一次查询 Factory 四类事件，统一按 `(blockNumber, transactionIndex, logIndex)` 排序。规范化事件至少包含：

```js
{
  kind: "token_launched" | "launch_swept" | "pool_graduated" | "tokens_locked",
  eventId,
  blockNumber,
  transactionIndex,
  logIndex,
  transactionHash,
  token,
  args
}
```

每次处理 TokenLaunched 前必须读取 `getLaunchedToken(token)`；只有 `exists=true`、返回 token 等于查询 token、curve/deployer 非零，且事件中的 curve/deployer/pairToken 与 getter 一致时，身份才成立。RPC 错误是 `unknown`，不能被当作 `not_pons`。

`computePonsPoolId` 使用 ethers `AbiCoder` 对按地址排序后的 `currency0/currency1/fee/tickSpacing/hooks` 做 `keccak256`，并与 Hook `PoolRegistered` 日志核对。

- [ ] **Step 4：加入乱序、重复、重组回放和 poolId 向量测试**

Run: `node --test test/pons.test.js test/chain.test.js`

Expected: PASS；重复日志生成同一 eventId，坏 getter 记录被拒绝，网络异常保留为 unknown。

- [ ] **Step 5：提交**

```bash
git add src/pons.js src/chain.js test/pons.test.js test/chain.test.js
git commit -m "实现 Pons 事件扫描与链上身份校验"
```

## Task 4：实现纯生命周期 reducer 与 Line A 准入

**Files:**
- Create: `src/lifecycle.js`
- Create: `test/lifecycle.test.js`

- [ ] **Step 1：写状态转换表的失败测试**

至少覆盖：

- TokenLaunched → `not_graduated + observed`；通过 Line A 后才进入 `watchlisted`。
- 低频但未死亡 → `curve_dead`，仍保留 4 小时低频监控。
- LaunchSwept → `swept`，monitor state 不凭空升级。
- PoolGraduated → `pool_created + decay`，但 `marketReady=false`。
- phase 3 或恢复读到 Rescued → `rescued + killed + watchlist=false`。
- 任何事件都不能从 `rescued` 回退；正常 phase 只允许 `not_graduated → swept → pool_created` 或 `swept → rescued`。
- Factory 记录 unknown 或事件/getter 不一致不能进入 watchlist。

```js
test("unknown bundle evidence can be watchlisted but cannot turn green", () => {
  const candidate = evaluateLineA({ ...base, bundleStatus: "unknown", internalStatus: "unknown" }, limits);
  assert.equal(candidate.watchlistEligible, true);
  assert.equal(canGreen({ ...baseState, riskDataStatus: "unknown" }), false);
});
```

- [ ] **Step 2：运行并确认失败**

Run: `node --test test/lifecycle.test.js`

Expected: FAIL，`src/lifecycle.js` 尚不存在。

- [ ] **Step 3：实现纯函数，不读取全局配置或网络**

导出：

```js
export function createPonsTokenState(event, record, now) {}
export function reducePonsEvent(previous, event, record, now) {}
export function evaluateLineA(input, limits) {}
export function admitWatchlist(currentAddresses, candidate, cap) {}
export function canGreen(tokenState) {}
```

Line A 规则按规格固化：

- 硬杀：规格中明确的敏感名称、创建者滚动 24h 发射数 >20、已知 bundle/internal >30%、满足样本门槛后仍全买零卖、归一化交易者 >80% 且形成明显对倒、持有人卡住 ≤3、已 rescued、身份矛盾。
- `bundleStatus/internalStatus=unknown` 只标“待核验”；若其余必需条件通过，可进入观察池，但 `canGreen=false`。
- 交易样本不足 5 笔或独立交易者不足 3 人时，流向为 unknown，不据此硬杀，也不能据此通过双向交易要求。
- 无可解释叙事的候选保持 `observed`，不占名额；Pons V1 和未识别的辅助垫默认不进 watchlist。
- 0–10 秒只记录出生，不发“可看”；主 Line A 年龄窗口为 1–20 分钟。持有人必须呈增长且不能只有 ≤3 个有效地址，叙事必须能由关键词或已核验的股票/RWA quote 地址解释。
- 观察池达到 cap 时只回收 `killed` 名额；`curve_dead` 继续低频核验，确认死亡满 4 小时才移出。其余新对象只记 seen/短告警，不挤掉活盘。
- `canGreen` 同时要求：Pons 身份确定、未 rescued、Line A/B/C 均通过、风险数据 known、准入时热度决策为“打”、毕业对象还需 `marketReady=true`。

- [ ] **Step 4：运行状态矩阵测试**

Run: `node --test test/lifecycle.test.js`

Expected: PASS，所有 phase、unknown、watchlist cap 和 green gate 分支均命中。

- [ ] **Step 5：提交**

```bash
git add src/lifecycle.js test/lifecycle.test.js
git commit -m "实现 Pons 生命周期与准入状态机"
```

## Task 5：实现 Curve 流量、交易者归一化和创建者频率

**Files:**
- Create: `src/curve.js`
- Create: `test/curve.test.js`

- [ ] **Step 1：写边界样本失败测试**

覆盖：

- 最近 30 笔同时含 buy/sell 且 ≥5 笔、≥3 个归一化交易者，才判定双向样本充分。
- 4 笔或 2 个交易者返回 `sampleStatus="insufficient"`。
- 所有标准化交易者都指向同一人时，份额 >80% 触发 wash 信号。
- 已知 Pons Router 作为 `tx.to` 时用 `tx.from` 归一化，不能把 Router 当交易者。
- sell event 是曲线路由的卖出可行证据；仅有 eth_call 报价不等于已观察到卖出。
- 创建者在滚动 24 小时窗口内发射数以 Factory `TokenLaunched` 为准。

- [ ] **Step 2：运行并确认失败**

Run: `node --test test/curve.test.js`

Expected: FAIL，`src/curve.js` 尚不存在。

- [ ] **Step 3：实现查询和纯汇总两层**

导出：

```js
export async function loadCurveTrades(provider, curve, fromBlock, toBlock) {}
export async function hydrateTraderAddresses(provider, trades) {}
export function summarizeCurveFlow(trades, options) {}
export async function countDeployerLaunches24h(provider, deployer, now) {}
```

实现约束：

- CurveBuy/CurveSell 使用 topic OR 查询，返回后统一排序，只保留最近 30 笔。
- 交易者优先使用交易 `from`；若 `tx.from` 是已知 Router/Forwarder，再结合事件 buyer/seller、recipient 推断实际交易者，并把选择依据写入结果。
- >80% 的比例分母是归一化后的有效交易数，协议地址、burn 地址和零地址不计入独立交易者。
- 最近一次交易时间来自区块时间，不使用本机收到日志的时间。
- `countDeployerLaunches24h` 先定位 `now-24h` 对应起始块，再按 indexed deployer topic 查询 Factory；RPC 分段沿用通用日志退避。
- RPC 获取交易或区块失败必须抛出带 txHash/blockNumber 的错误，由 pending check 重试，不能静默把风险改成安全。

- [ ] **Step 4：运行测试**

Run: `node --test test/curve.test.js`

Expected: PASS，样本边界、Router 归一化和 24 小时边界均为确定结果。

- [ ] **Step 5：提交**

```bash
git add src/curve.js test/curve.test.js
git commit -m "分析曲线交易与创建者发射频率"
```

## Task 6：接入 Pons 主循环、恢复对账与可靠 outbox

**Files:**
- Create: `src/outbox.js`
- Create: `test/outbox.test.js`
- Modify: `src/scanner.js`
- Modify: `src/runtime.js`
- Modify: `test/index.test.js`
- Create: `test/scanner-pons.test.js`

- [ ] **Step 1：写主游标与外部故障隔离失败测试**

用依赖注入的 fake provider/store/notifier 覆盖：

1. 一批 Pons 日志生成 transitions，并在一次 store commit 中推进 `cursors.ponsV2`。
2. Telegram 抛错时 Pons cursor 已经推进，outbox 保留 pending。
3. DexPaprika/Gecko 抛错时 Pons cursor 已经推进，pendingChecks 保留待重试项。
4. 相同范围重放不新增通知。
5. 启动时发现 cursor 后链上阶段已变化，reconcile 生成有来源标记的恢复 transition。
6. 单个 token 的第三方 enrichment 失败不阻断同范围其他 token；但原始日志获取/解析或必要的 Factory getter 身份核验失败时整段不提交 cursor。
7. `scan` 使用隔离内存状态，不读写正式 Store、不创建 outbox、不调用 Telegram。

- [ ] **Step 2：运行并确认失败**

Run: `node --test test/scanner-pons.test.js test/outbox.test.js`

Expected: FAIL，Pons orchestration 与 outbox worker 尚未存在。

- [ ] **Step 3：实现先提交、后投递的编排**

`src/outbox.js` 导出：

```js
export async function drainOutbox({ store, send, now, limit }) {}
export function nextRetryAt(now, attempts) {}
```

指数退避使用有限上限，例如 5s、15s、45s、135s、300s；保存 `attempts/nextAttemptAt/lastError`。成功后写 `status="delivered"` 和 `deliveredAt`，不立即删除记录，以便审计与去重。

`src/scanner.js` 增加：

```js
export async function previewPonsRange(deps) {}
export async function watchPonsRange(deps) {}
export async function reconcilePonsWatchlist(deps) {}
export async function runPendingChecks(deps) {}
```

执行顺序：

1. 读取 finalized head（扣除 `PONS_CONFIRMATIONS`）。
2. 从 `cursors.ponsV2 + 1` 扫到 finalized head。
3. 对事件做 getter 身份校验和纯 reducer，形成 transitions。
4. `commitPonsRange` 原子提交状态、去重、outbox、checks、cursor。
5. 独立调用 `drainOutbox` 和 `runPendingChecks`。

每次 `watch` 启动及每次生命周期事件后都以 Factory 当前记录 reconcile。`appliedEvents` 至少保留 7 天，并且保留期必须覆盖配置的回扫/重组窗口；裁剪不得删除仍被 outbox 引用的事件。pending check 达到重试上限或过期后写入明确 `failed/expired` 终态。

`watch` 中 Pons 主循环、辅助 Uniswap/Gecko 发现循环、outbox 循环、pending check 循环各自隔离。`scan` 走 `previewPonsRange`，只返回报告，不实例化持久化 Store。只允许记录并重试预期网络错误；ABI 解码、状态不变量或 store 落盘错误必须保留调用链并让当前循环失败，不得宽泛吞掉。

- [ ] **Step 4：验证故障隔离和现有启动模式**

Run: `node --test test/scanner-pons.test.js test/outbox.test.js test/index.test.js`

Expected: PASS；Telegram/市场 API 故障不阻塞 Factory cursor，状态错误会使对应测试可见失败。

- [ ] **Step 5：提交**

```bash
git add src/outbox.js src/scanner.js src/runtime.js test/outbox.test.js test/scanner-pons.test.js test/index.test.js
git commit -m "接入 Pons 主循环与可靠通知队列"
```

## Task 7：修复 Gecko V4 pool ID，并接入毕业市场就绪度

**Files:**
- Modify: `src/market.js`
- Modify: `test/market.test.js`
- Create: `test/fixtures/dexpaprika-pool.json`
- Modify: `src/lifecycle.js`
- Modify: `test/lifecycle.test.js`

- [ ] **Step 1：写 Gecko 回归测试和 DexPaprika 契约测试**

复现已观察到的 payload：venue 为 `uniswap-pools-trade`，pool 地址为 32-byte V4 pool ID。断言解析器接受该 ID；未知 venue 的 32-byte 值仍拒绝，以免把 token/pool 字段混淆。

DexPaprika fixture 固定实际使用字段：pool id、tokens、price、liquidity、24h volume、last_updated。适配器缺字段时返回 `status="unknown"` 并携带 source/error，不伪造 0。

- [ ] **Step 2：运行并确认当前 Gecko 测试失败**

Run: `node --test test/market.test.js`

Expected: FAIL，当前 allowlist 不认识 `uniswap-pools-trade`。

- [ ] **Step 3：做最小市场适配**

`src/market.js`：

- 把 `uniswap-pools-trade` 加入明确的 V4 venue allowlist。
- 新增 DexPaprika read-only client：

```js
export async function searchDexPaprikaPools(token, options = {}) {}
export async function getDexPaprikaPool(poolId, options = {}) {}
export async function getDexPaprikaTransactions(poolId, options = {}) {}
export function normalizeMarketEvidence(sources) {}
```

- 网络固定为 `robinhood`；HTTP 非 2xx、超时、限流和 schema 变化均返回可重试 unknown 或抛出带 endpoint/status 的预期错误。
- 市场证据只设置 `marketReady=true|false|unknown` 与 `facts.market`；永不设置 `protocolPhase`。
- Gecko 与 DexPaprika 对同一 CA 的流动性相差 2 倍以上时，结果标 conflict，不采用较大的数；等待链上/Blockscout 核验后再定，报告保留各来源原值。
- Pons graduated 的卖出能力按 V4 pool 实际 swap/交易证据判断；curve 阶段按 CurveSell 判断；V2 router 报价不得跨路由复用。

在 `src/lifecycle.js` 增加 `applyMarketEvidence(state, evidence, now)`，仅当 token、pairToken、poolId 均与链上记录一致且有可用流动性/近期交易时令 `marketReady=true`。

- [ ] **Step 4：运行市场与生命周期测试**

Run: `node --test test/market.test.js test/lifecycle.test.js`

Expected: PASS；Gecko 32-byte pool ID 不再导致 `invalid on page`，外部市场数据不能伪造毕业阶段。

- [ ] **Step 5：提交**

```bash
git add src/market.js src/lifecycle.js test/market.test.js test/lifecycle.test.js test/fixtures/dexpaprika-pool.json
git commit -m "修复 V4 池解析并验证毕业市场状态"
```

## Task 8：实现 Line C 衰减、市场热度与 LONG 分类

**Files:**
- Create: `src/decay.js`
- Create: `test/decay.test.js`
- Modify: `src/scanner.js`
- Modify: `test/scanner-pons.test.js`

- [ ] **Step 1：写时间窗口和热度边界失败测试**

覆盖：

- 基线固定为 `poolRegisteredAt` 后 `[0h,2h]`，随后记录每个完整 2h 窗口，并单独比较 `[22h,24h]`。
- 当前窗口尚未完整时返回 `pending`，不提前给结论。
- top10 排除协议地址、零地址和 burn 地址。
- `launches24h >= 20000` 为高热，观察池 cap=1；否则 cap=3。
- 热度为“不打”时，新候选不得绿灯且 admission cap=1；已经入池的对象继续按原 `admissionHeatDecision` 观察。
- `QUOTE_TOKENS` 只用 exact address；同名 symbol、大小写展示差异不影响分类。
- Uniswap 新池查询 `getLaunchedToken(token)` 明确返回 `exists=false` 后，满足股票报价币 allowlist 才分类为 LONG；RPC unknown 不能归 LONG。

- [ ] **Step 2：运行并确认失败**

Run: `node --test test/decay.test.js test/scanner-pons.test.js`

Expected: FAIL，衰减和确定性热度逻辑尚不存在。

- [ ] **Step 3：实现纯计算和辅助发现入口**

`src/decay.js` 导出：

```js
export function buildDecayWindows(poolRegisteredAt) {}
export function summarizeDecayWindow(transfers, options) {}
export function evaluateDecay({ baseline, current, thresholds }) {}
export function evaluateHeat(input, settings) {}
```

Line C 的数量、集中度和持有者变化均以相同 token 单位计算；缺失 decimals、索引不完整或窗口数据源失败时为 unknown，不能绿灯。结果写入 `state.decay`，每个样本含 window 起止、source、complete、metrics 和 decision。

`evaluateDecay` 写死以下判定，不依赖加权总分：

- 当前完整 2h 成交量 ≤ 前一完整窗口 50%，且持有人净增 ≤0、净买入 <0 → `killed`。
- `[22h,24h]` 成交量 < `[0h,2h]` 的 20% → `killed`。
- 持有人增加但调整后前 10 更集中 → 标庄、禁止 green。
- 创建者余额下降，只有能由 Swap/转入交易场所证明为卖出时才发卖出风险；单纯余额变化为 unknown。
- 价格/成交只跟 `$PONS` 变化、自身无独立买卖 → shadow coin，移出 watchlist。
- 任一窗口不完整、baseline unknown 或必需指标 unknown 时，只标风险，不硬淘汰。

`evaluateHeat` 返回：

```js
{
  decision: "打" | "不打",
  level: "normal" | "high",
  admissionCap: 3 | 1,
  launches24h,
  sourceAt
}
```

输入包含 24h 发射数、DexPaprika top10 的资产类别/新 ticker 情况和 Pons 热门占比。top10 全为基础设施/股票/PONS，或任一必需温度数据过期且刷新失败时返回“不打”；`launches24h >= HIGH_HEAT_LAUNCHES_24H` 只把 cap 收紧为 1。Pons 热门占比仅展示，不单独触发状态转换。缓存仍在一个计算周期内可沿用并标 `stale`，超过周期才进入保守决策。

温度在 `watch` 启动 banner 输出；盘中最多按整点再算一次，只在决策发生变化时发短告警，不得每个扫描轮次刷 Telegram。cap 从 3 收紧到 1 只影响新 admission，不删除已有活盘。

辅助 Uniswap/Gecko 新池仍可发现非 Pons token，但必须先完成 Pons identity read：

- `identity="pons"` → 交由 Pons 生命周期，不重复建立候选。
- `identity="not_pons"` 且 quote 地址在精确 allowlist → `pad="long"`。
- `identity="unknown"` → pending check，不归类。

- [ ] **Step 4：运行衰减与分类测试**

Run: `node --test test/decay.test.js test/scanner-pons.test.js`

Expected: PASS，小时边界、排除地址、20,000 阈值和 Pons/LONG 分流均确定。

- [ ] **Step 5：提交**

```bash
git add src/decay.js src/scanner.js test/decay.test.js test/scanner-pons.test.js
git commit -m "实现衰减观察与确定性市场热度"
```

## Task 9：实现只读 check 报告和短状态推送

**Files:**
- Create: `src/check.js`
- Create: `test/check.test.js`
- Modify: `src/notify.js`
- Modify: `test/notify.test.js`
- Modify: `src/index.js`
- Modify: `test/index.test.js`
- Modify: `README.md`

- [ ] **Step 1：写输出契约与零副作用失败测试**

`check` 测试需在执行前后比较 store 文件字节和 Telegram fake 调用次数，断言：

- store 完全不变。
- Telegram 调用为 0。
- 报告含 Factory 身份、protocol phase、monitor state、最近 Curve 样本、毕业/Hook、marketReady、风险数据状态、硬杀或未通过原因。
- 全局超时为 90 秒，超时报告明确列出未完成数据源，不把 unknown 显示为安全。

通知格式测试固定短消息类型：`new_launch`、`hard_kill`、`graduated`、`market_ready`、`rescued`、`green`。每条都含 token、稳定 event/outbox ID 和直接原因；不得继续发送旧版笼统加权分数作为最终结论。

- [ ] **Step 2：运行并确认失败**

Run: `node --test test/check.test.js test/notify.test.js test/index.test.js`

Expected: FAIL，独立 check 报告器和状态消息尚不存在。

- [ ] **Step 3：实现只读 check 和通知映射**

`src/check.js` 导出：

```js
export async function inspectToken(token, deps, { timeoutMs = 90_000 } = {}) {}
export function formatInspectionReport(report) {}
```

`inspectToken` 直接读取 RPC/API，不构造 Store、不调用 `markSeen`、不写 outbox、不调用 Telegram。允许并行读取相互独立的数据源，但每个失败都保留 source、错误上下文和 unknown 状态。

`src/notify.js` 新增：

```js
export function formatLifecycleNotification(notification) {}
```

`src/index.js`：

- `check` 调用 `inspectToken` 后只输出 stdout。
- `scan` 用隔离内存状态扫一轮，只输出报告，不读取/写入 `state.json` 或 outbox，也不调用 Telegram。
- `watch` 持续运行 Pons/辅助/检查/outbox 循环。
- `paper`、`live` 继续以非零退出码拒绝，错误文案明确“Transaction functionality is not included”。

README 更新运行方式、screen 示例、Pons 状态含义、Gecko/DexPaprika 限流行为、只推送安全边界和状态文件备份说明。

同时删除 README 中残留的 Noxa 监听说明；本版不再监听或展示 Noxa。

- [ ] **Step 4：运行 check/notify/index 测试**

Run: `node --test test/check.test.js test/notify.test.js test/index.test.js`

Expected: PASS；`check` 无落盘、无推送，`paper/live` 均拒绝。

- [ ] **Step 5：提交**

```bash
git add src/check.js src/notify.js src/index.js README.md test/check.test.js test/notify.test.js test/index.test.js
git commit -m "提供只读检查报告与生命周期推送"
```

## Task 10：全量回归、只推送审计与主网只读烟测

**Files:**
- Modify only if a directly related failing test proves a defect.

- [ ] **Step 1：运行全量测试**

Run: `npm test`

Expected: 所有测试 PASS，无 skipped、todo 或未处理 rejection。

Run: `rg -n "Noxa|NOXA" README.md src test`

Expected: 无输出。

- [ ] **Step 2：检查格式和意外改动**

Run: `git diff --check`

Expected: 无输出。

Run: `git status --short`

Expected: 只包含本计划列出的源代码、测试、配置和文档；不得包含 `.env`、状态 JSON、日志或凭据文件。

- [ ] **Step 3：审计交易能力没有被引入**

Run:

```bash
rg -n "new Wallet|PRIVATE_KEY|sendTransaction|broadcastTransaction|getSigner\(|signTransaction" src test .env.example README.md
```

Expected: 无输出。

Run:

```bash
node src/index.js paper
node src/index.js live
```

Expected: 两条命令都以非零状态退出，并明确拒绝交易模式。

- [ ] **Step 4：执行主网只读 smoke test**

使用公开示例 Pons token `0x2861f208e71ced7beab010457bf10f0c1ccc0e2d`：

Run: `npm run check -- 0x2861f208e71ced7beab010457bf10f0c1ccc0e2d`

Expected: 90 秒内输出完整或明确标记 unknown 的报告；不修改 data/store 文件、不发送 Telegram。

Run: `npm run scan`

Expected: 能校验 Pons 部署并输出发现/分析报告，不读写正式 state/outbox、不发送 Telegram；不出现 `Gecko pool address invalid on page 1 row 19`。

- [ ] **Step 5：核对关键状态不变量**

从 smoke test 生成的状态文件检查：

- `schemaVersion === 4`。
- 在集成测试产生的 watch 状态中，`cursors.ponsV2` 已推进且与 token/outbox 同次落盘；CLI `scan` 前后正式状态文件字节不变。
- `appliedEvents` key 匹配正则 `^4663:0x[0-9a-f]{64}:[0-9]+$`。
- `rescued` token 不在 watchlist。
- `pool_created` 可以暂时 `marketReady=false`。
- unknown bundle/internal 数据没有 green 通知。
- outbox 失败条目含 attempts、nextAttemptAt、lastError。

- [ ] **Step 6：最终提交**

仅在 Step 1–5 全部通过且确有直接修复内容时提交：

```bash
git add src test .env.example README.md docs/superpowers/specs docs/superpowers/plans
git commit -m "完成 V2 生命周期扫描器回归验证"
```

若验证阶段没有产生新改动，不创建空提交。

## 完成定义

只有同时满足以下条件才可宣告 V2 完成：

1. Pons 身份依赖 Factory getter 与事件一致性，不靠名称、symbol 或第三方标签。
2. phase、monitor state、marketReady 三类状态互不混用，Rescued 可恢复且不可回退。
3. token 状态、事件去重、outbox、pending checks 和 Pons cursor 原子落盘。
4. Telegram 与全部外部市场源失败均不阻塞 Factory cursor，并有可追溯重试状态。
5. Line A/B/C、样本下限、>80% 归一化交易者、4h curve_dead、24h 热度和 watchlist cap 均有边界测试。
6. V4 `uniswap-pools-trade` 32-byte pool ID 回归测试通过。
7. `check` 90 秒内完成或明确 unknown，且不写状态、不推送。
8. `paper/live` 被拒绝，代码库中不存在私钥、签名或交易广播路径。
9. `npm test`、`git diff --check` 和主网只读 smoke test 均通过。
