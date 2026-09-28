/* eslint-disable */
/**
 * Shadow AI Guard — Dashboard auth (login page)
 *
 * On first sign-up we call create_company_and_admin(), which creates the
 * company, makes this user its owner, seeds the 17 default policies, and
 * returns the join code employees will use. That RPC is idempotent, so
 * signing in again is harmless.
 */
(function () {
  "use strict";

  var CFG = window.SAG_CONFIG;
  var $ = function (id) { return document.getElementById(id); };

  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.indexOf("YOUR-PROJECT-REF") !== -1) {
    showAlert("Paste your Supabase URL and anon key into dashboard/assets/config.js first (setup step 4).");
    $("submitBtn").disabled = true;
    $("googleBtn").disabled = true;
  }

  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  window.sagClient = sb;

  var mode = "signin";

  /** The landing page (index.html) hosts this form in a hidden section. */
  function landing(hook, arg) {
    if (window.SAGLanding && window.SAGLanding[hook]) window.SAGLanding[hook](arg);
  }

  function showAlert(message, kind) {
    landing("openAuth");
    var box = $("alert");
    box.textContent = message;
    box.setAttribute("data-kind", kind || "error");
    box.hidden = false;
  }

  function setMode(next) {
    mode = next;
    $("tabSignIn").setAttribute("aria-selected", String(next === "signin"));
    $("tabSignUp").setAttribute("aria-selected", String(next === "signup"));
    $("companyField").hidden = next !== "signup";
    $("submitBtn").textContent = next === "signup" ? "Create account" : "Sign in";
    $("password").setAttribute("autocomplete", next === "signup" ? "new-password" : "current-password");
    $("alert").hidden = true;
  }

  $("tabSignIn").addEventListener("click", function () { setMode("signin"); });
  $("tabSignUp").addEventListener("click", function () { setMode("signup"); });

  /** Set when signed in but with no workspace yet — see enterWorkspaceSetup(). */
  var needsWorkspace = false;

  /**
   * Shown when the account is authenticated but has no admin_profiles row:
   * signup that half-completed, or an account that only exists as an
   * employee. Previously this case redirected to admin.html, which could
   * do nothing but display an error — a dead end with no way back.
   */
  function enterWorkspaceSetup(email) {
    needsWorkspace = true;
    setMode("signup");
    $("email").value = email || "";
    $("email").disabled = true;
    $("password").parentElement.hidden = true;
    $("submitBtn").textContent = "Create workspace";
    $("googleBtn").hidden = true;
    showAlert(
      "Signed in as " + (email || "this account") +
      ", but it has no workspace yet. Name your company to finish setup, or sign out to use a different account.",
      "ok"
    );
    showSignOutLink();
  }

  /** An escape hatch out of any signed-in state, on the login page itself. */
  function showSignOutLink() {
    if ($("signOutLink")) return;
    var link = document.createElement("button");
    link.id = "signOutLink";
    link.className = "btn btn-secondary btn-full";
    link.style.marginTop = "10px";
    link.textContent = "Sign out and use a different account";
    link.addEventListener("click", async function () {
      await sb.auth.signOut();
      window.location.href = "index.html";
    });
    $("submitBtn").insertAdjacentElement("afterend", link);
  }

  /**
   * Runs after ANY successful authentication (password or OAuth return).
   */
  async function completeLogin(companyName) {
    var profile = await sb.from("admin_profiles").select("company_id").maybeSingle();

    if (profile.data) {
      window.location.href = "admin.html";
      return true;
    }

    if (!companyName) {
      var session = await sb.auth.getSession();
      enterWorkspaceSetup(session.data.session && session.data.session.user.email);
      return false;
    }

    var created = await sb.rpc("create_company_and_admin", { p_company_name: companyName });
    if (created.error) {
      showAlert(created.error.message);
      return false;
    }

    window.location.href = "admin.html";
    return true;
  }

  $("submitBtn").addEventListener("click", async function () {
    var email = $("email").value.trim();
    var password = $("password").value;
    var company = $("companyName").value.trim();

    // Already authenticated, just missing a workspace — skip signUp,
    // which would fail with "User already registered".
    if (needsWorkspace) {
      if (!company) return showAlert("Enter your company name.");
      this.disabled = true;
      this.textContent = "Creating...";
      await completeLogin(company);
      this.disabled = false;
      this.textContent = "Create workspace";
      return;
    }

    if (!email || !password) return showAlert("Enter your email and password.");
    if (mode === "signup" && !company) return showAlert("Enter your company name.");

    this.disabled = true;
    var original = this.textContent;
    this.textContent = "Working...";

    try {
      var res =
        mode === "signup"
          ? await sb.auth.signUp({ email: email, password: password })
          : await sb.auth.signInWithPassword({ email: email, password: password });

      if (res.error) throw res.error;

      if (!res.data.session) {
        showAlert("Check your inbox to confirm your email, then sign in. (For demos, disable email confirmation in Supabase — setup step 3a.)", "ok");
        return;
      }

      await completeLogin(mode === "signup" ? company : null);
    } catch (e) {
      showAlert(e.message || "Sign-in failed.");
    } finally {
      this.disabled = false;
      this.textContent = original;
    }
  });

  $("googleBtn").addEventListener("click", async function () {
    // Strip any query/hash: Supabase appends its own, and a redirectTo
    // carrying "?logout" would sign the user straight back out on return.
    var redirectTo = window.location.origin + window.location.pathname;

    this.disabled = true;
    var res = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTo },
    });
    if (res.error) this.disabled = false;
    if (res.error) showAlert(res.error.message);
  });

  ["email", "password", "companyName"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("submitBtn").click();
    });
  });

  setMode("signin");

  /**
   * Resume an existing session — from an OAuth return, or because Supabase
   * cached one in localStorage from a previous visit.
   *
   * This deliberately checks for an admin profile BEFORE redirecting. The
   * earlier version redirected on session alone, which meant:
   *   - you could never reach the login form again without clearing site
   *     data, and
   *   - an account with no workspace landed on a dashboard that could only
   *     show an error, with no route back.
   */
  /** Signed in with a workspace: offer the dashboard, don't jump to it. */
  function showResumePanel(email) {
    $("loginForm").hidden = true;
    $("resumePanel").hidden = false;
    $("resumeEmail").textContent = email || "your account";
  }

  $("continueBtn").addEventListener("click", function () {
    window.location.href = "admin.html";
  });

  $("switchBtn").addEventListener("click", async function () {
    this.disabled = true;
    this.textContent = "Signing out...";
    await sb.auth.signOut();
    // Reload rather than just unhiding the form, so no stale state survives.
    window.location.href = window.location.pathname;
  });

  /**
   * Did this page load as the tail end of an OAuth round trip?
   *
   * Supabase returns either ?code=... (PKCE, the default) or a
   * #access_token=... fragment. Either way the person clicked "Continue
   * with Google" seconds ago and expects to land on the dashboard — so
   * this is the ONE case where continuing automatically is right. A
   * cached session from yesterday is not the same thing, and still gets
   * the explicit "Continue / Sign out" choice.
   */
  function isOAuthReturn() {
    var params = new URLSearchParams(window.location.search);
    var hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return params.has("code") || hash.has("access_token") ||
           params.has("error") || hash.has("error");
  }

  /** Surfaces a Google/Supabase error that came back in the URL. */
  function oauthErrorFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return params.get("error_description") || hash.get("error_description") ||
           params.get("error") || hash.get("error");
  }

  (async function resumeSession() {
    // ?logout signs out and shows the form, for scripted/demo resets.
    if (new URLSearchParams(window.location.search).has("logout")) {
      await sb.auth.signOut();
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    var oauthReturn = isOAuthReturn();

    if (oauthReturn) {
      var oauthError = oauthErrorFromUrl();
      if (oauthError) {
        window.history.replaceState({}, "", window.location.pathname);
        return showAlert(
          "Google sign-in failed: " + oauthError +
          ". Check that this URL is in Supabase's redirect list (setup step 3b)."
        );
      }
    }

    // supabase-js exchanges the code for a session on load, but that is
    // async — poll briefly rather than racing it.
    var session = null;
    for (var attempt = 0; attempt < (oauthReturn ? 20 : 1); attempt++) {
      var res = await sb.auth.getSession();
      session = res.data.session;
      if (session) break;
      await new Promise(function (r) { setTimeout(r, 150); });
    }

    if (!session) {
      if (oauthReturn) {
        showAlert("Google returned, but no session was created. Check the Supabase redirect URLs.");
      }
      return;   // no session: plain login form
    }

    var email = session.user && session.user.email;
    var profile = await sb.from("admin_profiles").select("company_id").maybeSingle();

    if (!profile.data) {
      return enterWorkspaceSetup(email);   // first login: name the company
    }

    if (oauthReturn) {
      window.location.href = "admin.html";  // they just signed in
      return;
    }

    showResumePanel(email);                 // returning visitor: ask first
  })();
})();
