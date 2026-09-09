import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli } from "./cli.js";
import { safeErrorMessage } from "./safety.js";

export function assertSupportedCommand(command) {
  if (!["watch", "scan", "check"].includes(command)) {
    throw new Error("Transaction functionality is not included. commands: watch | scan | check <token>");
  }
  return command;
}

export async function main() {
  const cli = parseCli(process.argv.slice(2));
  const { runCommand } = await import("./scanner.js");
  await runCommand(cli.command, cli.argument, { chainKey: cli.chain });
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(safeErrorMessage(error));
      process.exit(1);
    }
  );
}
