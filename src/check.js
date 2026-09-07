import { getAddress } from "ethers";
import { getProvider, findFirstBlockAtOrAfter } from "./chain.js";
import { SETTINGS } from "./config.js";
import { loadCurveTrades, hydrateTraderAddresses, summarizeCurveFlow, countDeployerLaunches24h } from "./curve.js";
import { evaluateLineA } from "./lifecycle.js";
import {
  blockscoutHolders,
  blockscoutToken,
  getDexPaprikaPool,
  getDexPaprikaTransactions,
  normalizeMarketEvidence,
} from "./market.js";
import {
  classifyPonsRecord,
  computePonsPoolId,
  findPonsPoolRegistration,
  readPonsLaunch,
} from "./pons.js";
import { safeErrorMessage } from "./safety.js";

function defaultDependencies() {
  return {
    provider: getProvider(),
    now: Date.now,
    getBlockNumber: async (provider) => provider.getBlockNumber(),
    findFirstBlockAtOrAfter,
    readLaunch: readPonsLaunch,
    loadCurveTrades,
    hydrateTraderAddresses,
    summarizeCurveFlow,
    readToken: blockscoutToken,
    readHolders: blockscoutHolders,
    countLaunches: countDeployerLaunches24h,
    findPoolRegistration: findPonsPoolRegistration,
    getMarketPool: getDexPaprikaPool,
    getMarketTransactions: getDexPaprikaTransactions,
    normalizeMarketEvidence,
  };
}

function phaseLabel(record) {
  return ["not_graduated", "swept", "pool_created", "rescued"][Number(record?.phase)] || "unknown";
}

function unknownReport(token, errors = []) {
  return {
    token,
    identity: "unknown",
    protocolPhase: "unknown",
    monitorState: "observed",
    curve: { status: "unknown", tradeCount: null, uniqueTraders: null },
    hookStatus: "unknown",
    marketReady: "unknown",
    riskDataStatus: "unknown",
    reasons: ["Factory identity unknown"],
    errors,
    unfinishedSources: [],
    timedOut: false,
  };
}

async function inspect(token, deps, pending) {
  const errors = [];
  const source = async (name, fn) => {
    pending.add(name);
    try {
      return { ok: true, value: await fn() };
    } catch (cause) {
      const error = { source: name, message: safeErrorMessage(cause) };
      errors.push(error);
      return { ok: false, error };
    } finally {
      pending.delete(name);
    }
  };

  const factory = await source("factory", () => deps.readLaunch(deps.provider, token));
  if (!factory.ok) return unknownReport(token, errors);

  let classification;
  try {
    classification = classifyPonsRecord(token, factory.value);
  } catch (cause) {
    errors.push({ source: "factory", message: safeErrorMessage(cause) });
    return unknownReport(token, errors);
  }
  if (classification.identity !== "pons-v2") {
    return {
      ...unknownReport(token, errors),
      identity: "not_pons",
      protocolPhase: "not_applicable",
      hookStatus: "not_applicable",
      marketReady: "not_applicable",
      reasons: ["Factory exists=false"],
    };
  }

  const record = factory.value;
  const now = deps.now();
  const curvePromise = source("curve", async () => {
    const head = await deps.getBlockNumber(deps.provider);
    const from = await deps.findFirstBlockAtOrAfter(now - 86_400_000, head, deps.provider);
    const trades = await deps.loadCurveTrades(deps.provider, record.curve, from, head);
    const hydrated = await deps.hydrateTraderAddresses(deps.provider, trades);
    return deps.summarizeCurveFlow(hydrated);
  });
  const metadataPromise = source("token_metadata", () => deps.readToken(token));
  const holdersPromise = source("holders", () => deps.readHolders(token, 20));
  const deployerPromise = source("deployer_24h", () => deps.countLaunches(deps.provider, record.deployer, now));

  const poolId = record.phase >= 2 ? computePonsPoolId(record) : null;
  const hookPromise = record.phase >= 2
    ? source("hook", async () => {
      const head = await deps.getBlockNumber(deps.provider);
      const from = await deps.findFirstBlockAtOrAfter(
        Number(record.sweptAt) > 0 ? Number(record.sweptAt) * 1000 : now - 86_400_000,
        head,
        deps.provider
      );
      return deps.findPoolRegistration(deps.provider, {
        poolId,
        token,
        pairToken: record.pairToken,
        fromBlock: from,
        toBlock: head,
      });
    })
    : Promise.resolve({ ok: true, value: null, notApplicable: true });

  const [curve, metadata, holders, deployer, hook] = await Promise.all([
    curvePromise,
    metadataPromise,
    holdersPromise,
    deployerPromise,
    hookPromise,
  ]);

  let market = { ok: true, value: { marketReady: false }, notApplicable: record.phase < 2 };
  if (record.phase >= 2 && hook.ok && hook.value) {
    market = await source("market", async () => {
      const [pool, transactions] = await Promise.all([
        deps.getMarketPool(poolId),
        deps.getMarketTransactions(poolId),
      ]);
      return deps.normalizeMarketEvidence({
        expected: { token, pairToken: record.pairToken, poolId },
        pools: pool ? [pool] : [],
        transactions,
      });
    });
  }

  const flow = curve.ok ? curve.value : { sampleStatus: "unknown", tradeCount: null, uniqueTraders: null };
  const reasons = [];
  if (flow.sampleStatus !== "sufficient") reasons.push("flow sample insufficient");
  if (!metadata.ok) reasons.push("token metadata unknown");
  if (!holders.ok) reasons.push("holders unknown");
  if (!deployer.ok) reasons.push("deployer history unknown");
  if (record.phase >= 2 && (!hook.ok || !hook.value)) reasons.push("Hook registration not confirmed");
  if (!market.ok || market.value?.marketReady !== true) reasons.push("market not ready");

  const lineA = evaluateLineA({
    identity: "pons-v2",
    name: metadata.ok ? metadata.value.name : "",
    symbol: metadata.ok ? metadata.value.symbol : "",
    deployerLaunches24h: deployer.ok ? deployer.value : null,
    bundleStatus: "unknown",
    internalStatus: "unknown",
    sellability: flow.sellability || "unknown",
    holderCount: metadata.ok ? metadata.value.holders : null,
    flow,
    ageSeconds: Number.isFinite(flow.lastTradeAt) ? Math.max(0, (now - flow.lastTradeAt) / 1000) : null,
    holdersIncreasing: null,
    narrativeReason: null,
  }, {
    maxDeployerLaunches24h: SETTINGS.maxDeployerLaunches24h,
    maxBundlePct: 30,
    maxInternalPct: 30,
    maxSingleTraderPct: SETTINGS.maxSingleTraderPct,
    minAgeSeconds: SETTINGS.lineAIgnoreSeconds,
    ignoreSeconds: SETTINGS.lineAIgnoreSeconds,
    maxAgeMinutes: SETTINGS.lineAMaxAgeMinutes,
    minFlowTrades: SETTINGS.minFlowTrades,
    minFlowUniqueTraders: SETTINGS.minFlowUniqueTraders,
  });
  if (lineA.killReason) reasons.unshift(lineA.killReason);
  for (const reason of lineA.reasons || []) if (!reasons.includes(reason)) reasons.push(reason);

  return {
    token,
    identity: classification.identity,
    protocolPhase: phaseLabel(record),
    monitorState: lineA.monitorState,
    curve: curve.ok ? { status: flow.sampleStatus, ...flow } : { status: "unknown", tradeCount: null, uniqueTraders: null },
    hookStatus: record.phase < 2 ? "not_applicable" : hook.ok && hook.value ? "registered" : hook.ok ? "not_found" : "unknown",
    poolId,
    marketReady: market.ok ? market.value.marketReady : "unknown",
    riskDataStatus: "unknown",
    reasons: [...new Set(reasons)],
    record,
    errors,
    unfinishedSources: [],
    timedOut: false,
  };
}

export async function inspectToken(token, supplied = {}, { timeoutMs = 90_000 } = {}) {
  const address = getAddress(token);
  const deps = { ...defaultDependencies(), ...supplied };
  const pending = new Set();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ...unknownReport(address),
      timedOut: true,
      unfinishedSources: [...pending],
      reasons: ["global inspection timeout"],
    }), timeoutMs);
  });
  try {
    return await Promise.race([inspect(address, deps, pending), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function formatInspectionReport(report) {
  const errors = report.errors?.length
    ? report.errors.map((entry) => `${entry.source}: ${entry.message}`).join("；")
    : "无";
  const unfinished = report.unfinishedSources?.length ? report.unfinishedSources.join(", ") : "无";
  const reasons = report.reasons?.length ? report.reasons.join("；") : "无";
  return [
    `CA ${report.token}`,
    `Factory 身份: ${report.identity}`,
    `Protocol phase: ${report.protocolPhase}`,
    `Monitor state: ${report.monitorState}`,
    `Curve 样本: ${report.curve?.status || "unknown"} / trades=${report.curve?.tradeCount ?? "unknown"} / traders=${report.curve?.uniqueTraders ?? "unknown"}`,
    `Hook/毕业: ${report.hookStatus}`,
    `marketReady: ${String(report.marketReady)}`,
    `风险数据: ${report.riskDataStatus}`,
    `未通过原因: ${reasons}`,
    `数据错误: ${errors}`,
    `全局超时: ${report.timedOut ? "是" : "否"}；未完成数据源: ${unfinished}`,
    "仅做只读检查与推送，不构造或发送交易。",
  ].join("\n");
}
