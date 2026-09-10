import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAssetCatalog, serializeAssetCatalog } from "../src/assets/catalog.js";
import { fetchJson } from "../src/assets/sources/http-json.js";

// Sources remain disabled until a stable official machine-readable schema is verified.
const SOURCES = Object.freeze({
  robinhood: Object.freeze({
    enabled: false,
    reason: "no verified machine-readable stock asset source",
  }),
  base: Object.freeze({ enabled: false, reason: "versioned manifest only" }),
  bsc: Object.freeze({ enabled: false, reason: "versioned manifest only" }),
  ethereum: Object.freeze({ enabled: false, reason: "no verified stock asset source" }),
  solana: Object.freeze({ enabled: false, reason: "source mapper not enabled" }),
});

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
  const rows = Array.isArray(payload) ? payload : payload?.assets;
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
    })).sort((left, right) => String(left.address).localeCompare(String(right.address))),
  };
  const catalog = createAssetCatalog(document);
  const serialized = serializeAssetCatalog(catalog);
  await write(serialized);
  return serialized;
}

export async function runAssetRefresh(argv = process.argv.slice(2)) {
  const chain = argv[0];
  const source = SOURCES[chain];
  if (!source) throw new Error(`unsupported asset source ${chain || "<missing>"}`);
  if (!source.enabled) throw new Error(`asset source ${chain} disabled-unverified: ${source.reason}`);
  const output = path.resolve("config", "assets", `${chain}.json`);
  return refreshAssetCatalog({ ...source, chain, write: (document) => atomicWriteJson(output, document) });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runAssetRefresh().then(
    (catalog) => console.log(`asset catalog refreshed: ${catalog.chain} assets=${catalog.assets.length}`),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
