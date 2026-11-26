// Single Vercel function dispatching the existing API routes.
// Individual handlers live outside /api so Vercel deploys only this entry point.
import h0 from "../handlers/admin/bot-license-fulfill.js";
import h1 from "../handlers/admin/instruments.js";
import h2 from "../handlers/analysis/market.js";
import h3 from "../handlers/analysis/strategy.js";
import h4 from "../handlers/bot-license/activate.js";
import h5 from "../handlers/bot-shop-status.js";
import h6 from "../handlers/bot-shop.js";
import h7 from "../handlers/bots/demo/close.js";
import h8 from "../handlers/bots/demo/control.js";
import h9 from "../handlers/bots/demo/mark.js";
import h10 from "../handlers/bots/demo/portfolio-permissions.js";
import h11 from "../handlers/bots/demo/trade.js";
import h12 from "../handlers/bots/emergency/control.js";
import h13 from "../handlers/callback.js";
import h14 from "../handlers/cron/bot-license-delivery.js";
import h15 from "../handlers/cron/demo-auto-worker.js";
import h16 from "../handlers/demo/sessions.js";
import h17 from "../handlers/deriv/account-snapshot.js";
import h18 from "../handlers/deriv/accounts.js";
import h19 from "../handlers/deriv/active-symbols.js";
import h20 from "../handlers/deriv/callback.js";
import h21 from "../handlers/deriv/disconnect.js";
import h22 from "../handlers/deriv/proposal.js";
import h23 from "../handlers/deriv/select-account.js";
import h24 from "../handlers/deriv/start.js";
import h25 from "../handlers/deriv/status.js";
import h26 from "../handlers/payments/mpesa/bot-shop-callback.js";
import h27 from "../handlers/payments/mpesa/callback.js";
import h28 from "../handlers/payments/mpesa/status.js";
import h29 from "../handlers/payments/mpesa/stk-push.js";
import h30 from "../handlers/subscriptions/status.js";
import h31 from "../handlers/bots/demo/history.js";
import h32 from "../handlers/bots/demo/positions.js";
import h33 from "../handlers/bots/demo/pending-batches.js";
import h34 from "../handlers/bots/demo/scalping-feed.js";
import h35 from "../handlers/bots/demo/scalping-preferences.js";

const ROUTES = {
  "/api/admin/bot-license-fulfill": h0,
  "/api/admin/instruments": h1,
  "/api/analysis/market": h2,
  "/api/analysis/strategy": h3,
  "/api/bot-license/activate": h4,
  "/api/bot-shop-status": h5,
  "/api/bot-shop": h6,
  "/api/bots/demo/close": h7,
  "/api/bots/demo/history": h31,
  "/api/bots/demo/positions": h32,
  "/api/bots/demo/pending-batches": h33,
  "/api/bots/demo/scalping-feed": h34,
  "/api/bots/demo/scalping-preferences": h35,
  "/api/bots/demo/control": h8,
  "/api/bots/demo/mark": h9,
  "/api/bots/demo/portfolio-permissions": h10,
  "/api/bots/demo/trade": h11,
  "/api/bots/emergency/control": h12,
  "/api/callback": h13,
  "/api/cron/bot-license-delivery": h14,
  "/api/cron/demo-auto-worker": h15,
  "/api/demo/sessions": h16,
  "/api/deriv/account-snapshot": h17,
  "/api/deriv/accounts": h18,
  "/api/deriv/active-symbols": h19,
  "/api/deriv/callback": h20,
  "/api/deriv/disconnect": h21,
  "/api/deriv/proposal": h22,
  "/api/deriv/select-account": h23,
  "/api/deriv/start": h24,
  "/api/deriv/status": h25,
  "/api/payments/mpesa/bot-shop-callback": h26,
  "/api/payments/mpesa/callback": h27,
  "/api/payments/mpesa/status": h28,
  "/api/payments/mpesa/stk-push": h29,
  "/api/subscriptions/status": h30
};

export default async function handler(req, res) {
  const routeParam = req.query?.__vercel_route;
  const routePath = Array.isArray(routeParam) ? routeParam.join("/") : String(routeParam || "");
  const pathname = routePath ? "/api/" + routePath.split("/").filter(Boolean).join("/") : "";
  const route = ROUTES[pathname];
  if (!route) return res.status(404).json({ error: "API route not found." });
  return route(req, res);
}
