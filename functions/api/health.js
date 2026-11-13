export async function onRequestGet() {
  return Response.json({
    ok: true,
    service: "traderwin-cloudflare-preview",
    runtime: "cloudflare-pages-functions",
    supabaseConnected: false,
    realTradingEnabled: false
  }, {
    headers: { "Cache-Control": "no-store" }
  });
}
