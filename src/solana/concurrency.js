export async function mapConcurrent(values, concurrency, worker) {
  if (!Array.isArray(values)) throw new Error("concurrent values must be an array");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (typeof worker !== "function") throw new Error("concurrent worker is required");
  const output = new Array(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}
