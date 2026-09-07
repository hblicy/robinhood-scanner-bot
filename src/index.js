import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeErrorMessage } from "./safety.js";

export function assertSupportedCommand(command) {
  if (!["watch", "scan", "check"].includes(command)) {
    throw new Error("Transaction functionality is not included. commands: watch | scan | check <token>");
  }
  return command;
}

export async function main() {
  const command = assertSupportedCommand(process.argv[2] || "watch");
  const argument = process.argv[3];
  const { runCommand } = await import("./scanner.js");
  await runCommand(command, argument);
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
