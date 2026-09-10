import bs58 from "bs58";

function keyString(value) {
  const key = value?.pubkey ?? value;
  return typeof key === "string" ? key : key?.toBase58?.() ?? String(key);
}

export function transactionAccountKeys(transaction) {
  const message = transaction?.transaction?.message;
  if (!message) throw new Error("Solana transaction message is missing");
  const staticKeys = (message.accountKeys ?? message.staticAccountKeys ?? []).map(keyString);
  const loaded = transaction.meta?.loadedAddresses;
  return [...staticKeys, ...(loaded?.writable ?? []).map(keyString), ...(loaded?.readonly ?? []).map(keyString)];
}

function instructionProgramId(instruction, keys) {
  if (instruction.programId) return keyString(instruction.programId);
  return keys[instruction.programIdIndex];
}

export function decodeInstructionData(instruction) {
  if (Buffer.isBuffer(instruction.data)) return instruction.data;
  if (instruction.data instanceof Uint8Array) return Buffer.from(instruction.data);
  if (typeof instruction.data !== "string") return Buffer.alloc(0);
  try {
    return Buffer.from(bs58.decode(instruction.data));
  } catch (cause) {
    throw new Error("Solana instruction data is not valid Base58", { cause });
  }
}

export function programInstructions(transaction, expectedProgramId) {
  const keys = transactionAccountKeys(transaction);
  const message = transaction.transaction.message;
  const outer = (message.instructions ?? message.compiledInstructions ?? []).map((instruction, index) => ({ instruction, instructionIndex: index }));
  const inner = (transaction.meta?.innerInstructions ?? []).flatMap((group) =>
    (group.instructions ?? []).map((instruction, offset) => ({ instruction, instructionIndex: group.index * 1_000 + offset + 1 }))
  );
  return [...outer, ...inner]
    .filter(({ instruction }) => instructionProgramId(instruction, keys) === expectedProgramId)
    .map(({ instruction, instructionIndex }) => ({
      instructionIndex,
      data: decodeInstructionData(instruction),
      accounts: (instruction.accounts ?? instruction.accountKeyIndexes ?? []).map((index) =>
        typeof index === "number" ? keys[index] : keyString(index)
      ),
    }));
}

export function hasAnyInstructions(transaction) {
  const message = transaction?.transaction?.message;
  return Boolean((message?.instructions ?? message?.compiledInstructions ?? []).length);
}

export function matchesDiscriminator(data, discriminator) {
  return data.length >= discriminator.length && discriminator.every((value, index) => data[index] === value);
}

export function requireAccounts(context, instruction, count, adapterId) {
  if (instruction.accounts.length < count || instruction.accounts.slice(0, count).some((value) => !value)) {
    throw new Error(`unsupported-idl-revision ${adapterId} signature=${context.signature} instruction=${instruction.instructionIndex}`);
  }
  return instruction.accounts;
}

export function chooseTargetPair(mintA, mintB, quoteMints) {
  if (typeof quoteMints === "function") {
    const classified = quoteMints(mintA, mintB);
    if (!classified || classified.candidateKind !== "meme") return null;
    return {
      ...classified,
      token: classified.targetToken,
      quoteToken: classified.referenceAsset,
      targetIsA: classified.targetToken === mintA,
    };
  }
  const aQuote = quoteMints.has(mintA);
  const bQuote = quoteMints.has(mintB);
  if (aQuote === bQuote) return null;
  return aQuote ? { token: mintB, quoteToken: mintA, targetIsA: false } : { token: mintA, quoteToken: mintB, targetIsA: true };
}
