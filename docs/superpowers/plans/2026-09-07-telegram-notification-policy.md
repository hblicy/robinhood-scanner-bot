# Telegram Notification Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Telegram lifecycle spam while preserving full scored reports, startup confirmation, and the `hard_kill`、`rescued`、`green`、`market_ready` critical transitions.

**Architecture:** Add one fail-closed lifecycle notification policy used by the outbox delivery boundary, while removing noisy notifications at their producers. Mark legacy queued noise as `suppressed` without deleting history. Treat the first Pons cursor recovery range as state-only; later ranges continue scheduling checks that may emit allowed critical transitions.

**Tech Stack:** Node.js 18+ ES modules, `node:test`, existing atomic JSON store and Telegram outbox.

---

### Task 1: Fail-closed lifecycle delivery policy

**Files:**
- Create: `src/notification-policy.js`
- Modify: `src/outbox.js`
- Modify: `src/store.js`
- Test: `test/outbox.test.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write failing outbox policy tests**

Add a test to `test/outbox.test.js` that feeds all allowed and forbidden transition types through the real `drainOutbox` function:

```js
test("delivers only allowed lifecycle types and suppresses legacy noise", async () => {
  const allowed = ["hard_kill", "rescued", "green", "market_ready"];
  const blocked = ["new_launch", "swept", "graduated", "heat_change", "phase_changed", undefined];
  const entries = [...allowed, ...blocked].map((transitionType, index) => ({
    id: `notice-${index}`,
    text: `message-${index}`,
    transitionType,
    attempts: 0,
  }));
  const sent = [];
  const delivered = [];
  const suppressed = [];
  const store = {
    listDueOutbox: () => entries,
    markOutboxDelivered: (id) => delivered.push(id),
    markOutboxSuppressed: (id, at) => suppressed.push([id, at]),
    rescheduleOutbox: () => { throw new Error("unexpected retry"); },
  };

  const result = await drainOutbox({
    store,
    send: async (_text, entry) => sent.push(entry.transitionType),
    now: () => 1_000,
  });

  assert.deepEqual(sent, allowed);
  assert.equal(delivered.length, allowed.length);
  assert.equal(suppressed.length, blocked.length);
  assert.deepEqual(result, { delivered: 4, suppressed: 6, retried: 0, failed: 0 });
});
```

Update the existing delivery/retry fixtures so their entries use `transitionType: "hard_kill"`, and update result assertions to include `suppressed: 0`.

Add a store regression to `test/store.test.js`:

```js
test("marks a queued notification suppressed without deleting its audit record", () => {
  const store = openStore(tempDir());
  store.commitPonsRange({
    toBlock: 10,
    transitions: [{
      eventId: EVENT_ID,
      blockNumber: 10,
      token: TOKEN,
      nextToken: tokenState(),
      notifications: [{ id: `${EVENT_ID}:new_launch`, transitionType: "new_launch", text: "noise" }],
      checks: [],
    }],
  });

  store.markOutboxSuppressed(`${EVENT_ID}:new_launch`, 1_200);

  const entry = store.snapshot().outbox[`${EVENT_ID}:new_launch`];
  assert.equal(entry.status, "suppressed");
  assert.equal(entry.suppressedAt, 1_200);
  assert.equal(entry.deliveredAt, null);
  assert.equal(store.listDueOutbox(2_000).length, 0);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/outbox.test.js test/store.test.js
```

Expected: FAIL because `drainOutbox` sends forbidden types, omits `suppressed`, and the store has no `markOutboxSuppressed` method.

- [ ] **Step 3: Implement the policy and atomic suppressed status**

Create `src/notification-policy.js`:

```js
const ALLOWED_LIFECYCLE_TYPES = new Set([
  "hard_kill",
  "rescued",
  "green",
  "market_ready",
]);

export function shouldSendLifecycleNotification(entry) {
  return ALLOWED_LIFECYCLE_TYPES.has(String(entry?.transitionType || ""));
}
```

In `src/store.js`, add beside `markOutboxDelivered`:

```js
markOutboxSuppressed(id, suppressedAt = now()) {
  return commit((draft) => {
    const entry = requireEntry(draft.outbox, id, "outbox entry");
    entry.status = "suppressed";
    entry.suppressedAt = suppressedAt;
    entry.deliveredAt = null;
    entry.lastError = null;
    return entry;
  });
},
```

In `src/outbox.js`, import the policy and apply it before `send`:

```js
import { shouldSendLifecycleNotification } from "./notification-policy.js";

export async function drainOutbox({
  store,
  send,
  now = Date.now,
  limit = 20,
  maxAttempts = 5,
}) {
  const result = { delivered: 0, suppressed: 0, retried: 0, failed: 0 };
  const entries = store.listDueOutbox(now(), limit);
  for (const entry of entries) {
    if (!shouldSendLifecycleNotification(entry)) {
      store.markOutboxSuppressed(entry.id, now());
      result.suppressed += 1;
      continue;
    }
    try {
      await send(entry.text, entry);
      store.markOutboxDelivered(entry.id, now());
      result.delivered += 1;
    } catch (cause) {
      const attempts = Number(entry.attempts || 0) + 1;
      const exhausted = attempts >= maxAttempts;
      store.rescheduleOutbox(entry.id, {
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: nextRetryAt(now(), attempts),
        lastError: safeErrorMessage(cause),
      });
      if (exhausted) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test test/outbox.test.js test/store.test.js
```

Expected: all tests pass; only the four allowlisted transition types call `send`.

- [ ] **Step 5: Commit the delivery boundary**

```bash
git add src/notification-policy.js src/outbox.js src/store.js test/outbox.test.js test/store.test.js
git commit -m "抑制低价值 Telegram 积压消息"
```

### Task 2: State-only first Pons recovery

**Files:**
- Modify: `src/scanner.js`
- Test: `test/scanner-pons.test.js`

- [ ] **Step 1: Write failing cold-start and realtime tests**

Change the existing atomic range test so raw launch events create checks but no lifecycle outbox:

```js
test("atomically commits realtime Pons state and checks without raw lifecycle notification", async () => {
  const store = tempStore();
  const result = await watchPonsRange(dependencies(store));
  const state = store.snapshot();
  assert.equal(result.transitions.length, 1);
  assert.equal(state.cursors.ponsV2, 120);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "not_graduated");
  assert.ok(state.appliedEvents[EVENT_ID]);
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.ok(state.pendingChecks[`${EVENT_ID}:curve_flow`]);
});
```

Change the replay assertion to keep one applied event, zero outbox entries, and one set of deduplicated checks:

```js
assert.equal(Object.keys(state.appliedEvents).length, 1);
assert.equal(Object.keys(state.outbox).length, 0);
assert.equal(Object.keys(state.pendingChecks).length, 4);
```

Replace the obsolete `new_launch` Telegram retry test with an allowed critical notification fixture:

```js
test("Telegram failure leaves a critical notification retryable without rolling back its cursor", async () => {
  const store = tempStore();
  store.commitPonsRange({
    toBlock: 120,
    transitions: [{
      eventId: EVENT_ID,
      blockNumber: 120,
      token: TOKEN,
      nextToken: createPonsTokenState(launchEvent(), launchRecord(), 10_000),
      notifications: [{
        id: `${EVENT_ID}:hard_kill`,
        eventId: EVENT_ID,
        transitionType: "hard_kill",
        token: TOKEN,
        text: "hard kill",
      }],
      checks: [],
    }],
  });

  const result = await drainOutbox({
    store,
    send: async () => { throw new Error("telegram unavailable"); },
    now: () => 10_000,
  });

  const state = store.snapshot();
  assert.equal(result.retried, 1);
  assert.equal(state.cursors.ponsV2, 120);
  assert.equal(state.outbox[`${EVENT_ID}:hard_kill`].attempts, 1);
});
```

Add this import for the fixture:

```js
import { createPonsTokenState } from "../src/lifecycle.js";
```

Extend the existing first-iteration test with recovery assertions:

```js
assert.equal(store.snapshot().cursors.ponsV2, 123);
assert.equal(Object.keys(store.snapshot().outbox).length, 0);
assert.equal(Object.keys(store.snapshot().pendingChecks).length, 0);
```

Add a restart/realtime test:

```js
test("a saved Pons cursor schedules realtime checks without raw launch notifications", async () => {
  const store = tempStore();
  store.commitPonsRange({ toBlock: 119, transitions: [] });
  const runtime = { lastBlock: null };

  await runPonsWatchIteration(runtime, {
    provider: {},
    store,
    settings: { ponsConfirmations: 2, lineAMaxAgeMinutes: 20 },
    getBlockNumber: async () => 125,
    findFirstBlockAtOrAfter: async () => 120,
    scanRange: async () => [launchEvent()],
    readLaunch: async () => launchRecord(),
    now: () => 10_000,
  });

  const state = store.snapshot();
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.ok(state.pendingChecks[`${EVENT_ID}:line_a`]);
});
```

- [ ] **Step 2: Run the scanner test and verify RED**

Run:

```bash
node --test test/scanner-pons.test.js
```

Expected: FAIL because launch events still create `new_launch` outbox entries and cold start still schedules historical checks.

- [ ] **Step 3: Remove raw lifecycle producers and add recovery mode**

In `src/scanner.js`:

1. Delete `lifecycleNotification` because no raw Factory event is directly pushable.
2. Add `scheduleChecks = true` to `buildPonsTransitions` and build transitions as:

```js
transitions.push({
  eventId: event.eventId,
  blockNumber: event.blockNumber,
  token: event.token,
  nextToken,
  notifications: [],
  checks: scheduleChecks ? lifecycleChecks(event, nextToken, now()) : [],
});
```

3. Pass the option through preview and commit:

```js
export async function previewPonsRange({
  provider,
  fromBlock,
  toBlock,
  now = Date.now,
  scanRange = scanPonsRange,
  readLaunch = readPonsLaunch,
  initialTokens = {},
  scheduleChecks = true,
}) {
  const events = await scanRange(provider, fromBlock, toBlock);
  const transitions = await buildPonsTransitions(events, {
    provider,
    readLaunch,
    now,
    initialTokens,
    scheduleChecks,
  });
  return { events, transitions };
}
```

4. Detect an absent saved cursor in `runPonsWatchIteration` and pass `scheduleChecks: !recovering`:

```js
let recovering = false;
if (state.lastBlock == null) {
  const savedCursor = dependencies.store.getPonsCursor();
  recovering = savedCursor == null;
  const boundary = await dependencies.findFirstBlockAtOrAfter(
    dependencies.now() - dependencies.settings.lineAMaxAgeMinutes * 60_000,
    safeHead
  );
  state.lastBlock = Math.min(safeHead, Math.max(savedCursor ?? -1, boundary - 1));
}
```

Pass `scheduleChecks: !recovering` in the subsequent `watchPonsRange` call.

- [ ] **Step 4: Run scanner tests and verify GREEN**

Run:

```bash
node --test test/scanner-pons.test.js
```

Expected: all scanner Pons tests pass; cold start has no outbox/checks and a saved cursor still schedules realtime checks.

- [ ] **Step 5: Commit recovery behavior**

```bash
git add src/scanner.js test/scanner-pons.test.js
git commit -m "首次补扫仅恢复 Pons 状态"
```

### Task 3: Suppress reconcile and market-heat noise

**Files:**
- Modify: `src/scanner.js`
- Test: `test/scanner-pons.test.js`

- [ ] **Step 1: Write failing producer tests**

In the rescued reconcile test, assert the allowed message remains:

```js
assert.ok(state.outbox[`reconcile:${TOKEN.toLowerCase()}:rescued:rescued`]);
```

Add a non-critical reconcile test:

```js
test("startup reconcile updates graduation state without Telegram", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  store.commitTokenUpdate({
    token: TOKEN,
    nextToken: { ...store.snapshot().tokens[TOKEN.toLowerCase()], watchlist: true, monitorState: "watchlisted" },
  });

  await reconcilePonsWatchlist({
    provider: {},
    store,
    readLaunch: async () => launchRecord(2),
    now: () => 20_000,
  });

  const state = store.snapshot();
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "pool_created");
  assert.equal(Object.keys(state.outbox).length, 0);
});
```

Rename the heat test to `market heat is persisted without Telegram notifications` and replace its final assertion with:

```js
assert.equal(Object.keys(state.outbox).length, 0);
```

- [ ] **Step 2: Run the scanner test and verify RED**

Run:

```bash
node --test test/scanner-pons.test.js
```

Expected: FAIL because graduation reconcile and the first heat decision still create outbox entries.

- [ ] **Step 3: Restrict reconcile and heat producers**

In `reconcilePonsWatchlist`, construct a notification only for rescued:

```js
let notification = null;
if (phase === "rescued") {
  notification = {
    id: `${event.eventId}:rescued`,
    eventId: event.eventId,
    transitionType: "rescued",
    token: address,
    reason: `Factory getter 阶段为 ${phase}`,
  };
  notification.text = formatLifecycleNotification(notification);
}
store.commitTokenUpdate({ token: address, nextToken, notification });
```

In `refreshMarketHeat`, remove previous-decision notification construction and persist only:

```js
store.commitHeat({ heat });
return heat;
```

- [ ] **Step 4: Run scanner tests and verify GREEN**

Run:

```bash
node --test test/scanner-pons.test.js
```

Expected: all tests pass; rescued remains queued, graduation and heat changes do not.

- [ ] **Step 5: Commit producer filtering**

```bash
git add src/scanner.js test/scanner-pons.test.js
git commit -m "仅推送关键生命周期状态"
```

### Task 4: Document policy and run complete verification

**Files:**
- Modify: `README.md`
- Verify: `src/runtime.js`
- Verify: `src/analyze.js`
- Verify: `test/runtime.test.js`

- [ ] **Step 1: Document the exact runtime policy**

After the recovery paragraph in `README.md`, add:

```md
首次没有 Pons 游标时仅恢复链上状态、事件去重和游标，不创建历史 Telegram 或历史 pending checks。实时 Pons 原始 `new_launch`、`swept`、`graduated` 与市场热度只记录状态/终端日志；Telegram 生命周期白名单仅包含 `hard_kill`、`rescued`、`green`、`market_ready`。升级前已积压的其他类型会保留审计记录并标记为 `suppressed`。普通候选仍按 `MIN_SCORE` 输出完整评分报告，启动成功提示保持不变。
```

- [ ] **Step 2: Run targeted notification and scoring suites**

Run:

```bash
node --test test/outbox.test.js test/store.test.js test/scanner-pons.test.js test/runtime.test.js test/notify.test.js
```

Expected: all targeted tests pass, including existing `handleCandidate` score-threshold and Telegram formatting coverage.

- [ ] **Step 3: Run the complete test suite**

Run:

```bash
npm test
```

Expected: every test passes with zero skipped or todo tests.

- [ ] **Step 4: Verify diff hygiene and push-only safety**

Run:

```bash
git diff --check
rg -n "PRIVATE_KEY|sendTransaction|broadcastTransaction|getSigner|signTransaction|approve\\(" src .env.example README.md
```

Expected: `git diff --check` exits 0; the safety search finds no transaction signing, authorization, or broadcasting path.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "说明 Telegram 推送白名单"
```

- [ ] **Step 6: Inspect final branch state**

Run:

```bash
git status --short --branch
git log -5 --oneline
```

Expected: the feature branch is clean and contains the design/plan commits plus three implementation commits and one documentation commit. Do not push until the user explicitly requests it.
