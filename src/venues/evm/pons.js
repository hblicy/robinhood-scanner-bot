import {
  parsePonsFactoryLog,
  parsePonsHookLog,
  readPonsLaunch,
  scanPonsRange,
  verifyPonsDeployment,
} from "../../pons.js";

export function createPonsAdapter() {
  return Object.freeze({
    id: "pons-v2-robinhood",
    sourceKind: "launchpad",
    version: 1,
    parseFactoryLog: parsePonsFactoryLog,
    parseHookLog: parsePonsHookLog,
    readLaunch: readPonsLaunch,
    scanRange: scanPonsRange,
    verifyDeployment: verifyPonsDeployment,
  });
}
