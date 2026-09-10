import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zeroPadValue } from "ethers";
import { readObservedSellReceipts } from "../src/security/evm/receipt-reader.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const VAULT = "0x3333333333333333333333333333333333333333";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("bounded observed-sell receipt reader", () => {
  it("reads only recent transfers into the bound liquidity addresses and caps receipt calls", async () => {
    const requests = [];
    const receiptHashes = [];
    const hashes = ["01", "02", "02", "03"].map((suffix) => `0x${suffix.padStart(64, "0")}`);
    const receipts = await readObservedSellReceipts({
      token: TOKEN,
      blockNumber: 100,
      analysisBlock: 1_000,
    }, {
      pool: POOL,
      vaults: [VAULT],
    }, {
      lookbackBlocks: 250,
      maxReceipts: 2,
      getLogs: async (request) => {
        requests.push(request);
        return hashes.map((transactionHash, index) => ({ transactionHash, blockNumber: 900 + index }));
      },
      getTransactionReceipt: async (transactionHash) => {
        receiptHashes.push(transactionHash);
        return { transactionHash, status: 1, logs: [] };
      },
    });

    assert.deepEqual(requests, [{
      address: TOKEN,
      topics: [TRANSFER, null, [zeroPadValue(POOL, 32), zeroPadValue(VAULT, 32)]],
      fromBlock: 751,
      toBlock: 1_000,
      chunk: 250,
      maxLogs: 500,
    }]);
    assert.deepEqual(receiptHashes, [hashes[3], hashes[1]]);
    assert.deepEqual(receipts.map(({ transactionHash }) => transactionHash), receiptHashes);
  });

  it("uses the candidate block when it is inside the bounded lookback", async () => {
    let request;
    await readObservedSellReceipts({ token: TOKEN, blockNumber: 980, analysisBlock: 1_000 }, { pool: POOL }, {
      getLogs: async (value) => { request = value; return []; },
      getTransactionReceipt: async () => { throw new Error("must not read receipts"); },
    });
    assert.equal(request.fromBlock, 980);
    assert.equal(request.toBlock, 1_000);
  });
});
