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

function nativeDelta(transaction, keys, address) {
  const index = keys.indexOf(address);
  const pre = transaction.meta?.preBalances?.[index];
  const post = transaction.meta?.postBalances?.[index];
  if (index < 0 || !Number.isSafeInteger(pre) || !Number.isSafeInteger(post)) return 0n;
  return BigInt(post) - BigInt(pre);
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
    const tokenQuoteIncrease = amountFor(post, { mint: binding.quote, owner: seller }) - amountFor(pre, { mint: binding.quote, owner: seller });
    const sellerQuoteIncrease = tokenQuoteIncrease > 0n
      ? tokenQuoteIncrease
      : binding.nativeQuote ? nativeDelta(transaction, keys, seller) : 0n;
    const vaultQuoteDecrease = amountFor(pre, { mint: binding.quote, account: binding.quoteVault }) - amountFor(post, { mint: binding.quote, account: binding.quoteVault });
    if (sellerTokenDecrease >= meaningfulThreshold && vaultTokenIncrease >= meaningfulThreshold && sellerQuoteIncrease > 0n && vaultQuoteDecrease > 0n) {
      if (!sellers.has(seller)) quoteOutflowTransactions++;
      sellers.add(seller);
    }
  }
  return { sellers, meaningfulSellers: sellers.size, quoteOutflowTransactions, transactionSamples: transactions.length };
}

export function observeSolanaWalletBuys({ transactions, binding, labels }) {
  if (!Array.isArray(transactions)) throw new Error("Solana wallet transactions must be an array");
  if (!(labels instanceof Map)) throw new Error("Solana wallet labels must be a Map");
  const matched = new Map();
  for (const item of transactions) {
    const transaction = item?.transaction;
    if (!transaction || transaction.meta?.err) continue;
    const keys = accountKeys(item);
    const pre = balancesByIdentity(transaction.meta?.preTokenBalances, keys);
    const post = balancesByIdentity(transaction.meta?.postTokenBalances, keys);
    const vaultTokenDecrease = amountFor(pre, { mint: binding.token, account: binding.baseVault })
      - amountFor(post, { mint: binding.token, account: binding.baseVault });
    const vaultQuoteIncrease = amountFor(post, { mint: binding.quote, account: binding.quoteVault })
      - amountFor(pre, { mint: binding.quote, account: binding.quoteVault });
    if (vaultTokenDecrease <= 0n || vaultQuoteIncrease <= 0n) continue;
    for (const [address, label] of labels) {
      const tokenIncrease = amountFor(post, { mint: binding.token, owner: address })
        - amountFor(pre, { mint: binding.token, owner: address });
      const tokenQuoteDecrease = amountFor(pre, { mint: binding.quote, owner: address })
        - amountFor(post, { mint: binding.quote, owner: address });
      const quoteDecrease = tokenQuoteDecrease > 0n
        ? tokenQuoteDecrease
        : binding.nativeQuote ? -nativeDelta(transaction, keys, address) : 0n;
      if (tokenIncrease > 0n && quoteDecrease > 0n) {
        matched.set(address, { address, ...label });
      }
    }
  }
  return { count: matched.size, matches: [...matched.values()] };
}
