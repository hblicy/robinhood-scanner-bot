import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface, ZeroAddress, getAddress, keccak256 } from "ethers";
import { PONS_FACTORY_ABI } from "../src/abis.js";
import { ADDR, CHAIN } from "../src/config.js";
import {
  classifyPonsRecord,
  computePonsPoolId,
  parsePonsFactoryLog,
  readPonsLaunch,
  reconcilePonsToken,
  scanPonsRange,
  verifyPonsDeployment,
} from "../src/pons.js";

const iface = new Interface(PONS_FACTORY_ABI);
const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const CURVE = getAddress("0x2222222222222222222222222222222222222222");
const DEPLOYER = getAddress("0x3333333333333333333333333333333333333333");
const QUOTE = getAddress("0x4444444444444444444444444444444444444444");
const TX_HASH = `0x${"ab".repeat(32)}`;

function record(overrides = {}) {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: DEPLOYER,
    creatorFeeRecipient: DEPLOYER,
    pairToken: QUOTE,
    graduationThreshold: "1000",
    poolFee: 0,
    tickSpacing: 200,
    creatorTaxBps: 100,
    buybackEnabled: true,
    phase: 0,
    sweptQuote: "0",
    sweptTokens: "0",
    sweptAt: 0,
    exists: true,
    ...overrides,
  };
}

function eventLog(name, values, overrides = {}) {
  const encoded = iface.encodeEventLog(iface.getEvent(name), values);
  return {
    address: ADDR.PONS_FACTORY,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 100,
    transactionIndex: 2,
    index: 7,
    transactionHash: TX_HASH,
    ...overrides,
  };
}

test("classifies only a non-empty matching launch record as Pons V2", () => {
  assert.deepEqual(classifyPonsRecord(TOKEN, record()), {
    identity: "pons-v2",
    protocolPhase: "not_graduated",
  });
  assert.deepEqual(classifyPonsRecord(TOKEN, record({
    token: ZeroAddress,
    curve: ZeroAddress,
    deployer: ZeroAddress,
    exists: false,
  })), {
    identity: "not_pons",
    protocolPhase: "not_applicable",
  });
});

test("rejects mismatched or structurally invalid launch records", () => {
  assert.throws(() => classifyPonsRecord(TOKEN, record({
    token: "0x5555555555555555555555555555555555555555",
  })), /token identity mismatch/);
  assert.throws(() => classifyPonsRecord(TOKEN, record({ curve: ZeroAddress })), /curve is zero/);
  assert.throws(() => classifyPonsRecord(TOKEN, record({ deployer: ZeroAddress })), /deployer is zero/);
  assert.throws(() => classifyPonsRecord(TOKEN, record(), {
    curve: CURVE,
    deployer: DEPLOYER,
    pairToken: ZeroAddress,
  }), /pairToken mismatch/);
});

test("maps all factory phases and rejects unknown values", () => {
  assert.equal(classifyPonsRecord(TOKEN, record({ phase: 0 })).protocolPhase, "not_graduated");
  assert.equal(classifyPonsRecord(TOKEN, record({ phase: 1 })).protocolPhase, "swept");
  assert.equal(classifyPonsRecord(TOKEN, record({ phase: 2 })).protocolPhase, "pool_created");
  assert.equal(classifyPonsRecord(TOKEN, record({ phase: 3 })).protocolPhase, "rescued");
  assert.throws(() => classifyPonsRecord(TOKEN, record({ phase: 4 })), /unknown Pons phase/);
});

test("parses a TokenLaunched log with a stable event id", () => {
  const parsed = parsePonsFactoryLog(eventLog("TokenLaunched", [
    TOKEN, CURVE, DEPLOYER, QUOTE, 4n, 1000n,
  ]));
  assert.equal(parsed.kind, "token_launched");
  assert.equal(parsed.eventId, `${CHAIN.id}:${TX_HASH}:7`);
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.args.curve, CURVE);
  assert.equal(parsed.args.deployer, DEPLOYER);
  assert.equal(parsed.args.pairToken, QUOTE);
  assert.equal(parsed.args.launchConfigId, "4");
});

test("scans all factory event types in canonical chain order", async () => {
  const logs = [
    eventLog("PoolGraduated", [TOKEN, 9n, 50n, 25n], { blockNumber: 102, transactionIndex: 0, index: 1 }),
    eventLog("LaunchSwept", [TOKEN, 25n, 75n], { blockNumber: 101, transactionIndex: 3, index: 4 }),
    eventLog("GraduationTokensPermanentlyLocked", [TOKEN, 10n], { blockNumber: 102, transactionIndex: 0, index: 0 }),
  ];
  let filter;
  const events = await scanPonsRange({}, 100, 102, {
    getLogs: async (input) => {
      filter = input;
      return logs;
    },
  });
  assert.equal(filter.address, ADDR.PONS_FACTORY);
  assert.equal(filter.fromBlock, 100);
  assert.equal(filter.toBlock, 102);
  assert.deepEqual(events.map((event) => event.kind), [
    "launch_swept",
    "tokens_locked",
    "pool_graduated",
  ]);
});

test("computes a V4 pool id with sorted currencies and the pinned hook", () => {
  const currency0 = TOKEN.toLowerCase() < QUOTE.toLowerCase() ? TOKEN : QUOTE;
  const currency1 = currency0 === TOKEN ? QUOTE : TOKEN;
  const expected = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [currency0, currency1, 0, 200, ADDR.PONS_HOOK]
  ));
  assert.equal(computePonsPoolId(record()), expected);
});

test("verifies bytecode and factory deployment links", async () => {
  const checked = [];
  const provider = {
    async getCode(address) {
      checked.push(address);
      return "0x6000";
    },
  };
  const result = await verifyPonsDeployment(provider, ADDR, {
    readFactoryLinks: async () => ({
      memeHook: ADDR.PONS_HOOK,
      locker: ADDR.PONS_LOCKER,
      graduationExecutor: ADDR.PONS_EXECUTOR,
    }),
  });
  assert.equal(result.ok, true);
  assert.ok(checked.includes(ADDR.PONS_FACTORY));
  assert.ok(checked.includes(ADDR.PONS_ROUTER));
  assert.ok(checked.includes(ADDR.PONS_HOOK));
});

test("fails deployment verification for missing code or mismatched getters", async () => {
  await assert.rejects(() => verifyPonsDeployment({
    getCode: async (address) => address === ADDR.PONS_LOCKER ? "0x" : "0x6000",
  }, ADDR, {
    readFactoryLinks: async () => ({
      memeHook: ADDR.PONS_HOOK,
      locker: ADDR.PONS_LOCKER,
      graduationExecutor: ADDR.PONS_EXECUTOR,
    }),
  }), /PONS_LOCKER.*has no bytecode/);

  await assert.rejects(() => verifyPonsDeployment({ getCode: async () => "0x6000" }, ADDR, {
    readFactoryLinks: async () => ({
      memeHook: ZeroAddress,
      locker: ADDR.PONS_LOCKER,
      graduationExecutor: ADDR.PONS_EXECUTOR,
    }),
  }), /memeHook.*expected.*actual/);
});

test("normalizes getLaunchedToken output and preserves RPC errors as failures", async () => {
  const raw = [
    TOKEN, CURVE, DEPLOYER, DEPLOYER, QUOTE, 1000n, 0n, 200n, 100n,
    true, 2n, 25n, 75n, 1234n, true,
  ];
  Object.assign(raw, {
    token: raw[0], curve: raw[1], deployer: raw[2], creatorFeeRecipient: raw[3], pairToken: raw[4],
    graduationThreshold: raw[5], poolFee: raw[6], tickSpacing: raw[7], creatorTaxBps: raw[8],
    buybackEnabled: raw[9], phase: raw[10], sweptQuote: raw[11], sweptTokens: raw[12],
    sweptAt: raw[13], exists: raw[14],
  });
  const normalized = await readPonsLaunch({}, TOKEN, {
    contractFactory: () => ({ getLaunchedToken: async () => raw }),
  });
  assert.equal(normalized.phase, 2);
  assert.equal(normalized.graduationThreshold, "1000");
  assert.equal(typeof normalized.sweptQuote, "string");

  await assert.rejects(() => readPonsLaunch({}, TOKEN, {
    contractFactory: () => ({ getLaunchedToken: async () => { throw new Error("rate limited"); } }),
  }), /Pons launch read failed.*rate limited/);
});

test("reconcile uses the factory record as authoritative state", async () => {
  const result = await reconcilePonsToken({}, TOKEN, {
    readLaunch: async () => record({ phase: 3 }),
  });
  assert.equal(result.identity, "pons-v2");
  assert.equal(result.protocolPhase, "rescued");
  assert.equal(result.record.token, TOKEN);
});
