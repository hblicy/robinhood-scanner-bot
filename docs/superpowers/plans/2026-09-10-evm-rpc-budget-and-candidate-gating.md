# EVM RPC Budget and Candidate Gating Implementation Plan（已被修订版取代）

> **停止执行：** 本计划中的本地 UTC 月份 JSON 预算器与 Dwellir 实际账单周期不一致。请改用同目录下的 `2026-09-10-evm-rpc-server-quota-and-candidate-gating.md`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Ethereum、Base、BSC、Robinhood 四条 EVM 链的付费 RPC 月度请求硬限制在共享的 20,000,000 次以内，并在付费深检前跳过当前不支持卖出验证或确定达不到既有深检线的候选。

**Architecture:** 新增一个跨进程、按 UTC 月份批量租约的本地预算器，挂在 analysis Provider 的每次实际 RPC 方法调用之前；四链共用 `data/rpc-analysis-budget.json`，达到上限时失败关闭并由候选层静默跳过。候选层复用安全注册表的场所能力和评分模块的分类上限，Robinhood 的 Pons 身份读取固定走官方 discovery Primary，其他 EVM 链也在通用 runner 中执行同一场所门控。

**Tech Stack:** Node.js 18+ ESM、ethers v6、`node:test`、JSON 原子文件替换、Node `net` 本机排他端口锁。

---

## 文件结构

- Create: `src/rpc-monthly-budget.js` — UTC 月份、跨进程额度租约、硬上限错误和单次通知权。
- Create: `test/rpc-monthly-budget.test.js` — 预算并发、月份切换、损坏状态与通知权测试。
- Create: `src/candidate-gate.js` — 场所门控、零 RPC 评分上界、路由统计和摘要格式。
- Create: `test/candidate-gate.test.js` — 深检线边界、缺失数据 fail-open 和统计测试。
- Modify: `src/rpc-budget.js` — 在高层 Provider RPC 调用真正开始前消耗一个月度响应额度。
- Modify: `src/rpc-endpoints.js` — 向 Provider 工厂传递 discovery/analysis 角色。
- Modify: `src/chain.js` — 构造并公开共享 analysis 月度预算；Pons 可取得原始 discovery Primary。
- Modify: `src/config.js` — Robinhood 兼容运行时解析 20M 配置。
- Modify: `src/chains/load-chain.js` — 四条 EVM 链解析同一个月度上限；Solana 不解析。
- Modify: `src/core/score.js` — 从现有分类分值计算保守上界，不复制评分常量。
- Modify: `src/market.js` — Gecko 事件记录原始市场字段是否完整，避免把缺失值 0 当成已知。
- Modify: `src/sellability.js` — 公开 Robinhood 兼容路径的严格卖出能力判断。
- Modify: `src/security/evm/index.js` — 安全注册表公开 `supports(candidate)`。
- Modify: `src/scanner.js` — Robinhood 官方 Pons 路由、候选门控、预算耗尽处理和路由摘要。
- Modify: `src/evm/runner.js` — Ethereum/Base/BSC 通用 runner 的门控、预算耗尽处理和摘要。
- Modify: `src/app.js` — 四链共享预算路径、通用 EVM 配额通知服务和 runner 配置。
- Modify: `test/rpc-budget.test.js`, `test/rpc-endpoints.test.js`, `test/config.test.js`, `test/core-score.test.js`, `test/market.test.js`, `test/sellability.test.js`, `test/evm-security.test.js`, `test/index.test.js`, `test/evm-runner.test.js`, `test/evm-apps.test.js` — 各接线点回归测试。
- Modify: `.env.example`, `README.md` — 配置、硬上限、故障语义与部署说明。

### Task 1: 实现跨进程 UTC 月度响应预算器

**Files:**
- Create: `src/rpc-monthly-budget.js`
- Create: `test/rpc-monthly-budget.test.js`

- [ ] **Step 1: 写预算租约和硬上限失败测试**

创建测试，使用临时目录和两个独立预算器模拟两个 EVM 进程：

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMonthlyRpcBudget,
  isRpcMonthlyBudgetExceeded,
} from "../src/rpc-monthly-budget.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-monthly-budget-"));
  return { dir, filePath: path.join(dir, "budget.json") };
}

describe("monthly RPC budget", () => {
  it("shares leases across processes without reserving above the limit", async () => {
    const { filePath } = fixture();
    const options = { filePath, limit: 3, leaseSize: 2, now: () => Date.UTC(2026, 8, 10) };
    const first = createMonthlyRpcBudget(options);
    const second = createMonthlyRpcBudget(options);

    await first.consume("eth_call", "robinhood");
    await second.consume("eth_getLogs", "base");
    await first.consume("eth_getCode", "bsc");
    await assert.rejects(
      () => second.consume("eth_call", "ethereum"),
      (error) => isRpcMonthlyBudgetExceeded(error) && error.limit === 3
    );

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
      month: "2026-09",
      limit: 3,
      reserved: 3,
      notificationClaimed: false,
    });
  });

  it("drops an old local lease when the UTC month changes", async () => {
    const { filePath } = fixture();
    let at = Date.UTC(2026, 8, 30, 23, 59);
    const budget = createMonthlyRpcBudget({ filePath, limit: 2, leaseSize: 2, now: () => at });
    await budget.consume("eth_call", "robinhood");
    at = Date.UTC(2026, 9, 1, 0, 0);
    await budget.consume("eth_call", "robinhood");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).month, "2026-10");
  });

  it("grants the monthly notification claim once across processes", async () => {
    const { filePath } = fixture();
    const options = { filePath, limit: 1, leaseSize: 1, now: () => Date.UTC(2026, 8, 10) };
    const first = createMonthlyRpcBudget(options);
    const second = createMonthlyRpcBudget(options);
    await first.consume("eth_call", "base");
    const claims = await Promise.all([
      first.claimExhaustionNotification(),
      second.claimExhaustionNotification(),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
  });
});
```

- [ ] **Step 2: 运行预算器测试并确认按缺失模块失败**

Run: `node --test test/rpc-monthly-budget.test.js`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND` 或缺少 `createMonthlyRpcBudget` 导出。

- [ ] **Step 3: 实现预算器、端口锁和原子状态替换**

在 `src/rpc-monthly-budget.js` 实现完整模块：

```js
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";

function utcMonth(now) {
  return new Date(now()).toISOString().slice(0, 7);
}

function budgetLockPort(filePath) {
  const normalized = path.resolve(filePath);
  const identity = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const digest = createHash("sha256").update(identity).digest();
  return 40_000 + (digest.readUInt16BE(0) % 10_000);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withBudgetLock(filePath, sleep, operation) {
  const port = budgetLockPort(filePath);
  const deadline = Date.now() + 5_000;
  let server;
  while (!server) {
    const candidate = net.createServer((socket) => socket.destroy());
    try {
      await listen(candidate, port);
      server = candidate;
    } catch (cause) {
      candidate.closeAllConnections?.();
      if (cause?.code !== "EADDRINUSE" || Date.now() >= deadline) {
        throw new Error(`RPC budget lock ${port} unavailable`, { cause });
      }
      await sleep(25);
    }
  }
  try {
    return await operation();
  } finally {
    await close(server);
  }
}

function freshState(month, limit) {
  return { month, limit, reserved: 0, notificationClaimed: false };
}

function validateState(value) {
  const valid = value && /^\d{4}-\d{2}$/.test(value.month)
    && Number.isInteger(value.limit) && value.limit > 0
    && Number.isInteger(value.reserved) && value.reserved >= 0
    && value.reserved <= value.limit
    && typeof value.notificationClaimed === "boolean";
  if (!valid) throw new Error("invalid RPC budget state");
  return value;
}

function readState(filePath, month, limit) {
  if (!fs.existsSync(filePath)) return freshState(month, limit);
  let state;
  try {
    state = validateState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (cause) {
    throw new Error(`invalid RPC budget state at ${filePath}`, { cause });
  }
  if (state.month !== month) return freshState(month, limit);
  if (state.limit !== limit) {
    throw new Error(`RPC monthly budget limit mismatch: state=${state.limit} config=${limit}`);
  }
  return state;
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export class RpcMonthlyBudgetExceededError extends Error {
  constructor({ month, limit, method, chain }) {
    super(`EVM analysis RPC monthly budget exhausted for ${month}: ${limit} responses`);
    this.name = "RpcMonthlyBudgetExceededError";
    this.code = "RPC_MONTHLY_BUDGET_EXCEEDED";
    this.month = month;
    this.limit = limit;
    this.method = method;
    this.chain = chain;
  }
}

export function isRpcMonthlyBudgetExceeded(error) {
  const pending = [error];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    if (typeof current === "object") {
      visited.add(current);
      if (current.code === "RPC_MONTHLY_BUDGET_EXCEEDED") return true;
      pending.push(current.cause, current.error, current.info?.error);
      if (Array.isArray(current.errors)) pending.push(...current.errors);
    }
  }
  return false;
}

export function createMonthlyRpcBudget({
  filePath,
  limit,
  leaseSize = 1_000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("RPC budget filePath is required");
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("RPC monthly budget limit must be a positive integer");
  if (!Number.isInteger(leaseSize) || leaseSize <= 0) throw new Error("RPC budget leaseSize must be a positive integer");

  let localMonth = null;
  let localRemaining = 0;
  let exhaustedMonth = null;
  let serial = Promise.resolve();

  const runSerial = (operation) => {
    const result = serial.then(operation, operation);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };
  const transact = (operation) => withBudgetLock(filePath, sleep, () => {
    const month = utcMonth(now());
    const state = readState(filePath, month, limit);
    const result = operation(state, month);
    if (result.write) writeState(filePath, state);
    return result.value;
  });

  return Object.freeze({
    consume(method, chain) {
      return runSerial(async () => {
        const month = utcMonth(now());
        if (localMonth !== month) {
          localMonth = month;
          localRemaining = 0;
          exhaustedMonth = null;
        }
        if (localRemaining === 0) {
          const granted = await transact((state, activeMonth) => {
            const available = state.limit - state.reserved;
            if (available <= 0) return { write: false, value: 0 };
            const value = Math.min(leaseSize, available);
            state.reserved += value;
            return { write: true, value };
          });
          if (granted === 0) {
            exhaustedMonth = month;
            throw new RpcMonthlyBudgetExceededError({ month, limit, method, chain });
          }
          localRemaining = granted;
        }
        localRemaining -= 1;
        exhaustedMonth = null;
      });
    },
    isLocallyExhausted() {
      return exhaustedMonth === utcMonth(now()) && localRemaining === 0;
    },
    claimExhaustionNotification() {
      return runSerial(() => transact((state) => {
        if (state.reserved < state.limit || state.notificationClaimed) {
          return { write: false, value: false };
        }
        state.notificationClaimed = true;
        return { write: true, value: true };
      }));
    },
    snapshot() {
      return runSerial(() => transact((state) => ({
        write: false,
        value: structuredClone(state),
      })));
    },
  });
}
```

实现细节必须完整包含：

- `new Date(now()).toISOString().slice(0, 7)` 生成 UTC 月份；
- 根据规范化绝对 `filePath` 的 SHA-256 生成 40,000–49,999 范围端口；
- 临时 `net.Server` 在 `127.0.0.1` 排他监听，`EADDRINUSE` 每 25ms 重试，5 秒后抛出带原因的错误；
- 锁内读取 JSON；文件不存在时初始化，JSON 损坏、字段非法或同月 `limit` 不同立即抛错；
- 使用同目录、带 PID 和随机 UUID 的临时文件，先 `openSync(..., "wx")` 写入，再 `renameSync` 原子替换；
- 每次租约最多 `leaseSize`，最后一批只租剩余额度；本地租约按月份保存，跨月立即丢弃；
- 同一进程的 `consume` 和 `claimExhaustionNotification` 通过 Promise 链串行，避免并发重复租约；
- 无剩余额度时先设置本地 exhausted 月份，再抛出 `RpcMonthlyBudgetExceededError`；
- `claimExhaustionNotification` 在共享状态中原子地把 `notificationClaimed` 从 false 改为 true。

- [ ] **Step 4: 补失败关闭测试**

在同一测试文件增加：损坏 JSON 必须拒绝、同月不同 limit 必须拒绝、最后一批小于 leaseSize、并发 `consume` 总成功数不超过 limit。断言错误文本分别包含 `invalid RPC budget state`、`limit mismatch`，且最终 `reserved <= limit`。

- [ ] **Step 5: 运行预算器测试**

Run: `node --test test/rpc-monthly-budget.test.js`

Expected: PASS，全部月度预算测试通过。

- [ ] **Step 6: 提交预算核心**

```bash
git add src/rpc-monthly-budget.js test/rpc-monthly-budget.test.js
git commit -m "实现跨进程 RPC 月度硬预算"
```

### Task 2: 将月度预算接入所有 EVM analysis Provider

**Files:**
- Modify: `src/rpc-budget.js`
- Modify: `src/rpc-endpoints.js`
- Modify: `src/chain.js`
- Modify: `src/config.js`
- Modify: `src/chains/load-chain.js`
- Modify: `src/app.js`
- Modify: `test/rpc-budget.test.js`
- Modify: `test/rpc-endpoints.test.js`
- Modify: `test/config.test.js`
- Modify: `test/evm-apps.test.js`

- [ ] **Step 1: 写 Provider 调用前计数的失败测试**

在 `test/rpc-budget.test.js` 增加测试，要求高层方法和直接 `send` 都先计数，失败请求也只占本次一次：

```js
it("consumes one monthly response before each provider RPC", async () => {
  const consumed = [];
  const provider = createBudgetedProvider({
    getCode: async () => "0x6000",
    send: async (method) => method,
  }, async (_cost, operation) => operation(), {
    beforeRequest: async (method) => consumed.push(method),
  });
  await provider.getCode("0x1");
  await provider.send("eth_chainId", []);
  assert.deepEqual(consumed, ["getCode", "eth_chainId"]);
});
```

在 `test/rpc-endpoints.test.js` 断言 Provider 工厂第三个参数依次为 `"discovery"` 和 `"analysis"`；相同 URL 时只创建一个 `"analysis"` Provider，确保全部付费流量受限。

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `node --test test/rpc-budget.test.js test/rpc-endpoints.test.js`

Expected: FAIL，因为 `beforeRequest` 和 Provider 角色尚未实现。

- [ ] **Step 3: 最小修改 Provider 包装与角色工厂**

把 `createBudgetedProvider` 签名改为：

```js
export function createBudgetedProvider(provider, schedule, { beforeRequest = null } = {}) {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cost = RPC_CU[property];
      if (!cost) return value.bind(target);
      return (...args) => schedule(cost, async () => {
        const method = property === "send" ? String(args[0]) : String(property);
        if (beforeRequest) await beforeRequest(method);
        return value.apply(target, args);
      });
    },
  });
}
```

给 `RPC_CU` 增加 `send: 26`。在 `createRoleProviders` 中把角色作为第三参传给 `createProvider`，相同端点按 `analysis` 创建，避免付费发现绕过预算：

```js
if (discoveryKey === analysisKey) {
  const shared = createProvider(analysisUrl, Math.min(discoveryCups, analysisCups), "analysis");
  return { analysis: shared, discoveryPrimary: shared, discoveryFallback: null, sameEndpoint: true };
}
const discoveryPrimary = createProvider(discoveryUrl, discoveryCups, "discovery");
const analysis = createProvider(analysisUrl, analysisCups, "analysis");
return { analysis, discoveryPrimary, discoveryFallback: analysis, sameEndpoint: false };
```

- [ ] **Step 4: 写四链同配置和 Solana 排除测试**

在 `test/config.test.js`/`test/evm-apps.test.js` 增加断言：

```js
assert.equal(loadChainConfig("base", env).rpc.monthlyResponseLimit, 20_000_000);
assert.equal(loadChainConfig("bsc", env).rpc.monthlyResponseLimit, 20_000_000);
assert.equal(loadChainConfig("ethereum", env).rpc.monthlyResponseLimit, 20_000_000);
assert.equal(loadChainConfig("robinhood", env).rpc.monthlyResponseLimit, 20_000_000);
assert.equal("monthlyResponseLimit" in loadChainConfig("solana", env).rpc, false);
```

另测 `EVM_ANALYSIS_RPC_MONTHLY_LIMIT=0` 和非整数值在启动解析时明确失败。

- [ ] **Step 5: 接入配置、共享路径和 analysis 角色预算**

- `src/config.js` 的已知环境变量和 `SETTINGS` 增加 `analysisRpcMonthlyLimit`，默认 20,000,000。
- `src/chains/load-chain.js` 只在 EVM 分支的 `rpc` 增加 `monthlyResponseLimit`，读取 `EVM_ANALYSIS_RPC_MONTHLY_LIMIT`。
- `src/app.js` 用 `path.join(projectRoot, "data", "rpc-analysis-budget.json")` 创建预算器，并随 `rpcOptions` 传给 `createChainRpcContext`。
- `src/chain.js` 的 `createChainRpcContext` 接受 `analysisBudget`；只给角色 `analysis` 的 Provider 传入：

```js
const providers = createRoleProviders({
  discoveryUrl: chain.discoveryRpc,
  analysisUrl: chain.analysisRpc,
  discoveryCups: settings.discoveryRpcCups,
  analysisCups: settings.analysisRpcCups,
  createProvider: (url, cups, role) => buildProvider(url, cups, {
    beforeRequest: role === "analysis" && analysisBudget
      ? (method) => analysisBudget.consume(method, chain.key)
      : null,
  }),
});
```

- 相同 discovery/analysis URL 时共享 Provider 仍按 analysis 计数。
- `getRpcContext()` 为 Robinhood 兼容扫描器使用 `DATA_DIR/rpc-analysis-budget.json` 创建相同预算，并新增 `getAnalysisBudget()` 导出。
- 返回的 RPC context 包含 `analysisBudget`，Solana RPC context 保持不变。

应用侧创建代码固定为：

```js
const analysisBudget = dependencies.analysisBudget ?? createMonthlyRpcBudget({
  filePath: path.join(projectRoot, "data", "rpc-analysis-budget.json"),
  limit: loaded.rpc.monthlyResponseLimit,
});
const rpcContext = createRpcContext({
  ...rpcOptions(loaded),
  analysisBudget,
});
```

- [ ] **Step 6: 运行 Provider、配置和应用测试**

Run: `node --test test/rpc-budget.test.js test/rpc-endpoints.test.js test/config.test.js test/evm-apps.test.js test/robinhood-app.test.js`

Expected: PASS；四条 EVM 使用同一预算路径，Solana 不出现该字段。

- [ ] **Step 7: 提交 Provider 接线**

```bash
git add src/rpc-budget.js src/rpc-endpoints.js src/chain.js src/config.js src/chains/load-chain.js src/app.js test/rpc-budget.test.js test/rpc-endpoints.test.js test/config.test.js test/evm-apps.test.js test/robinhood-app.test.js
git commit -m "接入四链共享付费 RPC 预算"
```

### Task 3: 建立单一卖出能力判断和保守评分上界

**Files:**
- Modify: `src/sellability.js`
- Modify: `src/security/evm/index.js`
- Modify: `src/core/score.js`
- Modify: `src/market.js`
- Modify: `test/sellability.test.js`
- Modify: `test/evm-security.test.js`
- Modify: `test/core-score.test.js`
- Modify: `test/market.test.js`

- [ ] **Step 1: 写场所能力失败测试**

在 `test/sellability.test.js` 断言 Robinhood 兼容路径仅支持合法非零池的 `uniswap-v2`。在 `test/evm-security.test.js` 断言注册表的 `supports` 只对已注册的 `(chain, venue)` 返回 true：

```js
assert.equal(supportsStrictSellability({ venue: "uniswap-v2", pool: POOL }), true);
assert.equal(supportsStrictSellability({ venue: "uniswap-v4", pool: POOL }), false);
assert.equal(registry.supports({ chain: "base", venue: "uniswap-v2-base" }), true);
assert.equal(registry.supports({ chain: "base", venue: "uniswap-v4-base" }), false);
```

- [ ] **Step 2: 运行场所能力测试并确认失败**

Run: `node --test test/sellability.test.js test/evm-security.test.js`

Expected: FAIL，缺少 `supportsStrictSellability` 或 `registry.supports`。

- [ ] **Step 3: 实现场所能力单一来源**

在 `src/sellability.js` 导出并在已有 V2 入口复用：

```js
export function supportsStrictSellability(context, { expectedVenue = "uniswap-v2" } = {}) {
  if (context?.venue !== expectedVenue) return false;
  try {
    const pool = getAddress(context.pool);
    return pool.toLowerCase() !== ADDR.ZERO.toLowerCase();
  } catch {
    return false;
  }
}
```

在 `createEvmSecurityRegistry` 返回对象中增加：

```js
supports(candidate) {
  return byVenue.has(entryKey(candidate?.chain, candidate?.venue));
}
```

`inspect` 仍保持 unknown/unsupported 行为，不改变安全结论。

- [ ] **Step 4: 写评分上界和 Gecko 数据完整性失败测试**

在 `test/core-score.test.js` 增加 `scoreCandidateUpperBound` 测试：已知分类用实际得分，未知分类使用 `SCORE_MAXIMA`，并验证默认 70 分时 59 跳过、60 边界仍可深检。

在 `test/market.test.js` 使用一条字段齐全和一条字段为 null 的 Gecko fixture，断言：

```js
assert.deepEqual(complete.market.scoreKnown, {
  flow: true,
  marketCap: true,
  liquidity: true,
});
assert.equal(incomplete.market.scoreKnown.flow, false);
```

- [ ] **Step 5: 运行评分和市场测试并确认失败**

Run: `node --test test/core-score.test.js test/market.test.js`

Expected: FAIL，缺少评分上界导出和 `market.scoreKnown`。

- [ ] **Step 6: 实现评分上界与原始字段完整性**

在 `src/core/score.js` 增加：

```js
export function scoreCandidateUpperBound(facts, thresholds, knownCategories) {
  const scored = scoreCandidate(facts, thresholds);
  const known = new Set(knownCategories);
  return Object.entries(scored.categories).reduce(
    (total, [name, category]) => total + (known.has(name) ? category.points : SCORE_MAXIMA[name]),
    0
  );
}
```

在 `src/market.js` 增加不接受 null/undefined/空字符串的 `isSuppliedNumber`，并给 Gecko `market` 加入：

```js
scoreKnown: {
  flow: [a.volume_usd?.m5, a.volume_usd?.h1, tx.buys, tx.sells].every(isSuppliedNumber),
  marketCap: [a.market_cap_usd, a.fdv_usd].some(isSuppliedNumber),
  liquidity: isSuppliedNumber(a.reserve_in_usd),
},
```

该元数据只描述原始响应完整性，不改变现有数值字段和最终评分。

- [ ] **Step 7: 运行四个定向测试文件**

Run: `node --test test/sellability.test.js test/evm-security.test.js test/core-score.test.js test/market.test.js`

Expected: PASS。

- [ ] **Step 8: 提交能力和评分基础**

```bash
git add src/sellability.js src/security/evm/index.js src/core/score.js src/market.js test/sellability.test.js test/evm-security.test.js test/core-score.test.js test/market.test.js
git commit -m "增加卖出能力门控与评分上界"
```

### Task 4: 实现候选路由决策与统计

**Files:**
- Create: `src/candidate-gate.js`
- Create: `test/candidate-gate.test.js`

- [ ] **Step 1: 写候选门控和 fail-open 测试**

测试以下完整行为：

```js
const thresholds = {
  minScore: 70,
  maxAgeMinutes: 30,
  minLiquidityUsd: 1_500,
  maxMcapUsd: 1_500_000,
};

assert.deepEqual(routeCandidate(v4Event, {
  now: () => NOW,
  thresholds,
  supportsSellability: () => false,
}), { action: "skip", reason: "unsupported-sellability-venue", upperBound: null });

assert.equal(routeCandidate(completeLowV2, {
  now: () => NOW,
  thresholds,
  supportsSellability: () => true,
}).reason, "prefilter-score-upper-bound");

assert.equal(routeCandidate(boundary60V2, {
  now: () => NOW,
  thresholds,
  supportsSellability: () => true,
}).action, "analyze");

assert.equal(routeCandidate(incompleteV2, {
  now: () => NOW,
  thresholds,
  supportsSellability: () => true,
}).action, "analyze");
```

另测 `createCandidateRouteStats`、`incrementCandidateRouteStat` 和 `formatCandidateRouteStats` 的固定字段与稳定输出顺序。

- [ ] **Step 2: 运行候选门控测试并确认失败**

Run: `node --test test/candidate-gate.test.js`

Expected: FAIL，缺少 `src/candidate-gate.js`。

- [ ] **Step 3: 实现候选门控**

`src/candidate-gate.js` 导出：

```js
export const CANDIDATE_ROUTE_STAT_KEYS = Object.freeze([
  "pons_official_checks",
  "deferred_pons_checks",
  "skipped_unsupported_venue",
  "skipped_score_upper_bound",
  "paid_deep_checks",
  "rpc_budget_skips",
]);

export function createCandidateRouteStats() {
  return Object.fromEntries(CANDIDATE_ROUTE_STAT_KEYS.map((key) => [key, 0]));
}

export function incrementCandidateRouteStat(stats, key) {
  if (!stats) return;
  if (!Object.hasOwn(stats, key)) throw new Error(`unknown candidate route stat: ${key}`);
  stats[key] += 1;
}

export function routeCandidate(event, { now, thresholds, supportsSellability }) {
  if (!supportsSellability(event)) {
    return { action: "skip", reason: "unsupported-sellability-venue", upperBound: null };
  }
  const known = event?.market?.scoreKnown;
  const ageMinutes = Number.isFinite(event?.createdAt)
    ? Math.max(0, (now() - event.createdAt) / 60_000)
    : null;
  if (!known || !Number.isFinite(ageMinutes) || ageMinutes > thresholds.maxAgeMinutes
      || !known.flow || !known.marketCap || !known.liquidity) {
    return { action: "analyze", reason: null, upperBound: null };
  }
  const facts = {
    ageMinutes,
    buys5m: event.market.buys5m,
    sells5m: event.market.sells5m,
    volume5m: event.market.volume5m,
    volume1h: event.market.volume1h,
    mcapUsd: event.market.mcapUsd,
    liquidityUsd: event.market.liquidityUsd,
  };
  const upperBound = scoreCandidateUpperBound(
    facts,
    thresholds,
    ["age", "flow", "marketCap", "liquidity"]
  );
  const deepThreshold = Math.max(0, Number(thresholds.minScore) - 10);
  return upperBound < deepThreshold
    ? { action: "skip", reason: "prefilter-score-upper-bound", upperBound }
    : { action: "analyze", reason: null, upperBound };
}
```

`formatCandidateRouteStats` 输出单行：`rpc-route pons=<n> deferred=<n> unsupported=<n> score=<n> paid=<n> budget=<n>`。

- [ ] **Step 4: 运行候选门控测试**

Run: `node --test test/candidate-gate.test.js`

Expected: PASS。

- [ ] **Step 5: 提交候选路由模块**

```bash
git add src/candidate-gate.js test/candidate-gate.test.js
git commit -m "实现零调用候选路由决策"
```

### Task 5: 接入 Robinhood 官方 Pons 路由、预算停止和摘要

**Files:**
- Modify: `src/scanner.js`
- Modify: `test/index.test.js`
- Modify: `test/candidate-recovery.test.js`

- [ ] **Step 1: 修改 RPC 路由测试使其要求 Pons 只走官方 Primary**

更新 `createWatchRpcBindings` 测试，显式传入：

```js
const discoveryPrimary = { role: "discovery-primary" };
const discoveryFallbackSessionProvider = { role: "analysis-fallback" };
```

断言 Factory/游标仍通过 `discoverySessions.run`，`analyzeCandidate` 使用 analysis Provider，而 `classifyCandidate` 使用 `discoveryPrimary`。再让 session provider 与 Primary 不同，证明分类不经过熔断备用。

- [ ] **Step 2: 写 Robinhood 候选门控和恢复路径失败测试**

在 `test/index.test.js` 增加：

- 非 Pons V4 标记 `unsupported-sellability-venue`，`analyze` 调用为 0；
- 完整低分 V2 标记 `prefilter-score-upper-bound`，`analyze` 调用为 0；
- 上界等于 60 的 V2 继续调用 `analyze`；
- 缺少 `scoreKnown` 的 V2 fail-open；
- candidate recovery 再次进入相同门控，不绕过场所判断；
- 分类 429 增加 `deferred_pons_checks`，编程错误仍向上传播；
- 月度预算错误即使包在 `RetryableAnalysisError.cause` 中，也不进入 candidate recovery，标记 `rpc-monthly-budget` 并推进游标。

- [ ] **Step 3: 运行 Robinhood 定向测试并确认失败**

Run: `node --test test/index.test.js test/candidate-recovery.test.js`

Expected: FAIL，分类仍使用 analysis Provider，V3/V4 仍调用分析。

- [ ] **Step 4: 最小接入官方分类、门控与统计**

修改 `createWatchRpcBindings`：

```js
export function createWatchRpcBindings({
  analysisProvider = getAnalysisProvider(),
  discoveryProvider = getDiscoveryProvider(),
  analysisBudget = getAnalysisBudget(),
  discoverySessions = getDiscoverySessions(),
  routeStats = null,
  getBlockNumberImpl = getBlockNumber,
  findFirstBlockAtOrAfterImpl = findFirstBlockAtOrAfter,
  scanOnchainImpl = scanOnchain,
  analyzeImpl = analyze,
  classifyCandidateImpl = classifyAuxiliaryCandidate,
} = {}) {
  const runDiscoverySession = (work) => discoverySessions.run(work);
  const discovery = {
    runDiscoverySession,
    getBlockNumber: (provider) => getBlockNumberImpl(provider),
    findFirstBlockAtOrAfter: (target, head, provider) =>
      findFirstBlockAtOrAfterImpl(target, head, provider),
  };
  return {
    analysisProvider,
    analysisBudget,
    startup: { runDiscoverySession },
    onchain: {
      ...discovery,
      scanOnchain: (from, to, provider) => scanOnchainImpl(from, to, { provider }),
    },
    pons: { ...discovery },
    async analyzeCandidate(event) {
      incrementCandidateRouteStat(routeStats, "paid_deep_checks");
      return analyzeImpl(event, { provider: analysisProvider });
    },
    async classifyCandidate(event) {
      incrementCandidateRouteStat(routeStats, "pons_official_checks");
      return classifyCandidateImpl(event, { provider: discoveryProvider });
    },
  };
}
```

`processWatchCandidate` 在 `not_pons` 后调用 `routeCandidate`。skip 时用现有 `candidateKey` 写入：

```js
candidateDependencies.markSeen(candidateKey(event), {
  token: event.token,
  skipped: decision.reason,
  upperBound: decision.upperBound,
});
```

并按原因计数：

```js
const stat = decision.reason === "unsupported-sellability-venue"
  ? "skipped_unsupported_venue"
  : "skipped_score_upper_bound";
incrementCandidateRouteStat(candidateDependencies.routeStats, stat);
```

分类 unknown/可恢复错误计入 `deferred_pons_checks`；实时和 `createCandidateRecoveryHandler` 因共用 `processWatchCandidate` 自动得到相同门控。

- [ ] **Step 5: 接入 Robinhood 预算耗尽处理和唯一告警**

在 `processWatchCandidate` 调用 `handleCandidate` 前检查 `analysisBudget.isLocallyExhausted()`；已耗尽时直接标记 skip。再包裹 `handleCandidate`，使第一次在分析中触顶的嵌套错误也进入同一个分支：

```js
const skipForBudget = async (error = null) => {
  incrementCandidateRouteStat(candidateDependencies.routeStats, "rpc_budget_skips");
  candidateDependencies.markSeen(candidateKey(event), {
    token: event.token,
    skipped: "rpc-monthly-budget",
  });
  await candidateDependencies.onBudgetExceeded(error);
  return null;
};

if (candidateDependencies.analysisBudget?.isLocallyExhausted()) {
  return skipForBudget();
}
try {
  return await handleCandidate(classified, { persistSeen: true }, candidateDependencies);
} catch (error) {
  if (isRpcMonthlyBudgetExceeded(error)) return skipForBudget(error);
  throw error;
}
```

该逻辑放在 Pons 身份分类之后，因此预算耗尽不会停止官方身份识别；同时实时路径和 `candidate_recovery` 都复用它，预算错误不会被当成普通候选恢复错误。

`watch` 创建共享 route stats，并从 `getAnalysisBudget()` 取得预算器。`onBudgetExceeded` 只有在 `claimExhaustionNotification()` 返回 true 时调用 `sendTelegram`，文本固定为：

```text
⚠️ EVM 付费 RPC 月度额度已用完
四条 EVM 链仍继续发现，但候选深检暂停至下个 UTC 月。
本机器人月度上限：20,000,000 次响应。
```

预算告警不得包含 RPC URL。通知调用失败记录一次带上下文错误，不把候选重新送入普通恢复。

- [ ] **Step 6: 在 Gecko 摘要附加累计路由统计**

向 `runWatchIteration` 注入 route stats；已有 `gecko:` 日志末尾附加稳定摘要，不逐候选增加 skip 日志：

```js
dependencies.log(
  `gecko: ${events.length} pools, ${result.accepted} new ${formatCandidateRouteStats(dependencies.routeStats)}`
);
```

- [ ] **Step 7: 运行 Robinhood 回归测试**

Run: `node --test test/index.test.js test/candidate-recovery.test.js test/push-only.test.js test/notify.test.js`

Expected: PASS；普通推送、blocked 风险、Pons 生命周期和启动补扫通知测试保持不变。

- [ ] **Step 8: 提交 Robinhood 接线**

```bash
git add src/scanner.js test/index.test.js test/candidate-recovery.test.js
git commit -m "优化 Robinhood 付费深检路由"
```

### Task 6: 接入 Ethereum、Base、BSC 通用 EVM runner

**Files:**
- Modify: `src/evm/runner.js`
- Modify: `src/app.js`
- Modify: `test/evm-runner.test.js`
- Modify: `test/evm-apps.test.js`

- [ ] **Step 1: 写通用 EVM 场所门控失败测试**

在 `test/evm-runner.test.js` 构造同一区块范围的 V2 和 V4 候选，注入：

```js
securityRegistry: {
  supports: (candidate) => candidate.venue === "uniswap-v2-base",
},
```

断言 V4 被 `markSeen` 为 `unsupported-sellability-venue`，V2 才调用 analyze。再为 BSC 和 Ethereum 各使用实际注册表 ID 做参数化测试，证明不是只修 Base。

- [ ] **Step 2: 写通用 EVM 预算耗尽失败测试**

让 `analyze` 抛出带 `RPC_MONTHLY_BUDGET_EXCEEDED` code 的嵌套错误，断言：

- 当前候选标记 `rpc-monthly-budget`；
- 后续候选在 `analysisBudget.isLocallyExhausted()` 为 true 时不调用 analyze；
- 区块游标仍推进；
- `onBudgetExceeded` 在一次迭代内只调用一次；
- discovery Provider 仍被读取。

- [ ] **Step 3: 运行通用 EVM 测试并确认失败**

Run: `node --test test/evm-runner.test.js test/evm-apps.test.js`

Expected: FAIL，runner 尚未使用 `securityRegistry.supports` 或预算处理。

- [ ] **Step 4: 在 runner 候选循环接入共享门控**

`defaultDependencies` 增加 `routeStats`、`routeCandidate`、`onBudgetExceeded`。在调用 `handleCandidate` 前：

1. 若 `analysisBudget.isLocallyExhausted()`，增加 `rpc_budget_skips`、标记 `rpc-monthly-budget` 并通知；
2. 调用 `routeCandidate(event, { now, thresholds: config.settings, supportsSellability: candidate => config.securityRegistry.supports(candidate) })`；
3. skip 决策写入当前链 store；
4. skip 决策分别增加 `skipped_unsupported_venue` 或 `skipped_score_upper_bound`；只有 analyze 决策增加 `paid_deep_checks` 并进入 `handleCandidate`；
5. 捕获嵌套月度预算错误后按配额 skip 处理，不重新抛出；其他错误保持现有调用链；
6. `watchEvm` 的发现 Session 若因“官方失败且付费备用额度耗尽”抛出预算错误，只记录发现暂停并进入下一轮，不退出进程。

候选循环使用以下结构，确保只有预算错误被静默转成配额 skip：

```js
const skip = (reason, upperBound = null) => {
  if (persist) store.markSeen(key, { token: event.token, skipped: reason, upperBound });
};
if (config.rpcContext.analysisBudget?.isLocallyExhausted()) {
  incrementCandidateRouteStat(dependencies.routeStats, "rpc_budget_skips");
  skip("rpc-monthly-budget");
  if (persist) await dependencies.onBudgetExceeded();
  continue;
}
const decision = dependencies.routeCandidate(event, {
  now: dependencies.now,
  thresholds: config.settings,
  supportsSellability: (candidate) => config.securityRegistry.supports(candidate),
});
if (decision.action === "skip") {
  incrementCandidateRouteStat(
    dependencies.routeStats,
    decision.reason === "unsupported-sellability-venue"
      ? "skipped_unsupported_venue"
      : "skipped_score_upper_bound"
  );
  skip(decision.reason, decision.upperBound);
  continue;
}
incrementCandidateRouteStat(dependencies.routeStats, "paid_deep_checks");
const candidateDependencies = {
  now: dependencies.now,
  maxAgeMinutes,
  minScore: config.settings.minScore,
  mode,
  analyze: dependencies.analyze,
  markSeen: (seenKey, payload) => store.markSeen(seenKey, payload),
  alertReport: dependencies.alertReport,
  log: dependencies.log,
};
try {
  const report = await handleCandidate(event, { persistSeen: persist }, candidateDependencies);
  if (report) reports.push(report);
} catch (error) {
  if (!isRpcMonthlyBudgetExceeded(error)) throw error;
  incrementCandidateRouteStat(dependencies.routeStats, "rpc_budget_skips");
  skip("rpc-monthly-budget");
  if (persist) await dependencies.onBudgetExceeded(error);
}
```

Robinhood 继续使用兼容 scanner；此任务只修改 `watch:base`、`watch:bsc`、`watch:ethereum` 的通用 runner 路径。

- [ ] **Step 5: 在 app 提供通用 EVM 唯一配额通知**

`createServices` 增加 `alertRpcBudget`，复用 Task 5 的固定文本和当前 Telegram 配置。`defaultDependencies` 的 `onBudgetExceeded` 先调用共享预算的 `claimExhaustionNotification()`，只有 true 才调用该服务。`notificationsEnabled=false` 的一次性 scan 不发送 Telegram：

```js
onBudgetExceeded: async () => {
  if (!config.notificationsEnabled) return;
  if (await config.rpcContext.analysisBudget.claimExhaustionNotification()) {
    await config.services.alertRpcBudget();
  }
},
```

- [ ] **Step 6: 在通用 EVM 周期摘要附加路由统计**

保持现有：

```text
base: blocks <from>-<to> candidates=<n> mode=<mode>
```

并在末尾追加同一个 `rpc-route ...` 格式。不同进程各自显示本地累计路由数，共享文件负责硬预算，不把本地统计误称为全局账单。

- [ ] **Step 7: 运行全部 EVM runner/app 测试**

Run: `node --test test/evm-runner.test.js test/evm-apps.test.js test/robinhood-app.test.js test/solana-app.test.js`

Expected: PASS；四条 EVM 均受预算约束，Solana app contract 不变。

- [ ] **Step 8: 提交通用 EVM 接线**

```bash
git add src/evm/runner.js src/app.js test/evm-runner.test.js test/evm-apps.test.js
git commit -m "限制多链 EVM 付费深检调用"
```

### Task 7: 文档、格式和全量验收

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: 更新示例配置**

在 EVM RPC 配置旁增加：

```dotenv
# Ethereum、Base、BSC、Robinhood 四链合计；Solana 不计入。
EVM_ANALYSIS_RPC_MONTHLY_LIMIT=20000000
```

保留现有 RPC URL 示例，不写真实 key。

- [ ] **Step 2: 更新部署和故障语义文档**

README 明确写出：

- 官方 RPC 负责高频发现；Robinhood Pons 逐候选身份识别不回退付费节点；
- 当前不支持严格卖出验证的 V3/V4/未知场所只发现和去重；
- 完整 Gecko 市场数据的评分上界低于 `MIN_SCORE - 10` 才跳过，缺失数据继续深检；
- 四条 EVM 共享 `data/rpc-analysis-budget.json`，UTC 月份、1,000 次批量租约和崩溃时保守浪费语义；
- 20M 是机器人硬上限，供应商账户剩余 5M 由另一个项目使用；
- 达到上限后发现继续、深检暂停、Telegram 只告警一次；
- 删除预算文件会破坏硬上限保证，运行中不得手动清零；
- `rpc-route` 是本地候选统计，`reserved` 是保守额度，不等于供应商最终账单。

- [ ] **Step 3: 运行配置与文档相关测试**

Run: `node --test test/config.test.js test/push-only.test.js test/evm-apps.test.js test/solana-app.test.js`

Expected: PASS。

- [ ] **Step 4: 运行全量测试**

Run: `npm test`

Expected: 全部测试 PASS，0 failed；若总数随新增测试变化，以 0 failed 为验收标准。

- [ ] **Step 5: 检查补丁格式和工作树范围**

Run: `git diff --check`

Expected: 无输出，exit code 0。

Run: `git status --short`

Expected: 只出现本计划列出的源代码、测试、`.env.example` 和 README 变更；不得出现密钥、运行时 `data/*.json` 或用户无关文件。

- [ ] **Step 6: 提交文档与最终验收改动**

```bash
git add .env.example README.md
git commit -m "说明 EVM RPC 月度预算与路由"
```

- [ ] **Step 7: 记录部署后观测命令**

部署并重启四条 EVM watcher 后，仅使用只读命令检查：

```bash
cat data/rpc-analysis-budget.json
```

Expected: `limit` 为 `20000000`、`reserved` 不大于 limit、`month` 为当前 UTC 月。运行 12–24 小时后，将 Dwellir 控制台增量与文件 `reserved`、各进程 `rpc-route paid=` 对照；本地预留应不小于实际调用增量的合理近似，且任何时刻不突破20M。
