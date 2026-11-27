/**
 * Prevent overlapping entry-analysis pipelines for the same instrument.
 * A slow calendar/reference check must not let several ticks race into
 * duplicate entry attempts. Other instruments and all exit managers remain
 * independent and continue processing while this instrument is gated.
 */
export async function runInstrumentEntryAnalysis({instrument,locks,analyse}={}) {
  if (typeof instrument !== "string" || !instrument.trim()) throw new TypeError("A valid instrument is required.");
  if (!locks || typeof locks.has !== "function" || typeof locks.add !== "function" || typeof locks.delete !== "function") {
    throw new TypeError("A shared instrument lock set is required.");
  }
  if (typeof analyse !== "function") throw new TypeError("An entry analysis callback is required.");
  const key=instrument.trim().toUpperCase();
  if (locks.has(key)) return {skipped:true,reason:"ENTRY_ANALYSIS_ALREADY_RUNNING"};
  locks.add(key);
  try {
    return {skipped:false,result:await analyse()};
  } finally {
    locks.delete(key);
  }
}
