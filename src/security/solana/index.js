import { sellabilityResult } from "../../sellability.js";
import { inspectMintControls } from "./mint.js";
import { observeSolanaSellTransactions } from "./flows.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";

function keyString(value) {
  return value?.toBase58?.() ?? String(value);
}

function tokenProgramFor(account) {
  const owner = keyString(account.owner);
  if (owner === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return null;
}

export async function validateSolanaPoolBinding(candidate, { connection }) {
  if (!connection?.getMultipleAccountsInfo) throw new Error("Solana binding connection is required");
  const metadata = candidate.metadata ?? {};
  if (!metadata.poolProgramId) return { verified: false, reason: "pool-program-missing" };
  const keys = [candidate.pool, metadata.baseVault, metadata.quoteVault].map((value) => new PublicKey(value));
  const [pool, baseVault, quoteVault] = await connection.getMultipleAccountsInfo(keys, "finalized");
  if (!pool || !baseVault || !quoteVault) return { verified: false, reason: "pool-account-missing" };
  if (keyString(pool.owner) !== metadata.poolProgramId) return { verified: false, reason: "pool-program-mismatch" };
  const baseProgram = tokenProgramFor(baseVault);
  const quoteProgram = tokenProgramFor(quoteVault);
  if (!baseProgram || !quoteProgram) return { verified: false, reason: "vault-program-mismatch" };
  try {
    const base = unpackAccount(keys[1], baseVault, baseProgram);
    const quote = unpackAccount(keys[2], quoteVault, quoteProgram);
    if (base.mint.toBase58() !== candidate.token) return { verified: false, reason: "base-vault-mint-mismatch" };
    if (quote.mint.toBase58() !== candidate.quoteToken) return { verified: false, reason: "quote-vault-mint-mismatch" };
  } catch {
    return { verified: false, reason: "vault-account-undecodable" };
  }
  return { verified: true };
}

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
      const validateBinding = dependencies.validateBinding ?? validateSolanaPoolBinding;
      const validation = await validateBinding(candidate, { connection: dependencies.connection });
      if (validation?.verified !== true) {
        return sellabilityResult("unknown", "pool-binding-mismatch", {
          evidenceMode: "observed-sells",
          bindingVerified: false,
          details: validation?.reason ? [validation.reason] : [],
        });
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
        nativeQuote: candidate.quoteToken === profile.wrappedNative,
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
