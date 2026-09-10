const LIQUID_REFERENCE_KINDS = new Set(["stable", "native", "crypto"]);

export function createLegacyPairClassifier({ referenceAssets = [], normalizeAddress }) {
  const normalize = (value) => normalizeAddress(value);
  const references = new Set(referenceAssets.map(normalize));
  return (left, right, { leftSide = "token0", rightSide = "token1" } = {}) => {
    const a = normalize(left);
    const b = normalize(right);
    const aReference = references.has(a);
    const bReference = references.has(b);
    if (aReference === bReference) return null;
    const targetToken = aReference ? b : a;
    const referenceAsset = aReference ? a : b;
    const targetSide = aReference ? rightSide : leftSide;
    const referenceSide = aReference ? leftSide : rightSide;
    return Object.freeze({
      candidateKind: "meme",
      targetToken,
      referenceAsset,
      targetSide,
      pairDirection: `${targetSide}/${referenceSide}`,
      targetAssetKind: "meme",
      referenceAssetKind: "native",
      referenceAssetIssuer: null,
      assetSource: null,
      assetVerifiedAt: null,
      referenceRestrictions: Object.freeze([]),
    });
  };
}

export function withLegacyPairAliases(classification) {
  if (!classification || classification.candidateKind !== "meme") return null;
  return {
    ...classification,
    token: classification.targetToken,
    quoteToken: classification.referenceAsset,
  };
}

export function createPairClassifier({ catalog, nativeQuotes = [], normalizeAddress }) {
  if (!catalog || typeof catalog.lookup !== "function") {
    throw new Error("catalog must expose lookup(address)");
  }
  if (typeof normalizeAddress !== "function") {
    throw new Error("normalizeAddress must be a function");
  }

  const normalize = (value) => normalizeAddress(value);
  const quoteSet = new Set(nativeQuotes.map((value) => normalize(value)));
  const describe = (value) => {
    const address = normalize(value);
    const asset = catalog.lookup(address);
    if (asset) return { ...asset, address };
    if (quoteSet.has(address)) {
      return { address, kind: "native", issuer: null, sourceId: null, verifiedAt: null };
    }
    return { address, kind: "unknown", issuer: null, sourceId: null, verifiedAt: null };
  };
  const isLiquidReference = ({ kind }) => LIQUID_REFERENCE_KINDS.has(kind);
  const makeCandidate = (target, reference, targetSide, referenceSide) => Object.freeze({
    candidateKind: "meme",
    targetToken: target.address,
    referenceAsset: reference.address,
    targetSide,
    pairDirection: `${targetSide}/${referenceSide}`,
    targetAssetKind: "meme",
    referenceAssetKind: reference.kind,
    referenceAssetIssuer: reference.issuer ?? null,
    assetSource: reference.sourceId ?? null,
    assetVerifiedAt: reference.verifiedAt ?? null,
    referenceRestrictions: Object.freeze([...(reference.restrictions ?? [])]),
  });

  return (left, right, { leftSide = "token0", rightSide = "token1" } = {}) => {
    const a = describe(left);
    const b = describe(right);
    if (a.kind === "stock" && b.kind === "unknown") {
      return makeCandidate(b, a, rightSide, leftSide);
    }
    if (b.kind === "stock" && a.kind === "unknown") {
      return makeCandidate(a, b, leftSide, rightSide);
    }
    if (isLiquidReference(a) && b.kind === "unknown") {
      return makeCandidate(b, a, rightSide, leftSide);
    }
    if (isLiquidReference(b) && a.kind === "unknown") {
      return makeCandidate(a, b, leftSide, rightSide);
    }
    if ((a.kind === "stock" && isLiquidReference(b))
      || (b.kind === "stock" && isLiquidReference(a))) {
      return Object.freeze({ candidateKind: "reference-liquidity" });
    }
    return null;
  };
}
