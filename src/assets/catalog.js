import { getAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

const CHAIN_FAMILIES = Object.freeze({
  ethereum: "evm",
  base: "evm",
  bsc: "evm",
  robinhood: "evm",
  solana: "solana",
});
const ASSET_KINDS = new Set(["stock", "stable", "native", "crypto"]);

function nonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function httpsUrl(name, value) {
  const text = nonEmptyString(name, value);
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error(`${name} must be a valid HTTPS URL`, { cause: error });
  }
  if (url.protocol !== "https:") throw new Error(`${name} must be a valid HTTPS URL`);
  return text;
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateCatalogDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("asset catalog must be an object");
  }
  if (document.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  const chain = nonEmptyString("chain", document.chain).toLowerCase();
  const family = nonEmptyString("family", document.family).toLowerCase();
  if (CHAIN_FAMILIES[chain] !== family) {
    throw new Error(`${chain} does not belong to the ${family} family`);
  }
  if (!document.source || typeof document.source !== "object") {
    throw new Error("source must be an object");
  }
  nonEmptyString("source.id", document.source.id);
  const disabled = document.source.status === "disabled-unverified";
  if (disabled) {
    if (document.source.url !== null || document.source.verifiedAt !== 0) {
      throw new Error("disabled source must use a null URL and verifiedAt 0");
    }
  } else {
    httpsUrl("source.url", document.source.url);
    positiveInteger("source.verifiedAt", document.source.verifiedAt);
  }
  if (!Array.isArray(document.assets)) throw new Error("assets must be an array");
  if (disabled && document.assets.length > 0) {
    throw new Error("disabled source cannot contain assets");
  }
  for (const [index, asset] of document.assets.entries()) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error(`asset ${index} must be an object`);
    }
    nonEmptyString(`asset ${index} address`, asset.address);
    nonEmptyString(`asset ${index} symbol`, asset.symbol);
    if (!ASSET_KINDS.has(asset.kind)) throw new Error(`asset ${index} has invalid kind`);
    nonEmptyString(`asset ${index} issuer`, asset.issuer);
    nonEmptyString(`asset ${index} sourceId`, asset.sourceId);
    httpsUrl(`asset ${index} sourceUrl`, asset.sourceUrl);
    positiveInteger(`asset ${index} verifiedAt`, asset.verifiedAt);
  }
  return { chain, family };
}

function normalizerFor(family) {
  return family === "evm"
    ? (value) => getAddress(value).toLowerCase()
    : (value) => new PublicKey(value).toBase58();
}

export function createAssetCatalog(document) {
  const { chain, family } = validateCatalogDocument(document);
  const normalize = normalizerFor(family);
  const byAddress = new Map();
  for (const asset of document.assets) {
    let address;
    try {
      address = normalize(asset.address);
    } catch (error) {
      throw new Error(`invalid asset address ${asset.address}`, { cause: error });
    }
    if (byAddress.has(address)) throw new Error(`duplicate asset ${address}`);
    byAddress.set(address, Object.freeze({ ...asset, address }));
  }
  return Object.freeze({
    schemaVersion: 1,
    chain,
    family,
    source: Object.freeze({ ...document.source }),
    assets: Object.freeze([...byAddress.values()]),
    has(address) {
      return byAddress.has(normalize(address));
    },
    lookup(address) {
      return byAddress.get(normalize(address)) ?? null;
    },
  });
}

export function serializeAssetCatalog(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    chain: catalog.chain,
    family: catalog.family,
    source: { ...catalog.source },
    assets: catalog.assets.map((asset) => ({ ...asset })),
  };
}
