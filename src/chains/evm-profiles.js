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
    venues: [
      {
        id: "uniswap-v2-ethereum",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 10_000_835,
        verifiedAtBlock: 25_937_482,
        sourceUrl: "https://github.com/Uniswap/contracts/blob/main/deployments/json/1.json",
        contracts: { factory: getAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f") },
      },
      {
        id: "uniswap-v3-ethereum",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 12_369_621,
        verifiedAtBlock: 25_937_482,
        sourceUrl: "https://github.com/Uniswap/contracts/blob/main/deployments/json/1.json",
        contracts: { factory: getAddress("0x1F98431c8aD98523631AE4a59f267346ea31F984") },
      },
      {
        id: "uniswap-v4-ethereum",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 21_688_329,
        verifiedAtBlock: 25_937_482,
        sourceUrl: "https://github.com/Uniswap/v4-subgraph/blob/main/networks.json",
        contracts: { poolManager: getAddress("0x000000000004444c5dc75cB358380D2e3dE08A90") },
      },
    ],
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
    venues: [
      {
        id: "uniswap-v3-base",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 1_371_680,
        verifiedAtBlock: 51_069_727,
        sourceUrl: "https://gov.uniswap.org/t/official-uniswap-v3-deployments-list/24323",
        contracts: { factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD") },
      },
      {
        id: "aerodrome-classic-base",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 3_200_559,
        verifiedAtBlock: 51_071_519,
        sourceUrl: "https://github.com/aerodrome-finance/contracts",
        contracts: { factory: getAddress("0x420DD381b31aEf6683db6B902084cB0FFECe40Da") },
      },
      {
        id: "aerodrome-slipstream-v1-base",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 13_843_704,
        verifiedAtBlock: 51_071_519,
        sourceUrl: "https://github.com/aerodrome-finance/slipstream",
        contracts: { factory: getAddress("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A") },
      },
      {
        id: "aerodrome-slipstream-v2-base",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 36_953_918,
        verifiedAtBlock: 51_071_519,
        sourceUrl: "https://github.com/aerodrome-finance/slipstream",
        contracts: { factory: getAddress("0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a") },
      },
      {
        id: "aerodrome-slipstream-v3-base",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 44_394_724,
        verifiedAtBlock: 51_071_519,
        sourceUrl: "https://github.com/aerodrome-finance/slipstream",
        contracts: { factory: getAddress("0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef") },
      },
      {
        id: "clanker-v4-base",
        sourceKind: "launchpad",
        version: 1,
        deploymentBlock: 31_526_699,
        verifiedAtBlock: 51_071_519,
        sourceUrl: "https://github.com/clanker-devco/v4-contracts",
        contracts: {
          factory: getAddress("0xE85A59c628F7d27878ACeB4bf3b35733630083a9"),
          poolManager: getAddress("0x498581fF718922c3f8e6A244956aF099B2652b2b"),
        },
      },
    ],
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
    venues: [
      {
        id: "pancakeswap-v2-bsc",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 6_809_737,
        verifiedAtBlock: 120_825_352,
        sourceUrl: "https://github.com/pancakeswap/pancake-swap-core/blob/master/contracts/PancakeFactory.sol",
        contracts: { factory: getAddress("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73") },
      },
      {
        id: "pancakeswap-v3-bsc",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 26_956_207,
        verifiedAtBlock: 120_825_352,
        sourceUrl: "https://developer.pancakeswap.finance/contracts/v3/addresses",
        contracts: { factory: getAddress("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865") },
      },
      {
        id: "pancakeswap-infinity-cl-bsc",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 47_214_308,
        verifiedAtBlock: 120_825_352,
        sourceUrl: "https://developer.pancakeswap.finance/contracts/infinity/resources/addresses",
        contracts: { poolManager: getAddress("0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b") },
      },
      {
        id: "four-meme-v2-bsc",
        sourceKind: "launchpad",
        version: 1,
        deploymentBlock: 40_000_000,
        verifiedAtBlock: 120_825_352,
        sourceUrl: "https://github.com/Four-Meme/Four-Smart-Contracts",
        contracts: {
          manager: getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b"),
          helper: getAddress("0xF251F83e40a78868FcfA3FA4599Dad6494E46034"),
        },
      },
      {
        id: "flap-v5-bsc",
        sourceKind: "launchpad",
        version: 1,
        protocolVersion: "v5.23.0",
        docsVersion: "v5.14.16",
        deploymentBlock: 39_980_228,
        verifiedAtBlock: 121_047_803,
        sourceUrl: "https://docs.flap.sh/flap/developers/deployed-contract-addresses",
        contracts: {
          portal: getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"),
          vaultPortal: getAddress("0x90497450f2a706f1951b5bdda52B4E5d16f34C06"),
          taxTokenV3: getAddress("0x024f18294970B5c76c0691b87f138A0317156422"),
        },
      },
    ],
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
    venues: [
      {
        id: "uniswap-v2-robinhood",
        sourceKind: "dex",
        version: 1,
        deploymentBlock: 8_928,
        verifiedAtBlock: 58_268_251,
        sourceUrl: "https://developers.uniswap.org/deployments",
        contracts: { factory: getAddress("0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f") },
      },
      {
        id: "o1-v4-robinhood",
        sourceKind: "launchpad",
        version: 4,
        deploymentBlock: 48_880_218,
        verifiedAtBlock: 54_953_301,
        sourceUrl: "https://docs.o1.exchange/launchpad/reference/launch-contract-suites.json",
        contracts: {
          factory: getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d"),
          hook: getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc"),
          poolManager: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
        },
      },
    ],
  }),
});

export { defineEvmProfile };
