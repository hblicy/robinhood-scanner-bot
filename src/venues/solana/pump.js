import { normalizeCandidate } from "../../core/candidate.js";
import { chooseTargetPair, hasAnyInstructions, matchesDiscriminator, programInstructions, requireAccounts } from "./instructions.js";

const DISC = Object.freeze({
  create: [24, 30, 200, 40, 5, 28, 7, 119],
  createV2: [214, 144, 76, 236, 95, 139, 49, 180],
  migrate: [155, 234, 231, 146, 236, 158, 162, 30],
  createPool: [233, 146, 209, 142, 207, 104, 64, 188],
});

function candidate(context, adapter, instruction, value) {
  return normalizeCandidate({
    chain: "solana", chainFamily: "solana", venue: adapter.id, sourceKind: adapter.sourceKind,
    blockOrSlot: context.slot, transactionId: context.signature, eventIndex: instruction.instructionIndex,
    createdAt: context.blockTime == null ? null : context.blockTime * 1_000,
    sourceProvenance: `${adapter.id}@${adapter.idlRevision}`, poolId: null, ...value,
  });
}

function ensureProgram(context, adapter, instructions) {
  if (instructions.length === 0 && hasAnyInstructions(context.transaction)) {
    throw new Error(`program-owner-mismatch ${adapter.id} signature=${context.signature}`);
  }
}

function pumpAdapter(profile, program) {
  const adapter = Object.freeze({ ...program, version: 1, parseTransaction(context) {
    const instructions = programInstructions(context.transaction, program.programId);
    ensureProgram(context, program, instructions);
    const events = [];
    for (const instruction of instructions) {
      if (matchesDiscriminator(instruction.data, DISC.create)) {
        const a = requireAccounts(context, instruction, 14, program.id);
        events.push(candidate(context, program, instruction, { token: a[0], quoteToken: profile.wrappedNative, pool: a[2], creator: a[7], lifecyclePhase: "new_launch", metadata: { bondingCurve: a[2] } }));
      } else if (matchesDiscriminator(instruction.data, DISC.createV2)) {
        const a = requireAccounts(context, instruction, 16, program.id);
        events.push(candidate(context, program, instruction, { token: a[0], quoteToken: profile.wrappedNative, pool: a[2], creator: a[5], lifecyclePhase: "new_launch", metadata: { bondingCurve: a[2] } }));
      } else if (matchesDiscriminator(instruction.data, DISC.migrate)) {
        const a = requireAccounts(context, instruction, 25, program.id);
        events.push(candidate(context, program, instruction, { token: a[2], quoteToken: a[14], pool: a[9], creator: a[5], lifecyclePhase: "graduated", metadata: { bondingCurve: a[3], authority: a[10], baseVault: a[17], quoteVault: a[18] } }));
      }
    }
    return events;
  } });
  return adapter;
}

function pumpSwapAdapter(profile, program) {
  const quoteMints = new Set(profile.quotes.map((quote) => quote.address));
  return Object.freeze({ ...program, version: 1, parseTransaction(context) {
    const instructions = programInstructions(context.transaction, program.programId);
    ensureProgram(context, program, instructions);
    const events = [];
    for (const instruction of instructions) {
      if (!matchesDiscriminator(instruction.data, DISC.createPool)) continue;
      const a = requireAccounts(context, instruction, 18, program.id);
      const pair = chooseTargetPair(a[3], a[4], quoteMints);
      if (!pair) continue;
      events.push(candidate(context, program, instruction, { ...pair, pool: a[0], creator: a[2], lifecyclePhase: "new_pool", metadata: { baseMint: a[3], quoteMint: a[4], baseVault: a[9], quoteVault: a[10] } }));
    }
    return events;
  } });
}

export function createPumpAdapters(profile) {
  const pump = profile.programs.find((program) => program.id === "pump-bonding-curve");
  const swap = profile.programs.find((program) => program.id === "pumpswap");
  if (!pump || !swap) throw new Error("Solana profile is missing Pump programs");
  return Object.freeze([pumpAdapter(profile, pump), pumpSwapAdapter(profile, swap)]);
}
