import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getAddress, JsonRpcProvider } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { createAssetCatalog, serializeAssetCatalog } from "../src/assets/catalog.js";
import { ASSET_TRANSACTION_JOURNAL } from "../src/assets/transaction.js";
import { fetchJson } from "../src/assets/sources/http-json.js";
import { readEnvFile } from "../src/env.js";
import {
  combineXStocksPages,
  fetchAllXStocksPages,
  parseXStocksAssets,
  refreshXStocksCatalogs,
} from "../src/assets/sources/xstocks.js";

const BASE_STOCKS_URL = "https://www.base.org/stocks";

// Sources remain disabled until a stable official machine-readable schema is verified.
const SOURCES = Object.freeze({
  xstocks: Object.freeze({ enabled: true }),
  robinhood: Object.freeze({
    enabled: false,
    reason: "no verified machine-readable stock asset source",
  }),
  base: Object.freeze({
    enabled: true,
    family: "evm",
    sourceId: "base-official-stocks",
    sourceUrl: BASE_STOCKS_URL,
  }),
  bsc: Object.freeze({ enabled: false, reason: "versioned manifest only" }),
  ethereum: Object.freeze({ enabled: false, reason: "no verified stock asset source" }),
  solana: Object.freeze({ enabled: false, reason: "source mapper not enabled" }),
});

function assetKey(address) {
  const value = String(address);
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
}

export function mergeVerifiedAssetRows(rows) {
  if (!Array.isArray(rows)) throw new Error("asset rows must be an array");
  const byAddress = new Map();
  for (const row of rows) {
    const key = assetKey(row?.address);
    const previous = byAddress.get(key);
    if (previous && previous.issuer !== row.issuer) {
      throw new Error(`asset issuer conflict for ${row.address}: ${previous.issuer} vs ${row.issuer}`);
    }
    if (!previous) byAddress.set(key, row);
  }
  return [...byAddress.values()].sort((left, right) =>
    assetKey(left.address).localeCompare(assetKey(right.address)));
}

function atomicWriteJson(file, document) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function validatedJournalEntries(journal, directory) {
  if (journal?.schemaVersion !== 1 || !/^[A-Za-z0-9-]+$/.test(journal?.transactionId || "")) {
    throw new Error("asset catalog transaction journal is invalid");
  }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("asset catalog transaction journal has no entries");
  }
  const seen = new Set();
  return journal.entries.map(({ chain, hadTarget }) => {
    if (!/^[a-z0-9-]+$/.test(chain || "") || seen.has(chain) || typeof hadTarget !== "boolean") {
      throw new Error("asset catalog transaction journal entry is invalid");
    }
    seen.add(chain);
    const target = path.resolve(directory, `${chain}.json`);
    return {
      target,
      temporary: `${target}.${journal.transactionId}.tmp`,
      backup: `${target}.${journal.transactionId}.bak`,
      hadTarget,
    };
  });
}

export function recoverAtomicJsonBatch({
  directory = path.resolve("config", "assets"),
  fsImpl = fs,
} = {}) {
  const resolvedDirectory = path.resolve(directory);
  const journalFile = path.join(resolvedDirectory, ASSET_TRANSACTION_JOURNAL);
  if (!fsImpl.existsSync(journalFile)) return false;
  let journal;
  try {
    journal = JSON.parse(fsImpl.readFileSync(journalFile, "utf8"));
  } catch (cause) {
    throw new Error(`asset catalog transaction journal cannot be read: ${cause.message}`, { cause });
  }
  const entries = validatedJournalEntries(journal, resolvedDirectory);
  try {
    for (const entry of entries) {
      if (entry.hadTarget) {
        if (!fsImpl.existsSync(entry.backup)) {
          throw new Error(`asset catalog backup is missing: ${entry.backup}`);
        }
        fsImpl.copyFileSync(entry.backup, entry.target);
      } else if (fsImpl.existsSync(entry.target)) {
        fsImpl.rmSync(entry.target, { force: true });
      }
    }
    fsImpl.rmSync(journalFile, { force: true });
    for (const entry of entries) {
      if (fsImpl.existsSync(entry.temporary)) fsImpl.rmSync(entry.temporary, { force: true });
      if (fsImpl.existsSync(entry.backup)) fsImpl.rmSync(entry.backup, { force: true });
    }
  } catch (cause) {
    throw new Error(`asset catalog transaction recovery failed: ${cause.message}`, { cause });
  }
  return true;
}

export function atomicWriteJsonBatch(documents, {
  directory = path.resolve("config", "assets"),
  fsImpl = fs,
  transactionId = randomUUID(),
} = {}) {
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) {
    throw new Error("asset catalog batch must be an object");
  }
  const resolvedDirectory = path.resolve(directory);
  recoverAtomicJsonBatch({ directory: resolvedDirectory, fsImpl });
  const entries = Object.entries(documents).map(([chain, document]) => {
    if (!/^[a-z0-9-]+$/.test(chain)) throw new Error(`invalid asset catalog chain: ${chain}`);
    const target = path.resolve(resolvedDirectory, `${chain}.json`);
    return {
      target,
      temporary: `${target}.${transactionId}.tmp`,
      backup: `${target}.${transactionId}.bak`,
      document,
      hadTarget: false,
    };
  });
  if (entries.length === 0) throw new Error("asset catalog batch is empty");
  const journalFile = path.join(resolvedDirectory, ASSET_TRANSACTION_JOURNAL);
  const journalTemporary = `${journalFile}.${transactionId}.tmp`;
  fsImpl.mkdirSync(resolvedDirectory, { recursive: true });
  for (const entry of entries) entry.hadTarget = fsImpl.existsSync(entry.target);
  try {
    for (const entry of entries) {
      fsImpl.writeFileSync(entry.temporary, `${JSON.stringify(entry.document, null, 2)}\n`, "utf8");
    }
    for (const entry of entries) {
      if (entry.hadTarget) fsImpl.copyFileSync(entry.target, entry.backup);
    }
    fsImpl.writeFileSync(journalTemporary, `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      entries: entries.map(({ target, hadTarget }) => ({
        chain: path.basename(target, ".json"),
        hadTarget,
      })),
    }, null, 2)}\n`, "utf8");
    fsImpl.renameSync(journalTemporary, journalFile);
    for (const entry of entries) fsImpl.renameSync(entry.temporary, entry.target);
    fsImpl.rmSync(journalFile, { force: true });
  } catch (cause) {
    const rollbackErrors = [];
    if (fsImpl.existsSync(journalFile)) {
      try {
        recoverAtomicJsonBatch({ directory: resolvedDirectory, fsImpl });
      } catch (rollbackCause) {
        rollbackErrors.push(rollbackCause.message);
      }
    } else {
      for (const entry of [...entries].reverse()) {
        try {
          if (fsImpl.existsSync(entry.backup)) {
            fsImpl.copyFileSync(entry.backup, entry.target);
          } else if (!entry.hadTarget && fsImpl.existsSync(entry.target) && !fsImpl.existsSync(entry.temporary)) {
            fsImpl.rmSync(entry.target, { force: true });
          }
        } catch (rollbackCause) {
          rollbackErrors.push(`${entry.target}: ${rollbackCause.message}`);
        }
      }
    }
    const suffix = rollbackErrors.length ? `; rollback failed: ${rollbackErrors.join(", ")}` : "";
    throw new Error(`asset catalog batch publish failed: ${cause.message}${suffix}`, { cause });
  } finally {
    if (fsImpl.existsSync(journalTemporary)) fsImpl.rmSync(journalTemporary, { force: true });
    if (!fsImpl.existsSync(journalFile)) {
      for (const entry of entries) {
        if (fsImpl.existsSync(entry.temporary)) fsImpl.rmSync(entry.temporary, { force: true });
        if (fsImpl.existsSync(entry.backup)) fsImpl.rmSync(entry.backup, { force: true });
      }
    }
  }
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function solanaAccountMap(connection, addresses) {
  const result = new Map();
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const chunk = addresses.slice(offset, offset + 100);
    const accounts = await connection.getMultipleAccountsInfo(
      chunk.map((address) => new PublicKey(address)),
      "finalized"
    );
    chunk.forEach((address, index) => {
      const account = accounts[index];
      result.set(address, {
        exists: account != null,
        owner: account?.owner?.toBase58?.() ?? null,
      });
    });
  }
  return result;
}

export async function runXStocksRefresh({
  fetchImpl = fetch,
  env = process.env,
  publish = (documents) => atomicWriteJsonBatch(documents),
  now = Date.now,
} = {}) {
  recoverAtomicJsonBatch();
  const pages = await fetchAllXStocksPages({ fetchImpl });
  const payload = combineXStocksPages(pages);
  const solanaDocument = parseXStocksAssets(payload, {
    network: "Solana", chain: "solana", family: "solana", now,
  });
  const solana = new Connection(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "finalized");
  const ethereum = new JsonRpcProvider(
    env.ETHEREUM_ANALYSIS_RPC_URL || env.ETHEREUM_DISCOVERY_RPC_URL || "https://ethereum-rpc.publicnode.com",
    1,
    { staticNetwork: true }
  );
  const bsc = new JsonRpcProvider(
    env.BSC_ANALYSIS_RPC_URL || env.BSC_DISCOVERY_RPC_URL || "https://bsc-rpc.publicnode.com",
    56,
    { staticNetwork: true }
  );
  try {
    const solanaAccounts = await solanaAccountMap(solana, solanaDocument.assets.map(({ address }) => address));
    return await refreshXStocksCatalogs({
      pages,
      readers: {
        solana: async (address) => solanaAccounts.get(address),
        ethereum: (address) => ethereum.getCode(address),
        bsc: (address) => bsc.getCode(address),
      },
      existingDocuments: Object.fromEntries(["solana", "ethereum", "bsc"].map((chain) => [
        chain,
        readJsonIfPresent(path.resolve("config", "assets", `${chain}.json`)),
      ])),
      publish,
      now,
    });
  } finally {
    ethereum.destroy();
    bsc.destroy();
  }
}

export function loadRefreshEnvironment({
  file = path.resolve(".env"),
  processEnv = process.env,
} = {}) {
  return { ...readEnvFile(file), ...processEnv };
}

function attributeValue(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

export function parseBaseStocksPage(html, { now = Date.now } = {}) {
  if (typeof html !== "string") throw new Error("Base stocks page must be HTML text");
  const byAddress = new Map();
  const bySymbol = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    const label = attributeValue(attributes, "aria-label");
    const href = attributeValue(attributes, "href");
    const labelMatch = label?.match(/^View ([A-Z0-9.]{1,20}c) on BaseScan$/i);
    if (!labelMatch || !href) continue;
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    const addressMatch = url.pathname.match(/^\/token\/(0x[0-9a-fA-F]{40})\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "basescan.org" || !addressMatch) continue;
    const symbol = labelMatch[1];
    const address = getAddress(addressMatch[1]);
    const key = address.toLowerCase();
    if (byAddress.has(key) && byAddress.get(key) !== symbol) {
      throw new Error(`Base official stock address has conflicting symbols: ${address}`);
    }
    if (bySymbol.has(symbol) && bySymbol.get(symbol) !== key) {
      throw new Error(`Base official stock symbol has conflicting addresses: ${symbol}`);
    }
    byAddress.set(key, symbol);
    bySymbol.set(symbol, key);
  }
  if (byAddress.size === 0) {
    throw new Error("Base official stocks page contains no full contract address links");
  }
  const verifiedAt = now();
  return {
    schemaVersion: 1,
    chain: "base",
    family: "evm",
    source: {
      id: "base-official-stocks",
      url: BASE_STOCKS_URL,
      verifiedAt,
      status: "verified",
    },
    assets: [...byAddress].map(([address, symbol]) => ({
      address: getAddress(address),
      symbol,
      kind: "stock",
      issuer: "Coinbase",
      sourceId: "base-official-stocks",
      sourceUrl: BASE_STOCKS_URL,
      verifiedAt,
    })),
  };
}

export async function refreshBaseStockCatalog({
  sourceUrl = BASE_STOCKS_URL,
  fetchImpl = fetch,
  readBytecode,
  write,
  now = Date.now,
}) {
  if (typeof readBytecode !== "function") throw new Error("Base bytecode reader is required");
  if (typeof write !== "function") throw new Error("Base catalog writer is required");
  let response;
  try {
    response = await fetchImpl(sourceUrl);
  } catch (error) {
    throw new Error(`Base official stocks request failed: ${error.message}`, { cause: error });
  }
  if (!response?.ok) {
    throw new Error(`Base official stocks request failed: HTTP ${response?.status ?? "unknown"}`);
  }
  const document = parseBaseStocksPage(await response.text(), { now });
  for (const asset of document.assets) {
    let bytecode;
    try {
      bytecode = await readBytecode(asset.address);
    } catch (error) {
      throw new Error(`Base stock bytecode read failed for ${asset.address}: ${error.message}`, { cause: error });
    }
    if (typeof bytecode !== "string" || !/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode === "0x") {
      throw new Error(`Base stock has no bytecode: ${asset.address}`);
    }
  }
  const serialized = serializeAssetCatalog(createAssetCatalog(document));
  await write(serialized);
  return serialized;
}

export async function refreshAssetCatalog({
  chain,
  family,
  sourceId,
  sourceUrl,
  fetchImpl = fetch,
  write,
  now = Date.now,
}) {
  const verifiedAt = now();
  const payload = await fetchJson(sourceUrl, { fetchImpl });
  const directRows = Array.isArray(payload) ? payload : payload?.assets;
  const sourceRows = Array.isArray(payload?.sources)
    ? payload.sources.flatMap((source) => source.status === "verified"
      ? (source.assets ?? []).map((row) => ({
        ...row,
        issuer: row.issuer ?? source.issuer,
        sourceId: row.sourceId ?? source.id,
        sourceUrl: row.sourceUrl ?? source.url,
      }))
      : [])
    : null;
  const rows = mergeVerifiedAssetRows(sourceRows ?? directRows);
  if (!Array.isArray(rows)) throw new Error("invalid asset registry payload: assets must be an array");

  const document = {
    schemaVersion: 1,
    chain,
    family,
    source: { id: sourceId, url: sourceUrl, verifiedAt },
    assets: rows.map((row) => ({
      ...row,
      kind: row.kind ?? "stock",
      sourceId: row.sourceId ?? sourceId,
      sourceUrl: row.sourceUrl ?? sourceUrl,
      verifiedAt: row.verifiedAt ?? verifiedAt,
    })),
  };
  const catalog = createAssetCatalog(document);
  const serialized = serializeAssetCatalog(catalog);
  await write(serialized);
  return serialized;
}

export async function runAssetRefresh(
  argv = process.argv.slice(2),
  { env = loadRefreshEnvironment() } = {}
) {
  const chain = argv[0];
  const source = SOURCES[chain];
  if (!source) throw new Error(`unsupported asset source ${chain || "<missing>"}`);
  if (!source.enabled) throw new Error(`asset source ${chain} disabled-unverified: ${source.reason}`);
  if (chain === "xstocks") return runXStocksRefresh({ env });
  const output = path.resolve("config", "assets", `${chain}.json`);
  if (chain === "base") {
    const rpcUrl = env.BASE_ANALYSIS_RPC_URL
      || env.BASE_DISCOVERY_RPC_URL
      || "https://mainnet.base.org";
    const provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
    try {
      return await refreshBaseStockCatalog({
        sourceUrl: source.sourceUrl,
        readBytecode: (address) => provider.getCode(address),
        write: (document) => atomicWriteJson(output, document),
      });
    } finally {
      provider.destroy();
    }
  }
  return refreshAssetCatalog({ ...source, chain, write: (document) => atomicWriteJson(output, document) });
}

export function formatAssetRefreshResult(result) {
  if (result?.chain && Array.isArray(result.assets)) {
    return `asset catalog refreshed: ${result.chain} assets=${result.assets.length}`;
  }
  const chains = ["solana", "ethereum", "bsc"];
  if (chains.every((chain) => Array.isArray(result?.[chain]?.assets))) {
    return `asset catalogs refreshed: ${chains.map((chain) => `${chain}=${result[chain].assets.length}`).join(" ")}`;
  }
  throw new Error("asset refresh returned an invalid result");
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runAssetRefresh().then(
    (catalog) => console.log(formatAssetRefreshResult(catalog)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
