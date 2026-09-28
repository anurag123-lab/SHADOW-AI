/**
 * Resets an admin's password using the service_role key.
 *
 * Supabase's own "forgot password" flow emails a reset link, which needs
 * working SMTP in the Auth settings — a different configuration from the
 * notifier's SMTP. When you are mid-setup and locked out, the admin API
 * is the direct route.
 *
 * This is an administrative action on real accounts, so it names the
 * account and prints what it did.
 *
 *   node reset-password.js                      list accounts
 *   node reset-password.js <email> <password>   set a new password
 */
require("dotenv").config();
const https = require("https");

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BASE || !KEY) {
  console.error("\n  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from notifier/.env\n");
  process.exit(1);
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      url,
      {
        method,
        headers: Object.assign(
          { apikey: KEY, Authorization: "Bearer " + KEY },
          payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
        ),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { /* non-JSON error body */ }
          if (res.statusCode >= 400) {
            return reject(new Error((parsed && (parsed.msg || parsed.message || parsed.error_description)) || `HTTP ${res.statusCode}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function list() {
  const { users } = await api("GET", "/auth/v1/admin/users?per_page=50");
  console.log("\n  Accounts in this project:\n");
  users.forEach((u) => {
    console.log("    " + u.email);
    console.log("      confirmed: " + (u.email_confirmed_at ? "yes" : "NO") +
                "   last sign-in: " + (u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "never"));
  });
  console.log("\n  Reset one:  node reset-password.js <email> <new-password>\n");
}

async function reset(email, password) {
  if (password.length < 6) {
    console.error("\n  Supabase requires at least 6 characters.\n");
    process.exit(1);
  }

  const { users } = await api("GET", "/auth/v1/admin/users?per_page=50");
  const user = users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  if (!user) {
    console.error(`\n  No account found for ${email}. Run without arguments to list them.\n`);
    process.exit(1);
  }

  await api("PUT", "/auth/v1/admin/users/" + user.id, {
    password: password,
    email_confirm: true,
  });

  console.log(`\n  Password updated for ${user.email}`);
  console.log(`  Sign in on the dashboard and in the extension with this password.\n`);
}

const [email, password] = process.argv.slice(2);
(email && password ? reset(email, password) : list()).catch((e) => {
  console.error("\n  failed:", e.message, "\n");
  process.exit(1);
});
