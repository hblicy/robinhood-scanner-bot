import { PublicKey } from "@solana/web3.js";
import { acquireInstanceLock } from "../instance-lock.js";
import { isDiscoveryFallbackError, sleep } from "../chain.js";
import { candidateKey, rawEventKey } from "../core/candidate.js";
import { handleCandidate } from "../runtime.js";
import { reconcilePrograms, subscribePrograms } from "./discovery.js";
import { safeErrorMessage } from "../safety.js";

function cursorsFor(config) {
  return Object.fromEntries(config.venues.map((venue) => [venue.id, config.store.getSolanaProgramCursor(venue.id)]));
}

async function bootstrap(config, persist) {
  const anchors = await config.rpcContext.discoverySessions.run(async (connection) => {
    const safeSlot = await connection.getSlot("confirmed");
    const values = [];
    for (const venue of config.venues) {
      const [latest] = await connection.getSignaturesForAddress(new PublicKey(venue.programId), { limit: 1 }, "confirmed");
      if (latest) values.push({ programId: venue.id, signature: latest.signature, slot: latest.slot, safeSlot });
    }
    return values;
  });
  for (const anchor of persist ? anchors : []) {
    config.store.commitSolanaProgramRange({
      programId: anchor.programId,
      cursor: { signature: anchor.signature, slot: anchor.slot, finalized: false, updatedAt: Date.now(), sameSlotApplied: true },
      events: [],
    });
  }
  return { mode: "recovery", candidates: 0, programs: anchors.length, reports: [] };
}

export async function runSolanaOnce(config, { persist = true } = {}) {
  const cursors = cursorsFor(config);
  if (Object.values(cursors).some((cursor) => cursor == null)) return bootstrap(config, persist);
  const adapters = new Map(config.venues.map((venue) => [venue.id, venue]));
  const results = await reconcilePrograms({
    sessions: config.rpcContext.discoverySessions,
    programs: config.venues,
    cursors,
    concurrency: config.rpc?.concurrency ?? 4,
    parseTransaction: (context) => adapters.get(context.program.id).parseTransaction(context),
  });
  const mode = persist ? config.settings.alertMode : "shadow";
  const reports = [];
  for (const result of results) {
    const applied = [];
    for (const candidate of result.events) {
      const event = { ...candidate, source: candidate.sourceKind, quote: candidate.quoteToken };
      if (persist && config.store.hasSeen(candidateKey(event))) {
        applied.push({ eventId: rawEventKey(candidate), slot: candidate.blockOrSlot });
        continue;
      }
      const report = await handleCandidate(event, { persistSeen: persist }, {
        now: Date.now,
        maxAgeMinutes: config.settings.maxAgeMinutes,
        minScore: config.settings.minScore,
        mode,
        analyze: config.services.analyze,
        markSeen: (key, payload) => config.store.markSeen(key, payload),
        alertReport: config.services.alertReport,
        log: console.log,
      });
      if (report) reports.push(report);
      applied.push({ eventId: rawEventKey(candidate), slot: candidate.blockOrSlot });
    }
    if (persist && result.newestProcessed) {
      config.store.commitSolanaProgramRange({
        programId: result.programId,
        cursor: { ...result.newestProcessed, finalized: false, updatedAt: Date.now(), sameSlotApplied: true },
        events: applied,
      });
    }
  }
  return { mode, candidates: results.reduce((sum, result) => sum + result.events.length, 0), programs: results.length, reports };
}

export async function watchSolana(config, dependencies = {}) {
  const delay = dependencies.sleep ?? sleep;
  const log = dependencies.log ?? console.log;
  const release = await (dependencies.acquireLock ?? acquireInstanceLock)(config.dataDir);
  let wake = false;
  const stopSubscriptions = config.rpcContext.wsConnection
    ? subscribePrograms({ connection: config.rpcContext.wsConnection, programs: config.venues, onHint: () => { wake = true; }, onError: (error) => log(`solana ws hint failed: ${safeErrorMessage(error)}`) })
    : async () => {};
  try {
    while (true) {
      try {
        const result = await runSolanaOnce(config, { persist: true });
        log(`solana: programs=${result.programs} candidates=${result.candidates} mode=${result.mode}`);
      } catch (error) {
        if (!isDiscoveryFallbackError(error)) throw error;
        log(`solana discovery retry: ${safeErrorMessage(error)}`);
      }
      const waitMs = wake ? 250 : config.settings.pollMs;
      wake = false;
      await delay(waitMs);
    }
  } finally {
    await stopSubscriptions();
    await release();
  }
}
