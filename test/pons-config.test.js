import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ADDR, QUOTE_ADDRESSES, SETTINGS } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Pons V2 deployment addresses are explicit", () => {
  assert.equal(ADDR.PONS_FACTORY, "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  assert.equal(ADDR.PONS_ROUTER, "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948");
  assert.equal(ADDR.PONS_HOOK, "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044");
  assert.equal(ADDR.PONS_LOCKER, "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952");
  assert.equal(ADDR.PONS_EXECUTOR, "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046");
});

test("Pons lifecycle defaults are bounded and deterministic", () => {
  assert.equal(SETTINGS.lineAMaxAgeMinutes, 20);
  assert.equal(SETTINGS.lineAIgnoreSeconds, 10);
  assert.equal(SETTINGS.minFlowTrades, 5);
  assert.equal(SETTINGS.minFlowUniqueTraders, 3);
  assert.equal(SETTINGS.maxSingleTraderPct, 80);
  assert.equal(SETTINGS.maxDeployerLaunches24h, 20);
  assert.equal(SETTINGS.highHeatLaunches24h, 20_000);
  assert.equal(SETTINGS.watchlistCapNormal, 3);
  assert.equal(SETTINGS.watchlistCapHighHeat, 1);
  assert.equal(SETTINGS.curveDeadGraceMs, 14_400_000);
  assert.equal(SETTINGS.dexPaprikaScan, true);
});

test("resolved quote allowlist stores addresses rather than display symbols", () => {
  assert.ok([...QUOTE_ADDRESSES].every((value) => /^0x[0-9a-f]{40}$/.test(value)));
  assert.ok(QUOTE_ADDRESSES.has(ADDR.WETH.toLowerCase()));
  assert.ok(QUOTE_ADDRESSES.has(ADDR.ZERO.toLowerCase()));
});

test("QUOTE_TOKENS accepts a verified address and rejects an unknown symbol", () => {
  const verifiedAddress = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
  const accepted = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./src/config.js').then(m => console.log([...m.QUOTE_ADDRESSES]))"],
    {
      cwd: root,
      env: { ...process.env, QUOTE_TOKENS: `WETH,ETH,USDG,${verifiedAddress}` },
      encoding: "utf8",
    }
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout.toLowerCase(), new RegExp(verifiedAddress));

  const rejected = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./src/config.js')"],
    {
      cwd: root,
      env: { ...process.env, QUOTE_TOKENS: "WETH,ETH,USDG,NVDA_FAKE" },
      encoding: "utf8",
    }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /QUOTE_TOKENS contains an unknown symbol/);
});
