const IDENTITY_STATUSES = new Set(["verified", "disabled-unverified"]);
const SECURITY_CAPABILITIES = new Set(["supported", "discovery-only", "unsupported"]);

function requiredString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function validateVenueEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("venue entry must be an object");
  }
  const entry = {
    ...value,
    chain: requiredString("chain", value.chain).toLowerCase(),
    family: requiredString("family", value.family).toLowerCase(),
    id: requiredString("id", value.id),
  };
  if (!IDENTITY_STATUSES.has(entry.identityStatus)) {
    throw new Error(`invalid identityStatus for ${entry.id}`);
  }
  if (!SECURITY_CAPABILITIES.has(entry.securityCapability)) {
    throw new Error(`invalid securityCapability for ${entry.id}`);
  }
  if (!Array.isArray(entry.verifiedContracts)) {
    throw new Error(`verifiedContracts must be an array for ${entry.id}`);
  }
  if (entry.identityStatus === "verified" && entry.family === "evm"
    && entry.verifiedContracts.length === 0) {
    throw new Error(`verifiedContracts must not be empty for ${entry.id}`);
  }
  if (entry.identityStatus === "disabled-unverified") {
    requiredString("disabledReason", entry.disabledReason);
  }
  entry.verifiedContracts = Object.freeze([...entry.verifiedContracts]);
  return Object.freeze(entry);
}

export function createVenueRegistry(entries) {
  if (!Array.isArray(entries)) throw new Error("venue registry entries must be an array");
  const byId = new Map();
  for (const value of entries) {
    const entry = validateVenueEntry(value);
    if (byId.has(entry.id)) throw new Error(`duplicate venue ${entry.id}`);
    byId.set(entry.id, entry);
  }
  return Object.freeze({
    get(id) {
      return byId.get(id) ?? null;
    },
    list() {
      return Object.freeze([...byId.values()]);
    },
    route(id) {
      const entry = byId.get(id);
      if (!entry || entry.identityStatus === "disabled-unverified") {
        return { action: "skip", reason: "venue-disabled-unverified" };
      }
      if (entry.securityCapability !== "supported") {
        return { action: "record-only", reason: "venue-security-unsupported" };
      }
      return { action: "analyze", reason: null };
    },
  });
}
