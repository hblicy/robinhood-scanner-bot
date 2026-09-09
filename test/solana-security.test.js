import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { inspectMintControls } from "../src/security/solana/mint.js";
import { observeSolanaSellTransactions } from "../src/security/solana/flows.js";
import { createSolanaSecurityRegistry } from "../src/security/solana/index.js";

const address = () => Keypair.generate().publicKey.toBase58();
const TOKEN = address();
const POOL = address();
const BASE_VAULT = address();
const QUOTE_VAULT = address();
const PROGRAM = SOLANA_PROFILE.programs.find((value) => value.id === "raydium-cpmm");

describe("Solana security", () => {
  it("reports mint/freeze authorities and Token-2022 controls as explicit risks", async () => {
    const result = await inspectMintControls(TOKEN, {
      readMint: async () => ({
        tokenProgram: "token-2022",
        mintAuthority: address(),
        freezeAuthority: address(),
        extensionTypes: ["TransferFeeConfig", "TransferHook", "PermanentDelegate", "DefaultAccountState"],
        transferFee: { basisPoints: 100 },
        transferHook: { programId: address() },
        permanentDelegate: address(),
        defaultFrozen: true,
      }),
    });
    assert.equal(result.status, "complete");
    assert.ok(result.redFlags.includes("active-mint-authority"));
    assert.ok(result.redFlags.includes("active-freeze-authority"));
    assert.ok(result.redFlags.includes("transfer-fee"));
    assert.ok(result.redFlags.includes("transfer-hook"));
    assert.ok(result.redFlags.includes("permanent-delegate"));
    assert.ok(result.redFlags.includes("default-frozen"));
  });

  it("keeps unknown extensions fail-closed", async () => {
    const result = await inspectMintControls(TOKEN, {
      readMint: async () => ({ tokenProgram: "token-2022", mintAuthority: null, freezeAuthority: null, extensionTypes: ["FutureExtension"] }),
    });
    assert.equal(result.status, "unknown");
    assert.ok(result.redFlags.includes("unknown-token-extension"));
  });

  it("requires independent meaningful sellers and bound quote outflow", () => {
    const quote = SOLANA_PROFILE.wrappedNative;
    const sellers = [address(), address(), address()];
    const transactions = sellers.map((seller, index) => ({
      signature: String(index + 1).repeat(64),
      transaction: {
        transaction: { message: { accountKeys: [seller, PROGRAM.programId, BASE_VAULT, QUOTE_VAULT] } },
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 0, mint: TOKEN, owner: seller, uiTokenAmount: { amount: "100" } },
            { accountIndex: 2, mint: TOKEN, owner: POOL, uiTokenAmount: { amount: "1000" } },
            { accountIndex: 0, mint: quote, owner: seller, uiTokenAmount: { amount: "1" } },
            { accountIndex: 3, mint: quote, owner: POOL, uiTokenAmount: { amount: "1000" } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: TOKEN, owner: seller, uiTokenAmount: { amount: "50" } },
            { accountIndex: 2, mint: TOKEN, owner: POOL, uiTokenAmount: { amount: "1050" } },
            { accountIndex: 0, mint: quote, owner: seller, uiTokenAmount: { amount: "11" } },
            { accountIndex: 3, mint: quote, owner: POOL, uiTokenAmount: { amount: "990" } },
          ],
        },
      },
    }));
    const observed = observeSolanaSellTransactions({
      transactions,
      binding: { token: TOKEN, quote, pool: POOL, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT, programId: PROGRAM.programId },
      meaningfulThreshold: 10n,
    });
    assert.equal(observed.meaningfulSellers, 3);
    assert.equal(observed.quoteOutflowTransactions, 3);
  });

  it("returns confirmed only after mint inspection and three bound sell flows", async () => {
    const candidate = { chain: "solana", venue: PROGRAM.id, token: TOKEN, quoteToken: SOLANA_PROFILE.wrappedNative, pool: POOL, metadata: { baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT } };
    const registry = createSolanaSecurityRegistry(SOLANA_PROFILE);
    const result = await registry.inspect(candidate, {
      inspectMint: async () => ({ status: "complete", redFlags: [] }),
      getObservedSellTransactions: async () => [],
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });
});
