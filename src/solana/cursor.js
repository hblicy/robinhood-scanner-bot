function requireCursor(cursor) {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new Error("Solana cursor must contain an object");
  }
  if (typeof cursor.signature !== "string" || cursor.signature.length === 0) {
    throw new Error("Solana cursor signature is required");
  }
  if (!Number.isInteger(cursor.slot) || cursor.slot < 0) {
    throw new Error("Solana cursor slot must be a non-negative integer");
  }
  if (cursor.finalized != null && typeof cursor.finalized !== "boolean") {
    throw new Error("Solana cursor finalized must be boolean");
  }
  if (!Number.isFinite(cursor.updatedAt) || cursor.updatedAt < 0) {
    throw new Error("Solana cursor updatedAt must be a non-negative timestamp");
  }
}

export function createSolanaCursorState(programs = {}) {
  if (!programs || typeof programs !== "object" || Array.isArray(programs)) {
    throw new Error("Solana program cursors must contain an object");
  }
  for (const cursor of Object.values(programs)) requireCursor(cursor);
  return { programs: structuredClone(programs) };
}

export function advanceProgramCursor(state, programId, nextCursor) {
  if (!state?.programs || typeof state.programs !== "object" || Array.isArray(state.programs)) {
    throw new Error("Solana cursor state is invalid");
  }
  if (typeof programId !== "string" || !programId) throw new Error("programId is required");
  requireCursor(nextCursor);
  const current = state.programs[programId];
  if (current && nextCursor.slot < current.slot) {
    throw new Error(`Solana cursor cannot move backwards from ${current.slot} to ${nextCursor.slot}`);
  }
  if (current && nextCursor.slot === current.slot && nextCursor.signature !== current.signature && !nextCursor.sameSlotApplied) {
    return structuredClone(state);
  }
  const { sameSlotApplied: _sameSlotApplied, ...persisted } = nextCursor;
  return {
    programs: {
      ...structuredClone(state.programs),
      [programId]: structuredClone(persisted),
    },
  };
}

export function planSignaturePage(page, anchor = null) {
  if (!Array.isArray(page)) throw new Error("signature page must be an array");
  const unseen = [];
  for (const entry of page) {
    if (!entry || typeof entry.signature !== "string" || !Number.isInteger(entry.slot)) {
      throw new Error("signature page entry is invalid");
    }
    if (anchor && entry.signature === anchor.signature && entry.slot === anchor.slot) break;
    if (!anchor || entry.slot >= anchor.slot) unseen.push(entry);
  }
  return unseen.reverse();
}
