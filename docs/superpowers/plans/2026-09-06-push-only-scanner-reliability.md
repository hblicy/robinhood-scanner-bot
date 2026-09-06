# Push-Only Scanner Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复纯扫描机器人剩余的静默漏扫、错误退出、数据源耦合、配置加载、网络超时和状态并发缺陷，同时保持所有交易能力缺失。

**Architecture:** 配置加载、候选完整性、来源调度和状态锁分别放在可独立测试的边界。核心数据失败通过异常向上传递并阻止 `seen`/游标提交，辅助数据失败保留在报告；`scan` 汇总失败后非零退出，`watch` 隔离链上与 Gecko 两个来源。

**Tech Stack:** Node.js 18+ ESM、`node:test`、ethers v6、dotenv parse、JSON 原子 rename。

---

## 文件结构

- Create: `src/env.js` — 局部读取 `.env`，不修改 `process.env`。
- Create: `src/instance-lock.js` — `watch` 单实例锁。
- Modify: `src/config.js` — 白名单配置和严格范围校验。
- Modify: `src/safety.js` — 范围及非负整数校验。
- Modify: `src/market.js` — Gecko 时间与分页完整性。
- Modify: `src/chain.js` — 核心 RPC 错误传播、事件解析和大分块重试。
- Modify: `src/analyze.js` — 核心/辅助依赖分级。
- Modify: `src/runtime.js` — 严格年龄和错误摘要。
- Modify: `src/scanner.js` — 来源隔离、确认高度和失败汇总。
- Modify: `src/notify.js` — Telegram 请求超时。
- Modify: `src/store.js` — 正确 token payload 和唯一临时文件。
- Modify/Create: `test/*.test.js` — 所有缺陷的回归测试。
- Modify: `.env.example`, `README.md` — 配置、错误及运行约束。

### Task 1: 局部环境加载与严格配置校验

**Files:**
- Create: `src/env.js`
- Create: `test/env.test.js`
- Modify: `src/config.js`
- Modify: `src/safety.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: 写入环境隔离失败测试**

在 `test/env.test.js` 创建临时 `.env`，内容包含扫描字段和 `PRIVATE_KEY`，断言 `readEnvFile` 返回普通对象且调用前后 `process.env.PRIVATE_KEY` 都不存在：

```js
const before = Object.hasOwn(process.env, "PRIVATE_KEY");
const values = readEnvFile(file);
assert.equal(values.RPC_URL, "https://example.invalid");
assert.equal(values.PRIVATE_KEY, "secret-fixture");
assert.equal(Object.hasOwn(process.env, "PRIVATE_KEY"), before);
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/env.test.js`

Expected: FAIL，`src/env.js` 尚不存在。

- [ ] **Step 3: 实现最小局部解析器**

`src/env.js` 只读取并返回对象：

```js
import fs from "node:fs";
import dotenv from "dotenv";

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return dotenv.parse(fs.readFileSync(file));
}
```

`src/config.js` 删除 `dotenv.config()`，创建 `fileEnv`，并让已有 `env(name)` 只从 `process.env[name]`、`fileEnv[name]` 和 fallback 取值。代码不得访问 `PRIVATE_KEY`、`MODE` 或 `ENABLE_LIVE_TRADING`。

- [ ] **Step 4: 运行环境测试确认 GREEN**

Run: `node --test test/env.test.js test/push-only.test.js`

Expected: PASS，且交易能力静态测试仍通过。

- [ ] **Step 5: 写入配置失败测试并确认 RED**

在 `test/config.test.js` 增加子进程用例：

```js
for (const [name, value] of [
  ["ONCHAIN_SCAN", "tru"],
  ["MIN_SCORE", "101"],
  ["MAX_TOP10_PCT", "-1"],
  ["MAX_TAX_BPS", "-1"],
  ["MAX_DEPLOYER_TOKENS", "1.5"],
  ["QUOTE_TOKENS", "UNKNOWN"],
]) {
  assert.notEqual(loadConfig({ [name]: value }).status, 0);
}
assert.notEqual(loadConfig({ ONCHAIN_SCAN: "false", GECKO_SCAN: "false" }).status, 0);
```

Run: `node --test test/config.test.js`

Expected: FAIL，当前布尔拼写被静默当成 false，范围和报价币未严格验证。

- [ ] **Step 6: 实现最小校验并确认 GREEN**

在 `src/safety.js` 增加 `validateNonNegativeInteger` 和 `validateRange`。在 `src/config.js` 中让 `envBool` 仅接受规定枚举；验证 `MIN_SCORE/MAX_TOP10_PCT` 为 0..100、`MAX_TAX_BPS` 为非负数、`MAX_DEPLOYER_TOKENS` 为非负整数、金额阈值为非负数。验证 `QUOTE_TOKENS` 非空且成员属于 `WETH/ETH/USDG`，并验证至少一个来源开启。新增 `confirmationBlocks`，默认 2，使用非负整数校验。

Run: `node --test test/config.test.js test/safety.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/env.js src/config.js src/safety.js test/env.test.js test/config.test.js test/safety.test.js
git commit -m "修复：隔离环境配置并严格校验扫描参数"
```

### Task 2: Gecko 时间戳和分页失败不得伪装成功

**Files:**
- Modify: `src/market.js`
- Modify: `test/market.test.js`

- [ ] **Step 1: 写入失败测试**

给 `geckoNewPools` 注入 `fetchImpl`、`now` 和 `maxAgeMinutes`。构造四个用例：合法新池返回；缺失时间抛出包含 `pool_created_at` 的错误；无效日期抛错；超过 30 分钟返回空数组。再构造第一页成功、第二页 503，断言整体 reject 而不是返回第一页部分结果：

```js
await assert.rejects(
  () => geckoNewPools(2, { fetchImpl, now: () => NOW, maxAgeMinutes: 30 }),
  /Gecko.*page 2.*503/i
);
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/market.test.js`

Expected: FAIL，当前实现吞掉请求错误、缺失时间使用当前时间、无效日期穿透年龄过滤。

- [ ] **Step 3: 实现最小修复**

让内部 `getJson(url, {fetchImpl, timeoutMs})` 使用注入 fetch，非 2xx 和 JSON 失败原样抛出并附 URL 脱敏后的上下文。`geckoNewPools(pages, options)` 不再 `.catch(() => null)`；每页必须有数组 `data`。解析时间使用：

```js
const createdAt = Date.parse(a.pool_created_at);
if (!Number.isFinite(createdAt)) {
  throw new Error(`Gecko pool_created_at invalid on page ${page}`);
}
if ((now() - createdAt) / 60_000 > maxAgeMinutes) continue;
```

保留不属于已配置报价币的合法池过滤，不把它视为数据错误。

- [ ] **Step 4: 运行确认 GREEN**

Run: `node --test test/market.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/market.js test/market.test.js
git commit -m "修复：严格处理Gecko时间与分页失败"
```

### Task 3: 核心分析失败重试、辅助失败显式降级

**Files:**
- Create: `test/analyze.test.js`
- Modify: `src/analyze.js`
- Modify: `src/chain.js`
- Modify: `src/notify.js`
- Modify: `test/format.test.js`

- [ ] **Step 1: 写入核心失败测试**

让 `analyze(event, dependencies)` 支持测试注入，并分别令 `readTokenMeta`、`bytecodeFlags`、`dexScreener` reject；断言错误包含来源和 token。令 DexScreener 返回 null，断言为可重试失败。V2/V3 使用 `pool+quote` 精确绑定；V4 无池地址时只要求非空市场数据，且报告 `marketBound=false`。

```js
await assert.rejects(
  () => analyze(EVENT, deps({ dexScreener: async () => null })),
  /DexScreener.*not indexed.*0x1111/i
);
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/analyze.test.js`

Expected: FAIL，`analyze` 当前把所有异常转换为报告。

- [ ] **Step 3: 实现核心完整性门**

`analyze` 先并发获取数据，再对 `metaResult`、`flagsResult`、`dexResult` 调用小型断言 helper。失败或 `dexResult.value === null` 时抛出带 `source/token` 的错误。V2/V3 继续传 `{pool, quote}`；V4 只做 token 查询并保持 `marketBound=false`。`readTokenMeta` 去掉 name/symbol/decimals/totalSupply 的逐项空值 catch，让 RPC 失败由核心门感知。

- [ ] **Step 4: 写入辅助降级与格式测试**

所有 Blockscout 注入都 reject，核心依赖成功，断言 `analyze` 返回报告且 `errorSources` 包含对应来源。在 `test/format.test.js` 断言 `formatAlert` 输出“数据异常”及来源名，不输出原始 URL 凭据。

- [ ] **Step 5: 运行并确认 RED 后实现格式输出**

Run: `node --test test/analyze.test.js test/format.test.js`

Expected: 新增格式断言 FAIL。

在 `formatAlert` 的安全行后追加：

```js
if (report.errorSources?.length) {
  lines.push(`<b>数据异常</b> ${report.errorSources.map((x) => esc(x.source)).join(", ")}`);
}
```

Run: `node --test test/analyze.test.js test/format.test.js test/score.test.js test/honeypot.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/analyze.js src/chain.js src/notify.js test/analyze.test.js test/format.test.js
git commit -m "修复：区分核心分析失败和辅助数据降级"
```

### Task 4: 严格年龄与候选失败汇总

**Files:**
- Modify: `src/runtime.js`
- Modify: `src/scanner.js`
- Modify: `test/runtime.test.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: 写入严格年龄失败测试**

在 `test/runtime.test.js` 令候选年龄为 `MAX_AGE_MINUTES + 0.1`，断言不调用 analyze，并以 `too-old` 写 seen；等于边界仍分析。quiet skip 报告带 `errorSources` 时，日志必须包含来源摘要。

Run: `node --test test/runtime.test.js`

Expected: FAIL，当前要超过两倍窗口才跳过，quiet 日志不显示来源。

- [ ] **Step 2: 实现并确认 GREEN**

把年龄判断从 `maxAgeMinutes * 2` 改为严格的 `maxAgeMinutes`；quiet 日志追加去重后的 `errorSources.source`。不改变一次性扫描的 `persistSeen:false`。

Run: `node --test test/runtime.test.js`

Expected: PASS。

- [ ] **Step 3: 写入候选汇总失败测试**

在 `test/index.test.js` 给 `runReadOnlyCandidates` 三个候选，让中间一个分析抛错。断言第一和第三个仍被处理，最后 reject `AggregateError`，其 errors 含失败 token。现有 `processEvents` 失败计数测试保留。

- [ ] **Step 4: 运行并确认 RED 后实现汇总**

Run: `node --test test/index.test.js`

Expected: FAIL，当前只写日志并返回 reports。

`runReadOnlyCandidates` 收集 `{event,error}`；drain 完所有候选后若非空则抛：

```js
throw new AggregateError(
  failures.map(({ error }) => error),
  `candidate analysis failed: ${failures.map(({ event }) => event.token).join(", ")}`
);
```

Run: `node --test test/index.test.js test/runtime.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/runtime.js src/scanner.js test/runtime.test.js test/index.test.js
git commit -m "修复：严格过滤币龄并汇总候选失败"
```

### Task 5: 数据源隔离、scan 非零失败和确认高度

**Files:**
- Modify: `src/scanner.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: 写入来源隔离失败测试**

增加 `scanOnce` 用例：`onchainScan:false/geckoScan:true` 时，把 `getBlockNumber` 设为抛错并记录调用次数，Gecko 返回一个候选，断言 RPC 调用为 0 且候选被处理。再增加链上来源 reject、Gecko 成功时仍处理 Gecko、最终 reject AggregateError 的用例。

Run: `node --test test/index.test.js`

Expected: FAIL，当前无条件获取 head 且来源错误被替换为空数组。

- [ ] **Step 2: 实现 scanOnce 来源汇总**

只有启用链上来源时才调用 `getBlockNumber/findFirstBlockAtOrAfter/scanOnchain`。使用 `Promise.allSettled` 获取启用来源，把 fulfilled 候选合并处理，把 rejected 来源保留；候选处理结束后，将来源和候选错误组合为一个 AggregateError。所有来源成功时保持返回 reports 的现有接口。

- [ ] **Step 3: 写入 watch 单轮隔离测试**

导出可测试的 `runWatchIteration(state, dependencies)`。链上 head 获取失败时断言 Gecko 仍执行；Gecko 失败时断言成功链上区间仍提交游标。`onchainScan:false` 时任何 RPC 依赖均不得调用。

- [ ] **Step 4: 运行 RED 后实现 watch 单轮函数**

Run: `node --test test/index.test.js`

Expected: FAIL，尚无单轮隔离接口。

`watch` 循环只负责调用 `runWatchIteration` 和 sleep。链上初始游标也在链上分支内惰性计算，初始化失败只记录为当轮链上错误，不阻止 Gecko。单轮内部使用两个独立 try/catch，分别记录 `onchain`、`gecko` 错误；不让一个来源跳过另一个。链上 `safeHead = latestHead - confirmationBlocks`，仅当 `safeHead > lastBlock` 扫描并提交到 `safeHead`。

- [ ] **Step 5: 运行确认 GREEN**

Run: `node --test test/index.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/scanner.js test/index.test.js
git commit -m "修复：隔离扫描来源并只提交确认区块"
```

### Task 6: 链上解析和 RPC 查询完整性

**Files:**
- Modify: `src/chain.js`
- Modify: `test/chain.test.js`

- [ ] **Step 1: 写入 RPC 重试失败测试**

让 `findFirstBlockAtOrAfter` 的 provider 第一次 `getBlock` reject、第二次成功，注入无等待 retry sleep，断言能定位边界。让 `attachBlockTimes` 连续失败，断言 reject 而不是把时间写成 null。

Run: `node --test test/chain.test.js`

Expected: FAIL，二分和 block time 当前未用 retry，后者还吞错。

- [ ] **Step 2: 实现 RPC 重试并确认 GREEN**

保留 `withRetry(fn, tries=3, sleepImpl=sleep)` 的数字第二参数兼容性。二分查块与批量 block time 均通过它读取；拿不到有限 timestamp 时抛带 block number 的错误。

Run: `node --test test/chain.test.js`

Expected: PASS。

- [ ] **Step 3: 写入精确 topic 畸形日志失败测试**

给 `scanOnchain(from,to,dependencies)` 注入三组日志和 `attachBlockTimes`。V2 返回工厂地址/topic 已匹配但 data 无法解析的日志，断言 reject 且错误包含 `uniswap-v2`、block 和 tx hash；V3/V4 各覆盖一次。

- [ ] **Step 4: 运行 RED 后实现严格解析**

Run: `node --test test/chain.test.js`

Expected: FAIL，三个 catch 当前静默忽略。

提取 `parseFactoryLogs(logs, venue, parser)`，只允许“事件合法但两侧都不是报价币”返回 null；ABI 解析异常包装来源、区块和交易哈希后抛出。`scanOnchain` 接受默认依赖以便注入测试，但正常调用签名保持兼容。

- [ ] **Step 5: 增大初始分块并验证回退**

先增加测试：默认一次请求覆盖 2000 块；provider 拒绝大区间后递归拆分且无遗漏、无重复。将 `getLogsChunked` 默认 chunk 从 400 调为 2000，保留最小 40 块和单块失败直接抛出的边界。

Run: `node --test test/chain.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/chain.js test/chain.test.js
git commit -m "修复：重试区块读取并拒绝畸形工厂日志"
```

### Task 7: Telegram 超时、状态写入和单实例锁

**Files:**
- Modify: `src/notify.js`
- Modify: `test/notify.test.js`
- Modify: `src/store.js`
- Modify: `test/store.test.js`
- Create: `src/instance-lock.js`
- Create: `test/instance-lock.test.js`
- Modify: `src/scanner.js`

- [ ] **Step 1: 写入 Telegram 超时失败测试**

`fetchImpl` 返回只在 signal abort 时 reject 的 Promise，传入 `timeoutMs:1` 和无等待 sleep，断言发生三次尝试并最终 reject；每次收到不同且已 abort 的 signal。

Run: `node --test test/notify.test.js`

Expected: FAIL，当前没有 signal 和 timeout。

- [ ] **Step 2: 实现并确认 Telegram GREEN**

`sendTelegramWith` 增加 `timeoutMs=10000`；每次尝试创建独立 AbortController 和 timer，把 `signal` 传给 fetch，并在 finally 清 timer。三次失败语义、退避和脱敏保持不变。

Run: `node --test test/notify.test.js test/runtime.test.js`

Expected: PASS。

- [ ] **Step 3: 写入状态回归测试**

在 `test/store.test.js` 断言 `markSeen("venue|pool|token", {token:TOKEN})` 保存的 `token` 等于 TOKEN；注入/观察写入路径，连续两个 store 写入时临时文件名不同且最后不残留 `.tmp`。

Run: `node --test test/store.test.js`

Expected: FAIL，当前 payload token 被复合 key 覆盖，临时文件固定。

- [ ] **Step 4: 实现状态修复并确认 GREEN**

`markSeen` 合并顺序改为保留 `payload.token`。`atomicWriteState` 使用 `randomUUID()` 和 `process.pid` 生成 `state.json.<pid>.<uuid>.tmp`，在 finally 中仅清理本次创建的临时文件。

Run: `node --test test/store.test.js`

Expected: PASS。

- [ ] **Step 5: 写入并实现单实例锁**

先创建失败测试：首个 `acquireInstanceLock(dir)` 成功，第二个拒绝；release 后可再次获取；锁中 PID 被 `isPidAlive` 判定不存在时可回收；活动 PID 不得被覆盖。

Run: `node --test test/instance-lock.test.js`

Expected: FAIL，模块尚不存在。

`src/instance-lock.js` 使用 `fs.openSync(lockPath,"wx")` 原子创建，写入 `{pid,createdAt}`。仅在 JSON 可解析、PID 为整数且 `isPidAlive(pid)===false` 时删除失效锁并重试一次。release 前重新读取并确认 PID 与本实例一致。`watch` 入口获取锁，在 finally 和 `process.once("exit", release)` 中释放；`scan/check` 不调用。

Run: `node --test test/instance-lock.test.js test/index.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/notify.js src/store.js src/instance-lock.js src/scanner.js test/notify.test.js test/store.test.js test/instance-lock.test.js
git commit -m "修复：限制通知等待并保护扫描状态写入"
```

### Task 8: 文档、完整验证、复审与同步

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Verify: all changed source and test files

- [ ] **Step 1: 更新用户文档**

README 说明：核心/辅助数据失败策略、严格年龄、确认区块、来源隔离、`scan` 部分失败时非零退出、`watch` 单实例、公共 RPC 仅适合试跑。`.env.example` 增加 `CONFIRMATION_BLOCKS=2`，并写明严格布尔值、报价币枚举及至少启用一个来源。

- [ ] **Step 2: 运行定向测试**

Run: `node --test test/env.test.js test/config.test.js test/market.test.js test/analyze.test.js test/runtime.test.js test/index.test.js test/chain.test.js test/notify.test.js test/store.test.js test/instance-lock.test.js`

Expected: 全部 PASS，无 warning 或未处理 rejection。

- [ ] **Step 3: 运行完整测试**

Run: `npm test`

Expected: exit code 0，全部测试 PASS。

- [ ] **Step 4: 静态安全与差异检查**

Run: `node --test test/push-only.test.js`

Expected: PASS；`src/` 中没有 wallet、private key、sign transaction、broadcast transaction、swap 或 approve 执行路径。

Run: `git diff --check 27252eb..HEAD`

Expected: 无输出，exit code 0。

- [ ] **Step 5: 主网只读冒烟**

Run: `npm run scan`

Expected: 在稳定 RPC 下完成并打印候选；不创建/修改 `data/`，不发送 Telegram，不签名或广播交易。公共 RPC 返回 403、429 或持续超时时记录为外部环境限制，同时确认进程以非零退出而不是静默成功。

- [ ] **Step 6: 独立只读复审**

仅在代码完成后按 `superpowers:requesting-code-review` 进行独立只读审查，重点核对本规格、错误传播、游标语义及无交易能力。审查代理不得改文件或执行外部写操作。

- [ ] **Step 7: 提交文档**

```bash
git add README.md .env.example
git commit -m "文档：说明扫描完整性和运行约束"
```

- [ ] **Step 8: 同步正式目录并复验**

同步前逐文件比较隔离分支与 `D:\code-web3\07-web3-bot\DEX\robinhood-scanner-bot`。若正式目录出现新修改则停止并报告冲突；否则只同步本计划涉及文件，不复制 `.git`、`node_modules`、`.env` 或 `data/`。同步后在正式目录重新运行 `npm test` 和 `test/push-only.test.js`，并再次确认 `.env` 哈希未改变。
