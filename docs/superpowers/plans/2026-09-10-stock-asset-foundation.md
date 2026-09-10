# Stock Asset Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可信股票资产注册表、方向无关的交易对分类、Venue 能力表和可持久化的 EVM RPC 次数预算，为后续 Launchpad 接入提供统一基础。

**Architecture:** 受 Git 管理的清单放在 `config/assets`，运行时最后有效快照放在 `data/<chain>/asset-catalog.json`。发现适配器只接收统一 `classifyPair`，Venue 能否深检由能力表决定；RPC 次数预算包裹 provider，并按链持久化到现有状态目录。

**Tech Stack:** Node.js 18+、ES modules、ethers v6、`node:test`、JSON 原子文件写入。

---

## 文件结构

- Create: `src/assets/catalog.js` — 校验、索引和查询可信资产。
- Create: `src/assets/cache.js` — 加载 Git 清单及原子维护运行时快照。
- Create: `src/assets/pair.js` — EVM/Solana 共用的方向无关分类结果。
- Create: `src/assets/sources/http-json.js` — 带 schema 校验的远端 JSON 读取。
- Create: `src/venues/registry.js` — Venue 身份、发现和安全能力表。
- Create: `src/venues/verify.js` — 启动时核验已启用 EVM 合约 bytecode。
- Create: `src/rpc-usage-budget.js` — RPC 次数持久化、阈值和降级决策。
- Create: `scripts/refresh-asset-catalog.js` — 显式刷新受 Git 管理的可信清单。
- Create: `config/assets/{ethereum,base,bsc,robinhood,solana}.json` — 版本化可信来源清单。
- Modify: `src/core/candidate.js` — 扩展候选字段并兼容旧字段。
- Modify: `src/chains/load-chain.js`、`src/app.js`、`src/chain.js` — 加载目录、预算和公共能力。
- Modify: `src/venues/evm/{uniswap,aerodrome,pancakeswap,clanker,four-meme}.js` — 注入分类器。
- Modify: `src/venues/solana/instructions.js`、`src/market.js` — 统一方向处理。
- Modify: `src/evm/runner.js`、`src/candidate-gate.js` — 按能力状态路由。
- Modify: `.env.example`、`README.md` — 配置、预算和运维说明。
- Test: `test/asset-catalog.test.js`、`test/pair-classification.test.js`、`test/venue-registry.test.js`、`test/rpc-usage-budget.test.js`。

### Task 1: 扩展统一候选结构

**Files:**
- Modify: `src/core/candidate.js`
- Modify: `test/candidate.test.js`

- [ ] **Step 1: 写入失败测试**

在 `test/candidate.test.js` 增加：

```js
it("normalizes target and reference assets while retaining legacy aliases", () => {
  const value = normalizeCandidate({
    chain: "base", chainFamily: "evm", venue: "o1-base", sourceKind: "launchpad",
    targetToken: TOKEN, referenceAsset: QUOTE, targetSide: "token1",
    targetAssetKind: "meme", referenceAssetKind: "stock",
    referenceAssetIssuer: "Coinbase", assetSource: "base-official-stocks",
    assetVerifiedAt: 1_789_000_000_000,
    pool: POOL, poolId: null, creator: null, blockOrSlot: 1,
    transactionId: TX, eventIndex: 0, createdAt: null,
    lifecyclePhase: "new_launch", sourceProvenance: "fixture-v1",
  });
  assert.equal(value.token, value.targetToken);
  assert.equal(value.quoteToken, value.referenceAsset);
  assert.equal(value.referenceAssetKind, "stock");
});

it("upgrades legacy token and quoteToken inputs without losing compatibility", () => {
  const value = normalizeCandidate(legacyCandidate());
  assert.equal(value.targetToken, value.token);
  assert.equal(value.referenceAsset, value.quoteToken);
  assert.equal(value.referenceAssetKind, "unknown");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/candidate.test.js`

Expected: FAIL，`targetToken` 或 `referenceAsset` 为 `undefined`。

- [ ] **Step 3: 实现兼容字段**

在 `normalizeCandidate()` 中使用同一规范化地址生成新旧字段：

```js
const targetToken = normalizeIdentity("targetToken", input.targetToken ?? input.token, chainFamily);
const referenceAsset = normalizeIdentity(
  "referenceAsset",
  input.referenceAsset ?? input.quoteToken,
  chainFamily
);
const targetSide = input.targetSide == null ? null : requiredString("targetSide", input.targetSide);
if (targetSide != null && !new Set(["token0", "token1", "base", "quote"]).has(targetSide)) {
  throw new Error(`unsupported targetSide ${targetSide}`);
}
const referenceAssetKind = input.referenceAssetKind ?? "unknown";

// 在 normalizeCandidate() 现有返回对象中替换旧地址字段并追加：
{
  token: targetToken,
  quoteToken: referenceAsset,
  targetToken,
  referenceAsset,
  targetSide,
  pairDirection: input.pairDirection ?? null,
  targetAssetKind: input.targetAssetKind ?? "unknown",
  referenceAssetKind,
  referenceAssetIssuer: input.referenceAssetIssuer ?? null,
  assetSource: input.assetSource ?? null,
  assetVerifiedAt: input.assetVerifiedAt ?? null,
  referenceRestrictions: Object.freeze([...(input.referenceRestrictions ?? [])]),
}
```

同步把 `candidateKey()`、`notificationKey()` 的主地址读取改为 `targetToken ?? token`。

- [ ] **Step 4: 运行候选测试**

Run: `node --test test/candidate.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/candidate.js test/candidate.test.js
git commit -m "扩展股票底池候选结构"
```

### Task 2: 建立可信资产目录与最后有效快照

**Files:**
- Create: `src/assets/catalog.js`
- Create: `src/assets/cache.js`
- Create: `test/asset-catalog.test.js`

- [ ] **Step 1: 写入目录校验测试**

```js
it("indexes verified EVM assets by normalized address", () => {
  const catalog = createAssetCatalog({
    chain: "base", family: "evm", schemaVersion: 1,
    source: { id: "base-official-stocks", url: "https://www.base.org/stocks", verifiedAt: 1 },
    assets: [{
      address: TOKEN.toLowerCase(), symbol: "NVDAc", kind: "stock", issuer: "Coinbase",
      sourceId: "base-official-stocks", sourceUrl: "https://www.base.org/stocks", verifiedAt: 1,
    }],
  });
  assert.equal(catalog.lookup(TOKEN).issuer, "Coinbase");
  assert.equal(catalog.has(QUOTE), false);
});

it("rejects duplicate, malformed and unverified asset records", () => {
  assert.throws(() => createAssetCatalog(invalidDuplicateCatalog()), /duplicate asset/i);
  assert.throws(() => createAssetCatalog(invalidSourceCatalog()), /source/i);
});

it("keeps the last valid snapshot when refresh validation fails", async () => {
  const cache = createAssetCatalogCache({ readJson, atomicWriteJson });
  const result = await cache.refresh({ current: validCatalog, load: async () => invalidCatalog });
  assert.equal(result.catalog, validCatalog);
  assert.equal(result.status, "stale");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/asset-catalog.test.js`

Expected: FAIL，无法导入 `src/assets/catalog.js`。

- [ ] **Step 3: 实现目录模型**

`src/assets/catalog.js` 的公共接口固定为：

```js
export function createAssetCatalog(document) {
  validateCatalogDocument(document);
  const normalize = document.family === "evm"
    ? (value) => getAddress(value).toLowerCase()
    : (value) => new PublicKey(value).toBase58();
  const byAddress = new Map();
  for (const asset of document.assets) {
    const key = normalize(asset.address);
    if (byAddress.has(key)) throw new Error(`duplicate asset ${key}`);
    byAddress.set(key, Object.freeze({ ...asset, address: normalize(asset.address) }));
  }
  return Object.freeze({
    chain: document.chain,
    family: document.family,
    source: Object.freeze({ ...document.source }),
    assets: Object.freeze([...byAddress.values()]),
    has: (address) => byAddress.has(normalize(address)),
    lookup: (address) => byAddress.get(normalize(address)) ?? null,
  });
}
```

校验必须要求 `schemaVersion === 1`、chain/family/source 完整、`kind` 属于 `stock|stable|native|crypto`、issuer 非空。每条资产还必须有 `sourceId`、HTTPS `sourceUrl` 和正整数 `verifiedAt`，从而允许 BSC 同一清单同时保存 bStocks、4Stock 等不同官方来源。

- [ ] **Step 4: 实现原子快照缓存**

`src/assets/cache.js` 暴露：

```js
export function createAssetCatalogCache({ readJson, atomicWriteJson }) {
  return Object.freeze({
    load({ shippedPath, runtimePath }) {
      const document = readJson(runtimePath) ?? readJson(shippedPath);
      return createAssetCatalog(document);
    },
    async refresh({ current, runtimePath, load }) {
      try {
        const next = createAssetCatalog(await load());
        atomicWriteJson(runtimePath, serializeAssetCatalog(next));
        return { catalog: next, status: "fresh", error: null };
      } catch (error) {
        return { catalog: current, status: "stale", error };
      }
    },
  });
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/asset-catalog.test.js`

Expected: PASS。

```bash
git add src/assets/catalog.js src/assets/cache.js test/asset-catalog.test.js
git commit -m "新增可信资产目录与快照缓存"
```

### Task 3: 增加版本化清单和显式刷新命令

**Files:**
- Create: `config/assets/ethereum.json`
- Create: `config/assets/base.json`
- Create: `config/assets/bsc.json`
- Create: `config/assets/robinhood.json`
- Create: `config/assets/solana.json`
- Create: `src/assets/sources/http-json.js`
- Create: `scripts/refresh-asset-catalog.js`
- Modify: `package.json`
- Create: `test/asset-refresh.test.js`

- [ ] **Step 1: 写入远端 schema 与原子输出测试**

```js
it("writes a sorted catalog only after every remote record validates", async () => {
  const written = [];
  const result = await refreshAssetCatalog({
    chain: "robinhood",
    sourceUrl: "https://docs.o1.exchange/robinhood-stock-quotes.json",
    fetchImpl: async () => jsonResponse([{ address: TOKEN, symbol: "NVDA", issuer: "Robinhood" }]),
    write: (document) => written.push(document),
  });
  assert.equal(result.assets.length, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].assets[0].kind, "stock");
});

it("does not write a partial catalog after one invalid row", async () => {
  const written = [];
  await assert.rejects(() => refreshAssetCatalog({
    chain: "base", sourceUrl: "https://www.base.org/stocks",
    fetchImpl: async () => jsonResponse([{ address: "bad", symbol: "BAD" }]),
    write: (document) => written.push(document),
  }), /invalid/i);
  assert.equal(written.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/asset-refresh.test.js`

Expected: FAIL，刷新模块不存在。

- [ ] **Step 3: 创建初始清单**

五个文件统一使用以下完整结构，初始 `assets` 仅写经过对应 PR 核验的记录；未核验链使用空数组而不是猜测地址：

```json
{
  "schemaVersion": 1,
  "chain": "ethereum",
  "family": "evm",
  "source": {
    "id": "no-verified-stock-source",
    "url": null,
    "verifiedAt": 0,
    "status": "disabled-unverified"
  },
  "assets": []
}
```

对于启用来源，`source.url` 必须是真实官方 URL，`verifiedAt` 必须为实际抓取时间；校验器只允许 `disabled-unverified` 使用空 URL 和空资产，不允许将空清单标记为 enabled。

- [ ] **Step 4: 实现刷新入口**

`scripts/refresh-asset-catalog.js` 只接受白名单 source：

```js
const SOURCES = Object.freeze({
  robinhood: "https://docs.o1.exchange/robinhood-stock-quotes.json",
});
const source = process.argv[2];
if (!Object.hasOwn(SOURCES, source)) throw new Error(`unsupported asset source ${source}`);
await runAssetRefresh({ source, url: SOURCES[source] });
```

HTTP 模块必须设置超时、检查状态码、验证 JSON content-type，并把异常包装为 `asset-registry-unavailable`，保留 cause。

- [ ] **Step 5: 增加 npm 命令并验证**

```json
"refresh-assets": "node scripts/refresh-asset-catalog.js"
```

Run: `node --test test/asset-refresh.test.js test/asset-catalog.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add config/assets src/assets/sources scripts/refresh-asset-catalog.js package.json test/asset-refresh.test.js
git commit -m "增加可信资产清单刷新入口"
```

### Task 4: 实现方向无关的交易对分类

**Files:**
- Create: `src/assets/pair.js`
- Create: `test/pair-classification.test.js`
- Modify: `src/venues/evm/uniswap.js`
- Modify: `src/venues/evm/aerodrome.js`
- Modify: `src/venues/evm/pancakeswap.js`
- Modify: `src/venues/evm/clanker.js`
- Modify: `src/venues/evm/four-meme.js`
- Modify: `src/venues/solana/instructions.js`
- Modify: `src/market.js`

- [ ] **Step 1: 写入正反方向和冒充测试**

```js
const classify = createPairClassifier({ catalog, nativeQuotes: [WETH, USDC], normalizeAddress: getAddress });

it("selects the meme side when the verified stock is token0 or token1", () => {
  assert.equal(classify(STOCK, MEME).targetToken, getAddress(MEME));
  assert.equal(classify(MEME, STOCK).referenceAsset, getAddress(STOCK));
});

it("does not trust a stock-looking ticker without a catalog address match", () => {
  const result = classify(MEME_NAMED_NVDA, UNKNOWN);
  assert.equal(result, null);
});

it("marks stock versus stable as reference liquidity instead of a meme", () => {
  assert.equal(classify(STOCK, USDC).candidateKind, "reference-liquidity");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/pair-classification.test.js`

Expected: FAIL，`createPairClassifier` 不存在。

- [ ] **Step 3: 实现分类器**

```js
export function createPairClassifier({ catalog, nativeQuotes = [], normalizeAddress }) {
  const normalize = (value) => normalizeAddress(value);
  const quoteSet = new Set(nativeQuotes.map(normalize));
  const describe = (value) => {
    const address = normalize(value);
    const asset = catalog.lookup(address);
    if (asset) return { ...asset, address };
    if (quoteSet.has(address)) return { address, kind: "native", issuer: null, source: null };
    return { address, kind: "unknown", issuer: null, source: null };
  };
  const isLiquidReference = ({ kind }) => ["stable", "native", "crypto"].includes(kind);
  const makeCandidate = (target, reference, targetSide) => ({
    candidateKind: "meme",
    targetToken: target.address,
    referenceAsset: reference.address,
    targetSide,
    referenceAssetKind: reference.kind,
    referenceAssetIssuer: reference.issuer,
    assetSource: reference.sourceId ?? null,
    assetVerifiedAt: reference.verifiedAt ?? null,
  });
  return (left, right, { leftSide = "token0", rightSide = "token1" } = {}) => {
    const a = describe(left);
    const b = describe(right);
    if (a.kind === "stock" && b.kind === "unknown") return makeCandidate(b, a, rightSide);
    if (b.kind === "stock" && a.kind === "unknown") return makeCandidate(a, b, leftSide);
    if (isLiquidReference(a) && b.kind === "unknown") return makeCandidate(b, a, rightSide);
    if (isLiquidReference(b) && a.kind === "unknown") return makeCandidate(a, b, leftSide);
    if (a.kind === "stock" && isLiquidReference(b)) return { candidateKind: "reference-liquidity" };
    if (b.kind === "stock" && isLiquidReference(a)) return { candidateKind: "reference-liquidity" };
    return null;
  };
}
```

- [ ] **Step 4: 向适配器注入同一个分类器**

把各 EVM adapter 的 `quoteAddresses` 参数替换为 `classifyPair`，解析时统一：

```js
const picked = classifyPair(args.token0, args.token1);
if (!picked || picked.candidateKind !== "meme") return null;
return {
  token: picked.targetToken,
  quoteToken: picked.referenceAsset,
  targetToken: picked.targetToken,
  referenceAsset: picked.referenceAsset,
  targetSide: picked.targetSide,
  referenceAssetKind: picked.referenceAssetKind,
  referenceAssetIssuer: picked.referenceAssetIssuer,
  assetSource: picked.assetSource,
  assetVerifiedAt: picked.assetVerifiedAt,
  ...venueFields,
};
```

`selectDexPair()` 必须同时检查 base/quote 两侧与目标地址，不能只要求目标是 `baseToken`。

- [ ] **Step 5: 运行适配器和市场测试**

Run: `node --test test/pair-classification.test.js test/market.test.js test/base-adapters.test.js test/bsc-adapters.test.js test/pump-adapter.test.js test/raydium-adapter.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/assets/pair.js src/venues src/market.js test/pair-classification.test.js test/market.test.js test/base-adapters.test.js test/bsc-adapters.test.js
git commit -m "统一股票底池交易对方向"
```

### Task 5: 建立 Venue 能力注册表并替换启发式路由

**Files:**
- Create: `src/venues/registry.js`
- Create: `src/venues/verify.js`
- Create: `test/venue-registry.test.js`
- Modify: `src/app.js`
- Modify: `src/candidate-gate.js`
- Modify: `src/evm/runner.js`
- Modify: `src/scanner.js`

- [ ] **Step 1: 写入状态与禁用原因测试**

```js
it("exposes enabled, discovery-only and disabled-unverified capabilities", () => {
  const registry = createVenueRegistry([
    venue({ id: "pons-v2-robinhood", identityStatus: "verified", securityCapability: "supported" }),
    venue({ id: "four-meme-v2-bsc", identityStatus: "verified", securityCapability: "discovery-only" }),
    venue({ id: "long-robinhood", identityStatus: "disabled-unverified", securityCapability: "unsupported", disabledReason: "missing-factory" }),
  ]);
  assert.equal(registry.route("pons-v2-robinhood").action, "analyze");
  assert.equal(registry.route("four-meme-v2-bsc").action, "record-only");
  assert.equal(registry.route("long-robinhood").reason, "venue-disabled-unverified");
});

it("rejects an enabled EVM venue whose verified contract has no bytecode", async () => {
  await assert.rejects(() => verifyVenueDeployments(verifiedVenue, {
    getCode: async () => "0x",
  }), /venue-contract-missing/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/venue-registry.test.js`

Expected: FAIL，能力注册表不存在。

- [ ] **Step 3: 实现严格能力表**

```js
export function createVenueRegistry(entries) {
  const byId = new Map(entries.map(validateVenueEntry).map((entry) => [entry.id, Object.freeze(entry)]));
  return Object.freeze({
    get: (id) => byId.get(id) ?? null,
    list: () => Object.freeze([...byId.values()]),
    route(id) {
      const entry = byId.get(id);
      if (!entry || entry.identityStatus === "disabled-unverified") {
        return { action: "skip", reason: "venue-disabled-unverified" };
      }
      if (entry.securityCapability !== "supported") {
        return { action: "record-only", reason: "venue-security-unsupported" };
      }
      return { action: "analyze", reason: null };
    },
  });
}
```

`src/venues/verify.js` 对 `identityStatus=verified` 的每个 `verifiedContracts` 调用一次 `getCode`；空 bytecode 抛出带 chain/venue/address 的 `venue-contract-missing`，disabled 条目不产生 RPC。

- [ ] **Step 4: 接入应用和候选路由**

`createApp()` 创建 `venueRegistry` 并放入 config；`routeCandidate()` 首先执行：

```js
const capability = venueRegistry.route(candidate.venue);
if (capability.action !== "analyze") return capability;
```

然后才执行 sellability 支持和分数上界判断。删除 Robinhood 中“非 Pons 股票 quote 等于 Long”的身份推断，只有已验证 adapter 能写入 `venue`。

- [ ] **Step 5: 运行路由回归**

Run: `node --test test/venue-registry.test.js test/candidate-gate.test.js test/evm-runner.test.js test/scanner-pons.test.js test/robinhood-app.test.js`

Expected: PASS；discovery-only 候选被记录但不深检，未验证 Venue 有稳定原因码。

- [ ] **Step 6: 提交**

```bash
git add src/venues/registry.js src/venues/verify.js src/app.js src/candidate-gate.js src/evm/runner.js src/scanner.js test/venue-registry.test.js test/candidate-gate.test.js test/evm-runner.test.js
git commit -m "增加 Venue 能力门控"
```

### Task 6: 增加可持久化 RPC 次数预算

**Files:**
- Create: `src/rpc-usage-budget.js`
- Create: `test/rpc-usage-budget.test.js`
- Modify: `src/rpc-budget.js`
- Modify: `src/chain.js`
- Modify: `src/chains/load-chain.js`
- Modify: `src/app.js`
- Modify: `test/chain.test.js`
- Modify: `test/chain-profiles.test.js`

- [ ] **Step 1: 写入月份、阈值和重启恢复测试**

```js
it("persists calls by method and enters the configured degradation stages", () => {
  const budget = createRpcUsageBudget({ limit: 100, initial: { month: "2026-09", total: 79, methods: {} }, now });
  budget.record("eth_getLogs");
  assert.equal(budget.snapshot().stage, "throttled");
  for (let i = 0; i < 15; i++) budget.record("eth_call");
  assert.equal(budget.snapshot().stage, "critical");
  for (let i = 0; i < 5; i++) budget.record("eth_call");
  assert.throws(() => budget.assertAllowed("analysis"), /rpc-budget-exhausted/);
});

it("starts a new counter when the UTC billing month changes", () => {
  const budget = createRpcUsageBudget({ limit: 100, initial: { month: "2026-08", total: 100, methods: {} }, now });
  assert.equal(budget.snapshot().total, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/rpc-usage-budget.test.js`

Expected: FAIL，预算模块不存在。

- [ ] **Step 3: 实现预算状态机**

```js
function stageFor(total, limit) {
  const ratio = total / limit;
  if (ratio >= 1) return "exhausted";
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.8) return "throttled";
  return "normal";
}

export function createRpcUsageBudget({ limit, initial, persist, now = Date.now }) {
  let state = normalizeMonth(initial, now());
  let dirty = false;
  return Object.freeze({
    record(method) {
      state.total += 1;
      state.methods[method] = (state.methods[method] ?? 0) + 1;
      dirty = true;
      return stageFor(state.total, limit);
    },
    assertAllowed(role) {
      if (stageFor(state.total, limit) === "exhausted" && role !== "discovery-public") {
        throw new Error("rpc-budget-exhausted");
      }
    },
    flush() {
      if (!dirty) return false;
      persist?.(structuredClone(state));
      dirty = false;
      return true;
    },
    snapshot: () => Object.freeze({ ...structuredClone(state), limit, stage: stageFor(state.total, limit) }),
  });
}
```

`app.js` 每 60 秒原子 flush 到 `data/<chain>/rpc-usage.json`，并在正常退出时再 flush；不得每次 RPC 都写磁盘。异常断电最多损失一个 flush 周期的本地计数，Dwellir API Key 的服务端 2000 万 quota 仍负责硬限制。

- [ ] **Step 4: 在 JSON-RPC 传输层准确计数**

保留 `createBudgetedProvider()` 的每秒速率控制；在 `chain.js` 使用子类覆盖 ethers 的 `_send`，按真实 JSON-RPC payload 计数，避免高层 `getLogs()` 与底层 `send()` 重复计数：

```js
class MeteredJsonRpcProvider extends JsonRpcProvider {
  constructor(request, network, options, { usageBudget, role }) {
    super(request, network, options);
    this.usageBudget = usageBudget;
    this.usageRole = role;
  }

  async _send(payload) {
    const requests = Array.isArray(payload) ? payload : [payload];
    this.usageBudget?.assertAllowed(this.usageRole);
    for (const request of requests) this.usageBudget?.record(String(request.method || "unknown"));
    return super._send(payload);
  }
}
```

同一个规范化 URL 仍由 `createRoleProviders()` 只构造一个实例，因此 discovery/analysis 复用时每个真实 payload 只记录一次。

usage budget 只绑定该链的 `analysisUrl`：官方 `discoveryUrl` 不计入 Dwellir 月额度；当 discovery fallback 实际复用 analysis provider 时，其请求自然计入。同一 URL 同时承担两个角色时整条链的所有请求都会计入。

- [ ] **Step 5: 增加链级默认额度**

`loadChainConfig()` 读取：

```text
BSC_MONTHLY_RPC_LIMIT=5500000
ETHEREUM_MONTHLY_RPC_LIMIT=4500000
ROBINHOOD_MONTHLY_RPC_LIMIT=5000000
BASE_MONTHLY_RPC_LIMIT=3000000
```

并要求四链合计不由单进程推断；README 明确供应商 Key 的 2000 万硬额度仍是最终保险。

- [ ] **Step 6: 运行预算和 provider 测试**

Run: `node --test test/rpc-usage-budget.test.js test/rpc-budget.test.js test/chain.test.js test/chain-profiles.test.js`

Expected: PASS；相同 URL 复用 provider 时每次方法调用只记一次。

- [ ] **Step 7: 提交**

```bash
git add src/rpc-usage-budget.js src/rpc-budget.js src/chain.js src/chains/load-chain.js src/app.js test/rpc-usage-budget.test.js test/rpc-budget.test.js test/chain.test.js test/chain-profiles.test.js
git commit -m "增加 EVM RPC 月度次数预算"
```

### Task 7: 接入启动摘要、降级策略和运维文档

**Files:**
- Modify: `src/evm/runner.js`
- Modify: `src/scanner.js`
- Modify: `src/index.js`
- Modify: `src/assets/cache.js`
- Modify: `src/chains/load-chain.js`
- Modify: `src/notify.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/multichain-evm.md`
- Modify: `test/index.test.js`
- Modify: `test/notify.test.js`

- [ ] **Step 1: 写入启动摘要和预算降级测试**

```js
it("prints asset, venue and RPC usage status without credentials", async () => {
  const lines = [];
  await printStartupSummary(configWithSecretRpc(), { log: (line) => lines.push(line) });
  const text = lines.join("\n");
  assert.match(text, /assets=.*venues=.*rpc-budget=/);
  assert.doesNotMatch(text, /secret-api-key/);
});

it("does not turn budget exhaustion into a safe sellability result", async () => {
  const result = await runCandidateAtExhaustedBudget();
  assert.equal(result.sellability.status, "unknown");
  assert.equal(result.sellability.reason, "rpc-budget-exhausted");
});

it("refreshes only runtime-enabled asset sources every six hours and retains a stale snapshot", async () => {
  let refreshCalls = 0;
  let tick;
  const scheduler = createAssetRefreshScheduler({
    intervalMs: 21_600_000,
    refresh: async () => { refreshCalls += 1; return lastValidCatalog; },
    setIntervalImpl: (callback) => { tick = callback; return 1; },
  });
  await scheduler.start();
  assert.equal(refreshCalls, 1);
  await tick();
  assert.equal(refreshCalls, 2);
  assert.equal(scheduler.currentCatalog(), lastValidCatalog);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/index.test.js test/notify.test.js`

Expected: FAIL，启动摘要缺少资产/Venue/预算字段。

- [ ] **Step 3: 实现可观测输出**

启动行固定包含：

```js
log(`${profile.name} assets=${catalog.assets.length} assetSnapshot=${catalog.source.verifiedAt}`);
log(`venues ${venueRegistry.list().map(({ id, identityStatus, securityCapability }) => `${id}:${identityStatus}/${securityCapability}`).join(" ")}`);
log(`rpc-budget ${usage.total}/${usage.limit} stage=${usage.stage}`);
```

每小时输出 `chain + method counts + cache hits + projected monthly total`。throttled 阶段加长市场补漏间隔，critical 阶段让低优先级候选 `record-only`，exhausted 阶段只停止受限分析端点。

`createAssetRefreshScheduler()` 在 watch 启动时刷新一次，此后使用 `ASSET_REFRESH_MS`（默认 `21600000`）调度；只运行 source manifest 明确声明 `runtimeRefresh=true` 的 JSON/on-chain 来源。Base 等版本化静态清单不在常驻进程抓网页。刷新失败保留 current catalog，并记录 `asset-registry-unavailable`。

- [ ] **Step 4: 更新配置和运维说明**

`.env.example` 写入 `ASSET_REFRESH_MS=21600000`、四链默认额度和 80/95/100% 行为；README 明确本地计数适用于单主机单实例，供应商 Key 的硬 quota 负责跨进程和其他主机的最终上限。

- [ ] **Step 5: 运行全量测试**

Run: `npm test`

Expected: 全部测试 PASS，进程无未处理 Promise rejection。

- [ ] **Step 6: 提交**

```bash
git add src/evm/runner.js src/scanner.js src/index.js src/assets/cache.js src/chains/load-chain.js src/notify.js .env.example README.md docs/operations/multichain-evm.md test/index.test.js test/notify.test.js
git commit -m "补充资产与 RPC 预算运维输出"
```

### Task 8: PR 1 验收

**Files:**
- Verify only.

- [ ] **Step 1: 检查范围和格式**

Run: `git diff --check origin/main...HEAD`

Expected: 无输出。

- [ ] **Step 2: 运行全量测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 3: 运行只读启动检查**

Run: `npm run scan -- --chain robinhood`

Expected: 启动摘要显示资产/Venue/预算；未配置 Telegram 时只在终端输出；不读取私钥、不广播交易。

- [ ] **Step 4: 推送并创建 PR 1**

```bash
git push -u origin feat/stock-meme-launchpads
gh api repos/hblicy/robinhood-scanner-bot/pulls -f title="建立五链股票资产与能力基础" -f head="feat/stock-meme-launchpads" -f base="fix/watch-analysis-binding" -f body="增加可信资产目录、方向无关交易对分类、Venue 能力门控和 EVM RPC 月度预算。未验证平台保持关闭；测试结果见提交记录。"
```

Expected: PR 只包含设计文档和基础层改动；正文列出测试结果、RPC 预算和未验证 Venue 的关闭状态。PR #10 合并后把该 PR 的 base 改为 `main`。
