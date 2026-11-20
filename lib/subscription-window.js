// Fail-closed subscription window evaluation. A paid status alone is not enough:
 // both the start and end timestamps must be valid and the current time in range.
export function evaluateSubscriptionWindow({ status, startsAt, endsAt, now = Date.now() } = {}) {
  if (!Number.isFinite(now)) return { active: false, status: "INVALID_CURRENT_TIME" };
  if (status !== "ACTIVE") {
    return { active: false, status: typeof status === "string" && status ? status : "NOT_PURCHASED" };
  }

  const start = typeof startsAt === "string" ? Date.parse(startsAt) : NaN;
  const end = typeof endsAt === "string" ? Date.parse(endsAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { active: false, status: "INVALID_SUBSCRIPTION_DATES" };
  }
  if (start > now) return { active: false, status: "NOT_YET_ACTIVE" };
  if (end <= now) return { active: false, status: "EXPIRED" };
  return { active: true, status: "ACTIVE" };
}
