import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { loadChainConfig } from "../src/chains/load-chain.js";

describe("Solana profile", () => {
  it("defines verified official programs and quote mints", () => {
    assert.equal(SOLANA_PROFILE.key, "solana");
    assert.equal(SOLANA_PROFILE.family, "solana");
    assert.ok(SOLANA_PROFILE.programs.length >= 6);
    assert.ok(SOLANA_PROFILE.quotes.length >= 3);
    for (const program of SOLANA_PROFILE.programs) {
      assert.equal(new PublicKey(program.programId).toBase58(), program.programId);
      assert.ok(Number.isInteger(program.deploymentSlot));
      assert.ok(Number.isInteger(program.verifiedAtSlot));
      assert.ok(program.verifiedAtSlot >= program.deploymentSlot);
      assert.match(program.sourceUrl, /^https:\/\//);
      assert.ok(program.idlRevision);
    }
  });

  it("loads independent HTTP, analysis, WebSocket, score, and chat values", () => {
    const config = loadChainConfig("solana", {
      SOLANA_DISCOVERY_RPC_URL: "https://solana-public.example",
      SOLANA_ANALYSIS_RPC_URL: "https://solana-private.example/key",
      SOLANA_WS_RPC_URL: "wss://solana-private.example/key",
      SOLANA_MIN_SCORE: "74",
      TELEGRAM_CHAT_ID: "common",
      SOLANA_TELEGRAM_CHAT_ID: "sol-chat",
    });
    assert.equal(config.family, "solana");
    assert.equal(config.rpc.discoveryUrl, "https://solana-public.example");
    assert.equal(config.rpc.analysisUrl, "https://solana-private.example/key");
    assert.equal(config.rpc.wsUrl, "wss://solana-private.example/key");
    assert.equal(config.settings.minScore, 74);
    assert.equal(config.telegram.chatId, "sol-chat");
    assert.equal(config.dataDir, path.resolve("data", "solana"));
  });

  it("supports reconciliation-only mode and validates Solana overrides", () => {
    const config = loadChainConfig("solana", {
      SOLANA_DISCOVERY_RPC_URL: "https://api.mainnet-beta.solana.com",
    });
    assert.equal(config.rpc.wsUrl, "");
    assert.throws(
      () => loadChainConfig("solana", { SOLANA_WS_RPC_URL: "https://not-websocket.example" }),
      /SOLANA_WS_RPC_URL/
    );
    assert.throws(() => loadChainConfig("solana", { SOLANA_MIN_SCORE: "101" }), /SOLANA_MIN_SCORE/);
  });
});
