import { normalizeCandidate } from "../core/candidate.js";

function logIndex(log) {
  return Number(log.index ?? log.logIndex);
}

function compareLogs(a, b) {
  return Number(a.blockNumber) - Number(b.blockNumber)
    || Number(a.transactionIndex ?? 0) - Number(b.transactionIndex ?? 0)
    || logIndex(a) - logIndex(b);
}

function adapterKey(address, topic) {
  return `${String(address).toLowerCase()}|${String(topic).toLowerCase()}`;
}

export async function scanEvmRange({
  chain,
  provider,
  fromBlock,
  toBlock,
  adapters,
  getLogs,
  getBlockTimes,
}) {
  const enabledIds = new Set(chain.venues.map(({ id }) => id));
  const enabled = adapters.filter(({ id }) => enabledIds.has(id));
  if (enabled.length === 0) return [];

  const addresses = [...new Set(enabled.flatMap(({ addresses: values }) => values))];
  const topicValues = [...new Set(enabled.flatMap(({ topics }) => topics))];
  const logs = await getLogs({
    provider,
    address: addresses,
    topics: [topicValues],
    fromBlock,
    toBlock,
  });
  const byFilter = new Map();
  for (const adapter of enabled) {
    for (const address of adapter.addresses) {
      for (const topic of adapter.topics) {
        byFilter.set(adapterKey(address, topic), adapter);
      }
    }
  }
  const sorted = [...logs].sort(compareLogs);
  const blockNumbers = [...new Set(sorted.map(({ blockNumber }) => Number(blockNumber)))].sort((a, b) => a - b);
  const blockTimes = await getBlockTimes({ provider, blockNumbers });
  const events = [];

  for (const log of sorted) {
    const adapter = byFilter.get(adapterKey(log.address, log.topics?.[0]));
    if (!adapter) continue;
    let parsed;
    try {
      parsed = await adapter.parse(log, { chain, provider });
    } catch (cause) {
      throw new Error(
        `${chain.key} ${adapter.id} parse failed at block ${log.blockNumber ?? "unknown"} `
        + `tx ${log.transactionHash || "unknown"} log ${logIndex(log)}`,
        { cause }
      );
    }
    if (!parsed) continue;
    events.push(normalizeCandidate({
      chain: chain.key,
      chainFamily: "evm",
      venue: adapter.id,
      sourceKind: adapter.sourceKind,
      token: parsed.token,
      quoteToken: parsed.quoteToken,
      pool: parsed.pool,
      poolId: parsed.poolId ?? null,
      creator: parsed.creator ?? null,
      blockOrSlot: Number(log.blockNumber),
      transactionId: log.transactionHash,
      eventIndex: logIndex(log),
      createdAt: blockTimes.get(Number(log.blockNumber)) ?? null,
      lifecyclePhase: parsed.lifecyclePhase,
      sourceProvenance: `${adapter.id}@${adapter.version}`,
      metadata: parsed.metadata ?? {},
      targetSide: parsed.targetSide ?? null,
      pairDirection: parsed.pairDirection ?? null,
      targetAssetKind: parsed.targetAssetKind ?? "unknown",
      referenceAssetKind: parsed.referenceAssetKind ?? "unknown",
      referenceAssetIssuer: parsed.referenceAssetIssuer ?? null,
      assetSource: parsed.assetSource ?? null,
      assetVerifiedAt: parsed.assetVerifiedAt ?? null,
      referenceRestrictions: parsed.referenceRestrictions ?? [],
    }));
  }
  return events;
}
