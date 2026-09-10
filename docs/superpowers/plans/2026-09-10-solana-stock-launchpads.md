# Solana xStocks and Stonk Fun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 Backed 官方 API 导入 Solana xStocks，正确识别 Meme/xStock 池，并在取得可信 Program 证据时接入 Stonk Fun 发现和资金流安全检查。

**Architecture:** xStocks 作为可信 reference asset 加入 Solana 资产目录，现有 Pump/Raydium 指令解析改用公共 pair classifier。Stonk Fun 只有 Program ID、指令布局、池/vault 账户约束全部可验证时才实例化，否则以 `disabled-unverified` 出现在启动摘要中。

**Tech Stack:** Node.js 18+、`@solana/web3.js`、`@solana/spl-token`、Backed xStocks REST API、`node:test`。

---

## 文件结构

- Modify: `config/assets/solana.json` — xStocks mint 清单。
- Modify: `config/assets/ethereum.json`、`config/assets/bsc.json` — Backed API 明确发布在对应网络的 xStocks ERC-20 地址。
- Create: `config/venues/solana.json` — Stonk Fun Program 证据和能力状态。
- Create: `src/assets/sources/xstocks.js` — Backed token API parser。
- Modify: `scripts/refresh-asset-catalog.js` — `xstocks` 刷新命令。
- Create when verified by this plan: `src/venues/solana/stonk-fun.js` — Program 指令解析。
- Create when verified by this plan: `src/security/solana/stonk-fun.js` — pool/vault/mint 绑定。
- Modify: `src/chains/solana-profile.js`、`src/venues/solana/instructions.js`、`src/app.js`。
- Modify: `src/security/solana/index.js`、`src/security/solana/flows.js`、`src/solana/analyze.js`。
- Modify: `src/notify.js`、`.env.example`、`README.md`、`docs/operations/multichain-solana.md`。
- Test: `test/xstocks-catalog.test.js`、`test/stonk-fun-adapter.test.js`、`test/solana-security.test.js`、`test/fixtures/solana/*`。

### Task 1: 建立串行 PR 4 分支

**Files:**
- Verify only.

- [ ] **Step 1: 从 PR 3 头创建分支**

Run: `git switch -c feat/solana-stock-launchpads`

Expected: 当前分支为 `feat/solana-stock-launchpads`。

- [ ] **Step 2: 运行当前全量测试**

Run: `npm test`

Expected: PASS。

### Task 2: 从 Backed 公共 token API 导入 Solana xStocks

**Files:**
- Create: `src/assets/sources/xstocks.js`
- Modify: `scripts/refresh-asset-catalog.js`
- Modify: `config/assets/solana.json`
- Modify: `config/assets/ethereum.json`
- Modify: `config/assets/bsc.json`
- Create: `test/xstocks-catalog.test.js`
- Create: `test/fixtures/assets/xstocks-token-response.json`

- [ ] **Step 1: 保存脱敏 API fixture 并写失败测试**

```js
it("extracts only Solana token contracts from the public xStocks token endpoint", () => {
  const document = parseXStocksTokens(fixture("xstocks-token-response.json"), { network: "solana" });
  assert.ok(document.assets.length > 0);
  assert.ok(document.assets.every(({ kind, issuer }) => kind === "stock" && issuer === "Backed"));
  assert.ok(document.assets.every(({ address }) => new PublicKey(address)));
});

it("rejects duplicate mints and rows without network provenance", () => {
  assert.throws(() => parseXStocksTokens(duplicateMintFixture(), { network: "solana" }), /duplicate asset/i);
  assert.throws(() => parseXStocksTokens(missingNetworkFixture(), { network: "solana" }), /network/i);
});

it("keeps Solana, Ethereum and BSC contracts in separate chain catalogs", () => {
  const solana = parseXStocksTokens(fixture("xstocks-token-response.json"), { network: "solana", chain: "solana", family: "solana" });
  const ethereum = parseXStocksTokens(fixture("xstocks-token-response.json"), { network: "ethereum", chain: "ethereum", family: "evm" });
  assert.ok(solana.assets.every(({ address }) => !address.startsWith("0x")));
  assert.ok(ethereum.assets.every(({ address }) => address.startsWith("0x")));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/xstocks-catalog.test.js`

Expected: FAIL，`parseXStocksTokens` 不存在。

- [ ] **Step 3: 实现 API parser**

Backed 官方公共 endpoint 使用 `GET https://api.backed.fi/api/v1/token`。parser 只接收响应中明确声明 Solana network 的 contract：

```js
function normalizeTokenRows(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.tokens;
  if (!Array.isArray(rows)) throw new Error("xStocks token response must contain an array");
  return rows;
}

function normalizeNetwork(value) {
  const key = String(value || "").trim().toLowerCase();
  return new Map([
    ["solana", "solana"],
    ["ethereum", "ethereum"],
    ["ethereum mainnet", "ethereum"],
    ["bnb smart chain", "bsc"],
    ["bsc", "bsc"],
  ]).get(key) ?? key;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`xStocks ${field} is required`);
  return value.trim();
}

export function parseXStocksTokens(payload, {
  network = "solana",
  chain = network,
  family = network === "solana" ? "solana" : "evm",
  now = Date.now,
} = {}) {
  const rows = normalizeTokenRows(payload).flatMap((token) =>
    token.contracts
      .filter((contract) => normalizeNetwork(contract.network) === network)
      .map((contract) => ({
        address: family === "solana"
          ? new PublicKey(contract.address).toBase58()
          : getAddress(contract.address),
        symbol: requiredString(token.symbol, "symbol"),
        kind: "stock",
        issuer: "Backed",
        isin: token.isin ?? null,
        sourceId: "backed-xstocks-api",
        sourceUrl: "https://api.backed.fi/api/v1/token",
        verifiedAt: now(),
      }))
  );
  return {
    schemaVersion: 1,
    chain,
    family,
    source: { id: "backed-xstocks-api", url: "https://api.backed.fi/api/v1/token", verifiedAt: now(), status: "verified" },
    assets: rows,
  };
}
```

响应字段与 fixture 不一致时以官方 OpenAPI schema 的真实字段为准，并同步 parser 测试；禁止猜测缺失 network。

- [ ] **Step 4: 链上验证 mint**

Solana 刷新批量使用 `getMultipleAccountsInfo`，要求每个 mint 存在且 owner 等于 `TOKEN_PROGRAM_ID` 或 `TOKEN_2022_PROGRAM_ID`；EVM 刷新要求对应链 `eth_getCode != 0x`。任一目标链验证失败时，该链旧快照保持不变，其他链也不混入它的地址。

- [ ] **Step 5: 刷新并测试**

Run: `npm run refresh-assets -- xstocks`

Expected: `config/assets/solana.json` 非空；API 中明确存在 Ethereum/BSC contract 时分别合并进对应清单。每链地址去重并按 symbol/address 排序。

Run: `node --test test/xstocks-catalog.test.js test/asset-catalog.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/assets/sources/xstocks.js scripts/refresh-asset-catalog.js config/assets/solana.json config/assets/ethereum.json config/assets/bsc.json test/xstocks-catalog.test.js test/fixtures/assets/xstocks-token-response.json
git commit -m "导入多链 xStocks 官方资产清单"
```

### Task 3: 让 Solana 指令解析支持 Meme/xStock 两个方向

**Files:**
- Modify: `src/venues/solana/instructions.js`
- Modify: `src/venues/solana/pump.js`
- Modify: `src/venues/solana/raydium.js`
- Modify: `test/pump-adapter.test.js`
- Modify: `test/raydium-adapter.test.js`
- Modify: `test/pair-classification.test.js`

- [ ] **Step 1: 写入 xStock 位于 base/quote 两侧测试**

```js
it("selects the meme when xStock is baseMint", () => {
  const event = parsePool(instruction({ baseMint: XSTOCK, quoteMint: MEME }));
  assert.equal(event.targetToken, MEME);
  assert.equal(event.referenceAsset, XSTOCK);
  assert.equal(event.targetSide, "quote");
});

it("selects the meme when xStock is quoteMint", () => {
  const event = parsePool(instruction({ baseMint: MEME, quoteMint: XSTOCK }));
  assert.equal(event.targetToken, MEME);
  assert.equal(event.targetSide, "base");
});

it("does not analyze xStock versus USDC as a meme", () => {
  assert.equal(parsePool(instruction({ baseMint: XSTOCK, quoteMint: USDC })), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/pump-adapter.test.js test/raydium-adapter.test.js test/pair-classification.test.js`

Expected: 至少一个 xStock 方向测试 FAIL。

- [ ] **Step 3: 替换本地 quote 判断**

修复 `instructions.js` 中未定义的 `mintA/mintB` 返回变量，并统一调用基础层 classifier：

```js
export function pickPoolAssets(baseMint, quoteMint, classifyPair) {
  const result = classifyPair(baseMint, quoteMint, { leftSide: "base", rightSide: "quote" });
  if (!result || result.candidateKind !== "meme") return null;
  return {
    token: result.targetToken,
    quoteToken: result.referenceAsset,
    targetToken: result.targetToken,
    referenceAsset: result.referenceAsset,
    targetIsA: result.targetSide === "base",
    targetSide: result.targetSide,
    referenceAssetKind: result.referenceAssetKind,
    referenceAssetIssuer: result.referenceAssetIssuer,
  };
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/pump-adapter.test.js test/raydium-adapter.test.js test/pair-classification.test.js test/solana-discovery.test.js`

Expected: PASS。

```bash
git add src/venues/solana/instructions.js src/venues/solana/pump.js src/venues/solana/raydium.js test/pump-adapter.test.js test/raydium-adapter.test.js test/pair-classification.test.js
git commit -m "支持 Solana 股票底池双向识别"
```

### Task 4: 核验 Stonk Fun Program 和指令布局

**Files:**
- Create: `config/venues/solana.json`
- Modify: `src/chains/solana-profile.js`
- Create: `test/stonk-fun-adapter.test.js`

- [ ] **Step 1: 写入显式能力状态测试**

```js
it("declares Stonk Fun as verified or disabled-unverified with evidence", () => {
  const venue = venueRegistry.get("stonk-fun-solana");
  assert.ok(venue);
  assert.ok(["verified", "disabled-unverified"].includes(venue.identityStatus));
  if (venue.identityStatus === "verified") {
    assert.doesNotThrow(() => new PublicKey(venue.programId));
    assert.match(venue.sourceUrl, /^https:\/\//);
    assert.ok(venue.idlRevision);
  } else {
    assert.equal(venue.programId, null);
    assert.equal(venue.disabledReason, "missing-verified-program-or-idl");
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/stonk-fun-adapter.test.js`

Expected: FAIL，Stonk Fun capability 不存在。

- [ ] **Step 3: 执行 Program 证据审计**

启用必须同时满足：

```text
项目官方页面或官方仓库公布 Program ID
getAccountInfo(programId).executable === true
ProgramData/upgrade authority 可记录
官方 IDL 或可与多笔真实交易一致的固定指令布局
至少一笔 Meme/xStock 建池交易可保存为 fixture
池和 vault 账户 owner/offset 可验证
```

全部满足时写入 verified Program；否则固定写入：

```json
{
  "id": "stonk-fun-solana",
  "identityStatus": "disabled-unverified",
  "programId": null,
  "idlRevision": null,
  "discoveryCapability": "disabled",
  "securityCapability": "unsupported",
  "disabledReason": "missing-verified-program-or-idl"
}
```

- [ ] **Step 4: 只向 profile 加入 verified Program**

```js
const verifiedPrograms = venueManifest.filter(({ identityStatus }) => identityStatus === "verified");
programs.push(...verifiedPrograms.map(defineProgram));
```

disabled 条目只进入 Venue 启动摘要，不进入 `assertSolanaPrograms()`。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/stonk-fun-adapter.test.js test/solana-config.test.js test/solana-app.test.js`

Expected: PASS。

```bash
git add config/venues/solana.json src/chains/solana-profile.js test/stonk-fun-adapter.test.js
git commit -m "增加 Stonk Fun 可信能力状态"
```

### Task 5: 为 verified Stonk Fun 增加指令 adapter

**Files:**
- Create only when Task 4 is verified: `src/venues/solana/stonk-fun.js`
- Modify: `src/app.js`
- Modify: `test/stonk-fun-adapter.test.js`
- Create only when Task 4 is verified: `test/fixtures/solana/stonk-fun-create-pool.json`

- [ ] **Step 1: 写入真实指令 fixture 测试**

```js
const event = adapter.parse(fixture("stonk-fun-create-pool"));
assert.equal(event.venue, "stonk-fun-solana");
assert.equal(event.lifecyclePhase, "new_launch");
assert.equal(event.referenceAssetKind, "stock");
assert.equal(event.referenceAssetIssuer, "Backed");
assert.equal(event.metadata.poolProgramId, manifest.programId);
assert.ok(event.metadata.baseVault);
assert.ok(event.metadata.quoteVault);
```

若 Task 4 为 disabled，本 Task 验收为：`createSolanaApplication()` 不导入 `stonk-fun.js`，且 `venues` 中没有 Stonk Fun adapter。

- [ ] **Step 2: 运行测试确认缺少 adapter 或确认禁用**

Run: `node --test test/stonk-fun-adapter.test.js`

Expected: verified 状态下 fixture 测试 FAIL；disabled 状态下实例化排除测试 PASS。

- [ ] **Step 3: 实现真实指令解析**

adapter 只匹配 manifest Program ID 和已固定 discriminator：

```js
if (programId !== manifest.programId || !data.subarray(0, 8).equals(CREATE_POOL_DISCRIMINATOR)) return null;
const binding = decodeCreatePoolAccounts(instruction, transactionKeys);
const pair = classifyPair(binding.baseMint, binding.quoteMint);
if (!pair || pair.referenceAssetKind !== "stock") return null;
return normalizeCandidate({ ...pair, ...binding, venue: manifest.id, lifecyclePhase: "new_launch" });
```

账户数量、索引或 owner 不符必须抛出带 signature/instructionIndex 的解析错误，不能返回猜测字段。

- [ ] **Step 4: 运行 adapter 测试并提交**

Run: `node --test test/stonk-fun-adapter.test.js test/solana-discovery.test.js test/solana-app.test.js`

Expected: PASS。

```bash
git add src/venues/solana/stonk-fun.js src/app.js test/stonk-fun-adapter.test.js test/fixtures/solana
git commit -m "接入已验证的 Stonk Fun 指令发现"
```

### Task 6: 绑定 Stonk Fun 池、vault 与真实卖出资金流

**Files:**
- Create only when Task 4 is verified: `src/security/solana/stonk-fun.js`
- Modify: `src/security/solana/index.js`
- Modify: `src/security/solana/flows.js`
- Modify: `src/solana/analyze.js`
- Modify: `test/solana-security.test.js`
- Modify: `test/stonk-fun-adapter.test.js`

- [ ] **Step 1: 写入绑定和资金流测试**

```js
it("confirms only after three independent Meme inflows and xStock outflows", async () => {
  const result = await security.inspect(stonkCandidate(), depsWithThreeBoundSells());
  assert.equal(result.status, "confirmed");
  assert.equal(result.meaningfulSellers, 3);
  assert.equal(result.quoteOutflowTransactions, 3);
});

it("keeps a wrong xStock vault owner unknown", async () => {
  const result = await security.inspect(stonkCandidate(), depsWithWrongVaultOwner());
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "pool-binding-mismatch");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/solana-security.test.js test/stonk-fun-adapter.test.js`

Expected: verified 状态下 Stonk Fun 安全测试 FAIL；disabled 状态下 registry 不支持该 Venue。

- [ ] **Step 3: 实现 Program 专属 binding**

```js
export async function validateStonkFunBinding(candidate, { connection, manifest }) {
  const accounts = await connection.getMultipleAccountsInfo([
    candidate.pool,
    candidate.metadata.baseVault,
    candidate.metadata.quoteVault,
  ].map((value) => new PublicKey(value)), "finalized");
  const expectedPoolOwner = new PublicKey(manifest.poolProgramId ?? manifest.programId);
  if (!accounts[0]?.owner.equals(expectedPoolOwner)) {
    return { verified: false, reason: "pool-binding-mismatch" };
  }
  return validateVaultMints(accounts, candidate);
}
```

真实资金流复用 `observeSolanaSellTransactions()`，但必须把 target/reference vault 方向随 `targetSide` 绑定。xStock mint 的 Token-2022 扩展只记录在 reference restrictions，不把 Meme 直接判为 blocked。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/solana-security.test.js test/stonk-fun-adapter.test.js test/solana-analyze.test.js`

Expected: PASS。

```bash
git add src/security/solana/stonk-fun.js src/security/solana/index.js src/security/solana/flows.js src/solana/analyze.js test/solana-security.test.js test/stonk-fun-adapter.test.js
git commit -m "增加 Stonk Fun 池与卖出资金流验证"
```

### Task 7: Solana 报告、shadow 验收和 PR 4

**Files:**
- Modify: `src/notify.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/multichain-solana.md`
- Modify: `test/notify.test.js`
- Modify: `test/solana-runner.test.js`

- [ ] **Step 1: 写入 xStock 报告和不直推测试**

```js
it("shows xStock reference source and mint in the Solana report", () => {
  const text = formatAlert(solanaXStockReport());
  assert.match(text, /xStocks.*Backed/);
  assert.match(text, new RegExp(XSTOCK_MINT));
});

it("does not send a raw Stonk Fun launch", () => {
  assert.equal(decideLifecycleAlert({ mode: "live", transitionType: "new_launch" }), null);
});
```

- [ ] **Step 2: 运行测试并实现输出**

Run: `node --test test/notify.test.js test/solana-runner.test.js`

Expected before change: FAIL；增加 reference 行和严格 lifecycle 路由后 PASS。

- [ ] **Step 3: 更新运维文档**

记录 `npm run refresh-assets -- xstocks`、最后有效快照、Stonk Fun 启用状态以及 `SOLANA_ALERT_MODE=shadow` 的验收方式。明确 Solana 不占 EVM 1800 万调用目标。

- [ ] **Step 4: 运行全量测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/notify.js .env.example README.md docs/operations/multichain-solana.md test/notify.test.js test/solana-runner.test.js
git commit -m "补充 Solana xStock 推送与运维说明"
```

- [ ] **Step 6: 运行 shadow 检查**

Run (PowerShell): `$env:SOLANA_ALERT_MODE="shadow"; npm run scan -- --chain solana`

Expected: 启动摘要显示 xStocks 数量和 Stonk Fun 状态；不发送 Telegram；程序不读取私钥。

- [ ] **Step 7: 推送并创建串行 PR 4**

```bash
git push -u origin feat/solana-stock-launchpads
gh api repos/hblicy/robinhood-scanner-bot/pulls -f title="接入 Solana xStocks 与 Stonk Fun" -f head="feat/solana-stock-launchpads" -f base="feat/base-stock-launchpads" -f body="导入 Backed 官方 xStocks mint，支持 Meme/xStock 双向交易对，并按可验证 Program/IDL 决定 Stonk Fun 是否启用。"
```

Expected: PR 明确说明 Stonk Fun 的 verified 或 disabled-unverified 证据结论。
