import { PublicKey } from "@solana/web3.js";
import fs from "node:fs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function defineProgram(value) {
  const programId = new PublicKey(value.programId).toBase58();
  if (!Number.isInteger(value.deploymentSlot) || value.deploymentSlot < 0) {
    throw new Error(`${value.id} deployment slot is invalid`);
  }
  if (!Number.isInteger(value.verifiedAtSlot) || value.verifiedAtSlot < value.deploymentSlot) {
    throw new Error(`${value.id} verification slot is invalid`);
  }
  if (!value.idlRevision || !/^https:\/\//.test(value.sourceUrl)) {
    throw new Error(`${value.id} provenance is incomplete`);
  }
  return Object.freeze({ ...value, programId });
}

const PUMP_REVISION = "9c82f61cb711b044a17f770ab8ce9f9bdf78f333";
const RAYDIUM_REVISION = "28411d09ad17e598f83885f65c4b6d25a172ced0";
const VERIFIED_AT_SLOT = 445_546_375;
const VENUE_CAPABILITIES = JSON.parse(fs.readFileSync(
  new URL("../../config/venues/solana.json", import.meta.url),
  "utf8"
));

export const SOLANA_PROFILE = deepFreeze({
  key: "solana",
  family: "solana",
  name: "Solana",
  nativeSymbol: "SOL",
  publicRpc: "https://api.mainnet-beta.solana.com",
  explorer: "https://solscan.io",
  dexScreenerSlug: "solana",
  confirmations: 1,
  wrappedNative: "So11111111111111111111111111111111111111112",
  quotes: [
    { symbol: "WSOL", address: "So11111111111111111111111111111111111111112" },
    { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    { symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  ],
  venueCapabilities: VENUE_CAPABILITIES,
  programs: [
    defineProgram({
      id: "pump-bonding-curve",
      sourceKind: "launchpad",
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      deploymentSlot: 433_095_571,
      verifiedAtSlot: VERIFIED_AT_SLOT,
      idlRevision: PUMP_REVISION,
      sourceUrl: `https://github.com/pump-fun/pump-public-docs/blob/${PUMP_REVISION}/idl/pump.json`,
    }),
    defineProgram({
      id: "pumpswap",
      sourceKind: "dex",
      programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
      deploymentSlot: 433_112_355,
      verifiedAtSlot: VERIFIED_AT_SLOT,
      idlRevision: PUMP_REVISION,
      sourceUrl: `https://github.com/pump-fun/pump-public-docs/blob/${PUMP_REVISION}/idl/pump_amm.json`,
    }),
    defineProgram({
      id: "raydium-launchlab",
      sourceKind: "launchpad",
      programId: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
      deploymentSlot: 443_733_445,
      verifiedAtSlot: VERIFIED_AT_SLOT,
      idlRevision: RAYDIUM_REVISION,
      sourceUrl: "https://docs.raydium.io/raydium/protocol/developers/addresses",
    }),
    defineProgram({
      id: "raydium-cpmm",
      sourceKind: "dex",
      programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
      deploymentSlot: 439_846_178,
      verifiedAtSlot: VERIFIED_AT_SLOT,
      idlRevision: RAYDIUM_REVISION,
      sourceUrl: "https://docs.raydium.io/raydium/protocol/developers/addresses",
    }),
    defineProgram({
      id: "raydium-clmm",
      sourceKind: "dex",
      programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
      deploymentSlot: 439_846_317,
      verifiedAtSlot: VERIFIED_AT_SLOT,
      idlRevision: RAYDIUM_REVISION,
      sourceUrl: "https://docs.raydium.io/raydium/protocol/developers/addresses",
    }),
    defineProgram({
      id: "raydium-amm-v4",
      sourceKind: "dex",
      programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      deploymentSlot: 434_518_095,
      verifiedAtSlot: VERIFIED_AT_SLOT,
      idlRevision: RAYDIUM_REVISION,
      sourceUrl: "https://docs.raydium.io/raydium/protocol/developers/addresses",
    }),
  ],
});
