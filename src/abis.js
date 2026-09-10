export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
];

export const PAIR_V2_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
];

export const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  "function getPair(address,address) view returns (address)",
];

export const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

export const V4_PM_ABI = [
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
];

export const AERODROME_CLASSIC_FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,bool indexed stable,address pool,uint256)",
];

export const AERODROME_SLIPSTREAM_FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,int24 indexed tickSpacing,address pool)",
];

export const CLANKER_V4_ABI = [
  "event TokenCreated(address msgSender,address indexed tokenAddress,address indexed tokenAdmin,string tokenImage,string tokenName,string tokenSymbol,string tokenMetadata,string tokenContext,int24 startingTick,address poolHook,bytes32 poolId,address pairedToken,address locker,address mevModule,uint256 extensionsSupply,address[] extensions)",
];

export const PANCAKE_INFINITY_CL_ABI = [
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)",
];

export const FOUR_MEME_V2_ABI = [
  "event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)",
  "event LiquidityAdded(address token1,uint256 token1Amount,address token2,uint256 token2Amount)",
];

export const FOUR_MEME_HELPER_ABI = [
  "function getTokenInfo(address token) view returns (uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)",
];

export const FLAP_PORTAL_ABI = [
  "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
  "event TokenQuoteSet(address token,address quoteToken)",
  "event TokenVersionSet(address token,uint8 version)",
  "event FlapTokenTaxSet(address token,uint256 tax)",
  "event LaunchedToDEX(address token,address pool,uint256 amount,uint256 eth)",
];

export const FLAP_PORTAL_STATE_ABI = [
  "function getTokenV8Safe(address token) view returns (tuple(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)",
];

export const POOL_TOKEN_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

export const O1_LAUNCH_FACTORY_ABI = [
  "event Launched(address indexed token,bytes32 indexed poolId,address indexed originalCreator,address quoteToken,uint256 launchSupply,int24 tickSpacing)",
];

export const B20_READ_ABI = [
  "function multiplier() view returns (uint256)",
  "function isPaused(uint8 feature) view returns (bool)",
  "function policyId(bytes32 policyScope) view returns (uint64)",
];

export const STONKS_EXCHANGE_ABI = [
  "event TokenLaunched(address indexed token,uint256 indexed tokenId,address indexed creator,address quote,address pool,uint24 fee,int24 launchTick,uint256 totalSupply,address feeLocker)",
  "function tokenInfo(address) view returns (address token,address creator,address pool,address quote,uint256 tokenId,uint24 fee,uint256 createdAt)",
];

export const V3_FACTORY_STATE_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
];

export const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];

export const PONS_FACTORY_ABI = [
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
  "event LaunchSwept(address indexed token,uint256 quoteOut,uint256 tokenOut)",
  "event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)",
  "event GraduationTokensPermanentlyLocked(address indexed token,uint256 amount)",
  "function memeHook() view returns (address)",
  "function locker() view returns (address)",
  "function graduationExecutor() view returns (address)",
  "function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
];

export const PONS_CURVE_ABI = [
  "event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)",
  "event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)",
];

export const PONS_HOOK_ABI = [
  "event PoolRegistered(bytes32 indexed poolId,address memecoin,address quoteToken,address creator)",
];
