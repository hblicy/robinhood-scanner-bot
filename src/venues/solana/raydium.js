import { createHash } from "node:crypto";
import { normalizeCandidate } from "../../core/candidate.js";
import { chooseTargetPair, hasAnyInstructions, matchesDiscriminator, programInstructions, requireAccounts } from "./instructions.js";

const anchor = (name) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
const LAYOUTS = Object.freeze({
  "raydium-launchlab": { discriminator: [67, 153, 175, 39, 218, 16, 38, 32], count: 18, creator: 1, pool: 5, mintA: 6, mintB: 7, vaultA: 8, vaultB: 9, lifecyclePhase: "new_launch" },
  "raydium-cpmm": { discriminator: [175, 175, 109, 31, 13, 152, 155, 237], count: 20, creator: 0, authority: 2, pool: 3, mintA: 4, mintB: 5, vaultA: 10, vaultB: 11, lifecyclePhase: "new_pool" },
  "raydium-clmm": { discriminator: anchor("create_pool"), count: 13, creator: 0, pool: 2, mintA: 3, mintB: 4, vaultA: 5, vaultB: 6, lifecyclePhase: "new_pool" },
  "raydium-amm-v4": { discriminator: [1], count: 21, creator: 17, authority: 5, pool: 4, mintA: 8, mintB: 9, vaultA: 10, vaultB: 11, lifecyclePhase: "new_pool" },
});

function createAdapter(profile, program, classifyPair) {
  const layout = LAYOUTS[program.id];
  const quotes = new Set(profile.quotes.map((quote) => quote.address));
  const classify = classifyPair ?? quotes;
  return Object.freeze({ ...program, version: 1, parseTransaction(context) {
    const instructions = programInstructions(context.transaction, program.programId);
    if (instructions.length === 0 && hasAnyInstructions(context.transaction)) throw new Error(`program-owner-mismatch ${program.id} signature=${context.signature}`);
    const events = [];
    for (const instruction of instructions) {
      if (!matchesDiscriminator(instruction.data, layout.discriminator)) continue;
      const a = requireAccounts(context, instruction, layout.count, program.id);
      const pair = chooseTargetPair(a[layout.mintA], a[layout.mintB], classify);
      if (!pair) continue;
      events.push(normalizeCandidate({
        chain: "solana", chainFamily: "solana", venue: program.id, sourceKind: program.sourceKind, ...pair,
        pool: a[layout.pool], poolId: null, creator: a[layout.creator] ?? null, blockOrSlot: context.slot,
        transactionId: context.signature, eventIndex: instruction.instructionIndex,
        createdAt: context.blockTime == null ? null : context.blockTime * 1_000,
        lifecyclePhase: layout.lifecyclePhase, sourceProvenance: `${program.id}@${program.idlRevision}`,
        metadata: { authority: layout.authority == null ? null : a[layout.authority], baseMint: a[layout.mintA], quoteMint: a[layout.mintB], baseVault: pair.targetIsA ? a[layout.vaultA] : a[layout.vaultB], quoteVault: pair.targetIsA ? a[layout.vaultB] : a[layout.vaultA], poolProgramId: program.programId },
      }));
    }
    return events;
  } });
}

export function createRaydiumAdapters(profile, { classifyPair = null } = {}) {
  const programs = profile.programs.filter((program) => LAYOUTS[program.id]);
  if (programs.length !== Object.keys(LAYOUTS).length) throw new Error("Solana profile is missing Raydium programs");
  return Object.freeze(programs.map((program) => createAdapter(profile, program, classifyPair)));
}
