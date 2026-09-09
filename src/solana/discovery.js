import { PublicKey } from "@solana/web3.js";
import { mapConcurrent } from "./concurrency.js";

function publicKey(value) {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

export async function reconcileProgram({
  connection,
  program,
  cursor = null,
  parseTransaction,
  commitment = "confirmed",
  pageLimit = 1_000,
  concurrency = 4,
}) {
  if (!connection || typeof connection.getSlot !== "function") throw new Error("Solana discovery connection is required");
  if (typeof parseTransaction !== "function") throw new Error("Solana transaction parser is required");
  const safeSlot = await connection.getSlot(commitment);
  let before;
  let reachedAnchor = false;
  const newestFirst = [];

  while (!reachedAnchor) {
    const page = await connection.getSignaturesForAddress(
      publicKey(program.programId),
      { limit: pageLimit, ...(before ? { before } : {}) },
      commitment
    );
    if (!Array.isArray(page)) throw new Error(`${program.id} signatures response must be an array`);
    for (const entry of page) {
      if (entry.slot > safeSlot) continue;
      if (cursor && entry.signature === cursor.signature && entry.slot === cursor.slot) {
        reachedAnchor = true;
        break;
      }
      if (cursor && entry.slot < cursor.slot) {
        reachedAnchor = true;
        break;
      }
      newestFirst.push(entry);
    }
    if (reachedAnchor || page.length < pageLimit || page.length === 0) break;
    before = page.at(-1)?.signature;
    if (!before) break;
  }

  const ordered = newestFirst.reverse();
  const parsedGroups = await mapConcurrent(ordered, concurrency, async (entry) => {
    if (entry.err) return [];
    const transaction = await connection.getTransaction(entry.signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) {
      throw new Error(`${program.id} transaction unavailable: ${entry.signature}`);
    }
    const parsed = await parseTransaction({
      transaction,
      signature: entry.signature,
      slot: entry.slot,
      blockTime: transaction.blockTime ?? null,
      program,
    });
    if (!Array.isArray(parsed)) throw new Error(`${program.id} parser must return an array`);
    return parsed;
  });
  const events = parsedGroups.flat();
  const newest = ordered.at(-1) ?? null;
  return {
    programId: program.id,
    safeSlot,
    newestProcessed: newest ? { signature: newest.signature, slot: newest.slot } : null,
    events,
  };
}

export async function reconcilePrograms({ sessions, programs, cursors, parseTransaction, commitment = "confirmed", concurrency = 4 }) {
  if (!sessions || typeof sessions.run !== "function") throw new Error("Solana discovery session runner is required");
  return sessions.run(async (connection) => {
    const results = [];
    for (const program of programs) {
      results.push(await reconcileProgram({
        connection,
        program,
        cursor: cursors?.[program.id] ?? null,
        parseTransaction,
        commitment,
        concurrency,
      }));
    }
    return results;
  });
}

export function subscribePrograms({ connection, programs, onHint, commitment = "confirmed", onError = console.warn }) {
  if (!connection || typeof connection.onLogs !== "function") throw new Error("Solana WebSocket connection is required");
  if (typeof onHint !== "function") throw new Error("Solana hint handler is required");
  const seen = new Set();
  const listeners = programs.map((program) => connection.onLogs(
    publicKey(program.programId),
    (notification, context) => {
      try {
        if (notification?.err || !notification?.signature) return;
        const key = `${program.id}|${notification.signature}`;
        if (seen.has(key)) return;
        seen.add(key);
        onHint({
          programId: program.id,
          signature: notification.signature,
          slot: context?.slot ?? null,
        });
      } catch (error) {
        onError(error);
      }
    },
    commitment
  ));
  return async () => {
    const settled = await Promise.allSettled(listeners.map(async (listener) => {
      const id = await listener;
      await connection.removeOnLogsListener(id);
    }));
    const failure = settled.find((item) => item.status === "rejected");
    if (failure) throw failure.reason;
  };
}
