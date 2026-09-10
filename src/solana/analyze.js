import { PublicKey } from "@solana/web3.js";
import { scoreCandidate } from "../core/score.js";
import { dexScreener } from "../market.js";
import { inspectMintControls } from "../security/solana/mint.js";
import { observeSolanaWalletBuys } from "../security/solana/flows.js";
import { normalizeWalletSignals } from "../wallet-labels.js";
import { mapConcurrent } from "./concurrency.js";

const NARRATIVE = ["ai", "agent", "cat", "dog", "meme", "pepe", "trump", "robinhood", "gme"];

function narrativeHits(symbol, name) {
  const text = `${symbol || ""} ${name || ""}`.toLowerCase();
  return NARRATIVE.filter((word) => text.includes(word));
}

async function observedTransactions(connection, candidate, limit = 40, concurrency = 4) {
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(candidate.pool),
    { limit },
    "finalized"
  );
  const transactions = await mapConcurrent(signatures.filter((item) => !item.err), concurrency, async (item) => {
    const transaction = await connection.getTransaction(item.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    return transaction ? { signature: item.signature, transaction } : null;
  });
  return transactions.filter(Boolean);
}

function checksFrom(categories) {
  return Object.values(categories).flatMap((category) => category.checks.map((check) => ({
    key: check.key,
    ok: check.ok,
    detail: check.detail,
    pts: check.points,
  })));
}

export async function analyzeSolanaCandidate(event, dependencies) {
  const { config, connection, securityRegistry } = dependencies;
  const errorSources = [];
  let dex = null;
  try {
    dex = await (dependencies.dexScreener ?? dexScreener)(event.token, {
      pool: event.pool,
      quote: event.quoteToken,
    }, { profile: config.profile });
  } catch (error) {
    errorSources.push({ source: "DexScreener", error });
  }
  const inspectMint = dependencies.inspectMint ?? inspectMintControls;
  const mint = await inspectMint(event.token, { connection });
  const readObserved = dependencies.getObservedTransactions
    ?? dependencies.getObservedSellTransactions
    ?? ((candidate) => observedTransactions(connection, candidate, 40, config.rpc?.concurrency ?? 4));
  let observedPromise;
  const getObserved = () => {
    observedPromise ??= Promise.resolve().then(() => readObserved(event));
    return observedPromise;
  };
  const sellability = await securityRegistry.inspect(event, {
    connection,
    inspectMint: async () => mint,
    meaningfulSellerCount: config.settings.meaningfulSellerCount,
    getObservedSellTransactions: getObserved,
  });
  const createdAt = event.createdAt ?? dex?.pairCreatedAt ?? null;
  const ageMinutes = createdAt == null ? null : Math.max(0, ((dependencies.now ?? Date.now)() - createdAt) / 60_000);
  const catalogStatus = dependencies.walletCatalog?.status ?? "unconfigured";
  const observedWallets = catalogStatus === "known" && dependencies.walletCatalog.labels?.size
    ? observeSolanaWalletBuys({
      transactions: await getObserved(),
      binding: {
        token: event.token,
        quote: event.quoteToken,
        baseVault: event.metadata?.baseVault,
        quoteVault: event.metadata?.quoteVault,
        nativeQuote: event.quoteToken === config.profile.wrappedNative,
      },
      labels: dependencies.walletCatalog.labels,
    })
    : { count: 0, matches: [] };
  const walletSignals = normalizeWalletSignals({ status: catalogStatus, ...observedWallets });
  const canonicalPumpMigration = event.venue === "pump-bonding-curve" && event.lifecyclePhase === "graduated";
  const facts = {
    ageMinutes,
    hasTwitter: Boolean(dex?.twitter),
    hasTelegram: Boolean(dex?.telegram),
    narrativeHits: narrativeHits(dex?.symbol, dex?.name),
    buys5m: dex?.buys5m ?? 0,
    sells5m: dex?.sells5m ?? 0,
    volume5m: dex?.volume5m ?? 0,
    volume1h: dex?.volume1h ?? 0,
    mcapUsd: dex?.mcapUsd ?? 0,
    liquidityUsd: dex?.liquidityUsd ?? 0,
    top10Pct: null,
    holderCount: null,
    creatorKnown: false,
    creatorPct: null,
    deployerHistoryKnown: false,
    deployerTokens: null,
    lpUnknown: !canonicalPumpMigration,
    lpBurnedPct: canonicalPumpMigration ? 100 : null,
    privilegesKnown: mint.status === "complete",
    mintable: Boolean(mint.mintAuthority),
    owner: mint.mintAuthority,
    honeypot: sellability.status === "blocked" ? true : sellability.status === "confirmed" ? false : null,
    buyTaxBps: null,
    sellTaxBps: null,
    walletSignalsStatus: walletSignals.status,
    walletSignalCount: walletSignals.count,
    walletSignalMatches: observedWallets.matches,
    marketBound: Boolean(dex?.marketBound),
  };
  const scored = scoreCandidate(facts, config.settings);
  const red = [...new Set([...scored.redFlags, ...(mint.redFlags ?? [])])];
  const verdict = sellability.status === "blocked"
    ? "skip"
    : sellability.status === "confirmed" && scored.score >= 75 && red.length === 0
      ? "green"
      : scored.score >= config.settings.minScore ? "review" : "skip";
  return {
    chain: "solana",
    chainName: config.profile.name,
    token: event.token,
    pool: event.pool,
    poolId: null,
    venue: event.venue,
    creator: event.creator,
    referenceAsset: event.referenceAsset ?? event.quoteToken,
    referenceAssetKind: event.referenceAssetKind ?? "unknown",
    referenceAssetIssuer: event.referenceAssetIssuer ?? null,
    referenceAssetStandard: event.referenceAssetKind === "stock"
      && event.referenceAssetIssuer === "Backed" ? "xStocks" : null,
    assetSource: event.assetSource ?? null,
    assetVerifiedAt: event.assetVerifiedAt ?? null,
    referenceRestrictions: [...(event.referenceRestrictions ?? [])],
    meta: { symbol: dex?.symbol || event.token.slice(0, 6), name: dex?.name || "" },
    dex: dex ?? { quoteSymbol: config.profile.quotes.find((quote) => quote.address === event.quoteToken)?.symbol || "SOL" },
    facts,
    score: scored.score,
    verdict,
    red,
    checks: checksFrom(scored.categories),
    sellability,
    honeypot: { honeypot: facts.honeypot },
    walletSignals,
    errorSources,
    links: {
      dex: dex?.url || `https://dexscreener.com/solana/${event.token}`,
      explorer: `${config.profile.explorer}/token/${event.token}`,
      gmgn: `https://gmgn.ai/sol/token/${event.token}`,
    },
  };
}
