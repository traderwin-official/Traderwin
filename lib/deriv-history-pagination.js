/**
 * Decide whether a Deriv history page is full enough to request an older page.
 * Use the raw response count, not the filtered candle count: filtering the
 * currently forming candle (or a malformed row) must not truncate pagination.
 */
export function shouldFetchOlderHistory({receivedCount,pageSize,oldestEpoch,fromEpoch,previousOldestEpoch=Infinity}) {
  if (!Number.isInteger(receivedCount) || receivedCount < 0 ||
      !Number.isInteger(pageSize) || pageSize < 1 ||
      !Number.isFinite(oldestEpoch) || !Number.isFinite(fromEpoch) ||
      !(Number.isFinite(previousOldestEpoch) || previousOldestEpoch === Infinity)) {
    throw new TypeError("Invalid Deriv history pagination state.");
  }
  return receivedCount >= pageSize &&
    oldestEpoch > fromEpoch &&
    oldestEpoch < previousOldestEpoch;
}
