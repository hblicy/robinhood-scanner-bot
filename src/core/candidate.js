import { getAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

const CHAIN_FAMILIES = Object.freeze({
  ethereum: "evm",
  base: "evm",
  bsc: "evm",
  robinhood: "evm",
  solana: "solana",
});
const SOURCE_KINDS = new Set(["dex", "launchpad"]);
const TARGET_SIDES = new Set(["token0", "token1", "base", "quote"]);

function requiredString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(name, value) {
  if (value == null) return null;
  return requiredString(name, value);
}

function nonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeIdentity(name, value, family, { optional = false } = {}) {
  if (optional && value == null) return null;
  const identity = requiredString(name, value);
  if (family === "evm") return getAddress(identity);
  try {
    return new PublicKey(identity).toBase58();
  } catch (error) {
    throw new Error(`${name} must be a valid Solana public key`, { cause: error });
  }
}

export function normalizeCandidate(input) {
  if (!input || typeof input !== "object") throw new Error("candidate must be an object");
  const chain = requiredString("chain", input.chain).toLowerCase();
  const chainFamily = requiredString("chainFamily", input.chainFamily).toLowerCase();
  if (CHAIN_FAMILIES[chain] !== chainFamily) {
    throw new Error(`${chain} does not belong to the ${chainFamily} family`);
  }
  const sourceKind = requiredString("sourceKind", input.sourceKind);
  if (!SOURCE_KINDS.has(sourceKind)) throw new Error(`unsupported sourceKind ${sourceKind}`);
  const blockOrSlot = nonNegativeInteger("blockOrSlot", input.blockOrSlot);
  const eventIndex = nonNegativeInteger("eventIndex", input.eventIndex);
  const transactionId = requiredString("transactionId", input.transactionId);
  if (chainFamily === "evm" && !/^0x[0-9a-fA-F]{64}$/.test(transactionId)) {
    throw new Error("transactionId must be a 32-byte EVM hash");
  }
  if (chainFamily === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{1,88}$/.test(transactionId)) {
    throw new Error("transactionId must be a Base58 Solana signature");
  }
  if (input.createdAt != null && (!Number.isFinite(input.createdAt) || input.createdAt < 0)) {
    throw new Error("createdAt must be null or a non-negative timestamp");
  }
  const poolId = optionalString("poolId", input.poolId);
  const metadata = input.metadata == null ? Object.freeze({}) : Object.freeze({ ...input.metadata });
  const targetToken = normalizeIdentity(
    input.targetToken == null ? "token" : "targetToken",
    input.targetToken ?? input.token,
    chainFamily
  );
  const referenceAsset = normalizeIdentity(
    input.referenceAsset == null ? "quoteToken" : "referenceAsset",
    input.referenceAsset ?? input.quoteToken,
    chainFamily
  );
  const targetSide = input.targetSide == null
    ? null
    : requiredString("targetSide", input.targetSide);
  if (targetSide != null && !TARGET_SIDES.has(targetSide)) {
    throw new Error(`unsupported targetSide ${targetSide}`);
  }
  if (input.assetVerifiedAt != null
    && (!Number.isFinite(input.assetVerifiedAt) || input.assetVerifiedAt < 0)) {
    throw new Error("assetVerifiedAt must be null or a non-negative timestamp");
  }
  if (input.referenceRestrictions != null && !Array.isArray(input.referenceRestrictions)) {
    throw new Error("referenceRestrictions must be an array");
  }

  return Object.freeze({
    chain,
    chainFamily,
    venue: requiredString("venue", input.venue),
    sourceKind,
    token: targetToken,
    quoteToken: referenceAsset,
    targetToken,
    referenceAsset,
    targetSide,
    pairDirection: optionalString("pairDirection", input.pairDirection),
    targetAssetKind: input.targetAssetKind ?? "unknown",
    referenceAssetKind: input.referenceAssetKind ?? "unknown",
    referenceAssetIssuer: optionalString("referenceAssetIssuer", input.referenceAssetIssuer),
    assetSource: optionalString("assetSource", input.assetSource),
    assetVerifiedAt: input.assetVerifiedAt ?? null,
    referenceRestrictions: Object.freeze([...(input.referenceRestrictions ?? [])]),
    pool: normalizeIdentity("pool", input.pool, chainFamily),
    poolId,
    creator: normalizeIdentity("creator", input.creator, chainFamily, { optional: true }),
    blockOrSlot,
    transactionId: chainFamily === "evm" ? transactionId.toLowerCase() : transactionId,
    eventIndex,
    createdAt: input.createdAt ?? null,
    lifecyclePhase: requiredString("lifecyclePhase", input.lifecyclePhase),
    sourceProvenance: requiredString("sourceProvenance", input.sourceProvenance),
    metadata,
  });
}

function chainOf(event) {
  return event.chain || "robinhood";
}

function isEvm(event) {
  return event.chainFamily !== "solana";
}

export function rawEventKey(event) {
  const transactionId = isEvm(event)
    ? String(event.transactionId).toLowerCase()
    : String(event.transactionId);
  return `${chainOf(event)}|${transactionId}|${event.eventIndex}`;
}

export function candidateKey(event) {
  const values = [
    chainOf(event),
    event.venue,
    event.poolId || event.pool || event.targetToken || event.token,
  ];
  return (isEvm(event)
    ? values.map((value) => String(value).toLowerCase())
    : values.map(String)
  ).join("|");
}

export function notificationKey(event, alertType, stateVersion) {
  const values = [chainOf(event), event.targetToken || event.token, alertType, stateVersion];
  return (isEvm(event)
    ? values.map((value) => String(value).toLowerCase())
    : values.map(String)
  ).join("|");
}
