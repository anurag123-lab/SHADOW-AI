/**
 * Generates dashboard/_index-stub.html from the real index.html.
 *
 * The only change is that the Supabase CDN <script> is swapped for a stub
 * that builds a fake client from the page's OWN query string. Everything
 * else — the markup, assets/config.js, assets/auth.js — is the real thing.
 *
 * Why a generated file rather than an iframe trick: the login page reads
 * `window.location.search` to detect ?logout, and neither srcdoc nor
 * document.write can give an iframe a genuine query string (document.open
 * resets the document URL to the parent's). A real page at a real URL is
 * the only way to test that branch honestly.
 *
 * Run: node scripts/build-auth-test.js   (the test harness assumes it ran)
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "dashboard");
const SRC = path.join(DIR, "index.html");
const OUT = path.join(DIR, "_index-stub.html");

const CDN_TAG =
  '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>';

const STUB = `<script>
  /* Test stub — configured by this page's own query string.
     ?session=1   a cached session exists
     ?profile=1   that account has an admin workspace
     ?logout      exercises the sign-out branch (read by auth.js itself) */
  (function () {
    var q = new URLSearchParams(window.location.search);
    var session = q.has("session") ? { user: { email: q.get("email") || "admin@acme.com" } } : null;
    var profile = q.has("profile") ? { company_id: "c-123" } : null;

    window.__testState = { signedOut: false, redirected: null };

    window.supabase = {
      createClient: function () {
        return {
          auth: {
            getSession: async function () {
              return { data: { session: window.__testState.signedOut ? null : session } };
            },
            signOut: async function () { window.__testState.signedOut = true; return {}; },
            signInWithPassword: async function () { return { data: { session: session }, error: null }; },
            signUp: async function () { return { data: { session: session }, error: null }; },
            signInWithOAuth: async function () { return { error: null }; },
          },
          from: function () {
            return { select: function () { return { maybeSingle: async function () {
              return { data: profile, error: null };
            } }; } };
          },
          rpc: async function () { return { data: null, error: null }; },
        };
      },
    };
  })();
</script>`;

const html = fs.readFileSync(SRC, "utf8");

if (!html.includes(CDN_TAG)) {
  console.error("\n  Could not find the Supabase CDN tag in index.html.");
  console.error("  It was probably upgraded — update CDN_TAG in this script.\n");
  process.exit(1);
}

fs.writeFileSync(OUT, html.replace(CDN_TAG, STUB));
console.log("  wrote dashboard/_index-stub.html (from index.html)");
