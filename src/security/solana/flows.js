function keyString(value) {
  const key = value?.pubkey ?? value;
  return typeof key === "string" ? key : key?.toBase58?.() ?? String(key);
}

function accountKeys(transaction) {
  const message = transaction?.transaction?.transaction?.message;
  return (message?.accountKeys ?? message?.staticAccountKeys ?? []).map(keyString);
}

function balancesByIdentity(items, keys) {
  const values = new Map();
  for (const item of items ?? []) {
    const identity = `${item.mint}|${item.owner || ""}|${keys[item.accountIndex] || item.accountIndex}`;
    values.set(identity, BigInt(item.uiTokenAmount?.amount ?? item.amount ?? 0));
  }
  return values;
}

function amountFor(map, { mint, owner = null, account = null }) {
  let sum = 0n;
  for (const [identity, amount] of map) {
    const [entryMint, entryOwner, entryAccount] = identity.split("|");
    if (entryMint !== mint) continue;
    if (owner != null && entryOwner !== owner) continue;
    if (account != null && entryAccount !== account) continue;
    sum += amount;
  }
  return sum;
}

export function observeSolanaSellTransactions({ transactions, binding, meaningfulThreshold }) {
  if (!Array.isArray(transactions)) throw new Error("Solana sell transactions must be an array");
  if (typeof meaningfulThreshold !== "bigint" || meaningfulThreshold <= 0n) throw new Error("meaningful threshold must be positive");
  const sellers = new Set();
  let quoteOutflowTransactions = 0;
  for (const item of transactions) {
    const transaction = item?.transaction;
    if (!transaction || transaction.meta?.err) continue;
    const keys = accountKeys(item);
    const seller = keys[0];
    if (!seller || seller === binding.pool || seller === binding.baseVault || seller === binding.quoteVault) continue;
    const pre = balancesByIdentity(transaction.meta?.preTokenBalances, keys);
    const post = balancesByIdentity(transaction.meta?.postTokenBalances, keys);
    const sellerTokenDecrease = amountFor(pre, { mint: binding.token, owner: seller }) - amountFor(post, { mint: binding.token, owner: seller });
    const vaultTokenIncrease = amountFor(post, { mint: binding.token, account: binding.baseVault }) - amountFor(pre, { mint: binding.token, account: binding.baseVault });
    const sellerQuoteIncrease = amountFor(post, { mint: binding.quote, owner: seller }) - amountFor(pre, { mint: binding.quote, owner: seller });
    const vaultQuoteDecrease = amountFor(pre, { mint: binding.quote, account: binding.quoteVault }) - amountFor(post, { mint: binding.quote, account: binding.quoteVault });
    if (sellerTokenDecrease >= meaningfulThreshold && vaultTokenIncrease >= meaningfulThreshold && sellerQuoteIncrease > 0n && vaultQuoteDecrease > 0n) {
      if (!sellers.has(seller)) quoteOutflowTransactions++;
      sellers.add(seller);
    }
  }
  return { sellers, meaningfulSellers: sellers.size, quoteOutflowTransactions, transactionSamples: transactions.length };
}
