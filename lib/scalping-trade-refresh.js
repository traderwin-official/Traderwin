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
