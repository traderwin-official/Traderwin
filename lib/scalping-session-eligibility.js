export function scalpingSessionPermissions({session, preference, profile, hasOpenTrade = false}) {
  const config = session?.config_snapshot && typeof session.config_snapshot === "object"
    ? session.config_snapshot
    : {};
  const entryEnabled = session?.broker === "DERIV" &&
    Boolean(session?.instrument) &&
    session?.status === "RUNNING" &&
    config.account_mode === "DEMO" &&
    preference?.enabled === true &&
    preference?.paper_execution_enabled === true &&
    preference?.account_mode === "DEMO" &&
    profile?.account_mode === "DEMO" &&
    preference?.execution === "WEBSITE_PAPER_ONLY";
  const manageOpen = hasOpenTrade === true;
  return {entryEnabled, manageOpen, include: entryEnabled || manageOpen};
}
