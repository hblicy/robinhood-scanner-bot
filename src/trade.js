import { Contract, Interface, Wallet, formatEther, keccak256, parseEther } from "ethers";
import { ADDR, SETTINGS, liveTradingAllowed } from "./config.js";
import { V2_FACTORY_ABI, V2_ROUTER_ABI, ERC20_ABI } from "./abis.js";
import { getProvider } from "./chain.js";
import { addTrade, commitPositionTrade, listPositions, removePosition, upsertPosition } from "./store.js";
import { sendTelegram } from "./notify.js";
import { dexScreener } from "./market.js";
import { minOutFromQuote, plannedExitAmount, safeErrorMessage } from "./safety.js";

function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

const transferIface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

export function netTransferAmount(receipt, token, wallet) {
  let net = 0n;
  for (const log of receipt?.logs || []) {
    if (!sameAddress(log.address, token)) continue;
    try {
      const parsed = transferIface.parseLog(log);
      if (!parsed) continue;
      if (sameAddress(parsed.args.to, wallet)) net += BigInt(parsed.args.value);
      if (sameAddress(parsed.args.from, wallet)) net -= BigInt(parsed.args.value);
    } catch {
      // A token receipt can contain events other than Transfer.
    }
  }
  return net;
}

function buyWei() {
  const amount = parseEther(String(SETTINGS.buyAmountEth));
  const maximum = parseEther(String(SETTINGS.maxBuyEth));
  return amount > maximum ? maximum : amount;
}

function defaultLiveDependencies(tokenAddress) {
  const provider = getProvider();
  const wallet = new Wallet(SETTINGS.privateKey, provider);
  const router = new Contract(ADDR.V2_ROUTER, V2_ROUTER_ABI, wallet);
  return {
    liveAllowed: liveTradingAllowed,
    amountIn: buyWei(),
    slippageBps: SETTINGS.slippageBps,
    gasLimit: SETTINGS.gasLimit,
    now: Date.now,
    wallet,
    token: new Contract(tokenAddress, ERC20_ABI, wallet),
    router,
    factory: new Contract(ADDR.V2_FACTORY, V2_FACTORY_ABI, provider),
    expectedFactory: ADDR.V2_FACTORY,
    routerAddress: ADDR.V2_ROUTER,
    provider,
    listPositions,
    prepareBuy: (...args) => prepareSignedCall(wallet, provider, router.swapExactETHForTokensSupportingFeeOnTransferTokens, args),
    prepareSell: (...args) => prepareSignedCall(wallet, provider, router.swapExactTokensForETHSupportingFeeOnTransferTokens, args),
    upsertPosition,
    removePosition,
    addTrade,
    commitPositionTrade,
    notify: sendTelegram,
  };
}

function defaultReconcileDependencies(position) {
  const provider = getProvider();
  return {
    provider,
    token: new Contract(position.token, ERC20_ABI, provider),
    wallet: { address: position.wallet },
    upsertPosition,
    removePosition,
    addTrade,
    commitPositionTrade,
  };
}

async function prepareSignedCall(wallet, provider, method, args) {
  const request = await method.populateTransaction(...args);
  const populated = await wallet.populateTransaction(request);
  const signed = await wallet.signTransaction(populated);
  return {
    hash: keccak256(signed),
    rawTx: signed,
    nonce: Number(populated.nonce),
    broadcast: () => provider.broadcastTransaction(signed),
  };
}

function requireReceipt(receipt, action) {
  if (!receipt || receipt.status === 0) throw new Error(`${action} transaction reverted`);
  return receipt;
}

export function validateLiveReport(report) {
  if (report.tradeReady !== true) throw new Error("live trade blocked: security checks are incomplete");
  if (report.marketBound !== true) throw new Error("live trade blocked: market is not bound to the event pool");
  if (report.verdict !== "green") throw new Error("live trade blocked: report is not green");
  if (report.venue !== "uniswap-v2" || !report.pool) {
    throw new Error("live trade blocked: only a bound Uniswap V2 pool is supported");
  }
  if (!sameAddress(report.quote, ADDR.WETH)) {
    throw new Error("live trade blocked: only a WETH quoted direct pool is supported");
  }
  if (!sameAddress(report.dex?.pairAddress, report.pool) || !sameAddress(report.dex?.quoteAddress, report.quote)) {
    throw new Error("live trade blocked: DexScreener pair does not match the report route");
  }
  if (
    !Array.isArray(report.path) ||
    report.path.length !== 2 ||
    !sameAddress(report.path[0], ADDR.WETH) ||
    !sameAddress(report.path[1], report.token)
  ) {
    throw new Error("live trade blocked: path does not match the bound WETH pool");
  }
  return report;
}

export async function verifyRouterBinding(report, deps) {
  const [routerWeth, routerFactory, pair] = await Promise.all([
    deps.router.WETH(),
    deps.router.factory(),
    deps.factory.getPair(ADDR.WETH, report.token),
  ]);
  if (!sameAddress(routerWeth, ADDR.WETH)) throw new Error("Router WETH does not match configured WETH");
  if (!sameAddress(routerFactory, deps.expectedFactory)) throw new Error("Router factory does not match configured factory");
  if (!sameAddress(pair, report.pool)) throw new Error("Router pair does not match the scored event pool");
  return true;
}

export async function executeLiveBuy(report, supplied = null) {
  validateLiveReport(report);
  if (!supplied && !liveTradingAllowed()) throw new Error("live trading gate is off");
  const deps = supplied || defaultLiveDependencies(report.token);
  if (!deps.liveAllowed()) throw new Error("live trading gate is off");
  const existing = (deps.listPositions?.() || []).find(
    (position) => sameAddress(position.token, report.token) && position.state !== "closed"
  );
  if (existing) throw new Error("active position already exists for this token");
  await verifyRouterBinding(report, deps);

  const amountIn = BigInt(deps.amountIn);
  if (amountIn <= 0n) throw new Error("buy amount must be positive");
  const path = [...report.path];
  const quoted = await deps.router.getAmountsOut(amountIn, path);
  const minOut = minOutFromQuote(quoted.at(-1), deps.slippageBps);
  const balanceBefore = BigInt(await deps.token.balanceOf(deps.wallet.address));
  const deadline = BigInt(Math.floor(deps.now() / 1000) + 90);
  const prepared = await deps.prepareBuy(
    minOut,
    path,
    deps.wallet.address,
    deadline,
    { value: amountIn, gasLimit: deps.gasLimit }
  );
  if (!prepared.hash || !prepared.rawTx || !Number.isInteger(prepared.nonce)) {
    throw new Error("prepared buy is missing durable transaction fields");
  }
  let pending = {
    schemaVersion: 2,
    state: "buy_pending",
    token: report.token,
    symbol: report.meta.symbol,
    venue: report.venue,
    pool: report.pool,
    quote: report.quote,
    path,
    mode: "live",
    amountInEth: formatEther(amountIn),
    entryUsd: report.facts.mcapUsd || 0,
    entryPriceUsd: report.dex?.priceUsd || 0,
    tp1Done: false,
    tp2Done: false,
    openedAt: deps.now(),
    wallet: deps.wallet.address,
    pending: {
      balanceBefore: balanceBefore.toString(),
      minOut: minOut.toString(),
      txHash: prepared.hash,
      rawTx: prepared.rawTx,
      nonce: prepared.nonce,
      preparedAt: deps.now(),
    },
  };
  deps.upsertPosition(pending);

  try {
    const tx = await prepared.broadcast();
    const receipt = requireReceipt(await tx.wait(), "buy");
    const acquired = netTransferAmount(receipt, report.token, deps.wallet.address);
    if (acquired <= 0n) throw new Error("buy confirmed without a positive receipt transfer");
    const position = {
      ...pending,
      state: "open",
      initialTokenAmount: acquired.toString(),
      remainingTokenAmount: acquired.toString(),
      buyTx: receipt.hash || prepared.hash,
      pending: null,
    };
    deps.commitPositionTrade(
      position,
      { side: "buy", mode: "live", token: report.token, tx: position.buyTx, amount: acquired.toString() }
    );
    await deps.notify(`🟢 实盘买入 <b>${report.meta.symbol}</b>\n${position.buyTx}`).catch(() => {});
    return position;
  } catch (error) {
    deps.upsertPosition({
      ...pending,
      state: "buy_pending",
      reviewReason: safeErrorMessage(error),
    });
    throw error;
  }
}

export async function maybeTrade(report) {
  if (SETTINGS.mode !== "paper" && SETTINGS.mode !== "live") return null;
  if (SETTINGS.mode === "live") {
    if (report.verdict !== "green") return null;
    if (!liveTradingAllowed()) throw new Error("live trading gate is off");
    return executeLiveBuy(report);
  }
  if (report.paperReady !== true || report.venue !== "uniswap-v2") return null;
  if (listPositions().some((position) => sameAddress(position.token, report.token) && position.state !== "closed")) {
    console.log(`skip paper trade: active position already exists for ${report.token}`);
    return null;
  }
  const amountIn = buyWei();
  const position = upsertPosition({
    schemaVersion: 2,
    state: "open",
    token: report.token,
    symbol: report.meta.symbol,
    venue: report.venue,
    pool: report.pool,
    quote: report.quote,
    path: report.path,
    mode: "paper",
    amountInEth: formatEther(amountIn),
    entryUsd: report.facts.mcapUsd || report.facts.priceUsd || 0,
    entryPriceUsd: report.dex?.priceUsd || 0,
    remainingPct: 100,
    tp1Done: false,
    tp2Done: false,
    openedAt: Date.now(),
  });
  addTrade({ side: "buy", mode: "paper", token: report.token, symbol: report.meta.symbol, amountInEth: position.amountInEth });
  await sendTelegram(
    `📝 模拟买入 <b>${report.meta.symbol}</b> ${position.amountInEth} ETH\n<code>${report.token}</code>`
  ).catch(() => {});
  return position;
}

export function confirmExit(position, { stage, soldAmount, txHash = null }) {
  const remainingBefore = BigInt(position.remainingTokenAmount);
  const sold = BigInt(soldAmount);
  if (sold <= 0n || sold > remainingBefore) throw new Error("confirmed sold amount is invalid");
  const remaining = remainingBefore - sold;
  return {
    ...position,
    state: remaining === 0n ? "closed" : "open",
    remainingTokenAmount: remaining.toString(),
    tp1Done: position.tp1Done || stage === "tp1",
    tp2Done: position.tp2Done || stage === "tp2",
    lastSellTx: txHash || position.lastSellTx || null,
    pending: null,
  };
}

export function confirmPaperExit(position, { sellPct, stage }) {
  const pct = Math.min(Number(position.remainingPct || 0), Number(sellPct));
  if (pct <= 0) throw new Error("paper position has no remaining amount");
  const remainingPct = Math.max(0, Number(position.remainingPct) - pct);
  return {
    ...position,
    state: remainingPct === 0 ? "closed" : "open",
    remainingPct,
    tp1Done: position.tp1Done || stage === "tp1",
    tp2Done: position.tp2Done || stage === "tp2",
  };
}

function paperExit(position, { sellPct, stage, reason, price }, deps) {
  const updated = confirmPaperExit(position, { sellPct, stage });
  const pct = Number(position.remainingPct) - updated.remainingPct;
  const trade = { side: "sell", mode: "paper", token: position.token, pct, reason, price };
  if (updated.remainingPct === 0) {
    deps.commitPositionTrade(null, trade, { removeToken: position.token });
  } else {
    deps.commitPositionTrade(updated, trade);
  }
  return updated;
}

export async function exitPosition(position, action, supplied = null) {
  if (position.mode !== "paper" && !supplied && !liveTradingAllowed()) {
    throw new Error("live trading gate is off");
  }
  const deps = supplied || (position.mode === "paper"
    ? { commitPositionTrade, notify: sendTelegram }
    : defaultLiveDependencies(position.token));
  if (position.mode === "paper") return paperExit(position, action, deps);
  if (!deps.liveAllowed()) throw new Error("live trading gate is off");
  if (position.schemaVersion !== 2 || position.state !== "open") {
    throw new Error("live position is not open schema v2 state");
  }
  if (
    !sameAddress(position.quote, ADDR.WETH) ||
    !Array.isArray(position.path) ||
    position.path.length !== 2 ||
    !sameAddress(position.path[0], ADDR.WETH) ||
    !sameAddress(position.path[1], position.token)
  ) {
    throw new Error("live position route is not a verified WETH path");
  }

  const planned = plannedExitAmount(position, action.sellPct);
  const balanceBefore = BigInt(await deps.token.balanceOf(deps.wallet.address));
  const remaining = BigInt(position.remainingTokenAmount);
  const amount = [planned, balanceBefore, remaining].reduce((a, b) => (a < b ? a : b));
  if (amount <= 0n) throw new Error("live sell amount is zero");
  const sellPath = [...position.path].reverse();
  const quoted = await deps.router.getAmountsOut(amount, sellPath);
  const minOut = minOutFromQuote(quoted.at(-1), deps.slippageBps);

  const allowance = BigInt(await deps.token.allowance(deps.wallet.address, deps.routerAddress));
  if (allowance < amount) {
    const approval = await deps.token.approve(deps.routerAddress, amount);
    requireReceipt(await approval.wait(), "approve");
  }

  const deadline = BigInt(Math.floor(deps.now() / 1000) + 90);
  const prepared = await deps.prepareSell(
    amount,
    minOut,
    sellPath,
    deps.wallet.address,
    deadline,
    { gasLimit: deps.gasLimit }
  );
  if (!prepared.hash || !prepared.rawTx || !Number.isInteger(prepared.nonce)) {
    throw new Error("prepared sell is missing durable transaction fields");
  }
  let pending = {
    ...position,
    state: "exit_pending",
    pending: {
      stage: action.stage,
      amount: amount.toString(),
      balanceBefore: balanceBefore.toString(),
      reason: action.reason,
      price: action.price,
      txHash: prepared.hash,
      rawTx: prepared.rawTx,
      nonce: prepared.nonce,
      preparedAt: deps.now(),
    },
  };
  deps.upsertPosition(pending);

  try {
    const tx = await prepared.broadcast();
    const receipt = requireReceipt(await tx.wait(), "sell");
    const net = netTransferAmount(receipt, position.token, deps.wallet.address);
    const receiptSold = -net;
    if (receiptSold <= 0n) throw new Error("sell confirmed without a positive receipt transfer");
    const soldAmount = receiptSold > remaining ? remaining : receiptSold;
    const updated = confirmExit(pending, { stage: action.stage, soldAmount, txHash: receipt.hash || prepared.hash });
    const trade = {
      side: "sell",
      mode: "live",
      token: position.token,
      amount: soldAmount.toString(),
      reason: action.reason,
      price: action.price,
      tx: updated.lastSellTx,
    };
    if (updated.state === "closed") {
      deps.commitPositionTrade(null, trade, { removeToken: position.token });
    } else {
      deps.commitPositionTrade(updated, trade);
    }
    await deps.notify(
      `💸 ${action.reason}\n<b>${position.symbol}</b> 已确认卖出 ${soldAmount.toString()} 个最小单位`
    ).catch(() => {});
    return updated;
  } catch (error) {
    deps.upsertPosition({
      ...pending,
      state: "exit_pending",
      reviewReason: safeErrorMessage(error),
    });
    throw error;
  }
}

function moveToReview(position, deps, reason) {
  const review = { ...position, state: "needs_review", reviewReason: reason };
  deps.upsertPosition(review);
  return review;
}

async function resolvePending(position, deps, action) {
  const pending = position.pending;
  if (!pending?.txHash) {
    return { review: moveToReview(position, deps, `pending ${action} has no transaction hash`) };
  }
  const receipt = await deps.provider.getTransactionReceipt(pending.txHash);
  if (receipt) {
    if (receipt.status === 0) {
      return { review: moveToReview(position, deps, `pending ${action} reverted`) };
    }
    return { receipt };
  }
  const transaction = await deps.provider.getTransaction(pending.txHash);
  if (transaction) return {};
  if (!pending.rawTx || !Number.isInteger(pending.nonce)) {
    return { review: moveToReview(position, deps, `pending ${action} cannot be replayed safely`) };
  }
  const latestNonce = await deps.provider.getTransactionCount(position.wallet, "latest");
  if (latestNonce > pending.nonce) {
    return { review: moveToReview(position, deps, `pending ${action} nonce was consumed without its receipt`) };
  }
  await deps.provider.broadcastTransaction(pending.rawTx);
  return {};
}

export async function reconcilePendingBuy(position, supplied = null) {
  const deps = supplied || defaultReconcileDependencies(position);
  const resolution = await resolvePending(position, deps, "buy");
  if (resolution.review) return resolution.review;
  const receipt = resolution.receipt;
  if (!receipt) return null;
  const acquired = netTransferAmount(receipt, position.token, position.wallet);
  if (acquired <= 0n) {
    return moveToReview(position, deps, "confirmed buy has no positive receipt transfer");
  }
  const updated = {
    ...position,
    state: "open",
    initialTokenAmount: acquired.toString(),
    remainingTokenAmount: acquired.toString(),
    buyTx: receipt.hash || position.pending.txHash,
    pending: null,
  };
  deps.commitPositionTrade(
    updated,
    { side: "buy", mode: "live", token: position.token, tx: updated.buyTx, amount: acquired.toString(), recovered: true }
  );
  return updated;
}

async function reconcilePendingExit(position, supplied = null) {
  const deps = supplied || defaultReconcileDependencies(position);
  const resolution = await resolvePending(position, deps, "sell");
  if (resolution.review) return resolution.review;
  const receipt = resolution.receipt;
  if (!receipt) return null;
  const net = netTransferAmount(receipt, position.token, position.wallet);
  const receiptSold = -net;
  if (receiptSold <= 0n) {
    return moveToReview(position, deps, "confirmed sell has no positive receipt transfer");
  }
  const remaining = BigInt(position.remainingTokenAmount);
  const soldAmount = receiptSold > remaining ? remaining : receiptSold;
  const updated = confirmExit(position, {
    stage: position.pending.stage,
    soldAmount,
    txHash: receipt.hash || position.pending.txHash,
  });
  const trade = {
    side: "sell",
    mode: "live",
    token: position.token,
    amount: soldAmount.toString(),
    reason: position.pending.reason,
    price: position.pending.price,
    tx: updated.lastSellTx,
    recovered: true,
  };
  if (updated.state === "closed") {
    deps.commitPositionTrade(null, trade, { removeToken: position.token });
  } else {
    deps.commitPositionTrade(updated, trade);
  }
  return updated;
}

async function tickOne(position) {
  const dex = await dexScreener(position.token, { pool: position.pool, quote: position.quote });
  const price = dex?.marketBound ? dex.priceUsd || 0 : 0;
  if (!price || !position.entryPriceUsd) return;
  const multiple = price / position.entryPriceUsd;
  const dropPct = ((position.entryPriceUsd - price) / position.entryPriceUsd) * 100;
  if (dropPct >= SETTINGS.slPct) {
    await exitPosition(position, { sellPct: 100, stage: "sl", reason: `止损 ${dropPct.toFixed(1)}%`, price });
  } else if (!position.tp1Done && multiple >= SETTINGS.tp1Mult) {
    await exitPosition(position, { sellPct: SETTINGS.tp1SellPct, stage: "tp1", reason: `止盈1 ${SETTINGS.tp1Mult}x`, price });
  } else if (position.tp1Done && !position.tp2Done && multiple >= SETTINGS.tp2Mult) {
    await exitPosition(position, { sellPct: SETTINGS.tp2SellPct, stage: "tp2", reason: `止盈2 ${SETTINGS.tp2Mult}x`, price });
  } else if (position.tp1Done && position.tp2Done && multiple >= SETTINGS.tp3Mult) {
    await exitPosition(position, { sellPct: 100, stage: "tp3", reason: `止盈3 ${SETTINGS.tp3Mult}x 清仓`, price });
  }
}

export async function tickPositions() {
  const positions = listPositions();
  for (const position of positions) {
    try {
      if (position.schemaVersion !== 2 || position.state === "needs_review") continue;
      if (position.state === "exit_pending") {
        await reconcilePendingExit(position);
      } else if (position.state === "buy_pending") {
        await reconcilePendingBuy(position);
      } else if (position.state === "open") {
        await tickOne(position);
      }
    } catch (error) {
      console.error("position tick", position.symbol, safeErrorMessage(error));
    }
  }
}

export function createSingleFlightTick(tick) {
  let running = false;
  return async function run() {
    if (running) return false;
    running = true;
    try {
      await tick();
      return true;
    } finally {
      running = false;
    }
  };
}

export { buyWei, reconcilePendingExit };
