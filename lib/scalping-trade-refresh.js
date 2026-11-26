/**
 * Reconcile worker-local open positions against an authoritative DB snapshot.
 * Locked positions are left untouched; pending positions remain quarantined
 * until their manager releases its lock and a later successful read confirms
 * whether they remain open and which TP stages have committed.
 */
export function applyOpenTradeSnapshot({trades=[],activeTrades,locks,pendingRefresh,onRemoved=()=>{}}={}) {
 if(!activeTrades||!locks||!pendingRefresh)throw new TypeError("Trade reconciliation maps and sets are required.");
 const seen=new Set();
 for(const trade of Array.isArray(trades)?trades:[]){
  const id=trade?.id;
  if(id===undefined||id===null)continue;
  seen.add(id);
  if(locks.has(id))continue;
  activeTrades.set(id,trade);
  pendingRefresh.delete(id);
 }
 for(const id of activeTrades.keys()){
  if(seen.has(id)||locks.has(id))continue;
  activeTrades.delete(id);
  pendingRefresh.delete(id);
  onRemoved(id);
 }
 // A pending position absent from the authoritative OPEN snapshot is closed.
 for(const id of [...pendingRefresh]){
  if(!seen.has(id)&&!locks.has(id)){
   pendingRefresh.delete(id);
   activeTrades.delete(id);
   onRemoved(id);
  }
 }
 return {open:seen.size,pending:pendingRefresh.size};
}
