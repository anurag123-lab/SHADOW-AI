/* eslint-disable */
/**
 * Shadow AI Guard — Extension Popup
 * =================================
 * A four-state machine: not configured -> signed out -> not enrolled -> active.
 * All real work happens in the service worker; this only sends messages.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var VIEWS = ["viewSetup", "viewSignIn", "viewEnroll", "viewActive"];

  /** Guards the self-heal below against looping if SET_CONNECTION fails. */
  var autoConnectTried = false;

  function showView(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
  }

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          return resolve({ ok: false, error: chrome.runtime.lastError.message });
        }
        resolve(response || { ok: false, error: "no response" });
      });
    });
  }

  var alertTimer = null;
  function notify(message, kind) {
    var box = $("alert");
    box.textContent = message;
    box.setAttribute("data-kind", kind || "error");
    box.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { box.hidden = true; }, 5000);
  }

  function busy(button, isBusy, label) {
    button.disabled = isBusy;
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = label || "Working...";
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  }

  function relativeTime(ts) {
    if (!ts) return "never";
    var secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 60) return secs + "s ago";
    if (secs < 3600) return Math.round(secs / 60) + "m ago";
    return Math.round(secs / 3600) + "h ago";
  }

  /* ================================================================ *
   * Render
   * ================================================================ */
  async function refresh() {
    var res = await send({ type: "GET_STATE" });
    if (!res.ok) {
      $("brandSub").textContent = "Background worker unavailable";
      notify(res.error || "Could not reach the extension's background worker.");
      return;
    }
    var state = res.data;

    var badge = $("statusBadge");

    if (!state.configured) {
      // The connection is compiled into config.js by `npm run sync-config`.
      // If the worker somehow hasn't picked it up — a stale override, a
      // storage read that failed, a half-written file — adopt it here
      // rather than making the employee paste a URL and a JWT by hand.
      // The manual form stays as the fallback for an unconfigured build.
      var compiled = window.ShadowAIConfig;
      if (compiled && compiled.isConfigured(compiled.SUPABASE_URL, compiled.SUPABASE_ANON_KEY) && !autoConnectTried) {
        autoConnectTried = true;
        console.log("[ShadowAI:popup] adopting compiled connection settings");
        var applied = await send({
          type: "SET_CONNECTION",
          url: compiled.SUPABASE_URL,
          anonKey: compiled.SUPABASE_ANON_KEY,
        });
        if (applied.ok) return refresh();
      }

      $("brandSub").textContent = "Not connected";
      badge.hidden = false;
      badge.textContent = "Setup";
      badge.setAttribute("data-state", "error");
      // Pre-fill so it is one click, not a copy-paste job.
      if (compiled) {
        if (!$("setupUrl").value) $("setupUrl").value = compiled.SUPABASE_URL || "";
        if (!$("setupKey").value) $("setupKey").value = compiled.SUPABASE_ANON_KEY || "";
      }
      return showView("viewSetup");
    }

    if (!state.signedIn) {
      $("brandSub").textContent = "Signed out";
      badge.hidden = false;
      badge.textContent = "Sign in";
      badge.setAttribute("data-state", "off");
      return showView("viewSignIn");
    }

    if (!state.enrolled) {
      $("brandSub").textContent = state.user ? state.user.email : "Signed in";
      badge.hidden = false;
      badge.textContent = "Join";
      badge.setAttribute("data-state", "off");
      return showView("viewEnroll");
    }

    // ---- active ----
    var identity = state.identity || {};
    $("brandSub").textContent = identity.companyName || "Connected";

    badge.hidden = false;
    badge.textContent = state.enabled ? "Active" : "Paused";
    badge.setAttribute("data-state", state.enabled ? "on" : "off");

    $("companyName").textContent = state.enabled
      ? "Protected on AI tools"
      : "Protection paused";
    $("anonId").textContent = identity.employeeHash || "";
    document.querySelector(".status-card").setAttribute("data-off", String(!state.enabled));

    $("statPolicies").textContent = state.policyCount;
    $("statTokens").textContent = state.honeytokenCount;
    $("statKeywords").textContent = state.keywordCount;

    $("enabledToggle").checked = !!state.enabled;
    $("toggleSub").textContent = state.enabled ? "Scanning is on" : "Nothing is being checked";

    $("departmentActive").value = identity.department || "Unspecified";

    var sync = "Policy last synced " + relativeTime(state.policyFetchedAt);
    if (state.queuedEvents > 0) sync += " · " + state.queuedEvents + " events queued offline";
    $("syncLine").textContent = sync;

    showView("viewActive");
  }

  /* ================================================================ *
   * Actions
   * ================================================================ */
  $("saveConnection").addEventListener("click", async function () {
    var url = $("setupUrl").value.trim();
    var key = $("setupKey").value.trim();
    if (!url || !key) return notify("Both fields are required.");

    busy(this, true, "Saving...");
    var res = await send({ type: "SET_CONNECTION", url: url, anonKey: key });
    busy(this, false);
    if (!res.ok) return notify(res.error);
    notify("Connected.", "ok");
    refresh();
  });

  $("googleBtn").addEventListener("click", async function () {
    busy(this, true, "Opening Google...");
    var res = await send({ type: "SIGN_IN_GOOGLE" });
    busy(this, false);
    if (!res.ok) {
      return notify(
        /redirect/i.test(res.error || "")
          ? "Google rejected the redirect. Add this extension's chromiumapp.org URL to Supabase's redirect list (setup step 3b)."
          : res.error
      );
    }
    refresh();
  });

  $("signInBtn").addEventListener("click", async function () {
    var email = $("email").value.trim();
    var password = $("password").value;
    if (!email || !password) return notify("Enter your email and password.");

    busy(this, true, "Signing in...");
    var res = await send({ type: "SIGN_IN_PASSWORD", email: email, password: password });
    busy(this, false);
    if (!res.ok) return notify(res.error);
    refresh();
  });

  $("signUpBtn").addEventListener("click", async function () {
    var email = $("email").value.trim();
    var password = $("password").value;
    if (!email || password.length < 6) return notify("Enter an email and a password of at least 6 characters.");

    busy(this, true, "Creating...");
    var res = await send({ type: "SIGN_UP_PASSWORD", email: email, password: password });
    busy(this, false);
    if (!res.ok) return notify(res.error);
    if (!res.data) return notify("Check your inbox to confirm your email, then sign in.", "ok");
    refresh();
  });

  $("enrollBtn").addEventListener("click", async function () {
    var code = $("joinCode").value.trim().toUpperCase();
    if (!code) return notify("Enter the join code from your IT team.");

    busy(this, true, "Joining...");
    var res = await send({ type: "ENROLL", joinCode: code, department: $("department").value });
    busy(this, false);
    if (!res.ok) {
      return notify(/invalid join code/i.test(res.error || "") ? "That join code wasn't recognised." : res.error);
    }
    notify("Joined " + (res.data.companyName || "your workspace") + ".", "ok");
    refresh();
  });

  $("enabledToggle").addEventListener("change", async function () {
    await send({ type: "SET_ENABLED", enabled: this.checked });
    refresh();
  });

  $("departmentActive").addEventListener("change", async function () {
    var res = await send({ type: "SET_DEPARTMENT", department: this.value });
    if (!res.ok) return notify(res.error);
    notify("Department updated.", "ok");
  });

  $("syncBtn").addEventListener("click", async function () {
    busy(this, true, "Syncing...");
    var res = await send({ type: "FORCE_SYNC" });
    await send({ type: "FLUSH_QUEUE" });
    busy(this, false);
    if (!res.ok) return notify(res.error || "Sync failed — last-known policy is still in force.");
    if (res.data && res.data.failures && res.data.failures.length) {
      notify("Partial sync: " + res.data.failures.join(", ") + " failed. Previous settings retained.");
    } else {
      notify("Synced.", "ok");
    }
    refresh();
  });

  $("signOutBtn").addEventListener("click", async function () {
    busy(this, true, "Signing out...");
    await send({ type: "SIGN_OUT" });
    busy(this, false);
    refresh();
  });

  // Enter-to-submit on the sign-in fields.
  ["email", "password"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("signInBtn").click();
    });
  });
  $("joinCode").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("enrollBtn").click();
  });

  refresh();
})();
