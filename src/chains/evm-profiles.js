import { getAddress } from "ethers";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function defineEvmProfile(value) {
  if (value.family !== "evm") throw new Error(`${value.key} must use the EVM family`);
  if (!Number.isInteger(value.id) || value.id <= 0) throw new Error(`${value.key} chain ID is invalid`);
  if (!value.quotes?.length || !value.venues?.length) throw new Error(`${value.key} profile is incomplete`);
  for (const venue of value.venues) {
    if (!Number.isInteger(venue.deploymentBlock) || venue.deploymentBlock < 0) {
      throw new Error(`${venue.id} deployment block is invalid`);
    }
    if (!Number.isInteger(venue.verifiedAtBlock) || venue.verifiedAtBlock < venue.deploymentBlock) {
      throw new Error(`${venue.id} verification block is invalid`);
    }
    if (!/^https:\/\//.test(venue.sourceUrl)) throw new Error(`${venue.id} source URL is invalid`);
    for (const address of Object.values(venue.contracts)) getAddress(address);
  }
  return deepFreeze(value);
}

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

export const EVM_PROFILES = deepFreeze({
  ethereum: defineEvmProfile({
    key: "ethereum",
    family: "evm",
    id: 1,
    name: "Ethereum",
    nativeSymbol: "ETH",
    publicRpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    dexScreenerSlug: "ethereum",
    geckoNetwork: "eth",
    confirmations: 12,
    wrappedNative: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    quotes: [
      { symbol: "ETH", address: NATIVE },
      { symbol: "ETH", address: ZERO },
      { symbol: "WETH", address: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") },
      { symbol: "USDC", address: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") },
      { symbol: "USDT", address: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7") },
    ],
    venues: [{
      id: "uniswap-v2-ethereum",
      sourceKind: "dex",
      version: 1,
      deploymentBlock: 10_000_835,
      verifiedAtBlock: 25_937_482,
      sourceUrl: "https://developers.uniswap.org/deployments",
      contracts: { factory: getAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f") },
    }],
  }),
  base: defineEvmProfile({
    key: "base",
    family: "evm",
    id: 8453,
    name: "Base",
    nativeSymbol: "ETH",
    publicRpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    dexScreenerSlug: "base",
    geckoNetwork: "base",
    confirmations: 2,
    wrappedNative: getAddress("0x4200000000000000000000000000000000000006"),
    quotes: [
      { symbol: "ETH", address: NATIVE },
      { symbol: "ETH", address: ZERO },
      { symbol: "WETH", address: getAddress("0x4200000000000000000000000000000000000006") },
      { symbol: "USDC", address: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") },
    ],
    venues: [{
      id: "uniswap-v3-base",
      sourceKind: "dex",
      version: 1,
      deploymentBlock: 1_371_680,
      verifiedAtBlock: 51_069_727,
      sourceUrl: "https://gov.uniswap.org/t/official-uniswap-v3-deployments-list/24323",
      contracts: { factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD") },
    }],
  }),
  bsc: defineEvmProfile({
    key: "bsc",
    family: "evm",
    id: 56,
    name: "BNB Chain",
    nativeSymbol: "BNB",
    publicRpc: "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
    dexScreenerSlug: "bsc",
    geckoNetwork: "bsc",
    confirmations: 3,
    wrappedNative: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
    quotes: [
      { symbol: "BNB", address: NATIVE },
      { symbol: "BNB", address: ZERO },
      { symbol: "WBNB", address: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c") },
      { symbol: "USDT", address: getAddress("0x55d398326f99059fF775485246999027B3197955") },
      { symbol: "USDC", address: getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d") },
    ],
    venues: [{
      id: "pancakeswap-v2-bsc",
      sourceKind: "dex",
      version: 1,
      deploymentBlock: 6_809_737,
      verifiedAtBlock: 120_815_819,
      sourceUrl: "https://github.com/pancakeswap/pancake-swap-core/blob/master/contracts/PancakeFactory.sol",
      contracts: { factory: getAddress("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73") },
    }],
  }),
  robinhood: defineEvmProfile({
    key: "robinhood",
    family: "evm",
    id: 4663,
    name: "Robinhood Chain",
    nativeSymbol: "ETH",
    publicRpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    dexScreenerSlug: "robinhood",
    geckoNetwork: "robinhood",
    confirmations: 2,
    wrappedNative: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    quotes: [
      { symbol: "ETH", address: NATIVE },
      { symbol: "ETH", address: ZERO },
      { symbol: "WETH", address: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73") },
      { symbol: "USDG", address: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168") },
    ],
    venues: [{
      id: "uniswap-v2-robinhood",
      sourceKind: "dex",
      version: 1,
      deploymentBlock: 8_928,
      verifiedAtBlock: 58_268_251,
      sourceUrl: "https://developers.uniswap.org/deployments",
      contracts: { factory: getAddress("0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f") },
    }],
  }),
});

export { defineEvmProfile };
