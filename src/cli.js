const COMMANDS = new Set(["watch", "scan", "check"]);
const CHAINS = new Set(["robinhood", "base", "bsc", "ethereum", "solana"]);

export function parseCli(argv) {
  const args = [...argv];
  let chain = "robinhood";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--chain") {
      if (!args[i + 1]) throw new Error("--chain requires a value");
      chain = args.splice(i, 2)[1].toLowerCase();
      i -= 1;
    } else if (args[i].startsWith("--chain=")) {
      chain = args.splice(i, 1)[0].slice(8).toLowerCase();
      i -= 1;
    }
  }
  if (!CHAINS.has(chain)) throw new Error(`unsupported chain ${chain}`);
  const command = args.shift() || "watch";
  if (!COMMANDS.has(command)) {
    throw new Error("Transaction functionality is not included. commands: watch | scan | check <token>");
  }
  const argument = args.shift() || null;
  if (args.length || (command === "check" && !argument) || (command !== "check" && argument)) {
    throw new Error(`invalid arguments for ${command}`);
  }
  return { command, chain, argument };
}
