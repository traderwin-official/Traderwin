/**
 * Reject out-of-order market ticks per instrument.
 * Deriv epochs have second precision, so multiple updates within the same
 * second remain valid; only strictly older epochs are discarded.
 */
export function acceptMonotonicMarketTick({instrument,epoch,latestByInstrument}={}) {
 if(typeof instrument!=="string"||!instrument.trim())throw new TypeError("A market instrument is required.");
 if(!(latestByInstrument instanceof Map))throw new TypeError("A per-instrument latest-epoch map is required.");
 const timestamp=Number(epoch);
 if(!Number.isFinite(timestamp)||timestamp<=0)return false;
 const key=instrument.trim().toUpperCase();
 const previous=latestByInstrument.get(key);
 if(Number.isFinite(previous)&&timestamp<previous)return false;
 latestByInstrument.set(key,Math.max(Number.isFinite(previous)?previous:0,timestamp));
 return true;
}
