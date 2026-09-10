import { getAddress } from "ethers";

export async function verifyVenueDeployments(entryOrEntries, { getCode }) {
  if (typeof getCode !== "function") throw new Error("getCode must be a function");
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
  for (const entry of entries) {
    if (entry.identityStatus !== "verified" || entry.family !== "evm") continue;
    for (const rawAddress of entry.verifiedContracts) {
      const address = getAddress(rawAddress);
      const code = await getCode(address);
      if (typeof code !== "string" || /^0x0*$/i.test(code)) {
        throw new Error(
          `venue-contract-missing chain=${entry.chain} venue=${entry.id} address=${address}`
        );
      }
    }
  }
}
