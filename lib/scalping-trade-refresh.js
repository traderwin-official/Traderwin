/**
 * Apply an authoritative open-position snapshot without allowing an older
 * in-flight read to overwrite state changed by a later exit operation.
 */
export function applyOpenTradeSnapshot({trades=[],activeTrades,locks,pendingRefresh,snapshotGeneration=Number.MAX_SAFE_INTEGER,onRemoved=()=>{}}={}) {
 if(!activeTrades||!locks||!pendingRefresh)throw new TypeError("Trade reconciliation maps and sets are required.");
 const seen=new Set();
 for(const trade of Array.isArray(trades)?trades:[]){
  const id=trade?.id;
  if(id===undefined||id===null)continue;
  seen.add(id);
  if(locks.has(id))continue;
  const requiredGeneration=pendingRefresh.get(id);
  if(requiredGeneration!==undefined&&snapshotGeneration<requiredGeneration)continue;
  activeTrades.set(id,trade);
  pendingRefresh.delete(id);
 }
 for(const id of activeTrades.keys()){
  if(seen.has(id)||locks.has(id))continue;
  const requiredGeneration=pendingRefresh.get(id);
  if(requiredGeneration!==undefined&&snapshotGeneration<requiredGeneration)continue;
  activeTrades.delete(id);
  pendingRefresh.delete(id);
  onRemoved(id);
 }
 // Also clear quarantined IDs whose row is absent from this sufficiently new
 // OPEN snapshot: the durable ledger confirms that those positions have closed.
 for(const [id,requiredGeneration] of [...pendingRefresh.entries()]){
  if(snapshotGeneration<requiredGeneration||locks.has(id))continue;
  if(!seen.has(id)){
   pendingRefresh.delete(id);
   activeTrades.delete(id);
   onRemoved(id);
  }
 }
 return {open:seen.size,pending:pendingRefresh.size};
}


/**
 * Remove an uncertain position from local management until a DB snapshot
 * started after this failure confirms whether it remains OPEN.
 */
export function quarantineTradeForRefresh({tradeId,activeTrades,pendingRefresh,snapshotGeneration=0,onRemoved=()=>{}}={}) {
 if(tradeId===undefined||tradeId===null)throw new TypeError("A trade ID is required.");
 if(!activeTrades||!pendingRefresh)throw new TypeError("Trade reconciliation maps are required.");
 const requiredGeneration=(Number.isSafeInteger(snapshotGeneration)&&snapshotGeneration>=0?snapshotGeneration:0)+1;
 pendingRefresh.set(tradeId,requiredGeneration);
 activeTrades.delete(tradeId);
 onRemoved(tradeId);
 return requiredGeneration;
}
