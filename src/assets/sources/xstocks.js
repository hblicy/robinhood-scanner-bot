import { getAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createAssetCatalog, serializeAssetCatalog } from "../catalog.js";

export const XSTOCKS_ASSETS_URL = "https://api.xstocks.fi/api/v2/public/assets";
const SOURCE_ID = "backed-xstocks-api-v2";
const TARGETS = Object.freeze({
  solana: Object.freeze({ network: "Solana", family: "solana" }),
  ethereum: Object.freeze({ network: "Ethereum", family: "evm" }),
  bsc: Object.freeze({ network: "BinanceSmartChain", family: "evm" }),
});
const SOLANA_TOKEN_OWNERS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`xStocks ${field} is required`);
  }
  return value.trim();
}

function normalizeAddress(address, family) {
  return family === "solana"
    ? new PublicKey(address).toBase58()
    : getAddress(address);
}

function assetKey(address, family) {
  return family === "evm" ? address.toLowerCase() : address;
}

function rowsFromPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.nodes)) {
    throw new Error("xStocks public assets response must contain nodes");
  }
  return payload.nodes;
}

export function parseXStocksAssets(payload, {
  network = "Solana",
  chain = "solana",
  family = chain === "solana" ? "solana" : "evm",
  now = Date.now,
} = {}) {
  const verifiedAt = now();
  const byAddress = new Map();
  for (const token of rowsFromPayload(payload)) {
    const symbol = requiredString(token?.symbol, "symbol");
    if (!Array.isArray(token.deployments)) {
      throw new Error(`xStocks deployments are required for ${symbol}`);
    }
    for (const deployment of token.deployments) {
      const deploymentNetwork = requiredString(deployment?.network, `network for ${symbol}`);
      if (deploymentNetwork !== network) continue;
      const address = normalizeAddress(requiredString(deployment.address, `address for ${symbol}`), family);
      const key = assetKey(address, family);
      if (byAddress.has(key)) throw new Error(`duplicate asset ${address}`);
      byAddress.set(key, {
        address,
        symbol,
        name: typeof token.name === "string" && token.name.trim() ? token.name.trim() : symbol,
        kind: "stock",
        issuer: "Backed",
        isin: typeof token.isin === "string" && token.isin.trim() ? token.isin.trim() : null,
        sourceId: SOURCE_ID,
        sourceUrl: XSTOCKS_ASSETS_URL,
        verifiedAt,
      });
    }
  }
  if (byAddress.size === 0) throw new Error(`xStocks response has no ${network} deployments`);
  return {
    schemaVersion: 1,
    chain,
    family,
    source: {
      id: SOURCE_ID,
      url: XSTOCKS_ASSETS_URL,
      verifiedAt,
      status: "verified",
    },
    assets: [...byAddress.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol) || assetKey(left.address, family).localeCompare(assetKey(right.address, family))),
  };
}

export function combineXStocksPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("xStocks pages are required");
  }
  const nodes = [];
  pages.forEach((payload, index) => {
    const rows = rowsFromPayload(payload);
    const currentPage = payload.page?.currentPage;
    const hasNextPage = payload.page?.hasNextPage;
    if (currentPage !== index || typeof hasNextPage !== "boolean") {
      throw new Error(`xStocks page provenance is invalid at page ${index}`);
    }
    if (index < pages.length - 1 && !hasNextPage) {
      throw new Error(`xStocks pagination ended before page ${index + 1}`);
    }
    if (index === pages.length - 1 && hasNextPage) {
      throw new Error("xStocks pages are incomplete");
    }
    nodes.push(...rows);
  });
  return { nodes, page: { currentPage: pages.length - 1, hasNextPage: false } };
}

function mergeDocuments(current, incoming) {
  const family = incoming.family;
  const byAddress = new Map();
  for (const asset of current?.assets ?? []) {
    const address = normalizeAddress(asset.address, family);
    byAddress.set(assetKey(address, family), { ...asset, address });
  }
  for (const asset of incoming.assets) {
    const key = assetKey(asset.address, family);
    const previous = byAddress.get(key);
    if (previous && previous.issuer !== asset.issuer) {
      throw new Error(`asset issuer conflict for ${asset.address}: ${previous.issuer} vs ${asset.issuer}`);
    }
    byAddress.set(key, asset);
  }
  const merged = {
    ...incoming,
    source: current?.assets?.length
      ? { ...incoming.source, id: "merged-verified-stock-sources", status: "verified-partial" }
      : incoming.source,
    assets: [...byAddress.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol) || assetKey(left.address, family).localeCompare(assetKey(right.address, family))),
  };
  return serializeAssetCatalog(createAssetCatalog(merged));
}

async function verifyDocument(chain, document, reader) {
  if (typeof reader !== "function") throw new Error(`${chain} xStocks verifier is required`);
  for (const asset of document.assets) {
    let result;
    try {
      result = await reader(asset.address);
    } catch (cause) {
      throw new Error(`${chain} xStocks verification failed for ${asset.address}: ${cause.message}`, { cause });
    }
    if (chain === "solana") {
      const owner = typeof result?.owner === "string" ? result.owner : result?.owner?.toBase58?.();
      if (!result?.exists || !SOLANA_TOKEN_OWNERS.has(owner)) {
        throw new Error(`Solana xStocks mint owner is invalid for ${asset.address}`);
      }
    } else if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result) || result === "0x") {
      throw new Error(`${chain} xStocks has no bytecode: ${asset.address}`);
    }
  }
}

export async function refreshXStocksCatalogs({
  pages,
  readers,
  existingDocuments = {},
  publish,
  now = Date.now,
}) {
  if (typeof publish !== "function") throw new Error("xStocks catalog batch publisher is required");
  const payload = combineXStocksPages(pages);
  const incoming = Object.fromEntries(Object.entries(TARGETS).map(([chain, target]) => [
    chain,
    parseXStocksAssets(payload, { ...target, chain, now }),
  ]));
  await Promise.all(Object.entries(incoming).map(([chain, document]) =>
    verifyDocument(chain, document, readers?.[chain])));
  const documents = Object.fromEntries(Object.entries(incoming).map(([chain, document]) => [
    chain,
    mergeDocuments(existingDocuments[chain], document),
  ]));
  await publish(documents);
  return documents;
}

export async function fetchAllXStocksPages({ fetchImpl = fetch, sourceUrl = XSTOCKS_ASSETS_URL } = {}) {
  const pages = [];
  for (let page = 0; ; page += 1) {
    let response;
    try {
      const url = new URL(sourceUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", "100");
      response = await fetchImpl(url);
    } catch (cause) {
      throw new Error(`xStocks public assets request failed at page ${page}: ${cause.message}`, { cause });
    }
    if (!response?.ok) {
      throw new Error(`xStocks public assets request failed at page ${page}: HTTP ${response?.status ?? "unknown"}`);
    }
    const payload = await response.json();
    pages.push(payload);
    if (payload.page?.hasNextPage === false) return pages;
    if (payload.page?.currentPage !== page || pages.length > 100) {
      throw new Error(`xStocks public assets pagination is invalid at page ${page}`);
    }
  }
}
