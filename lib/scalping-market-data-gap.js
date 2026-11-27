/**
 * Report a feed interruption without inventing executable prices.
 * The worker may manage an existing position from the first fresh bid/ask
 * after reconnect, but historical spot/OHLC cannot prove a missed bid/ask exit.
 */
export function detectMarketDataGap({instrument,previousEpoch,epoch,activePositionCount=0,thresholdSeconds=30}={}) {
 if(typeof instrument!=="string"||!instrument.trim())throw new TypeError("A market instrument is required.");
 const previous=Number(previousEpoch),current=Number(epoch),threshold=Number(thresholdSeconds);
 if(!Number.isFinite(previous)||previous<=0||!Number.isFinite(current)||current<=previous||
    !Number.isFinite(threshold)||threshold<0)return null;
 const gapSeconds=current-previous;
 if(gapSeconds<=threshold)return null;
 return {
  instrument:instrument.trim().toUpperCase(),
  gapSeconds,
  previousEpoch:previous,
  resumedEpoch:current,
  activePositionCount:Number.isInteger(activePositionCount)&&activePositionCount>0?activePositionCount:0,
  executableHistoryAvailable:false,
  requiresManualReview:Number.isInteger(activePositionCount)&&activePositionCount>0
 };
}
