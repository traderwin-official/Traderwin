/**
 * Supabase persistence/permission adapters for the portfolio coordinator.
 * Pass a server-only Supabase client created with the service-role key.
 * Never import this module into browser code.
 */
export function createSupabasePortfolioAdapters(db, external = {}) {
  if (!db || typeof db.from !== "function" || typeof db.rpc !== "function") {
    throw new TypeError("A server-side Supabase client is required.");
  }
  return {
    async loadState(scope) {
      const { data, error } = await db.from("portfolio_profit_protection_state")
        .select("peak_unrealized_profit_usd,included_position_ids,position_peak_state,membership_version,state_version")
        .eq("user_id", scope.userId).eq("account_mode", scope.accountMode)
        .eq("broker", scope.broker).eq("broker_account_ref", scope.accountRef).maybeSingle();
      if (error) throw new Error("Could not load portfolio protection state.");
      if (!data) return { peakProfitUsd: 0, includedPositionIds: [], positionPeakState: {}, membershipVersion: 0, stateVersion: 0 };
      return {
        peakProfitUsd: Number(data.peak_unrealized_profit_usd),
        includedPositionIds: data.included_position_ids,
        positionPeakState: data.position_peak_state || {},
        membershipVersion: Number(data.membership_version),
        stateVersion: Number(data.state_version)
      };
    },
    async loadPermissions(scope) {
      const { data, error } = await db.from("portfolio_trade_permissions")
        .select("manual_trade_management,bot_trade_management,close_managed_positions")
        .eq("user_id", scope.userId).eq("account_mode", scope.accountMode)
        .eq("broker", scope.broker).eq("broker_account_ref", scope.accountRef).maybeSingle();
      if (error) throw new Error("Could not load portfolio permissions.");
      return {
        manageManualTrades: data?.manual_trade_management === true,
        manageBotTrades: data?.bot_trade_management === true,
        closeManagedPositions: data?.close_managed_positions === true
      };
    },
    async saveState(scope, state, expectedStateVersion) {
      const { data, error } = await db.rpc("save_portfolio_profit_protection_state_v2", {
        p_user_id: scope.userId, p_account_mode: scope.accountMode, p_broker: scope.broker,
        p_broker_account_ref: scope.accountRef, p_peak_profit_usd: state.peakProfitUsd,
        p_current_profit_usd: state.currentProfitUsd, p_protected_floor_usd: state.protectedFloorUsd,
        p_trailing_active: state.trailingActive, p_included_position_ids: state.includedPositionIds,
        p_position_peak_state: state.positionPeakState,
        p_membership_version: state.membershipVersion, p_state_version: state.stateVersion,
        p_expected_state_version: expectedStateVersion, p_last_valuation_at: state.lastValuationAt,
        p_quote_source: state.quoteSource, p_quote_as_of: state.quoteAsOf
      });
      if (error) throw new Error("Could not persist portfolio protection state.");
      return { saved: data === true };
    },
    async isRealExecutionAuthorized(scope) {
      if (scope.accountMode !== "REAL") return false;
      const { data, error } = await db.from("real_execution_authorizations")
        .select("status,authorized_at,broker_verified_at,risk_acknowledged_at")
        .eq("user_id", scope.userId).maybeSingle();
      if (error) throw new Error("Could not verify REAL execution authorization.");
      return data?.status === "AUTHORIZED" && Boolean(data.authorized_at && data.broker_verified_at && data.risk_acknowledged_at);
    },
    loadSnapshot: external.loadSnapshot,
    closePosition: external.closePosition
  };
}
