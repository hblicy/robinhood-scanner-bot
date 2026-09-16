# Robinhood Scanner No-Alert Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除历史 Pons 检查积压和首次链上大区间阻塞，使 Robinhood 扫描器持续推进游标、按原策略推送，并留下可追溯运行日志。

**Architecture:** 将状态升级到 schema v6，用可审计的 `expired` 终态原子整理旧任务；Pons 生命周期改为每个事件一个完整 inspection。Pending worker 使用独立的公平选择器，普通链上 worker 以 200 区块为提交单元，健康格式化模块只输出游标和计数，不接触凭据。

**Tech Stack:** Node.js ESM、`node:test`、JSON 原子状态文件、ethers、GNU screen、Telegram outbox。

---

## 文件职责

- `src/store.js`：schema v6、pending check 原子整理、Pons 新任务替代旧任务、调用公平选择器。
- `src/pending-checks.js`：纯函数实现 due task 分桶、排序和轮询选择。
- `src/scanner.js`：Pons 单任务调度、pending bucket 游标、200 区块链上提交单元、worker 日志接线。
- `src/candidate-recovery.js`：只有 pending candidate recovery 才恢复活跃 key。
- `src/scanner-health.js`：无凭据的启动整理、worker 活动和每小时状态摘要。
- `test/store.test.js`：v5 → v6、批量过期、canonical 合并、原子失败和 Pons supersede。
- `test/pending-checks.test.js`：三桶选择与小 limit 轮转。
- `test/scanner-pons.test.js`：单一 inspection 和 pending worker 行为。
- `test/index.test.js`：bootstrap cursor、200 区块分段、失败重试和日志。
- `test/candidate-recovery.test.js`：failed/expired 不再占用 recovery key。
- `test/scanner-health.test.js`：健康汇总和凭据不泄漏。
- `README.md`、`docs/operations/multichain-evm.md`：带日志的 screen 启动、备份和验收命令。

### Task 1: schema v6 与旧 pending check 原子整理

**Files:**
- Modify: `src/store.js:8-125,127-205,430-508`
- Modify: `test/store.test.js:1-330`

- [ ] **Step 1: 写 v5 迁移、509 × 4 超龄任务、窗口内 canonical 和写盘失败测试**

在 `test/store.test.js` 增加以下 helper 和用例。批量用例复现生产任务形态；窗口内用例验证幂等合并；失败用例验证内存状态不被污染。

```js
function stateFile(overrides = {}) {
  return {
    schemaVersion: 5,
    seen: {},
    positions: {},
    trades: [],
    cursors: { onchain: null, ponsV2: 100, solanaPrograms: {} },
    tokens: {},
    watchlist: [],
    heat: null,
    appliedEvents: {},
    outbox: {},
    pendingChecks: {},
    ...overrides,
  };
}

it("migrates v5 to v6 without losing lifecycle data", () => {
  const dir = tempDir();
  const raw = stateFile({
    tokens: { [TOKEN.toLowerCase()]: tokenState({ birthAt: 500 }) },
    pendingChecks: {
      [`${EVENT_ID}:holders`]: {
        id: `${EVENT_ID}:holders`,
        eventId: EVENT_ID,
        type: "holders",
        token: TOKEN,
        dueAt: 600,
        status: "pending",
        attempts: 3,
        nextAttemptAt: 700,
        createdAt: 500,
        completedAt: null,
        lastError: "rate limited",
      },
    },
  });
  write(dir, "state.json", JSON.stringify(raw));

  const store = createStore({ dataDir: dir, now: () => 1_000 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));

  assert.equal(saved.schemaVersion, 6);
  assert.deepEqual(saved.tokens, raw.tokens);
  assert.deepEqual(saved.pendingChecks, raw.pendingChecks);
  assert.deepEqual(store.snapshot().cursors, raw.cursors);
});

it("rejects an unsupported pending-check status", () => {
  const dir = tempDir();
  write(dir, "state.json", JSON.stringify(stateFile({
    pendingChecks: {
      bad: { id: "bad", type: "holders", status: "forgotten", nextAttemptAt: 1, createdAt: 1 },
    },
  })));
  assert.throws(() => createStore({ dataDir: dir }), /pending check bad has invalid status/);
});

it("expires a production-sized legacy Pons backlog without deleting audit records", () => {
  const dir = tempDir();
  const now = 2_000_000;
  const tokens = {};
  const pendingChecks = {};
  const types = ["curve_flow", "holders", "deployer_24h", "line_a"];
  for (let index = 1; index <= 509; index += 1) {
    const token = `0x${String(index).padStart(40, "0")}`;
    const eventId = `4663:0x${String(index).padStart(64, "0")}:0`;
    tokens[token] = tokenState({ token, birthAt: 1_000 });
    for (const type of types) {
      const id = `${eventId}:${type}`;
      pendingChecks[id] = {
        id,
        eventId,
        type,
        token,
        dueAt: 1_000,
        status: "pending",
        attempts: 4,
        nextAttemptAt: 1_500,
        createdAt: 1_000,
        completedAt: null,
        lastError: "timeout",
      };
    }
  }
  write(dir, "state.json", JSON.stringify(stateFile({ tokens, pendingChecks })));
  const store = createStore({ dataDir: dir, now: () => now });

  const result = store.reconcilePendingChecks({ at: now, maxAgeMinutes: 30 });
  const state = store.snapshot();

  assert.deepEqual(result, {
    scanned: 2036,
    expired: 2036,
    canonicalCreated: 0,
    reasons: { "outside-alert-window": 2036 },
  });
  assert.equal(Object.keys(state.pendingChecks).length, 2036);
  assert.equal(Object.values(state.pendingChecks).every((check) => check.status === "expired"), true);
});

it("consolidates fresh legacy checks once and remains idempotent", () => {
  const dir = tempDir();
  const now = 100_000;
  const pendingChecks = Object.fromEntries(
    ["curve_flow", "holders", "deployer_24h", "line_a"].map((type, index) => {
      const id = `${EVENT_ID}:${type}`;
      return [id, {
        id,
        eventId: EVENT_ID,
        type,
        token: TOKEN,
        dueAt: 90_000 + index,
        status: "pending",
        attempts: index,
        nextAttemptAt: 95_000 + index,
        createdAt: 80_000 + index,
        completedAt: null,
        lastError: `error-${index}`,
      }];
    })
  );
  write(dir, "state.json", JSON.stringify(stateFile({
    tokens: { [TOKEN.toLowerCase()]: tokenState({ birthAt: 90_000 }) },
    pendingChecks,
  })));
  const store = createStore({ dataDir: dir, now: () => now });

  const first = store.reconcilePendingChecks({ at: now, maxAgeMinutes: 30 });
  const second = store.reconcilePendingChecks({ at: now, maxAgeMinutes: 30 });
  const state = store.snapshot();
  const canonical = state.pendingChecks[`${EVENT_ID}:pons_inspection`];

  assert.equal(first.canonicalCreated, 1);
  assert.equal(first.expired, 4);
  assert.deepEqual(second, { scanned: 0, expired: 0, canonicalCreated: 0, reasons: {} });
  assert.equal(canonical.type, "pons_inspection");
  assert.equal(canonical.attempts, 3);
  assert.equal(canonical.nextAttemptAt, 95_000);
  assert.equal(Object.values(state.pendingChecks).filter((check) => check.status === "pending").length, 1);
});

it("keeps in-memory pending checks unchanged when reconciliation cannot persist", () => {
  const dir = tempDir();
  const id = `${EVENT_ID}:holders`;
  write(dir, "state.json", JSON.stringify({
    ...stateFile({
      schemaVersion: 6,
      tokens: { [TOKEN.toLowerCase()]: tokenState({ birthAt: 1_000 }) },
      pendingChecks: {
        [id]: {
          id,
          eventId: EVENT_ID,
          type: "holders",
          token: TOKEN,
          dueAt: 1_000,
          status: "pending",
          attempts: 0,
          nextAttemptAt: 1_000,
          createdAt: 1_000,
          completedAt: null,
          lastError: null,
        },
      },
    }),
  }));
  const store = createStore({
    dataDir: dir,
    now: () => 2_000_000,
    writeState: () => { throw new Error("rename failed"); },
  });
  const before = store.snapshot();

  assert.throws(
    () => store.reconcilePendingChecks({ at: 2_000_000, maxAgeMinutes: 30 }),
    /rename failed/
  );
  assert.deepEqual(store.snapshot(), before);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/store.test.js`

Expected: FAIL；schema 仍为 5，且 `reconcilePendingChecks` 尚不存在。

- [ ] **Step 3: 实现 schema v6、过期 helper 与原子整理 API**

在 `src/store.js` 修改版本接受范围，并加入这些常量和 helper：

```js
const STATE_VERSION = 6;
const PENDING_CHECK_STATUSES = new Set(["pending", "completed", "failed", "expired"]);
const LEGACY_PONS_CHECK_TYPES = new Set([
  "curve_flow",
  "holders",
  "deployer_24h",
  "line_a",
  "market",
  "line_c",
]);

function expireCheckEntry(entry, expiredAt, expirationReason) {
  entry.status = "expired";
  entry.expiredAt = expiredAt;
  entry.expirationReason = expirationReason;
}

function incrementReason(summary, reason) {
  summary.expired += 1;
  summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
}

function validatePendingChecks(checks) {
  for (const [id, entry] of Object.entries(checks)) {
    if (!PENDING_CHECK_STATUSES.has(entry?.status)) {
      throw new Error(`state.json pending check ${id} has invalid status`);
    }
  }
}

function isEvmAddress(value) {
  return /^0x[0-9a-f]{40}$/.test(String(value || "").toLowerCase());
}
```

将 schema 校验改为：

```js
if (![3, 4, 5, STATE_VERSION].includes(raw.schemaVersion)) {
  throw new Error(`state.json must use schemaVersion 3, 4, 5, or ${STATE_VERSION}`);
}
```

在现有 `validateObject(lifecycle.pendingChecks, "pendingChecks")` 后调用：

```js
validatePendingChecks(lifecycle.pendingChecks);
```

在 store 返回对象中加入原子整理方法：

```js
reconcilePendingChecks({ at = now(), maxAgeMinutes }) {
  if (!Number.isFinite(at) || !Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
    throw new Error("pending-check reconciliation requires a finite time and positive maxAgeMinutes");
  }
  return commit((draft) => {
    const summary = { scanned: 0, expired: 0, canonicalCreated: 0, reasons: {} };
    const groups = new Map();
    const expire = (entry, reason) => {
      expireCheckEntry(entry, at, reason);
      incrementReason(summary, reason);
    };

    for (const entry of Object.values(draft.pendingChecks)) {
      if (entry?.status !== "pending" || !LEGACY_PONS_CHECK_TYPES.has(entry.type)) continue;
      summary.scanned += 1;
      const token = String(entry.token || "").toLowerCase();
      const tokenState = draft.tokens[token];
      if (!tokenState) {
        expire(entry, "token-state-missing");
        continue;
      }
      const valid = isEvmAddress(token)
        && String(entry.eventId || "")
        && Number.isFinite(tokenState.birthAt)
        && Number.isFinite(entry.dueAt)
        && Number.isFinite(entry.nextAttemptAt)
        && Number.isFinite(entry.createdAt);
      if (!valid) {
        expire(entry, "invalid-pending-check");
        continue;
      }
      if (at - tokenState.birthAt > maxAgeMinutes * 60_000) {
        expire(entry, "outside-alert-window");
        continue;
      }
      const group = groups.get(token) || [];
      group.push(entry);
      groups.set(token, group);
    }

    for (const checks of groups.values()) {
      checks.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      const source = checks.at(-1);
      const canonicalId = `${source.eventId}:pons_inspection`;
      if (!draft.pendingChecks[canonicalId]) {
        draft.pendingChecks[canonicalId] = {
          id: canonicalId,
          eventId: source.eventId,
          type: "pons_inspection",
          token: source.token,
          dueAt: Math.min(...checks.map((check) => check.dueAt)),
          status: "pending",
          attempts: Math.max(...checks.map((check) => Number(check.attempts || 0))),
          nextAttemptAt: Math.min(...checks.map((check) => check.nextAttemptAt)),
          createdAt: Math.min(...checks.map((check) => check.createdAt)),
          completedAt: null,
          lastError: source.lastError ?? null,
        };
        summary.canonicalCreated += 1;
      }
      for (const entry of checks) expire(entry, `superseded-by:${canonicalId}`);
    }
    return summary;
  });
},
```

- [ ] **Step 4: 更新旧 schema 断言并运行 GREEN**

把 `test/store.test.js` 中预期 `schemaVersion === 5` 的旧断言改为 6，不改变其余历史字段断言。

Run: `node --test test/store.test.js`

Expected: PASS，所有 store tests 通过。

- [ ] **Step 5: 提交状态迁移**

```bash
git add src/store.js test/store.test.js
git commit -m "修复：整理历史检查积压"
```

### Task 2: Pons 生命周期只创建一个完整 inspection

**Files:**
- Modify: `src/scanner.js:67-80,247-309`
- Modify: `src/store.js:330-388`
- Modify: `test/scanner-pons.test.js:58-250,330-380`
- Modify: `test/store.test.js:341-487`

- [ ] **Step 1: 将 Pons 测试改为单任务，并增加较新事件替代旧任务的测试**

在 `test/scanner-pons.test.js` 将 launch 后的断言改为：

```js
const inspectionId = `${EVENT_ID}:pons_inspection`;
assert.ok(state.pendingChecks[inspectionId]);
assert.equal(state.pendingChecks[inspectionId].type, "pons_inspection");
assert.equal(Object.keys(state.pendingChecks).length, 1);
```

将 inspection handler 用例中的 check ID 和 handler type 改为 `pons_inspection`，并明确验证一次执行只调用一次完整 inspect：

```js
let inspections = 0;
const handlers = createInspectionCheckHandlers({
  provider: {},
  store,
  now: () => 20_000,
  inspect: async () => {
    inspections += 1;
    return {
      token: TOKEN,
      identity: "pons-v2",
      protocolPhase: "not_graduated",
      monitorState: "killed",
      marketReady: false,
      riskDataStatus: "known",
      reasons: ["cannot-sell"],
      curve: { status: "sufficient", tradeCount: 5, uniqueTraders: 3, bidirectional: false },
      timedOut: false,
      errors: [],
    };
  },
});
const result = await runPendingChecks({ store, handlers, now: () => 20_000, limit: 1 });
assert.equal(inspections, 1);
assert.equal(result.completed, 1);
assert.equal(store.snapshot().pendingChecks[inspectionId].status, "completed");
```

在 `test/store.test.js` 增加新生命周期事件 supersede 用例：

```js
it("expires an older pending Pons inspection when a newer lifecycle event is committed", () => {
  const store = openStore(tempDir());
  const oldId = `${EVENT_ID}:pons_inspection`;
  const nextEventId = `4663:${"0x" + "cd".repeat(32)}:2`;
  const nextId = `${nextEventId}:pons_inspection`;
  store.commitPonsRange({
    toBlock: 120,
    transitions: [{
      eventId: EVENT_ID,
      blockNumber: 120,
      token: TOKEN,
      nextToken: tokenState({ birthAt: 900 }),
      checks: [{ id: oldId, eventId: EVENT_ID, type: "pons_inspection", token: TOKEN, dueAt: 1_000 }],
    }],
  });
  store.commitPonsRange({
    toBlock: 121,
    transitions: [{
      eventId: nextEventId,
      blockNumber: 121,
      token: TOKEN,
      nextToken: tokenState({ birthAt: 900, protocolPhase: "pool_created" }),
      checks: [{ id: nextId, eventId: nextEventId, type: "pons_inspection", token: TOKEN, dueAt: 1_000 }],
    }],
  });

  const state = store.snapshot();
  assert.equal(state.pendingChecks[oldId].status, "expired");
  assert.equal(state.pendingChecks[oldId].expirationReason, `superseded-by:${nextId}`);
  assert.equal(state.pendingChecks[nextId].status, "pending");
});
```

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `node --test test/scanner-pons.test.js test/store.test.js`

Expected: FAIL；当前仍生成四个检查，handler map 没有 `pons_inspection`，store 不会 supersede。

- [ ] **Step 3: 把生命周期调度和 handler 收敛为 `pons_inspection`**

在 `src/scanner.js` 替换 `lifecycleChecks`：

```js
function lifecycleChecks(event, state, now) {
  if (!new Set(["token_launched", "pool_graduated"]).has(event.kind)) return [];
  return [{
    id: `${event.eventId}:pons_inspection`,
    eventId: event.eventId,
    type: "pons_inspection",
    token: state.token,
    dueAt: now,
  }];
}
```

让 `createInspectionCheckHandlers` 只返回一个 handler：

```js
return { pons_inspection: handle };
```

在 `src/store.js` 的 `commitPonsRange` 写入新 check 前，原子过期同 token 的旧 pending inspection：

```js
for (const check of transition.checks || []) {
  if (!check?.id) throw new Error(`Pons transition ${eventId} check id is required`);
  if (check.type === "pons_inspection") {
    for (const existing of Object.values(draft.pendingChecks)) {
      if (existing.status !== "pending" || existing.type !== "pons_inspection") continue;
      if (String(existing.token || "").toLowerCase() !== token || existing.id === check.id) continue;
      expireCheckEntry(existing, now(), `superseded-by:${check.id}`);
    }
  }
  if (!draft.pendingChecks[check.id]) {
    draft.pendingChecks[check.id] = {
      ...structuredClone(check),
      eventId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: check.dueAt ?? now(),
      createdAt: now(),
      completedAt: null,
      lastError: null,
    };
  }
}
```

- [ ] **Step 4: 更新旧测试 ID 并运行 GREEN**

在 `test/scanner-pons.test.js` 和 `test/store.test.js` 中，把本功能相关的 `curve_flow/holders/market/line_a` 持久化期望改为 `pons_inspection`；保留 Task 1 的 legacy fixture，因为它验证升级兼容。

Run: `node --test test/scanner-pons.test.js test/store.test.js`

Expected: PASS。

- [ ] **Step 5: 提交 Pons 单任务化**

```bash
git add src/scanner.js src/store.js test/scanner-pons.test.js test/store.test.js
git commit -m "修复：合并重复的 Pons 检查"
```

### Task 3: Pending worker 三桶公平调度

**Files:**
- Create: `src/pending-checks.js`
- Create: `test/pending-checks.test.js`
- Modify: `src/store.js:1-6,430-435`
- Modify: `src/scanner.js:1-52,139-195,1237-1243`
- Modify: `src/candidate-recovery.js:41-44`
- Modify: `test/scanner-pons.test.js:139-205`
- Modify: `test/candidate-recovery.test.js:32-60`

- [ ] **Step 1: 为纯选择器、bucket cursor 和 candidate active key 写 RED 测试**

创建 `test/pending-checks.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { PENDING_CHECK_BUCKET_COUNT, selectDueChecks } from "../src/pending-checks.js";

function check(id, type, nextAttemptAt) {
  return { id, type, status: "pending", nextAttemptAt, createdAt: nextAttemptAt };
}

test("interleaves realtime, Pons and other due checks", () => {
  const entries = [
    check("candidate-old", "candidate_recovery", 1),
    check("candidate-new", "candidate_recheck", 2),
    check("pons-old", "pons_inspection", 1),
    check("pons-new", "pons_inspection", 2),
    check("other-old", "custom", 1),
  ];
  const selected = selectDueChecks(entries, { at: 10, limit: 5, startBucket: 0 });
  assert.deepEqual(selected.map(({ id }) => id), [
    "candidate-old",
    "pons-old",
    "other-old",
    "pons-new",
    "candidate-new",
  ]);
});

test("rotating start buckets prevents starvation when limit is one", () => {
  const entries = [
    check("candidate", "candidate_recovery", 1),
    check("pons", "pons_inspection", 1),
    check("other", "custom", 1),
  ];
  const ids = Array.from({ length: PENDING_CHECK_BUCKET_COUNT }, (_, startBucket) =>
    selectDueChecks(entries, { at: 10, limit: 1, startBucket })[0].id
  );
  assert.deepEqual(ids, ["candidate", "pons", "other"]);
});

test("ignores future and terminal checks", () => {
  const selected = selectDueChecks([
    check("due", "pons_inspection", 1),
    check("future", "candidate_recovery", 11),
    { ...check("expired", "candidate_recovery", 1), status: "expired" },
    { ...check("failed", "candidate_recovery", 1), status: "failed" },
  ], { at: 10, limit: 20, startBucket: 0 });
  assert.deepEqual(selected.map(({ id }) => id), ["due"]);
});
```

把 `test/candidate-recovery.test.js` 的 active key 用例改成 pending、failed、expired、completed 四种状态，并断言只有 pending token 被返回：

```js
import { candidateKey } from "../src/runtime.js";

assert.equal(keys.size, 1);
assert.equal(keys.has(candidateKey(event)), true);
```

在 `test/scanner-pons.test.js` 增加 bucket cursor 返回断言：

```js
const result = await runPendingChecks({
  store,
  handlers: { candidate_recovery: async () => undefined },
  now: () => 2_000,
  limit: 1,
  startBucket: 2,
});
assert.equal(result.selected, 1);
assert.equal(result.nextBucketCursor, 0);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/pending-checks.test.js test/candidate-recovery.test.js test/scanner-pons.test.js`

Expected: FAIL；纯选择器文件不存在，failed recovery 仍被视为 active，worker 不返回 cursor。

- [ ] **Step 3: 实现纯三桶选择器并接入 store**

创建 `src/pending-checks.js`：

```js
export const PENDING_CHECK_BUCKET_COUNT = 3;

const REALTIME_TYPES = new Set(["candidate_recovery", "candidate_recheck"]);
const PONS_TYPES = new Set([
  "pons_inspection",
  "curve_flow",
  "holders",
  "deployer_24h",
  "line_a",
  "market",
  "line_c",
]);

export function pendingCheckBucket(type) {
  if (REALTIME_TYPES.has(type)) return 0;
  if (PONS_TYPES.has(type)) return 1;
  return 2;
}

export function selectDueChecks(entries, { at, limit, startBucket = 0 }) {
  if (!Number.isFinite(at) || !Number.isInteger(limit) || limit < 0) {
    throw new Error("pending-check selection requires finite at and non-negative integer limit");
  }
  const buckets = Array.from({ length: PENDING_CHECK_BUCKET_COUNT }, () => []);
  for (const entry of entries) {
    if (entry?.status !== "pending" || !Number.isFinite(entry.nextAttemptAt) || entry.nextAttemptAt > at) continue;
    buckets[pendingCheckBucket(entry.type)].push(entry);
  }
  for (const bucket of buckets) {
    bucket.sort((left, right) =>
      left.nextAttemptAt - right.nextAttemptAt
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));
  }

  const selected = [];
  let cursor = ((startBucket % PENDING_CHECK_BUCKET_COUNT) + PENDING_CHECK_BUCKET_COUNT)
    % PENDING_CHECK_BUCKET_COUNT;
  while (selected.length < limit) {
    let picked = false;
    for (let offset = 0; offset < PENDING_CHECK_BUCKET_COUNT && selected.length < limit; offset += 1) {
      const bucket = buckets[(cursor + offset) % PENDING_CHECK_BUCKET_COUNT];
      if (!bucket.length) continue;
      selected.push(bucket.shift());
      picked = true;
    }
    if (!picked) break;
    cursor = (cursor + 1) % PENDING_CHECK_BUCKET_COUNT;
  }
  return selected;
}
```

在 `src/store.js` 导入 `selectDueChecks`，并替换 `listDueChecks`：

```js
listDueChecks(at = now(), limit = 20, startBucket = 0) {
  return selectDueChecks(Object.values(state.pendingChecks), { at, limit, startBucket })
    .map((entry) => structuredClone(entry));
},
```

- [ ] **Step 4: 接入 worker cursor，并只恢复 pending candidate key**

在 `src/candidate-recovery.js` 改为：

```js
export function activeCandidateRecoveryKeys(snapshot) {
  return new Set(Object.values(snapshot?.pendingChecks || {})
    .filter((check) => check?.type === "candidate_recovery" && check.status === "pending")
    .map((check) => candidateKey(check.event)));
}
```

在 `src/scanner.js` 导入 `PENDING_CHECK_BUCKET_COUNT`，扩充 `runPendingChecks`：

```js
export async function runPendingChecks({
  store,
  handlers,
  now = Date.now,
  limit = 20,
  maxAttempts = 5,
  startBucket = 0,
}) {
  const checks = store.listDueChecks(now(), limit, startBucket);
  const result = {
    selected: checks.length,
    completed: 0,
    retried: 0,
    failed: 0,
    nextBucketCursor: (startBucket + 1) % PENDING_CHECK_BUCKET_COUNT,
  };
  for (const check of checks) {
    try {
      const handler = handlers?.[check.type];
      if (typeof handler !== "function") throw new Error(`no pending-check handler for ${check.type}`);
      const update = await handler(check);
      if (update?.retryAt != null) {
        if (!Number.isFinite(update.retryAt)) {
          throw new Error(`pending check ${check.id} returned invalid retryAt`);
        }
        store.rescheduleCheck(check.id, {
          status: "pending",
          attempts: Number(check.attempts || 0) + 1,
          nextAttemptAt: update.retryAt,
          lastError: safeErrorMessage(update.lastError || "evidence pending"),
        });
        result.retried += 1;
        continue;
      }
      if (update?.nextToken && update?.token) {
        store.applyCheckResult(check.id, { ...update, completedAt: now() });
      } else {
        store.completeCheck(check.id, now());
      }
      result.completed += 1;
    } catch (cause) {
      if (cause instanceof NonRetryablePendingCheckError) throw cause.cause || cause;
      const attempts = Number(check.attempts || 0) + 1;
      const allowedAttempts = Number.isInteger(check.maxAttempts) && check.maxAttempts > 0
        ? check.maxAttempts
        : maxAttempts;
      const exhausted = attempts >= allowedAttempts;
      const anchoredOffset = Array.isArray(check.retryOffsetsMs)
        ? check.retryOffsetsMs[attempts]
        : null;
      const retryAt = Number.isFinite(check.firstAnalyzedAt) && Number.isFinite(anchoredOffset)
        ? check.firstAnalyzedAt + anchoredOffset
        : nextRetryAt(now(), attempts);
      store.rescheduleCheck(check.id, {
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: retryAt,
        lastError: safeErrorMessage(cause),
      });
      if (exhausted) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
```

在 watch pending loop 外保存 cursor：

```js
let pendingBucketCursor = 0;
loops.push((async () => {
  while (true) {
    const result = await runPendingChecks({
      store,
      handlers: pendingHandlers,
      startBucket: pendingBucketCursor,
    });
    pendingBucketCursor = result.nextBucketCursor;
    if (result.failed) console.error(`pending checks: ${result.failed} checks exhausted retries`);
    await sleep(settings.outboxPollMs);
  }
})());
```

- [ ] **Step 5: 更新旧 result 深比较并运行 GREEN**

将旧 `{ completed, retried, failed }` 深比较加上 `selected` 和 `nextBucketCursor`。默认 `startBucket=0` 时，`nextBucketCursor` 为 1。

Run: `node --test test/pending-checks.test.js test/candidate-recovery.test.js test/scanner-pons.test.js test/store.test.js`

Expected: PASS。

- [ ] **Step 6: 提交公平调度**

```bash
git add src/pending-checks.js src/store.js src/scanner.js src/candidate-recovery.js test/pending-checks.test.js test/candidate-recovery.test.js test/scanner-pons.test.js test/store.test.js
git commit -m "修复：公平调度待处理检查"
```

### Task 4: 普通链上 bootstrap 与 200 区块提交单元

**Files:**
- Modify: `src/scanner.js:510-588`
- Modify: `test/index.test.js:714-736,1392-1480`

- [ ] **Step 1: 写 bootstrap 持久化、分段推进、创世边界和失败不推进测试**

在 `test/index.test.js` 增加：

```js
it("persists the bootstrap cursor and advances one 200-block segment per iteration", async () => {
  let cursor = null;
  const cursors = [];
  const ranges = [];
  const state = { lastBlock: null, lastGecko: 0 };
  const dependencies = {
    settings: {
      onchainScan: true,
      geckoScan: false,
      confirmationBlocks: 0,
      maxAgeMinutes: 30,
    },
    now: () => 1_000,
    getBlockNumber: async () => 600,
    getOnchainCursor: () => cursor,
    findFirstBlockAtOrAfter: async () => 100,
    scanOnchain: async (from, to) => { ranges.push([from, to]); return []; },
    handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
    setOnchainCursor: (value) => { cursor = value; cursors.push(value); },
    geckoNewPools: async () => [],
    log: () => {},
  };

  await runWatchIteration(state, dependencies);
  await runWatchIteration(state, dependencies);

  assert.deepEqual(cursors, [99, 299, 499]);
  assert.deepEqual(ranges, [[100, 299], [300, 499]]);
  assert.equal(state.lastBlock, 499);
});

it("scans genesis block zero before committing a non-negative cursor", async () => {
  const cursors = [];
  const ranges = [];
  await runWatchIteration({ lastBlock: null, lastGecko: 0 }, {
    settings: { onchainScan: true, geckoScan: false, confirmationBlocks: 0, maxAgeMinutes: 30 },
    now: () => 1_000,
    getBlockNumber: async () => 50,
    getOnchainCursor: () => null,
    findFirstBlockAtOrAfter: async () => 0,
    scanOnchain: async (from, to) => { ranges.push([from, to]); return []; },
    handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
    setOnchainCursor: (value) => cursors.push(value),
    geckoNewPools: async () => [],
    log: () => {},
  });
  assert.deepEqual(ranges, [[0, 50]]);
  assert.deepEqual(cursors, [50]);
});

it("keeps a failed segment at its previously committed cursor", async () => {
  let cursor = 99;
  const ranges = [];
  const state = { lastBlock: 99, lastGecko: 0 };
  const dependencies = {
    settings: { onchainScan: true, geckoScan: false, confirmationBlocks: 0, maxAgeMinutes: 30 },
    now: () => 1_000,
    getBlockNumber: async () => 600,
    getOnchainCursor: () => cursor,
    findFirstBlockAtOrAfter: async () => 100,
    scanOnchain: async (from, to) => {
      ranges.push([from, to]);
      return [{ token: "0x1111111111111111111111111111111111111111" }];
    },
    handleEvents: async () => ({ accepted: 1, handled: 0, failed: 1 }),
    setOnchainCursor: (value) => { cursor = value; },
    geckoNewPools: async () => [],
    log: () => {},
  };
  await runWatchIteration(state, dependencies);
  await runWatchIteration(state, dependencies);
  assert.deepEqual(ranges, [[100, 299], [100, 299]]);
  assert.equal(cursor, 99);
  assert.equal(state.lastBlock, 99);
});

it("logs the failed onchain stage and exact retry range", async () => {
  const logs = [];
  await runWatchIteration({ lastBlock: 99, lastGecko: 0 }, {
    settings: { onchainScan: true, geckoScan: false, confirmationBlocks: 0, maxAgeMinutes: 30 },
    now: () => 1_000,
    getBlockNumber: async () => 600,
    getOnchainCursor: () => 99,
    findFirstBlockAtOrAfter: async () => 100,
    scanOnchain: async () => { throw new Error("rpc timeout"); },
    handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
    setOnchainCursor: () => { throw new Error("cursor must not advance"); },
    geckoNewPools: async () => [],
    log: (line) => logs.push(line),
  });
  assert.match(logs.join("\n"), /stage=range from=100 to=299.*rpc timeout/);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/index.test.js`

Expected: FAIL；当前首次扫描覆盖整个 safe range，bootstrap 不单独持久化。

- [ ] **Step 3: 实现 200 区块提交边界和 bootstrap 持久化**

在 `src/scanner.js` 增加：

```js
export const ONCHAIN_SCAN_CHUNK_BLOCKS = 200;

async function runOnchainStage(stage, work, context = "") {
  try {
    return await work();
  } catch (cause) {
    throw new Error(
      `onchain stage=${stage}${context} failed: ${safeErrorMessage(cause)}`,
      { cause }
    );
  }
}
```

把 `runWatchIteration` 的 onchain session 核心改为：

```js
const onchainStartedAt = dependencies.now();
const result = await runDiscoverySession(async (provider) => {
  const latestHead = await runOnchainStage(
    "head",
    () => dependencies.getBlockNumber(provider)
  );
  const safeHead = latestHead - (settings.confirmationBlocks ?? 0);
  let lastBlock = state.lastBlock;
  let scanFrom = null;
  if (safeHead >= 0 && lastBlock == null) {
    lastBlock = await runOnchainStage("boundary", () => initialOnchainCursor({
      head: safeHead,
      savedCursor: dependencies.getOnchainCursor(),
      maxAgeMinutes: settings.maxAgeMinutes,
      now: dependencies.now,
      findFirstBlockAtOrAfter: (target, head) =>
        dependencies.findFirstBlockAtOrAfter(target, head, provider),
    }));
    if (lastBlock >= 0 && dependencies.getOnchainCursor() == null) {
      await runOnchainStage("bootstrap-cursor", () => dependencies.setOnchainCursor(lastBlock));
      state.lastBlock = lastBlock;
    }
    if (lastBlock < 0) scanFrom = 0;
  }
  if (safeHead < 0 || (lastBlock >= 0 && safeHead <= lastBlock)) {
    return { safeHead, lastBlock, scanned: null };
  }
  const from = scanFrom ?? lastBlock + 1;
  const to = Math.min(safeHead, from + ONCHAIN_SCAN_CHUNK_BLOCKS - 1);
  const scanned = await runOnchainStage(
    "range",
    () => processOnchainRange(
      { from, head: to },
      {
        scanOnchain: (start, end) => dependencies.scanOnchain(start, end, provider),
        handleEvents: (events) => dependencies.handleEvents(
          events.map((event) => ({ ...event, observedAt: event.observedAt ?? observedAt })),
          "onchain"
        ),
      }
    ),
    ` from=${from} to=${to}`
  );
  return { safeHead, lastBlock, from, to, scanned };
});
```

成功提交必须使用 `result.to`：

```js
if (result.scanned?.complete) {
  dependencies.setOnchainCursor(result.to);
  state.lastBlock = result.to;
}
```

日志使用实际段尾和剩余 lag：

```js
dependencies.log(
  `onchain from=${result.from} to=${result.to} safeHead=${result.safeHead}`
  + ` cursorLag=${Math.max(0, result.safeHead - result.to)}`
  + ` durationMs=${Math.max(0, dependencies.now() - onchainStartedAt)}`
  + ` events=${result.scanned.events.length} accepted=${result.scanned.accepted}`
  + ` failed=${result.scanned.failed}`
);
```

- [ ] **Step 4: 更新原有 range 断言并运行 GREEN**

小于 200 块的原用例保持范围不变；大范围用例改为只期望一个 200 块段。失败用例必须断言第二轮重试同一段。

Run: `node --test test/index.test.js`

Expected: PASS。

- [ ] **Step 5: 提交分段游标**

```bash
git add src/scanner.js test/index.test.js
git commit -m "修复：分段推进普通链上游标"
```

### Task 5: 无凭据健康摘要与 worker 活动日志

**Files:**
- Create: `src/scanner-health.js`
- Create: `test/scanner-health.test.js`
- Modify: `src/scanner.js:1-52,1097-1280`
- Modify: `test/index.test.js:430-590`

- [ ] **Step 1: 写健康摘要、整理摘要和敏感信息隔离测试**

创建 `test/scanner-health.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPendingReconciliation,
  formatScannerHealth,
  formatWorkerActivity,
} from "../src/scanner-health.js";

test("formats cursor and queue health without entry payloads or credentials", () => {
  const output = formatScannerHealth({
    cursors: { onchain: 100, ponsV2: 120 },
    pendingChecks: {
      one: {
        status: "pending",
        type: "pons_inspection",
        createdAt: 1_000,
        lastError: "https://rpc.example/secret-key",
      },
      two: { status: "expired", type: "holders", createdAt: 500 },
    },
    outbox: {
      notice: { status: "delivered", text: "token=telegram-secret" },
    },
  }, 4_000);
  assert.match(output, /onchain=100/);
  assert.match(output, /pons=120/);
  assert.match(output, /pending=1/);
  assert.match(output, /expired=1/);
  assert.match(output, /oldestPendingAgeMs=3000/);
  assert.doesNotMatch(output, /secret-key|telegram-secret/);
});

test("formats only non-zero worker activity fields", () => {
  assert.equal(
    formatWorkerActivity("outbox", { delivered: 1, suppressed: 0, retried: 2, failed: 0 }),
    "outbox delivered=1 retried=2"
  );
  assert.equal(formatWorkerActivity("outbox", { delivered: 0, retried: 0, failed: 0 }), null);
});

test("formats startup reconciliation reason counts", () => {
  const output = formatPendingReconciliation({
    scanned: 4,
    expired: 4,
    canonicalCreated: 0,
    reasons: { "outside-alert-window": 4 },
  });
  assert.equal(
    output,
    "pending-reconcile scanned=4 expired=4 canonicalCreated=0 reasons=outside-alert-window:4"
  );
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/scanner-health.test.js`

Expected: FAIL；模块不存在。

- [ ] **Step 3: 实现只读取计数的健康格式化模块**

创建 `src/scanner-health.js`：

```js
function counts(entries, field) {
  return Object.values(entries || {}).reduce((result, entry) => {
    const key = String(entry?.[field] || "unknown");
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function formatCounts(values) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export function formatPendingReconciliation(summary) {
  return `pending-reconcile scanned=${summary.scanned} expired=${summary.expired}`
    + ` canonicalCreated=${summary.canonicalCreated}`
    + ` reasons=${formatCounts(summary.reasons) || "none"}`;
}

export function formatWorkerActivity(name, result) {
  const fields = Object.entries(result)
    .filter(([key, value]) => !["nextBucketCursor"].includes(key) && Number(value) > 0)
    .map(([key, value]) => `${key}=${value}`);
  return fields.length ? `${name} ${fields.join(" ")}` : null;
}

export function formatScannerHealth(snapshot, at = Date.now()) {
  const pending = Object.values(snapshot?.pendingChecks || {}).filter((entry) => entry?.status === "pending");
  const created = pending.map((entry) => Number(entry.createdAt)).filter(Number.isFinite);
  const oldestPendingAgeMs = created.length ? Math.max(0, at - Math.min(...created)) : 0;
  return [
    "scanner-health",
    `onchain=${snapshot?.cursors?.onchain ?? "null"}`,
    `pons=${snapshot?.cursors?.ponsV2 ?? "null"}`,
    `pendingStatus=${formatCounts(counts(snapshot?.pendingChecks, "status")) || "none"}`,
    `pendingTypes=${formatCounts(counts(Object.fromEntries(pending.map((entry, index) => [index, entry])), "type")) || "none"}`,
    `oldestPendingAgeMs=${oldestPendingAgeMs}`,
    `outbox=${formatCounts(counts(snapshot?.outbox, "status")) || "none"}`,
  ].join(" ");
}
```

- [ ] **Step 4: 在 Robinhood live 启动和三个 worker 接入日志**

在 `src/scanner.js` 导入三个 formatter，并增加一个可测试的启动 helper：

```js
export function reconcileWatchPendingChecks({
  store,
  settings,
  mode,
  now = Date.now,
  log = console.log,
}) {
  if (mode !== "live") return null;
  const reconciliation = store.reconcilePendingChecks({
    at: now(),
    maxAgeMinutes: settings.maxAgeMinutes,
  });
  log(formatPendingReconciliation(reconciliation));
  return reconciliation;
}
```

`watch` 获取 runtime 后、RPC startup checks 前调用：

```js
reconcileWatchPendingChecks({ store, settings, mode });
```

outbox loop 在结果非零时输出：

```js
const activity = formatWorkerActivity("outbox", result);
if (activity) console.log(activity);
```

pending loop 在更新 bucket cursor 后输出：

```js
const activity = formatWorkerActivity("pending-checks", result);
if (activity) console.log(activity);
```

现有每小时 RPC usage loop 同时输出 state 摘要：

```js
console.log(formatHourlyUsage(context.config, Date.now()));
console.log(formatScannerHealth(store.snapshot(), Date.now()));
```

在 `test/index.test.js` 导入 `reconcileWatchPendingChecks` 并增加同步用例，避免启动无限 watch loop：

```js
it("reconciles pending checks only for live watch mode", () => {
  const calls = [];
  const store = {
    reconcilePendingChecks: (input) => {
      calls.push(input);
      return { scanned: 0, expired: 0, canonicalCreated: 0, reasons: {} };
    },
  };
  const logs = [];
  reconcileWatchPendingChecks({
    store,
    settings: { maxAgeMinutes: 30 },
    mode: "live",
    now: () => 1_000,
    log: (line) => logs.push(line),
  });
  reconcileWatchPendingChecks({
    store,
    settings: { maxAgeMinutes: 30 },
    mode: "recovery",
    now: () => 2_000,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(calls, [{ at: 1_000, maxAgeMinutes: 30 }]);
  assert.deepEqual(logs, ["pending-reconcile scanned=0 expired=0 canonicalCreated=0 reasons=none"]);
});
```

- [ ] **Step 5: 运行健康与启动测试确认 GREEN**

Run: `node --test test/scanner-health.test.js test/index.test.js test/scanner-pons.test.js test/outbox.test.js`

Expected: PASS；输出测试不包含 fixture 中的 secret 文本。

- [ ] **Step 6: 提交可观测性**

```bash
git add src/scanner-health.js src/scanner.js test/scanner-health.test.js test/index.test.js test/scanner-pons.test.js
git commit -m "功能：记录扫描器健康状态"
```

### Task 6: screen 运维文档与完整验收

**Files:**
- Modify: `README.md:58-68,218-233`
- Modify: `docs/operations/multichain-evm.md:16-42`

- [ ] **Step 1: 更新带日志的 screen 启动与查看命令**

把 README 的 Robinhood screen 示例替换为：

```bash
cd /home/ubuntu/robinhood-scanner-bot
mkdir -p logs
screen -dmS robinhood -L -Logfile logs/robinhood.log \
  bash -lc 'cd /home/ubuntu/robinhood-scanner-bot && exec npm run watch:robinhood'

screen -ls
tail -f /home/ubuntu/robinhood-scanner-bot/logs/robinhood.log
screen -r robinhood
```

紧邻说明：`screen -L` 之后故障必须先保存日志；不得把 `.env`、RPC URL、Telegram token 或 chat ID 粘贴到日志报告。

- [ ] **Step 2: 记录升级备份、状态检查和 30 分钟验收命令**

在 `docs/operations/multichain-evm.md` 增加 Robinhood 升级段落：

```bash
cd /home/ubuntu/robinhood-scanner-bot
cp -a data "data.backup.$(date +%Y%m%d-%H%M%S)"
npm ci
npm test
```

启动后使用不输出凭据的检查：

```bash
tail -n 200 logs/robinhood.log
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync("data/robinhood/state.json","utf8"));
const count=(items,key)=>Object.values(items||{}).reduce((r,x)=>(r[x?.[key]||"unknown"]=(r[x?.[key]||"unknown"]||0)+1,r),{});
console.log({schemaVersion:s.schemaVersion,cursors:s.cursors,pending:count(s.pendingChecks,"status"),outbox:count(s.outbox,"status")});
'
```

文档明确验收：schemaVersion 为 6、旧 Pons 任务进入 expired、onchain cursor 非 null 且连续推进、30 分钟内 pending 不无界增长。没有满足原策略的候选时，Telegram 没有候选消息不是故障。

- [ ] **Step 3: 运行全部定向测试**

Run:

```bash
node --test test/store.test.js test/pending-checks.test.js test/scanner-pons.test.js test/index.test.js test/candidate-recovery.test.js test/scanner-health.test.js test/outbox.test.js
```

Expected: PASS，0 fail。

- [ ] **Step 4: 运行完整回归和差异检查**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: 测试数不少于基线 709，0 fail；`git diff --check` 无输出；status 只包含 README 和运维文档。

- [ ] **Step 5: 提交运维文档**

```bash
git add README.md docs/operations/multichain-evm.md
git commit -m "文档：补充 Robinhood 日志与恢复验收"
```

- [ ] **Step 6: 最终分支验收**

Run:

```bash
npm test
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: 全量测试 0 fail；diff check 无输出；工作树干净；提交仅覆盖本计划六个任务和已确认的设计/计划文档。不要在本地测试中连接生产 Telegram，也不要修改 `.env` 或 `data/`。
