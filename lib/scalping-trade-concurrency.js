/**
 * Run one exit/mark task per open position without coupling their locks.
 * A slow or failed position must not prevent sibling positions from progressing.
 */
export async function manageTradesIndependently({
  trades = [],
  locks,
  manage,
  onError = () => {}
} = {}) {
  if (!locks || typeof locks.has !== "function" ||
      typeof locks.add !== "function" || typeof locks.delete !== "function") {
    throw new TypeError("A shared per-position lock set is required.");
  }
  if (typeof manage !== "function") {
    throw new TypeError("A position management function is required.");
  }

  const eligible = [];
  const seen = new Set();
  for (const trade of Array.isArray(trades) ? trades : []) {
    const id = trade?.id;
    if ((typeof id !== "string" && typeof id !== "number") ||
        seen.has(id) || locks.has(id)) continue;
    seen.add(id);
    locks.add(id);
    eligible.push(trade);
  }

  const outcomes = await Promise.all(eligible.map(async trade => {
    try {
      await manage(trade);
      return true;
    } catch (error) {
      try { onError(error, trade); } catch {}
      return false;
    } finally {
      locks.delete(trade.id);
    }
  }));
  return outcomes.every(Boolean);
}
