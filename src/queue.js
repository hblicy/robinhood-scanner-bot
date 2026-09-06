export class CandidateQueue {
  constructor({ maxSize, hasSeen, keyOf = (event) => String(event?.token || "").toLowerCase() }) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) throw new Error("maxSize must be positive");
    this.maxSize = maxSize;
    this.hasSeen = hasSeen;
    this.keyOf = keyOf;
    this.items = [];
    this.inFlight = new Set();
    this.pending = new Set();
  }

  get size() {
    return this.items.length;
  }

  get isFull() {
    return this.items.length >= this.maxSize;
  }

  enqueue(event) {
    const key = this.keyOf(event);
    if (!key || this.hasSeen(key) || this.pending.has(key) || this.inFlight.has(key)) return false;
    if (this.items.length >= this.maxSize) return false;
    this.pending.add(key);
    this.items.push(event);
    return true;
  }

  take() {
    const event = this.items.shift() || null;
    if (!event) return null;
    const key = this.keyOf(event);
    this.pending.delete(key);
    this.inFlight.add(key);
    return event;
  }

  finish(eventOrKey) {
    const key = typeof eventOrKey === "object"
      ? this.keyOf(eventOrKey)
      : String(eventOrKey || "").toLowerCase();
    this.inFlight.delete(key);
  }
}
