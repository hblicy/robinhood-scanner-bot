import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { inspectMintControls } from "../src/security/solana/mint.js";
import { observeSolanaSellTransactions, observeSolanaWalletBuys } from "../src/security/solana/flows.js";
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
    const candidate = { chain: "solana", venue: PROGRAM.id, token: TOKEN, quoteToken: SOLANA_PROFILE.wrappedNative, pool: POOL, metadata: { baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT, poolProgramId: PROGRAM.programId } };
    const registry = createSolanaSecurityRegistry(SOLANA_PROFILE);
    const result = await registry.inspect(candidate, {
      inspectMint: async () => ({ status: "complete", redFlags: [] }),
      validateBinding: async () => ({ verified: true }),
      getObservedSellTransactions: async () => [],
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("keeps sellability unknown when the on-chain pool or vault binding does not match", async () => {
    let readFlows = 0;
    const registry = createSolanaSecurityRegistry(SOLANA_PROFILE);
    const result = await registry.inspect({
      chain: "solana", venue: PROGRAM.id, token: TOKEN,
      quoteToken: SOLANA_PROFILE.wrappedNative, pool: POOL,
      metadata: { baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT, poolProgramId: PROGRAM.programId },
    }, {
      inspectMint: async () => ({ status: "complete", redFlags: [] }),
      validateBinding: async () => ({ verified: false, reason: "base-vault-mint-mismatch" }),
      getObservedSellTransactions: async () => { readFlows++; return []; },
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "pool-binding-mismatch");
    assert.equal(result.bindingVerified, false);
    assert.equal(readFlows, 0);
  });

  it("counts a labelled wallet only when a bound pool flow delivered the token", () => {
    const buyer = address();
    const quote = SOLANA_PROFILE.wrappedNative;
    const labels = new Map([[buyer, { label: "Alpha KOL", type: "kol", source: "gmgn" }]]);
    const transactions = [{
      signature: "1".repeat(64),
      transaction: {
        transaction: { message: { accountKeys: [buyer, BASE_VAULT, QUOTE_VAULT] } },
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 0, mint: TOKEN, owner: buyer, uiTokenAmount: { amount: "0" } },
            { accountIndex: 1, mint: TOKEN, owner: POOL, uiTokenAmount: { amount: "1000" } },
            { accountIndex: 0, mint: quote, owner: buyer, uiTokenAmount: { amount: "100" } },
            { accountIndex: 2, mint: quote, owner: POOL, uiTokenAmount: { amount: "1000" } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: TOKEN, owner: buyer, uiTokenAmount: { amount: "50" } },
            { accountIndex: 1, mint: TOKEN, owner: POOL, uiTokenAmount: { amount: "950" } },
            { accountIndex: 0, mint: quote, owner: buyer, uiTokenAmount: { amount: "90" } },
            { accountIndex: 2, mint: quote, owner: POOL, uiTokenAmount: { amount: "1010" } },
          ],
        },
      },
    }];
    const observed = observeSolanaWalletBuys({
      transactions,
      binding: { token: TOKEN, quote, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT },
      labels,
    });
    assert.deepEqual(observed.matches, [{ address: buyer, label: "Alpha KOL", type: "kol", source: "gmgn" }]);

    transactions[0].transaction.meta.postTokenBalances[1].uiTokenAmount.amount = "1000";
    assert.equal(observeSolanaWalletBuys({
      transactions,
      binding: { token: TOKEN, quote, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT },
      labels,
    }).matches.length, 0);
  });

  it("accepts native SOL balance movement when the bound quote vault uses wrapped SOL", () => {
    const trader = address();
    const quote = SOLANA_PROFILE.wrappedNative;
    const sell = {
      transaction: {
        transaction: { message: { accountKeys: [trader, BASE_VAULT, QUOTE_VAULT] } },
        meta: {
          err: null,
          preBalances: [1_000, 0, 0],
          postBalances: [1_010, 0, 0],
          preTokenBalances: [
            { accountIndex: 0, mint: TOKEN, owner: trader, uiTokenAmount: { amount: "50" } },
            { accountIndex: 1, mint: TOKEN, owner: POOL, uiTokenAmount: { amount: "100" } },
            { accountIndex: 2, mint: quote, owner: POOL, uiTokenAmount: { amount: "100" } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: TOKEN, owner: trader, uiTokenAmount: { amount: "40" } },
            { accountIndex: 1, mint: TOKEN, owner: POOL, uiTokenAmount: { amount: "110" } },
            { accountIndex: 2, mint: quote, owner: POOL, uiTokenAmount: { amount: "90" } },
          ],
        },
      },
    };
    assert.equal(observeSolanaSellTransactions({
      transactions: [sell],
      binding: { token: TOKEN, quote, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT, nativeQuote: true },
      meaningfulThreshold: 1n,
    }).meaningfulSellers, 1);

    const buy = structuredClone(sell);
    buy.transaction.meta.preBalances[0] = 1_010;
    buy.transaction.meta.postBalances[0] = 1_000;
    buy.transaction.meta.preTokenBalances[0].uiTokenAmount.amount = "40";
    buy.transaction.meta.postTokenBalances[0].uiTokenAmount.amount = "50";
    buy.transaction.meta.preTokenBalances[1].uiTokenAmount.amount = "110";
    buy.transaction.meta.postTokenBalances[1].uiTokenAmount.amount = "100";
    buy.transaction.meta.preTokenBalances[2].uiTokenAmount.amount = "90";
    buy.transaction.meta.postTokenBalances[2].uiTokenAmount.amount = "100";
    assert.equal(observeSolanaWalletBuys({
      transactions: [buy],
      binding: { token: TOKEN, quote, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT, nativeQuote: true },
      labels: new Map([[trader, { label: "Native buyer", type: "smart_money", source: "gmgn" }]]),
    }).count, 1);
  });
});
