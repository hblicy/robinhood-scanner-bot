# Candidate Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist retryable Robinhood candidate classification and analysis failures so RPC throttling cannot create a 15-second retry storm or stall the on-chain cursor.

**Architecture:** Add a small pure `candidate-recovery` module for retry records and error classification. Extract the live candidate/source processor from `watch()` so tests execute the real `classify → analyze → markSeen` path. The source processor hands retryable failures to the existing persistent pending-check store; only a successful handoff counts as handled, while unexpected errors still fail the source range.

**Tech Stack:** Node.js ESM, `node:test`, existing JSON state store, ethers RPC error classification.

---

### Task 1: Candidate recovery records and retry classification

**Files:**
- Create: `src/candidate-recovery.js`
- Create: `test/candidate-recovery.test.js`

- [ ] **Step 1: Write failing tests for deterministic IDs, fixed retry offsets, active-key restoration, and strict error classification**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_RECOVERY_OFFSETS_MS,
  RetryableCandidateError,
  activeCandidateRecoveryKeys,
  candidateRecoveryId,
  createCandidateRecovery,
  isRetryableCandidateFailure,
} from "../src/candidate-recovery.js";

const event = {
  chain: "robinhood",
  token: "0x1000000000000000000000000000000000000001",
  pool: "0x2000000000000000000000000000000000000002",
  source: "gecko",
  venue: "uniswap-v2",
  createdAt: 1_000,
};

test("candidate recovery uses a separate deterministic pending-check identity", () => {
  const check = createCandidateRecovery(event, 10_000, new Error("rate limited"));
  assert.equal(check.id, candidateRecoveryId(event));
  assert.match(check.id, /^candidate-recovery:/);
  assert.equal(check.type, "candidate_recovery");
  assert.equal(check.dueAt, 10_000 + CANDIDATE_RECOVERY_OFFSETS_MS[0]);
  assert.deepEqual(check.retryOffsetsMs, [120_000, 300_000, 600_000]);
  assert.equal(check.maxAttempts, 3);
  assert.match(check.lastError, /rate limited/);
});

test("candidate recovery restores pending and failed keys but not completed keys", () => {
  const id = candidateRecoveryId(event);
  const keys = activeCandidateRecoveryKeys({ pendingChecks: {
    pending: { id, type: "candidate_recovery", status: "pending", event },
    failed: { id: `${id}:failed`, type: "candidate_recovery", status: "failed", event: { ...event, token: "0x3000000000000000000000000000000000000003" } },
    done: { id: `${id}:done`, type: "candidate_recovery", status: "completed", event: { ...event, token: "0x4000000000000000000000000000000000000004" } },
  }});
  assert.equal(keys.size, 2);
});

test("only expected transient candidate failures are retryable", () => {
  assert.equal(isRetryableCandidateFailure(new RetryableCandidateError("identity unavailable")), true);
  assert.equal(isRetryableCandidateFailure(Object.assign(new Error("metadata unavailable"), { code: "RETRYABLE_ANALYSIS" })), true);
  assert.equal(isRetryableCandidateFailure(Object.assign(new Error("too many requests"), { status: 429 })), true);
  assert.equal(isRetryableCandidateFailure(new ReferenceError("analyzeCandidate is not defined")), false);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/candidate-recovery.test.js`

Expected: FAIL because `src/candidate-recovery.js` does not exist.

- [ ] **Step 3: Implement the pure recovery module**

```js
import { candidateKey } from "./runtime.js";
import { isDiscoveryFallbackError } from "./chain.js";
import { safeErrorMessage } from "./safety.js";

export const CANDIDATE_RECOVERY_OFFSETS_MS = Object.freeze([120_000, 300_000, 600_000]);

export class RetryableCandidateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetryableCandidateError";
    this.code = "RETRYABLE_CANDIDATE";
  }
}

export function candidateRecoveryId(event) {
  return `candidate-recovery:${candidateKey(event)}`;
}

export function createCandidateRecovery(event, failedAt, error) {
  if (!Number.isFinite(failedAt)) throw new Error("candidate recovery requires failedAt");
  const dueAt = failedAt + CANDIDATE_RECOVERY_OFFSETS_MS[0];
  return {
    id: candidateRecoveryId(event),
    type: "candidate_recovery",
    event: structuredClone(event),
    firstAnalyzedAt: failedAt,
    dueAt,
    nextAttemptAt: dueAt,
    retryOffsetsMs: [...CANDIDATE_RECOVERY_OFFSETS_MS],
    maxAttempts: CANDIDATE_RECOVERY_OFFSETS_MS.length,
    lastError: safeErrorMessage(error),
  };
}

export function isRetryableCandidateFailure(error) {
  return error?.code === "RETRYABLE_CANDIDATE"
    || error?.code === "RETRYABLE_ANALYSIS"
    || isDiscoveryFallbackError(error);
}

export function activeCandidateRecoveryKeys(snapshot) {
  return new Set(Object.values(snapshot?.pendingChecks || {})
    .filter((check) => check?.type === "candidate_recovery" && check.status !== "completed")
    .map((check) => candidateKey(check.event)));
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/candidate-recovery.test.js`

Expected: all candidate recovery tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/candidate-recovery.js test/candidate-recovery.test.js
git commit -m "实现候选失败恢复记录"
```

### Task 2: Preserve the first failure and execute the real candidate path

**Files:**
- Modify: `src/store.js:437-454`
- Modify: `src/scanner.js:178-215`
- Modify: `test/store.test.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing tests for initial error persistence and full recovery execution**

Add a store assertion:

```js
test("preserves the initial pending-check error", () => {
  const store = tempStore();
  store.scheduleCheck({
    id: "candidate-recovery:test",
    type: "candidate_recovery",
    dueAt: 120_000,
    lastError: "server response 429 Too Many Requests",
  });
  assert.match(store.snapshot().pendingChecks["candidate-recovery:test"].lastError, /429/);
});
```

Replace the helper-only binding test with a real candidate execution test:

```js
it("executes classify, analyze and markSeen through the live candidate path", async () => {
  const calls = [];
  const event = {
    chain: "robinhood",
    token: "0x1000000000000000000000000000000000000001",
    pool: "0x2000000000000000000000000000000000000002",
    source: "gecko",
    venue: "uniswap-v2",
    createdAt: 1_000,
    observedAt: 2_000,
  };
  await processWatchCandidate(event, {
    classifyCandidate: async (value) => { calls.push("classify"); return { ...value, identity: "not_pons" }; },
    candidateDependencies: {
      now: () => 2_000,
      maxAgeMinutes: 30,
      minScore: 70,
      mode: "live",
      analyze: async (value) => { calls.push("analyze"); return {
        ...value,
        score: 80,
        verdict: "review",
        meta: { symbol: "TEST" },
        sellability: CONFIRMED_SELLABILITY,
      }; },
      markSeen: () => calls.push("seen"),
      alertReport: async () => calls.push("alert"),
      log: () => {},
    },
  });
  assert.deepEqual(calls, ["classify", "analyze", "alert", "seen"]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/store.test.js test/index.test.js`

Expected: FAIL because the store clears `lastError` and `processWatchCandidate` is not exported.

- [ ] **Step 3: Preserve initial errors and add the shared candidate executor**

In `store.scheduleCheck`, use:

```js
lastError: check.lastError == null ? null : safeErrorMessage(check.lastError),
```

In `scanner.js`, add:

```js
export async function processWatchCandidate(event, {
  classifyCandidate,
  candidateDependencies,
}) {
  const classified = await classifyCandidate(event);
  if (classified.identity === "pons-v2") {
    candidateDependencies.markSeen(candidateKey(event), {
      token: event.token,
      skipped: "pons-v2",
    });
    return null;
  }
  if (classified.identity === "unknown") {
    throw new RetryableCandidateError(
      `Pons identity unknown for ${event.token}: ${classified.error || "Factory read failed"}`
    );
  }
  return handleCandidate(classified, { persistSeen: true }, candidateDependencies);
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/store.test.js test/index.test.js`

Expected: all store and scanner orchestration tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/store.js src/scanner.js test/store.test.js test/index.test.js
git commit -m "统一候选实时处理链路"
```

### Task 3: Persist retryable failures and suppress duplicate source requests

**Files:**
- Modify: `src/scanner.js:178-215, 828-897`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing integration tests for durable handoff, deduplication, recovery, and unexpected errors**

Add tests around an exported `createWatchSourceProcessor`:

```js
it("persists one retryable failure and suppresses duplicate source requests", async () => {
  const scheduled = [];
  const recoveryKeys = new Set();
  let classifications = 0;
  const event = candidateEvent();
  const process = createWatchSourceProcessor({
    maxQueueSize: 10,
    hasSeen: () => false,
    claimed: new Set(),
    recoveryKeys,
    executeCandidate: (work) => work(),
    classifyCandidate: async () => {
      classifications += 1;
      throw Object.assign(new Error("Too Many Requests"), { status: 429 });
    },
    candidateDependencies: candidateDependencies(),
    scheduleRecovery: async (value, error) => {
      scheduled.push(createCandidateRecovery(value, 10_000, error));
      recoveryKeys.add(candidateKey(value));
    },
    logError: () => {},
  });
  assert.deepEqual(await process([event]), { accepted: 1, handled: 1, failed: 0 });
  assert.deepEqual(await process([event]), { accepted: 0, handled: 0, failed: 0 });
  assert.equal(classifications, 1);
  assert.equal(scheduled.length, 1);
});

it("does not persist or hide an unexpected candidate error", async () => {
  const event = candidateEvent();
  const result = await createWatchSourceProcessor({
    maxQueueSize: 10,
    hasSeen: () => false,
    claimed: new Set(),
    recoveryKeys: new Set(),
    executeCandidate: (work) => work(),
    classifyCandidate: async () => { throw new ReferenceError("programming fault"); },
    candidateDependencies: candidateDependencies(),
    scheduleRecovery: async () => { throw new Error("must not schedule"); },
    logError: () => {},
  })([event]);
  assert.equal(result.failed, 1);
});

it("recovery retries the full candidate path and leaves ordinary sellability rechecks distinct", async () => {
  const calls = [];
  const handler = createCandidateRecoveryHandler({
    executeCandidate: (work) => work(),
    classifyCandidate: async (event) => { calls.push("classify"); return { ...event, identity: "not_pons" }; },
    candidateDependencies: {
      ...candidateDependencies(),
      analyze: async (event) => { calls.push("analyze"); return safeReport(event); },
      markSeen: () => calls.push("seen"),
      onAnalyzed: () => calls.push("sellability-recheck"),
    },
  });
  await handler({ id: candidateRecoveryId(candidateEvent()), event: candidateEvent() });
  assert.deepEqual(calls, ["classify", "analyze", "sellability-recheck", "seen"]);
});
```

- [ ] **Step 2: Run the scanner orchestration tests and verify RED**

Run: `node --test test/index.test.js`

Expected: FAIL because the source processor and recovery handler do not exist.

- [ ] **Step 3: Implement scheduler, source processor, and recovery handler**

Add to `scanner.js`:

```js
export function createCandidateRecoveryScheduler({ store, recoveryKeys, now = Date.now }) {
  return async (event, error) => {
    const check = store.scheduleCheck(createCandidateRecovery(event, now(), error));
    recoveryKeys.add(candidateKey(event));
    return check;
  };
}

export function createCandidateRecoveryHandler({
  executeCandidate,
  classifyCandidate,
  candidateDependencies,
}) {
  return async (check) => executeCandidate(() => processWatchCandidate(check.event, {
    classifyCandidate,
    candidateDependencies,
  }));
}

export function createWatchSourceProcessor({
  maxQueueSize,
  hasSeen,
  claimed,
  recoveryKeys,
  executeCandidate,
  classifyCandidate,
  candidateDependencies,
  scheduleRecovery,
  logError,
}) {
  const inner = new CandidateQueue({
    maxSize: maxQueueSize,
    hasSeen: (key) => hasSeen(key) || claimed.has(key) || recoveryKeys.has(key),
    keyOf: candidateKey,
  });
  const queue = {
    get size() { return inner.size; },
    get isFull() { return inner.isFull; },
    enqueue(event) {
      const accepted = inner.enqueue(event);
      if (accepted) claimed.add(candidateKey(event));
      return accepted;
    },
    take: () => inner.take(),
    finish(event) {
      inner.finish(event);
      claimed.delete(candidateKey(event));
    },
  };
  return (events) => processEvents(events, queue, () => drainQueue(queue, DEFAULT_ANALYSIS_CONCURRENCY,
    async (event) => executeCandidate(async () => {
      try {
        return await processWatchCandidate(event, { classifyCandidate, candidateDependencies });
      } catch (error) {
        if (!isRetryableCandidateFailure(error)) {
          logError(`handle failed ${event.token} ${safeErrorMessage(error)}`);
          throw error;
        }
        await scheduleRecovery(event, error);
        logError(`candidate deferred ${event.token} ${safeErrorMessage(error)}`);
        return null;
      }
    })));
}
```

In `watch()`:

```js
const recoveryKeys = activeCandidateRecoveryKeys(store.snapshot());
const scheduleRecovery = createCandidateRecoveryScheduler({ store, recoveryKeys, now: Date.now });
pendingHandlers.candidate_recovery = createCandidateRecoveryHandler({
  executeCandidate,
  classifyCandidate: rpc.classifyCandidate,
  candidateDependencies,
});
const createSourceProcessor = () => createWatchSourceProcessor({
  maxQueueSize: SETTINGS.maxQueueSize,
  hasSeen,
  claimed,
  recoveryKeys,
  executeCandidate,
  classifyCandidate: rpc.classifyCandidate,
  candidateDependencies,
  scheduleRecovery,
  logError: console.error,
});
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/index.test.js test/scanner-pons.test.js test/store.test.js test/candidate-recovery.test.js`

Expected: all focused tests pass; the 429 test records one recovery and performs one classification across two source iterations.

- [ ] **Step 5: Run the complete verification suite**

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `git diff --check origin/main...HEAD`

Expected: no output and exit code 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/scanner.js test/index.test.js
git commit -m "持久化退避重试失败候选"
```

### Task 4: Review and update Pull Request #9

**Files:**
- No production file changes expected.

- [ ] **Step 1: Review the final diff against the approved design**

Run: `git diff --stat origin/main...HEAD`

Expected: only the design/plan, candidate recovery module, scanner/store changes, and their tests.

- [ ] **Step 2: Push the completed branch**

Run: `git push origin fix/watch-analysis-binding`

Expected: remote branch advances without force push.

- [ ] **Step 3: Update and read back PR #9**

Run: `gh pr view 9 --repo hblicy/robinhood-scanner-bot --json number,url,state,headRefName,baseRefName`

Expected: PR #9 is open, head is `fix/watch-analysis-binding`, and base is `main`.

