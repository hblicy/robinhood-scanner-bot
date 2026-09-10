# Base Stock Launchpads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导入 Base 官方 B20 股票清单，支持股票底池方向与 B20 限制报告，并对 O1、Stonks Exchange、BaseStonk 执行严格的可启用性核验。

**Architecture:** Base 股票身份只来自 `base.org/stocks` 的完整合约地址和链上 bytecode。三个 Launchpad 分别拥有能力项；在没有官方或浏览器验证的 factory/ABI/真实事件时保持 `disabled-unverified`，普通 Uniswap/Aerodrome 池不能改变其身份状态。

**Tech Stack:** Node.js 18+、ethers v6、Base B20 interfaces、BaseScan verified contracts、`node:test`。

---

## 文件结构

- Modify: `config/assets/base.json` — Base 官方 B20 股票地址。
- Create: `config/venues/base.json` — 三个平台的证据和状态。
- Create: `config/abis/b20.json` — 官方 B20 只读接口。
- Create when verified by this plan: `src/venues/evm/o1-base.js`、`src/venues/evm/stonks-exchange.js`、`src/venues/evm/base-stonk.js` — 平台专属解析器。
- Create when verified by this plan: `src/security/evm/o1-base.js`、`src/security/evm/stonks-exchange.js`、`src/security/evm/base-stonk.js` — 平台安全绑定。
- Modify: `src/security/evm/reference-asset.js` — B20 multiplier/policy/pause。
- Modify: `src/chains/evm-profiles.js`、`src/app.js`、`src/notify.js` — Base 能力和输出。
- Test: `test/base-stock-assets.test.js`、`test/base-stock-launchpads.test.js`、`test/fixtures/evm/base-*.json`。

### Task 1: 建立串行 PR 3 分支

**Files:**
- Verify only.

- [ ] **Step 1: 从 PR 2 头创建分支**

Run: `git switch -c feat/base-stock-launchpads`

Expected: 当前分支为 `feat/base-stock-launchpads`。

- [ ] **Step 2: 运行现有测试**

Run: `npm test`

Expected: PASS。

### Task 2: 导入并验证 Base 官方 B20 股票清单

**Files:**
- Modify: `config/assets/base.json`
- Modify: `scripts/refresh-asset-catalog.js`
- Create: `test/base-stock-assets.test.js`
- Create: `test/fixtures/assets/base-official-stocks.html`

- [ ] **Step 1: 写入官方列表解析测试**

```js
it("extracts only full Base stock contract links from the official page", () => {
  const document = parseBaseStocksPage(fixture("base-official-stocks.html"));
  assert.ok(document.assets.length >= 10);
  assert.ok(document.assets.every(({ address }) => /^0x[0-9a-fA-F]{40}$/.test(address)));
  assert.ok(document.assets.every(({ issuer, kind }) => issuer === "Coinbase" && kind === "stock"));
});

it("fails closed when the official page contains symbols but no full addresses", () => {
  assert.throws(() => parseBaseStocksPage("<div>NVDAc 0xb200...108C</div>"), /full contract address/i);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/base-stock-assets.test.js`

Expected: FAIL，Base 官方页面 parser 尚不存在。

- [ ] **Step 3: 实现严格 parser**

parser 只接受指向 `basescan.org/token/<40-byte-address>` 或官方嵌入数据中的完整 20-byte 地址；缩略地址、文本 ticker 和未知域名全部拒绝。输出固定来源：

```js
return {
  schemaVersion: 1,
  chain: "base",
  family: "evm",
  source: {
    id: "base-official-stocks",
    url: "https://www.base.org/stocks",
    verifiedAt: now(),
    status: "verified",
  },
  assets: rows.map(({ address, symbol }) => ({
    address, symbol, kind: "stock", issuer: "Coinbase",
    sourceId: "base-official-stocks", sourceUrl: "https://www.base.org/stocks", verifiedAt: now(),
  })),
};
```

- [ ] **Step 4: 刷新并链上验证**

Run: `npm run refresh-assets -- base`

Expected: `config/assets/base.json` 非空且每个地址 `eth_getCode != 0x`；任一失败时旧文件保持不变。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/base-stock-assets.test.js test/asset-catalog.test.js test/pair-classification.test.js`

Expected: PASS。

```bash
git add config/assets/base.json scripts/refresh-asset-catalog.js test/base-stock-assets.test.js test/fixtures/assets/base-official-stocks.html
git commit -m "导入 Base 官方 B20 股票清单"
```

### Task 3: 检查 B20 multiplier、pause 与 transfer policy

**Files:**
- Create: `config/abis/b20.json`
- Modify: `src/security/evm/reference-asset.js`
- Modify: `test/reference-asset-security.test.js`
- Modify: `test/base-stock-assets.test.js`

- [ ] **Step 1: 写入 B20 只读检查测试**

```js
it("reports B20 multiplier and policy controls without blocking the meme by itself", async () => {
  const result = await inspectReferenceAsset(B20, {
    readB20: async () => ({ multiplier: 1_020_000_000_000_000_000n, paused: false, policyIds: [7n] }),
  });
  assert.equal(result.standard, "B20");
  assert.equal(result.multiplier, "1020000000000000000");
  assert.deepEqual(result.restrictions, ["transfer-policy"]);
  assert.equal(result.targetSellability, undefined);
});

it("keeps a failed B20 policy read unknown", async () => {
  const result = await inspectReferenceAsset(B20, { readB20: async () => { throw new Error("rpc down"); } });
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.restrictions, ["reference-check-unavailable"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/reference-asset-security.test.js test/base-stock-assets.test.js`

Expected: FAIL，B20 字段尚未解析。

- [ ] **Step 3: 固定官方 B20 只读 ABI**

从 Base 官方 `base-std` B20 interfaces 原样提取 `multiplier`、pause 和 policy 查询函数到 `config/abis/b20.json`；代码不声明未在官方 interface 中存在的方法。

- [ ] **Step 4: 实现检查与缓存键**

缓存键使用 `base + token + bytecodeHash`。返回：

```js
{
  status: "complete",
  standard: "B20",
  multiplier: String(multiplier),
  paused,
  restrictions: policyIds.length ? ["transfer-policy"] : [],
}
```

`paused === true` 说明 reference 当前不可转移，但目标 Meme 仍保持自身检查结论；报告标记 `reference-asset-restricted`。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/reference-asset-security.test.js test/base-stock-assets.test.js test/notify.test.js`

Expected: PASS。

```bash
git add config/abis/b20.json src/security/evm/reference-asset.js test/reference-asset-security.test.js test/base-stock-assets.test.js
git commit -m "增加 B20 股票底池限制检查"
```

### Task 4: 核验 O1、Stonks Exchange 和 BaseStonk

**Files:**
- Create: `config/venues/base.json`
- Create: `test/base-stock-launchpads.test.js`
- Modify: `src/chains/evm-profiles.js`
- Modify: `src/app.js`

- [ ] **Step 1: 写入三平台显式状态测试**

```js
for (const id of ["o1-base", "stonks-exchange-base", "base-stonk-base"]) {
  it(`${id} has an explicit verified or disabled identity`, () => {
    const venue = registry.get(id);
    assert.ok(venue);
    assert.ok(["verified", "disabled-unverified"].includes(venue.identityStatus));
    if (venue.identityStatus === "disabled-unverified") {
      assert.match(venue.disabledReason, /missing-(factory|verified-abi|event-source)/);
      assert.deepEqual(venue.verifiedContracts, []);
    }
  });
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/base-stock-launchpads.test.js`

Expected: FAIL，Base Venue 清单不存在。

- [ ] **Step 3: 对每个平台执行同一证据审计**

每个平台必须全部满足：

```text
官方项目页面或官方代码仓库给出 Base 主网入口
BaseScan 合约 bytecode 非空且 ABI 已验证
factory/portal 事件能唯一给出 token、reference、pool 和 creator
至少一笔真实创建交易可保存为 fixture
安全检查能绑定真实池、hook/router 或 vault
```

全部满足时记录 `identityStatus=verified` 和完整 contracts/source；否则记录：

```json
{
  "id": "stonks-exchange-base",
  "identityStatus": "disabled-unverified",
  "discoveryCapability": "disabled",
  "lifecycleCapability": "disabled",
  "securityCapability": "unsupported",
  "verifiedContracts": [],
  "disabledReason": "missing-factory-or-verified-abi"
}
```

O1、Stonks Exchange、BaseStonk 必须分别保存状态，不能共享一个模糊的 `base-stock-launchpad` 身份。

- [ ] **Step 4: 只实例化 verified 平台**

`createApp()` 使用：

```js
const enabledBaseLaunchpads = venueRegistry.list().filter((venue) =>
  venue.chain === "base" && venue.identityStatus === "verified"
);
for (const venue of enabledBaseLaunchpads) venues.push(instantiateVerifiedBaseLaunchpad(venue));
```

`instantiateVerifiedBaseLaunchpad()` 只接受三个明确 ID；未知 ID 抛出错误，disabled 条目不会传入。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/base-stock-launchpads.test.js test/base-adapters.test.js test/evm-apps.test.js test/chain-profiles.test.js`

Expected: PASS；启动摘要逐项显示状态。

```bash
git add config/venues/base.json src/chains/evm-profiles.js src/app.js test/base-stock-launchpads.test.js
git commit -m "增加 Base 股票平台可信状态"
```

### Task 5: 为通过核验的平台增加专属 adapter

**Files:**
- Create only for verified entries: `src/venues/evm/o1-base.js`
- Create only for verified entries: `src/venues/evm/stonks-exchange.js`
- Create only for verified entries: `src/venues/evm/base-stonk.js`
- Create only for verified entries: `src/security/evm/o1-base.js`
- Create only for verified entries: `src/security/evm/stonks-exchange.js`
- Create only for verified entries: `src/security/evm/base-stonk.js`
- Modify: `src/app.js`
- Modify: `test/base-stock-launchpads.test.js`
- Create only for verified entries: `test/fixtures/evm/base-o1-launch.json`
- Create only for verified entries: `test/fixtures/evm/base-stonks-exchange-launch.json`
- Create only for verified entries: `test/fixtures/evm/base-stonk-launch.json`

- [ ] **Step 1: 为每个 verified entry 写真实 fixture 测试**

每个测试使用相同严格断言，但绑定平台自己的 ABI：

```js
const event = adapter.parse(realFixture);
assert.equal(event.venue, expectedVenueId);
assert.equal(event.chain, "base");
assert.equal(event.referenceAssetKind, "stock");
assert.equal(event.assetSource, "base-official-stocks");
assert.ok(event.pool || event.poolId);
assert.ok(event.venueIdentityEvidence.factory);
```

若 Task 4 没有 verified entry，本 Task 的验收结果是：不存在任何上述 adapter 文件，三个 capability 均保持 disabled，测试断言 `enabledBaseLaunchpads.length === 0`。

- [ ] **Step 2: 运行测试确认缺少 adapter 或确认全部禁用**

Run: `node --test test/base-stock-launchpads.test.js`

Expected: verified entry 对应测试 FAIL；没有 verified entry 时 disabled 集合测试 PASS。

- [ ] **Step 3: 实现 verified adapter 和安全绑定**

每个 adapter 必须固定自身 factory topics，并通过公共 pair classifier 识别 B20 quote。安全 entry 必须验证实际 pool/hook/router 后再使用 observed sells；不能仅因事件来自 factory 就返回 confirmed。

```js
return createLaunchpadSecurityEntry({
  chain: "base",
  venue: manifest.id,
  isPoolResolved: ({ metadata }) => metadata?.poolResolved === true,
  bind: (candidate) => verifyBaseLaunchPool(candidate, manifest.contracts),
});
```

- [ ] **Step 4: 运行 Base 全套测试并提交**

Run: `node --test test/base-stock-launchpads.test.js test/base-stock-assets.test.js test/base-adapters.test.js test/evm-security.test.js test/evm-runner.test.js`

Expected: PASS。

```bash
git add src/venues/evm src/security/evm src/app.js test/base-stock-launchpads.test.js test/fixtures/evm
git commit -m "接入已验证的 Base 股票发射平台"
```

### Task 6: Base 报告、shadow 验收和 PR 3

**Files:**
- Modify: `src/notify.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/multichain-evm.md`
- Modify: `test/notify.test.js`

- [ ] **Step 1: 写入 Base 股票底池报告测试**

```js
it("shows the verified B20 symbol, address source and venue state", () => {
  const text = formatAlert(baseStockPairReport());
  assert.match(text, /Base/);
  assert.match(text, /B20.*NVDAc/);
  assert.match(text, /base-official-stocks/);
  assert.doesNotMatch(text, /undefined|null/);
});
```

- [ ] **Step 2: 运行测试并实现输出**

Run: `node --test test/notify.test.js`

Expected before change: FAIL；增加 reference asset 行后 PASS。

- [ ] **Step 3: 运行全量测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 4: 提交文档和报告**

```bash
git add src/notify.js .env.example README.md docs/operations/multichain-evm.md test/notify.test.js
git commit -m "补充 Base 股票底池报告与运维说明"
```

- [ ] **Step 5: 本地 shadow 检查**

Run (PowerShell): `$env:BASE_ALERT_MODE="shadow"; npm run scan -- --chain base`

Expected: 输出 B20 资产数量和三个 Venue 状态；不发送 Telegram。

- [ ] **Step 6: 推送并创建串行 PR 3**

```bash
git push -u origin feat/base-stock-launchpads
gh api repos/hblicy/robinhood-scanner-bot/pulls -f title="接入 Base B20 股票 Meme 扫描" -f head="feat/base-stock-launchpads" -f base="feat/robinhood-bsc-stock-launchpads" -f body="导入 Base 官方 B20 合约清单，增加 B20 限制报告，并对 O1、Stonks Exchange、BaseStonk 按官方或浏览器验证证据决定启用状态。"
```

Expected: PR 明确列出真正启用和保持 `disabled-unverified` 的平台。
