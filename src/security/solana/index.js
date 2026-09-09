import { sellabilityResult } from "../../sellability.js";
import { inspectMintControls } from "./mint.js";
import { observeSolanaSellTransactions } from "./flows.js";

export function createSolanaSecurityRegistry(profile) {
  const programs = new Map(profile.programs.map((program) => [program.id, program]));
  return Object.freeze({
    async inspect(candidate, dependencies = {}) {
      const program = programs.get(candidate?.venue);
      if (!program) return sellabilityResult("unknown", "unsupported-venue");
      const metadata = candidate.metadata ?? {};
      if (!candidate.pool || !metadata.baseVault || !metadata.quoteVault) {
        return sellabilityResult("unknown", "pool-not-resolved");
      }
      const inspectMint = dependencies.inspectMint ?? inspectMintControls;
      const mint = await inspectMint(candidate.token, { connection: dependencies.connection });
      if (mint?.status !== "complete") {
        return sellabilityResult("unknown", "mint-controls-unknown", { details: mint?.details });
      }
      if (mint.redFlags?.length) {
        return sellabilityResult("unknown", "mint-controls-risk", { details: mint.redFlags });
      }
      if (dependencies.restrictionEvidence?.blocked === true) {
        return sellabilityResult("blocked", dependencies.restrictionEvidence.reason || "program-transfer-restriction");
      }
      if (typeof dependencies.getObservedSellTransactions !== "function") {
        return sellabilityResult("unknown", "evidence-unavailable", { details: ["Solana observed sell reader unavailable"] });
      }
      const binding = {
        token: candidate.token,
        quote: candidate.quoteToken,
        pool: candidate.pool,
        baseVault: metadata.baseVault,
        quoteVault: metadata.quoteVault,
        authority: metadata.authority ?? null,
        programId: program.programId,
      };
      const transactions = await dependencies.getObservedSellTransactions(candidate, binding);
      const observed = observeSolanaSellTransactions({
        transactions,
        binding,
        meaningfulThreshold: dependencies.meaningfulThreshold ?? 1n,
      });
      const evidence = {
        evidenceMode: "observed-sells",
        bindingVerified: true,
        meaningfulSellers: observed.meaningfulSellers,
        quoteOutflowReceipts: observed.quoteOutflowTransactions,
        details: [`checked ${observed.transactionSamples} Solana transactions`],
      };
      const required = dependencies.meaningfulSellerCount ?? 3;
      if (observed.meaningfulSellers < required || observed.quoteOutflowTransactions < required) {
        return sellabilityResult("unknown", "insufficient-meaningful-sells", evidence);
      }
      return sellabilityResult("confirmed", null, evidence);
    },
  });
}
