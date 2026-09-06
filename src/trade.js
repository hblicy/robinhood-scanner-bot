import {
  Contract,
  MaxUint256,
  Wallet,
  formatEther,
  parseEther,
} from "ethers";
import { ADDR, SETTINGS, liveTradingAllowed } from "./config.js";
import { V2_ROUTER_ABI, ERC20_ABI } from "./abis.js";
import { getProvider } from "./chain.js";
import { addTrade, listPositions, removePosition, upsertPosition } from "./store.js";
import { sendTelegram } from "./notify.js";
import { dexScreener } from "./market.js";

function buyWei() {
  const n = parseEther(String(SETTINGS.buyAmountEth));
  const max = parseEther(String(SETTINGS.maxBuyEth));
  return n > max ? max : n;
}

export async function maybeTrade(report) {
  if (report.verdict !== "green") return null;
  if (SETTINGS.mode !== "paper" && SETTINGS.mode !== "live") return null;
  if (report.venue !== "uniswap-v2") {
    console.log("skip trade: only uniswap-v2 auto path is wired");
    return null;
  }

  const amountIn = buyWei();
  if (SETTINGS.mode === "paper" || !liveTradingAllowed()) {
    const pos = upsertPosition({
      token: report.token,
      symbol: report.meta.symbol,
      venue: report.venue,
      pool: report.pool,
      mode: "paper",
      amountInEth: formatEther(amountIn),
      entryUsd: report.facts.mcapUsd || report.facts.priceUsd || 0,
      entryPriceUsd: report.dex?.priceUsd || 0,
      remainingPct: 100,
      tp1Done: false,
      tp2Done: false,
      openedAt: Date.now(),
    });
    addTrade({ side: "buy", mode: "paper", token: report.token, symbol: report.meta.symbol, amountInEth: pos.amountInEth });
    await sendTelegram(
      `📝 模拟买入 <b>${report.meta.symbol}</b> ${pos.amountInEth} ETH\n<code>${report.token}</code>\n入场价 $${Number(pos.entryPriceUsd).toPrecision(4)}\n止盈 ${SETTINGS.tp1Mult}x/${SETTINGS.tp2Mult}x/${SETTINGS.tp3Mult}x · 止损 -${SETTINGS.slPct}%`
    ).catch(() => {});
    return pos;
  }

  const wallet = new Wallet(SETTINGS.privateKey, getProvider());
  const router = new Contract(ADDR.V2_ROUTER, V2_ROUTER_ABI, wallet);
  const path = [ADDR.WETH, report.token];
  const minOut = 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 90);
  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut,
    path,
    wallet.address,
    deadline,
    { value: amountIn, gasLimit: SETTINGS.gasLimit }
  );
  const rec = await tx.wait();
  const pos = upsertPosition({
    token: report.token,
    symbol: report.meta.symbol,
    venue: report.venue,
    pool: report.pool,
    mode: "live",
    amountInEth: formatEther(amountIn),
    entryUsd: report.facts.mcapUsd || 0,
    entryPriceUsd: report.dex?.priceUsd || 0,
    remainingPct: 100,
    tp1Done: false,
    tp2Done: false,
    openedAt: Date.now(),
    buyTx: rec.hash,
    wallet: wallet.address,
  });
  addTrade({ side: "buy", mode: "live", token: report.token, tx: rec.hash });
  await sendTelegram(`🟢 实盘买入 <b>${report.meta.symbol}</b>\n${rec.hash}`).catch(() => {});
  return pos;
}

export async function tickPositions() {
  const open = listPositions().filter((p) => p.remainingPct > 0);
  for (const pos of open) {
    try {
      await tickOne(pos);
    } catch (err) {
      console.error("position tick", pos.symbol, err.message);
    }
  }
}

async function tickOne(pos) {
  const dex = await dexScreener(pos.token);
  const price = dex?.priceUsd || 0;
  if (!price || !pos.entryPriceUsd) return;
  const multiple = price / pos.entryPriceUsd;
  const dropPct = ((pos.entryPriceUsd - price) / pos.entryPriceUsd) * 100;

  if (dropPct >= SETTINGS.slPct) {
    await exit(pos, pos.remainingPct, `止损 ${dropPct.toFixed(1)}%`, price);
    return;
  }
  if (!pos.tp1Done && multiple >= SETTINGS.tp1Mult) {
    await exit(pos, SETTINGS.tp1SellPct, `止盈1 ${SETTINGS.tp1Mult}x`, price);
    pos.tp1Done = true;
  } else if (pos.tp1Done && !pos.tp2Done && multiple >= SETTINGS.tp2Mult) {
    await exit(pos, SETTINGS.tp2SellPct, `止盈2 ${SETTINGS.tp2Mult}x`, price);
    pos.tp2Done = true;
  } else if (pos.tp1Done && pos.tp2Done && multiple >= SETTINGS.tp3Mult) {
    await exit(pos, pos.remainingPct, `止盈3 ${SETTINGS.tp3Mult}x 清仓`, price);
  }
}

async function exit(pos, sellPct, reason, price) {
  const pct = Math.min(pos.remainingPct, sellPct);
  if (pct <= 0) return;
  if (pos.mode === "live" && liveTradingAllowed()) {
    await liveSell(pos, pct);
  }
  pos.remainingPct = Math.max(0, pos.remainingPct - pct);
  addTrade({ side: "sell", mode: pos.mode, token: pos.token, pct, reason, price });
  await sendTelegram(
    `💸 ${reason}\n<b>${pos.symbol}</b> 卖出 ${pct}% @ $${Number(price).toPrecision(4)}\n剩余 ${pos.remainingPct}%`
  ).catch(() => {});
  if (pos.remainingPct <= 0) removePosition(pos.token);
  else upsertPosition(pos);
}

async function liveSell(pos, pct) {
  const wallet = new Wallet(SETTINGS.privateKey, getProvider());
  const token = new Contract(pos.token, ERC20_ABI, wallet);
  const router = new Contract(ADDR.V2_ROUTER, V2_ROUTER_ABI, wallet);
  const bal = await token.balanceOf(wallet.address);
  const amount = (bal * BigInt(Math.floor(pct))) / 100n;
  if (amount === 0n) return;
  const allowance = await token.allowance(wallet.address, ADDR.V2_ROUTER);
  if (allowance < amount) {
    const txa = await token.approve(ADDR.V2_ROUTER, MaxUint256);
    await txa.wait();
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 90);
  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
    amount,
    0n,
    [pos.token, ADDR.WETH],
    wallet.address,
    deadline,
    { gasLimit: SETTINGS.gasLimit }
  );
  await tx.wait();
}

export { buyWei };
