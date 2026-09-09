import { PublicKey } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionTypes,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import { safeErrorMessage } from "../../safety.js";

const KNOWN_EXTENSIONS = new Set([
  "TransferFeeConfig", "TransferHook", "PermanentDelegate", "DefaultAccountState",
  "MetadataPointer", "TokenMetadata", "InterestBearingConfig", "NonTransferable",
  "MintCloseAuthority", "ConfidentialTransferMint", "ConfidentialTransferFeeConfig",
  "GroupPointer", "TokenGroup", "GroupMemberPointer", "TokenGroupMember",
]);

function extensionName(value) {
  return typeof value === "string" ? value : ExtensionType[value] ?? `Unknown(${value})`;
}

async function readMintFromChain(address, connection) {
  if (!connection?.getAccountInfo) throw new Error("Solana analysis connection is required");
  const publicKey = new PublicKey(address);
  const account = await connection.getAccountInfo(publicKey, "finalized");
  if (!account) throw new Error(`mint account not found: ${address}`);
  const owner = account.owner?.toBase58?.() ?? String(account.owner);
  const tokenProgram = owner === TOKEN_PROGRAM_ID.toBase58()
    ? TOKEN_PROGRAM_ID
    : owner === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID
      : null;
  if (!tokenProgram) throw new Error(`unsupported mint owner ${owner}`);
  const mint = unpackMint(publicKey, account, tokenProgram);
  const extensionTypes = getExtensionTypes(mint.tlvData).map(extensionName);
  const defaultState = getDefaultAccountState(mint);
  return {
    tokenProgram: tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "token-2022" : "spl-token",
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    extensionTypes,
    transferFee: getTransferFeeConfig(mint),
    transferHook: getTransferHook(mint),
    permanentDelegate: getPermanentDelegate(mint)?.delegate?.toBase58?.() ?? null,
    defaultFrozen: defaultState?.state === AccountState.Frozen,
  };
}

export async function inspectMintControls(address, dependencies = {}) {
  try {
    const mint = await (dependencies.readMint
      ? dependencies.readMint(address)
      : readMintFromChain(address, dependencies.connection));
    const extensionTypes = (mint.extensionTypes ?? []).map(extensionName);
    const unknown = extensionTypes.filter((name) => !KNOWN_EXTENSIONS.has(name));
    const redFlags = [];
    if (mint.mintAuthority) redFlags.push("active-mint-authority");
    if (mint.freezeAuthority) redFlags.push("active-freeze-authority");
    if (mint.transferFee) redFlags.push("transfer-fee");
    if (mint.transferHook) redFlags.push("transfer-hook");
    if (mint.permanentDelegate) redFlags.push("permanent-delegate");
    if (mint.defaultFrozen) redFlags.push("default-frozen");
    if (extensionTypes.includes("NonTransferable")) redFlags.push("non-transferable");
    if (unknown.length) redFlags.push("unknown-token-extension");
    return {
      status: unknown.length ? "unknown" : "complete",
      tokenProgram: mint.tokenProgram,
      mintAuthority: mint.mintAuthority ?? null,
      freezeAuthority: mint.freezeAuthority ?? null,
      extensions: {
        transferFee: mint.transferFee ?? null,
        transferHook: mint.transferHook ?? null,
        permanentDelegate: mint.permanentDelegate ?? null,
        defaultFrozen: mint.defaultFrozen ?? null,
        types: extensionTypes,
      },
      redFlags,
      details: unknown.map((name) => `unknown extension ${name}`),
    };
  } catch (error) {
    return {
      status: "unknown",
      tokenProgram: null,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: { transferFee: null, transferHook: null, permanentDelegate: null, defaultFrozen: null, types: [] },
      redFlags: [],
      details: [`mint inspection unavailable: ${safeErrorMessage(error)}`],
    };
  }
}
