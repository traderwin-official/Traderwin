export const PRODUCTION_SUPABASE_PROJECT_REF = "whcmrzdvaiqfmgvlfqxo";

export function assertIsolatedSupabaseProject({
  url,
  expectedProjectRef,
  forbiddenProjectRefs = [PRODUCTION_SUPABASE_PROJECT_REF]
}) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("SUPABASE_URL is required for the isolated DEMO worker.");
  }
  if (typeof expectedProjectRef !== "string" || !/^[a-z0-9]{20}$/.test(expectedProjectRef)) {
    throw new Error("SUPABASE_EXPECTED_PROJECT_REF must be the exact 20-character Supabase project ref.");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTPS Supabase project URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new Error("SUPABASE_URL must be a plain HTTPS Supabase project URL.");
  }

  const match = parsed.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (!match) {
    throw new Error("SUPABASE_URL must use the standard <project-ref>.supabase.co hostname.");
  }

  const actualProjectRef = match[1];
  const forbidden = new Set(forbiddenProjectRefs);
  if (forbidden.has(actualProjectRef)) {
    throw new Error("Refusing to start DEMO worker against a protected production Supabase project.");
  }
  if (actualProjectRef !== expectedProjectRef) {
    throw new Error("SUPABASE_URL does not match SUPABASE_EXPECTED_PROJECT_REF.");
  }
  return actualProjectRef;
}
