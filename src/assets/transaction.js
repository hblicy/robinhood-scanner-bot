import path from "node:path";

export const ASSET_TRANSACTION_JOURNAL = ".xstocks-refresh-transaction.json";

export function assertNoPendingAssetTransaction(shippedPath, existsSync) {
  if (typeof existsSync !== "function") throw new Error("asset transaction existence reader is required");
  const journalFile = path.join(path.dirname(path.resolve(shippedPath)), ASSET_TRANSACTION_JOURNAL);
  if (existsSync(journalFile)) {
    throw new Error(
      `asset catalog refresh is incomplete (${journalFile}); run npm run refresh-assets -- xstocks before starting the scanner`
    );
  }
}
