import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { importWalletCsvFiles, serializeWalletCatalog } from "../src/wallets/catalog.js";

function parseArgs(argv) {
  const files = [];
  let family = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--family") family = argv[++index];
    else if (arg === "--output") output = argv[++index];
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else files.push(arg);
  }
  if (!family || !output || files.length === 0) {
    throw new Error("usage: --family evm|solana --output <file> <csv...>");
  }
  return { family, output, files };
}

function atomicWrite(file, content) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const catalog = importWalletCsvFiles(options.files, { family: options.family });
  atomicWrite(options.output, serializeWalletCatalog(catalog));
  console.log(`wallets=${catalog.wallets.length} rejected=${catalog.rejected.length}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
