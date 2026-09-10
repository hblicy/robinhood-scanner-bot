# Robinhood and BSC Stock Launchpads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在基础层之上安全接入 Robinhood 的 Pons/O1/Long 能力和 BSC 的 Four.meme/Flap，并让可信股票底池进入专属安全检查。

**Architecture:** 每个平台由已验证 profile、发现 adapter 和安全 adapter 三部分组成。已验证合约才进入日志过滤器；地址或 ABI 无法核验的平台进入 `disabled-unverified`，不会用普通 DEX 事件猜测身份。

**Tech Stack:** Node.js 18+、ethers v6、EVM logs/receipts、`node:test`、官方 JSON/ABI 快照。

---

## 文件结构

- Create: `src/venues/evm/o1.js`、`src/venues/evm/flap.js` — 平台发现解析。
- Create: `src/security/evm/o1.js`、`src/security/evm/four-meme.js`、`src/security/evm/flap.js` — 平台绑定和卖出证据。
- Create: `src/security/evm/reference-asset.js` — 股票底池限制读取与缓存。
- Create: `config/venues/robinhood.json`、`config/venues/bsc.json` — 已验证与禁用平台清单。
- Create: `config/abis/o1-launch-factory.json`、`config/abis/flap-portal.json` — 从官方/已验证合约固定的 ABI。
- Modify: `config/assets/robinhood.json`、`config/assets/bsc.json` — 可信股票资产。
- Modify: `src/chains/evm-profiles.js`、`src/app.js`、`src/abis.js` — 实例化平台。
- Modify: `src/security/evm/index.js`、`src/notify.js` — 能力和参考资产风险。
- Modify: `src/scanner.js` — 删除 Long 启发式身份判断。
- Test: `test/robinhood-stock-launchpads.test.js`、`test/bsc-stock-launchpads.test.js`、`test/reference-asset-security.test.js`。

### Task 1: 建立串行 PR 2 分支并验证基础层

**Files:**
- Verify only.

- [ ] **Step 1: 从 PR 1 头创建分支**

Run: `git switch -c feat/robinhood-bsc-stock-launchpads`

Expected: 当前分支为 `feat/robinhood-bsc-stock-launchpads`，包含 PR 1 全部提交。

- [ ] **Step 2: 运行基础层测试**

Run: `npm test`

Expected: PASS；失败时停止本计划，不在失败基础上增加平台代码。

### Task 2: 固定 Robinhood O1 合约和股票 quote 清单

**Files:**
- Create: `config/venues/robinhood.json`
- Create: `config/abis/o1-launch-factory.json`
- Modify: `config/assets/robinhood.json`
- Modify: `src/chains/evm-profiles.js`
- Create: `test/robinhood-stock-launchpads.test.js`

- [ ] **Step 1: 写入可信来源和 bytecode 测试**

```js
it("pins the official O1 Robinhood launch suite", () => {
  const o1 = EVM_PROFILES.robinhood.venues.find(({ id }) => id === "o1-v4-robinhood");
  assert.equal(o1.contracts.factory, getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d"));
  assert.equal(o1.contracts.hook, getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc"));
  assert.equal(o1.contracts.poolManager, getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"));
  assert.match(o1.sourceUrl, /^https:\/\/docs\.o1bot\.exchange/);
});

it("rejects an O1 stock quote that is absent from the trusted catalog", () => {
  assert.equal(robinhoodCatalog.lookup(UNVERIFIED_STOCK), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/robinhood-stock-launchpads.test.js`

Expected: FAIL，profile 尚无 `o1-v4-robinhood`。

- [ ] **Step 3: 固定官方 suite 和 ABI**

使用 O1 官方快照中的地址：

```json
{
  "id": "o1-v4-robinhood",
  "identityStatus": "verified",
  "securityCapability": "supported",
  "contracts": {
    "factory": "0xcE9C48cFa068947f77738c81Be406B53338E5B0d",
    "hook": "0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc",
    "poolManager": "0x8366a39CC670B4001A1121B8F6A443A643e40951"
  },
  "sourceUrl": "https://docs.o1bot.exchange/"
}
```

从 O1 官方 production contracts 与 Robinhood Blockscout 已验证实现取得 ABI；两边函数和事件签名必须一致后，原样保存为 `config/abis/o1-launch-factory.json`。启动验证使用 `getCode` 确认三个地址均非 `0x`。

- [ ] **Step 4: 刷新 Robinhood 股票清单**

Run: `npm run refresh-assets -- robinhood`

Expected: `config/assets/robinhood.json` 包含非空、按地址排序的股票资产；每项有 issuer、symbol、source 和验证时间，重复或错误地址使命令失败且不覆写旧文件。

- [ ] **Step 5: 运行 profile 和资产测试并提交**

Run: `node --test test/robinhood-stock-launchpads.test.js test/asset-catalog.test.js test/chain-profiles.test.js`

Expected: PASS。

```bash
git add config/venues/robinhood.json config/abis/o1-launch-factory.json config/assets/robinhood.json src/chains/evm-profiles.js test/robinhood-stock-launchpads.test.js
git commit -m "固定 O1 与 Robinhood 股票资产来源"
```

### Task 3: 实现 O1 发现和安全绑定

**Files:**
- Create: `src/venues/evm/o1.js`
- Create: `src/security/evm/o1.js`
- Modify: `src/app.js`
- Modify: `src/security/evm/index.js`
- Modify: `test/robinhood-stock-launchpads.test.js`
- Create: `test/fixtures/evm/o1-token-launched.json`

- [ ] **Step 1: 保存真实脱敏事件并写失败测试**

```js
it("parses an O1 launch and binds its registered stock quote", () => {
  const event = adapter.parse(fixture("o1-token-launched"));
  assert.equal(event.venue, "o1-v4-robinhood");
  assert.equal(event.lifecyclePhase, "new_launch");
  assert.equal(event.referenceAssetKind, "stock");
  assert.equal(event.metadata.poolResolved, true);
  assert.ok(event.poolId);
});

it("returns unknown when the event quote is not registered by O1 and the asset catalog", async () => {
  const result = await security.inspect(candidateWithUnregisteredQuote());
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "asset-unverified");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/robinhood-stock-launchpads.test.js`

Expected: FAIL，O1 adapter 不存在。

- [ ] **Step 3: 实现 O1 解析器**

`createO1Adapter()` 必须：

```js
return Object.freeze({
  id: "o1-v4-robinhood",
  sourceKind: "launchpad",
  addresses: Object.freeze([factory]),
  topics: Object.freeze([iface.getEvent("TokenLaunched").topicHash]),
  parse(log) {
    const args = iface.parseLog(log).args;
    const pair = classifyPair(args.token, args.quote);
    if (!pair || pair.candidateKind !== "meme") return null;
    return normalizeLaunch({
      ...pair,
      pool: poolManager,
      poolId: String(args.poolId).toLowerCase(),
      creator: getAddress(args.creator),
      lifecyclePhase: "new_launch",
      metadata: { hook, poolResolved: true, factory: getAddress(log.address) },
    });
  },
});
```

事件名和参数名必须以已固定 ABI 为准；如果 ABI 中名称不同，测试使用 ABI 的真实名称，不自造兼容事件。

- [ ] **Step 4: 实现 O1 安全绑定**

安全 adapter 验证 factory、hook、poolManager、poolId 和 quote catalog 后，复用 `createLaunchpadSecurityEntry()` 的真实卖出 receipt 证据。20 秒 anti-snipe 窗口内返回 `unknown:launch-cooldown`，不能把高开盘费误判为永久貔貅。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/robinhood-stock-launchpads.test.js test/evm-security.test.js test/evm-apps.test.js`

Expected: PASS。

```bash
git add src/venues/evm/o1.js src/security/evm/o1.js src/app.js src/security/evm/index.js test/robinhood-stock-launchpads.test.js test/fixtures/evm/o1-token-launched.json
git commit -m "接入 Robinhood O1 扫描与安全绑定"
```

### Task 4: 核验 Pons V1 并移除 Long 启发式身份

**Files:**
- Modify: `config/venues/robinhood.json`
- Modify: `src/venues/evm/pons.js`
- Modify: `src/scanner.js`
- Modify: `src/app.js`
- Modify: `test/scanner-pons.test.js`
- Modify: `test/robinhood-stock-launchpads.test.js`

- [ ] **Step 1: 写入禁止误标测试**

```js
it("does not label an arbitrary stock-quoted pool as Long", async () => {
  const event = await classifyCandidate(stockQuotedUniswapPool());
  assert.notEqual(event.venue, "long-robinhood");
});

it("keeps Pons V1 disabled when its verified ABI or event source is unavailable", () => {
  const capability = registry.get("pons-v1-robinhood");
  assert.equal(capability.identityStatus, "disabled-unverified");
  assert.match(capability.disabledReason, /verified-abi|event-source/);
});
```

- [ ] **Step 2: 运行测试确认当前误标或缺少能力项**

Run: `node --test test/scanner-pons.test.js test/robinhood-stock-launchpads.test.js`

Expected: 至少一项 FAIL。

- [ ] **Step 3: 删除 Long 推断**

删除以“非 Pons + quote token”为依据赋值 `long` 的分支。普通池保留原 DEX venue；Long 只有在 `config/venues/robinhood.json` 中具备 verified factory 和 adapter 时才可能出现。

- [ ] **Step 4: 执行 Pons V1 双重核验**

对 `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` 执行：

```text
eth_chainId == 4663
eth_getCode != 0x
Blockscout verified ABI 可读取
官方 Pons 来源能关联该 factory
真实创建事件可由 ABI 解码
```

五项全部满足时增加 `pons-v1-robinhood` adapter 和 fixture；任一不满足时写入：

```json
{
  "id": "pons-v1-robinhood",
  "identityStatus": "disabled-unverified",
  "securityCapability": "unsupported",
  "disabledReason": "missing-verified-abi-or-event-source"
}
```

Long 使用相同五项标准；没有可信 factory 时保持 `disabled-unverified`。

- [ ] **Step 5: 运行回归并提交**

Run: `node --test test/scanner-pons.test.js test/robinhood-stock-launchpads.test.js test/candidate-gate.test.js`

Expected: PASS；任意普通股票底池不再误标 Long。

```bash
git add config/venues/robinhood.json src/venues/evm/pons.js src/scanner.js src/app.js test/scanner-pons.test.js test/robinhood-stock-launchpads.test.js test/fixtures/evm
git commit -m "严格核验 Pons V1 并移除 Long 误标"
```

### Task 5: 核验并导入 BSC 股票资产

**Files:**
- Modify: `config/assets/bsc.json`
- Modify: `scripts/refresh-asset-catalog.js`
- Create: `test/bsc-stock-assets.test.js`
- Create: `test/fixtures/assets/bsc-stock-sources.json`

- [ ] **Step 1: 写入多发行方和冒充测试**

```js
it("keeps bStocks and 4Stock provenance on each asset", () => {
  const catalog = loadBscCatalog();
  for (const asset of catalog.assets) {
    assert.ok(["BTech Holdings", "Four.meme"].includes(asset.issuer));
    assert.match(asset.sourceUrl, /^https:\/\//);
    assert.ok(asset.sourceId);
    assert.ok(asset.verifiedAt > 0);
  }
});

it("does not accept an unverified bStock-looking ticker", () => {
  assert.equal(loadBscCatalog().lookup(FAKE_NVDA), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bsc-stock-assets.test.js`

Expected: FAIL，BSC 股票清单为空或缺少逐资产来源。

- [ ] **Step 3: 对 bStocks 和 4Stock 分别执行来源审计**

每条资产必须取得官方发行页面或官方 Launchpad 页面中的完整 BSC 地址，并通过 BscScan bytecode 与 ERC-20 metadata 复核。只有名称、ticker 或缩略地址的记录不写入清单。没有合格记录的来源在 fixture 中记录 `disabled-unverified` 和稳定原因码，不创建伪地址。

- [ ] **Step 4: 原子刷新 BSC 清单**

刷新器把两个来源合并成一个按地址排序的文档，每个资产保留自身 `sourceId/sourceUrl/verifiedAt`。同地址来自两个互斥 issuer 时整次刷新失败。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/bsc-stock-assets.test.js test/asset-catalog.test.js test/pair-classification.test.js`

Expected: PASS；未核验资产数量可以为零，但其来源状态必须明确，且不得按 ticker 放行。

```bash
git add config/assets/bsc.json scripts/refresh-asset-catalog.js test/bsc-stock-assets.test.js test/fixtures/assets/bsc-stock-sources.json
git commit -m "增加 BSC 股票资产可信清单"
```

### Task 6: 修通 Four.meme 安全能力

**Files:**
- Create: `src/security/evm/four-meme.js`
- Modify: `src/app.js`
- Modify: `src/security/evm/index.js`
- Modify: `src/candidate-gate.js`
- Modify: `test/bsc-adapters.test.js`
- Modify: `test/evm-security.test.js`

- [ ] **Step 1: 写入毕业前后路由测试**

```js
it("records an unresolved Four.meme launch without a paid deep check", async () => {
  const route = routeCandidate(candidate({ metadata: { poolResolved: false } }), {
    venueRegistry: registry,
    supportsSellability: () => true,
  });
  assert.equal(route.action, "record-only");
});

it("analyzes a graduated Four.meme token only after binding the migration pool", async () => {
  const result = await security.inspect(candidate({ metadata: { poolResolved: true } }), depsWithThreeSells());
  assert.equal(result.status, "confirmed");
  assert.equal(result.bindingVerified, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bsc-adapters.test.js test/evm-security.test.js`

Expected: FAIL，Four.meme 尚未注册安全 entry。

- [ ] **Step 3: 实现严格 pool 绑定**

```js
export function createFourMemeSecurityEntry(profileVenue) {
  return createLaunchpadSecurityEntry({
    chain: "bsc",
    venue: profileVenue.id,
    isPoolResolved: (candidate) => candidate.metadata?.poolResolved === true,
    bind: async (candidate) => ({
      ok: candidate.pool !== profileVenue.contracts.manager,
      reason: "pool-not-resolved",
      pool: candidate.pool,
      excludedAddresses: Object.values(profileVenue.contracts),
    }),
  });
}
```

同时在 `routeCandidate()` 增加通用 launchpad 规则：`sourceKind === "launchpad" && metadata.poolResolved === false` 返回 `{ action: "record-only", reason: "pool-not-resolved" }`，不占用分析 RPC。必须保留毕业交易中解析出的 Pancake V2/V3 pool 身份；不能把 manager 当成池进行安全检查。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/bsc-adapters.test.js test/evm-security.test.js test/evm-runner.test.js`

Expected: PASS；毕业前 record-only，毕业后进入绑定深检。

```bash
git add src/security/evm/four-meme.js src/app.js src/security/evm/index.js src/candidate-gate.js test/bsc-adapters.test.js test/evm-security.test.js
git commit -m "接通 Four.meme 毕业池安全检查"
```

### Task 7: 接入 Flap Portal、税 token 和迁移池

**Files:**
- Create: `config/venues/bsc.json`
- Create: `config/abis/flap-portal.json`
- Create: `src/venues/evm/flap.js`
- Create: `src/security/evm/flap.js`
- Modify: `src/chains/evm-profiles.js`
- Modify: `src/app.js`
- Modify: `src/abis.js`
- Create: `test/fixtures/evm/flap-token-created.json`
- Create: `test/fixtures/evm/flap-migrated.json`
- Create: `test/bsc-stock-launchpads.test.js`

- [ ] **Step 1: 写入官方地址与事件测试**

```js
it("pins Flap Portal v5.8.6 on BNB Chain", () => {
  const flap = EVM_PROFILES.bsc.venues.find(({ id }) => id === "flap-v5-bsc");
  assert.equal(flap.contracts.portal, getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"));
  assert.equal(flap.contracts.vaultPortal, getAddress("0x90497450f2a706f1951b5bdda52B4E5d16f34C06"));
});

it("parses Flap standard and tax launches without directly alerting", () => {
  const event = adapter.parse(fixture("flap-token-created"));
  assert.equal(event.lifecyclePhase, "new_launch");
  assert.equal(event.metadata.taxModel, "tax-v3");
  assert.equal(decideLifecycleAlert({ mode: "live", transitionType: "new_launch" }), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bsc-stock-launchpads.test.js`

Expected: FAIL，Flap profile/adapter 不存在。

- [ ] **Step 3: 固定官方 ABI 和 profile**

使用 Flap 官方 BNB 主网资料固定：Portal `0xe2cE...9De0`、VaultPortal `0x9049...4C06`、版本 `v5.8.6`。下载官方 ABI 后保存原始 JSON；测试计算 event topic，确保与真实 fixture 的 topic0 一致。

- [ ] **Step 4: 实现发现 adapter**

adapter 解析 token 创建、税模型和迁移事件；创建阶段 `poolResolved=false`，迁移阶段从同交易 receipt 中绑定唯一 Pancake pool。多于一个匹配池必须抛出带 tx 上下文的错误。

- [ ] **Step 5: 实现 Flap 安全 adapter**

安全结果包含：

```js
{
  taxModel,
  configuredTaxBps,
  vault: candidate.metadata.vault ?? null,
  poolResolved: true,
  evidenceMode: "observed-sells"
}
```

税率超过现有 `MAX_TAX_BPS` 归为 `blocked:excessive-tax`；无法读取税配置归为 `unknown:tax-config-unavailable`。

- [ ] **Step 6: 运行测试并提交**

Run: `node --test test/bsc-stock-launchpads.test.js test/evm-security.test.js test/bsc-adapters.test.js`

Expected: PASS。

```bash
git add config/venues/bsc.json config/abis/flap-portal.json src/venues/evm/flap.js src/security/evm/flap.js src/chains/evm-profiles.js src/app.js src/abis.js test/bsc-stock-launchpads.test.js test/fixtures/evm
git commit -m "接入 BSC Flap 发射与税风险"
```

### Task 8: 区分 Meme 限制与股票底池限制

**Files:**
- Create: `src/security/evm/reference-asset.js`
- Create: `test/reference-asset-security.test.js`
- Modify: `src/analyze.js`
- Modify: `src/notify.js`
- Modify: `test/notify.test.js`

- [ ] **Step 1: 写入限制归属测试**

```js
it("keeps a stock transfer policy separate from meme sellability", async () => {
  const result = await inspectReferenceAsset(STOCK, { readPolicies });
  assert.deepEqual(result.restrictions, ["transfer-policy"]);
  assert.equal(result.targetSellability, undefined);
});

it("prints reference restrictions without calling the meme a honeypot", () => {
  const text = formatAlert(report({ sellability: confirmed(), referenceRestrictions: ["transfer-policy"] }));
  assert.match(text, /股票底池限制.*transfer-policy/);
  assert.doesNotMatch(text, /貔貅.*已阻断/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/reference-asset-security.test.js test/notify.test.js`

Expected: FAIL，缺少 reference restriction 输出。

- [ ] **Step 3: 实现缓存检查**

`inspectReferenceAsset()` 按 `chain + address + bytecodeHash` 缓存静态 policy/pause/multiplier 能力；调用失败返回 `{ status: "unknown", restrictions: ["reference-check-unavailable"] }`，不得改写目标 Meme 的 sellability。

- [ ] **Step 4: 更新报告并运行测试**

Run: `node --test test/reference-asset-security.test.js test/notify.test.js test/analyze.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/security/evm/reference-asset.js src/analyze.js src/notify.js test/reference-asset-security.test.js test/notify.test.js
git commit -m "区分股票底池与 Meme 交易限制"
```

### Task 9: PR 2 回归、文档和创建 PR

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/multichain-evm.md`

- [ ] **Step 1: 更新启用状态文档**

文档逐项列出 Pons V1/V2、O1、Long、Four.meme、Flap 的 `enabled|discovery-only|disabled-unverified`，并给出 disabledReason。禁止写“已支持”而没有对应 adapter 和 fixture。

- [ ] **Step 2: 运行全量测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 3: 检查差异**

Run: `git diff --check feat/stock-meme-launchpads...HEAD`

Expected: 无输出。

- [ ] **Step 4: 提交文档**

```bash
git add .env.example README.md docs/operations/multichain-evm.md
git commit -m "记录 Robinhood 与 BSC 平台状态"
```

- [ ] **Step 5: 推送并创建串行 PR 2**

```bash
git push -u origin feat/robinhood-bsc-stock-launchpads
gh api repos/hblicy/robinhood-scanner-bot/pulls -f title="接入 Robinhood 与 BSC 股票 Meme 平台" -f head="feat/robinhood-bsc-stock-launchpads" -f base="feat/stock-meme-launchpads" -f body="接入经验证的 O1、Four.meme 与 Flap；Pons V1、Long 按可信来源核验结果启用或明确关闭。普通新币事件不直推，股票底池限制单独报告。"
```

Expected: PR base 指向 PR 1 分支；PR 1 合并后将 base 改为 `main`。
