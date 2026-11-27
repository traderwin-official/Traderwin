export function getDerivDisconnectScalpingPatch(now = new Date().toISOString()) {
  return {
    enabled: false,
    paper_execution_enabled: false,
    updated_at: now
  };
}
