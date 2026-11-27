import test from "node:test";
import assert from "node:assert/strict";
import {
  assertIsolatedSupabaseProject,
  PRODUCTION_SUPABASE_PROJECT_REF
} from "../lib/supabase-project-guard.js";

const isolatedRef = "abcdefghijklmnopqrst";

test("accepts only the explicitly expected isolated Supabase project", () => {
  assert.equal(assertIsolatedSupabaseProject({
    url: `https://${isolatedRef}.supabase.co`,
    expectedProjectRef: isolatedRef
  }), isolatedRef);
});

test("rejects a missing or malformed expected project ref", () => {
  assert.throws(() => assertIsolatedSupabaseProject({
    url: `https://${isolatedRef}.supabase.co`
  }), /SUPABASE_EXPECTED_PROJECT_REF/);
  assert.throws(() => assertIsolatedSupabaseProject({
    url: `https://${isolatedRef}.supabase.co`,
    expectedProjectRef: "not-a-project-ref"
  }), /SUPABASE_EXPECTED_PROJECT_REF/);
});

test("rejects a URL that does not match the explicitly expected project", () => {
  assert.throws(() => assertIsolatedSupabaseProject({
    url: "https://zyxwvutsrqponmlkjihg.supabase.co",
    expectedProjectRef: isolatedRef
  }), /does not match/);
});

test("always rejects the known production project, even if it is configured as expected", () => {
  assert.throws(() => assertIsolatedSupabaseProject({
    url: `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`,
    expectedProjectRef: PRODUCTION_SUPABASE_PROJECT_REF
  }), /protected production/);
});

test("rejects non-HTTPS, non-Supabase, and credential-bearing URLs", () => {
  for (const url of [
    `http://${isolatedRef}.supabase.co`,
    "https://example.com",
    `https://user:pass@${isolatedRef}.supabase.co`
  ]) {
    assert.throws(() => assertIsolatedSupabaseProject({
      url,
      expectedProjectRef: isolatedRef
    }));
  }
});
