/* eslint-disable */
/**
 * Shadow AI Guard — Dashboard application
 * =======================================
 * Reads go straight to Supabase's REST API. There is no backend API layer
 * because there is nothing for one to do: Row Level Security already
 * scopes every query to the signed-in admin's own company, so a
 * pass-through server would only add a hop and a second place for an
 * authorisation bug to live.
 *
 * Aggregation happens client-side for the simple counts (a few thousand
 * metadata rows is nothing) and in SQL for the two queries with real
 * logic in them — the digest and the override escalation.
 */
(function () {
  "use strict";

  var CFG = window.SAG_CONFIG;
  var C = window.SAGCharts;
  var $ = function (id) { return document.getElementById(id); };

  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  var state = {
    companyId: null,
    company: null,
    rangeDays: 30,
    events: [],
    drill: null,        // which overview tile is expanded
    drillShown: 50,
  };

  /* ================================================================ *
   * Utilities
   * ================================================================ */
  function notify(message, kind) {
    var box = $("alert");
    box.textContent = message;
    box.setAttribute("data-kind", kind || "error");
    box.hidden = false;
    if (kind === "ok") setTimeout(function () { box.hidden = true; }, 3500);
  }

  function esc(value) {
    return String(value == null ? "" : value);
  }

  function tally(rows, key) {
    var counts = {};
    rows.forEach(function (r) {
      var k = typeof key === "function" ? key(r) : r[key];
      if (k == null) return;
      counts[k] = (counts[k] || 0) + 1;
    });
    return counts;
  }

  function sortedEntries(counts, limit) {
    var entries = Object.keys(counts)
      .map(function (k) { return [k, counts[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    return limit ? entries.slice(0, limit) : entries;
  }

  function patternLabel(type) {
    var found = CFG.PATTERN_TYPES.filter(function (p) { return p.type === type; })[0];
    return found ? found.label : type;
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k]; else node.setAttribute(k, attrs[k]);
    });
    if (text != null) node.textContent = String(text);
    return node;
  }

  function emptyState(container, message) {
    container.textContent = "";
    container.appendChild(el("p", { class: "empty" }, message));
  }

  /* ================================================================ *
   * Bootstrap
   * ================================================================ */
  async function boot() {
    var session = await sb.auth.getSession();
    if (!session.data.session) {
      window.location.href = "index.html";
      return;
    }

    // getSession() has finished any ?code= exchange by now, so the URL is safe to tidy.
    var returnTab = handleOAuthReturn();
    if (returnTab) showTab(returnTab);

    var profile = await sb.from("admin_profiles").select("company_id, role").maybeSingle();
    if (profile.error || !profile.data) {
      notify("This account isn't an IT admin for any workspace. If you signed in with the employee extension, use that instead.");
      return;
    }
    state.companyId = profile.data.company_id;

    var company = await sb
      .from("companies")
      .select("name, join_code, sanctioned_ai_tool_url, sanctioned_ai_tool_name, override_alert_threshold")
      .eq("id", state.companyId)
      .single();

    if (company.data) {
      state.company = company.data;
      $("companyLabel").textContent = company.data.name;
      $("joinCodeValue").textContent = company.data.join_code;
    }

    loadSanctioned();
    loadProfile();
    await loadAll();
  }

  async function loadAll() {
    state.rangeDays = Number($("rangeSelect").value);
    var since = new Date(Date.now() - state.rangeDays * 86400000).toISOString();
    $("rangeLabel").textContent =
      state.rangeDays >= 3650 ? "All recorded activity" : "Last " + state.rangeDays + " days";

    var events = await sb
      .from("flagged_events")
      .select("id, timestamp, ai_tool, source, file_name, file_type, pattern_types, compliance_frameworks, department, risk_level, tier, action, false_positive_reason, confirmed_leak, employee_hash")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false })
      .limit(5000);

    if (events.error) {
      notify("Could not load events: " + events.error.message);
      return;
    }
    state.events = events.data || [];

    renderTiles();
    renderTimeChart();
    renderDeptChart();
    renderPatternChart();
    renderRiskChart();
    renderComplianceChart();

    loadDigest();
    loadTools(since);
    renderFalsePositives();
    loadOverrides();
    loadPolicies();
    loadHoneytokens();
    loadKeywords();
  }

  /* ================================================================ *
   * Stat tiles (Feature 19 at a glance)
   * ================================================================ */
  function renderTiles() {
    var events = state.events;
    var total = events.length;

    var mandatory = events.filter(function (e) { return e.tier === "MandatoryRedaction"; }).length;
    var overrides = events.filter(function (e) { return e.action === "sent_anyway" || e.action === "uploaded_anyway"; }).length;
    var redacted = events.filter(function (e) { return e.action === "redacted"; }).length;
    var fp = events.filter(function (e) { return e.action === "marked_false_positive"; }).length;
    var leaks = events.filter(function (e) { return e.confirmed_leak; }).length;
    var files = events.filter(function (e) { return e.source === "file"; }).length;

    var pct = function (n) { return total ? Math.round((n / total) * 100) + "%" : "—"; };

    var tiles = [
      { key: "all", label: "Flagged events", value: total, note: total ? files + " from file uploads" : "nothing yet" },
      { key: "redacted", label: "Redacted before sending", value: redacted, note: pct(redacted) + " of all events", tone: "good" },
      { key: "mandatory", label: "Mandatory redactions", value: mandatory, note: "no override was offered" },
      { key: "overrides", label: "Sent anyway", value: overrides, note: pct(overrides) + " override rate" },
      { key: "leaks", label: "Confirmed leaks", value: leaks, note: leaks ? "honeytoken matches" : "no honeytokens hit", tone: leaks ? "critical" : "good" },
      { key: "fp", label: "False positives", value: fp, note: pct(fp) + " of all events" },
    ];

    var wrap = $("tiles");
    wrap.textContent = "";
    tiles.forEach(function (t) {
      var card = el("button", {
        class: "tile tile-button", type: "button", "data-key": t.key,
        "aria-label": t.label + ": " + t.value + ". View events",
      });
      card.addEventListener("click", function () { openEvents(t.key); });
      card.appendChild(el("div", { class: "tile-label" }, t.label));
      card.appendChild(el("div", { class: "tile-value" }, t.value));
      var note = el("div", { class: "tile-note" }, t.note);
      if (t.tone) note.setAttribute("data-tone", t.tone);
      card.appendChild(note);
      var more = el("span", { class: "tile-more" }, "View events");
      more.appendChild(el("span", { class: "tile-arrow", "aria-hidden": "true" }, "→"));
      card.appendChild(more);
      wrap.appendChild(card);
    });

    $("overviewMeta").textContent =
      total + (total === 1 ? " event" : " events") + " · " +
      new Set(state.events.map(function (e) { return e.employee_hash; })).size + " anonymous IDs";

    if (state.drill) renderDrill();
  }

  /* ================================================================ *
   * Tile drill-down — the events behind each number, metadata only.
   * Reads the same rows as the charts: flagged_events has no column
   * that can hold a message or file contents, so there is nothing
   * else this could show.
   * ================================================================ */
  var DRILL = {
    all:       { title: "All flagged events",      test: function () { return true; } },
    redacted:  { title: "Redacted before sending", test: function (e) { return e.action === "redacted"; } },
    mandatory: { title: "Mandatory redactions",    test: function (e) { return e.tier === "MandatoryRedaction"; } },
    overrides: { title: "Sent anyway",             test: function (e) { return e.action === "sent_anyway" || e.action === "uploaded_anyway"; } },
    leaks:     { title: "Confirmed leaks",         test: function (e) { return e.confirmed_leak; } },
    fp:        { title: "False positives",         test: function (e) { return e.action === "marked_false_positive"; } },
  };
  var DRILL_PAGE = 50;

  /** Open the events page for one overview block (its own view, with its own URL). */
  function openEvents(key, fromHistory) {
    if (!DRILL[key]) key = "all";
    state.drill = key;
    state.drillShown = DRILL_PAGE;
    $("drillSearch").value = "";
    showTab("events", true);
    if (!fromHistory) { try { history.pushState({ view: "events", key: key }, "", window.location.pathname + "#events/" + key); } catch (e) {} }
    renderDrill();
    window.scrollTo(0, 0);
  }

  function eventSearchText(e) {
    return [
      e.ai_tool, e.department, e.risk_level, e.employee_hash, e.source, e.file_type, e.file_name,
      CFG.ACTION_LABELS[e.action] || e.action,
      (e.pattern_types || []).map(patternLabel).join(" "),
      (e.compliance_frameworks || []).join(" "),
      e.confirmed_leak ? "confirmed leak honeytoken" : "",
    ].join(" ").toLowerCase();
  }

  var DRILL_BLURB = {
    all: "Every event the extension reported in this period.",
    redacted: "Sensitive values were replaced before the message reached the AI tool.",
    mandatory: "High-risk matches where the employee had no option to send the original.",
    overrides: "The employee was warned and chose to send or upload as-is.",
    leaks: "A planted honeytoken reached an AI prompt — proof of a leak, not a guess.",
    fp: "Employees reported these as not actually sensitive — use them to tune noisy rules.",
  };

  var ACTION_TONE = {
    redacted: "good", marked_false_positive: "neutral", dismissed_no_action: "neutral",
    blocked: "critical", upload_cancelled: "good", redirected_to_sanctioned: "good",
    sent_anyway: "warning", uploaded_anyway: "warning", warned: "neutral",
  };

  function topOf(rows, key) {
    var c = tally(rows, key), best = null;
    Object.keys(c).forEach(function (k) { if (!best || c[k] > c[best]) best = k; });
    return best;
  }

  function renderDrill() {
    var def = DRILL[state.drill];
    if (!def) return;
    var q = $("drillSearch").value.trim().toLowerCase();
    var rows = state.events.filter(def.test);
    var matching = q ? rows.filter(function (e) { return eventSearchText(e).indexOf(q) !== -1; }) : rows;

    $("drillTitle").textContent = def.title;
    $("drillBlurb").textContent = DRILL_BLURB[state.drill] || "";
    $("drillCount").textContent = (q ? matching.length + " of " : "") + rows.length +
      (rows.length === 1 ? " event" : " events") + " · " + $("rangeLabel").textContent.toLowerCase();

    // summary strip
    var ids = new Set(rows.map(function (e) { return e.employee_hash; })).size;
    var high = rows.filter(function (e) { return e.risk_level === "High" || e.confirmed_leak; }).length;
    var stats = [
      ["Events", rows.length],
      ["Anonymous IDs", ids],
      ["High risk", high],
      ["Top AI tool", topOf(rows, "ai_tool") || "—"],
      ["Top department", topOf(rows, "department") || "—"],
    ];
    var strip = $("drillStats");
    strip.textContent = "";
    stats.forEach(function (st) {
      var cell = el("div", { class: "ev-stat" });
      cell.appendChild(el("span", null, st[0]));
      cell.appendChild(el("b", null, st[1]));
      strip.appendChild(cell);
    });

    var box = $("drillTable");
    box.textContent = "";
    if (!matching.length) {
      return emptyState(box, rows.length ? "No events match that search." : "No events of this kind in the selected range.");
    }

    var table = el("table", { class: "ev-table" });
    var thead = el("thead");
    var hr = el("tr");
    ["When", "AI tool", "Source", "Detected", "Department", "Risk", "Action", "Anonymous ID"]
      .forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    matching.slice(0, state.drillShown).forEach(function (e) {
      var tr = el("tr");
      var d = new Date(e.timestamp);

      var when = el("td", { class: "ev-when" });
      when.appendChild(el("b", null, d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })));
      when.appendChild(el("span", null, d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })));
      tr.appendChild(when);

      var tool = el("td");
      tool.appendChild(el("span", { class: "ev-tool" }, e.ai_tool));
      tr.appendChild(tool);

      var src = el("td", { class: "ev-src" });
      src.appendChild(el("b", null, e.source === "file" ? "File upload" : "Typed text"));
      if (e.source === "file") {
        var fileLine = (e.file_type ? "." + e.file_type : "file") + (e.file_name ? " · " + e.file_name : "");
        src.appendChild(el("span", { title: fileLine }, fileLine));
      }
      tr.appendChild(src);

      var detected = el("td", { class: "ev-detected" });
      (e.pattern_types || []).forEach(function (t) {
        var tag = el("span", { class: "ev-tag" }, patternLabel(t));
        if (t === "honeytoken") tag.setAttribute("data-tone", "critical");
        detected.appendChild(tag);
      });
      var fw = (e.compliance_frameworks || []).join(" · ") || "Internal Policy";
      detected.appendChild(el("small", null, fw));
      tr.appendChild(detected);

      tr.appendChild(el("td", null, e.department || "Unspecified"));

      var risk = el("td");
      var level = e.confirmed_leak ? "Leak" : e.risk_level;
      risk.appendChild(el("span", { class: "ev-risk", "data-level": e.confirmed_leak ? "Leak" : e.risk_level }, level));
      tr.appendChild(risk);

      var actionCell = el("td");
      var action = el("span", { class: "ev-action", "data-tone": ACTION_TONE[e.action] || "neutral" }, CFG.ACTION_LABELS[e.action] || e.action);
      actionCell.appendChild(action);
      if (e.action === "marked_false_positive" && e.false_positive_reason) {
        actionCell.appendChild(el("small", null, CFG.FP_REASON_LABELS[e.false_positive_reason] || e.false_positive_reason));
      }
      tr.appendChild(actionCell);

      var idCell = el("td");
      idCell.appendChild(el("code", { class: "ev-id" }, e.employee_hash));
      tr.appendChild(idCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var scroller = el("div", { class: "table-scroll" });
    scroller.appendChild(table);
    box.appendChild(scroller);

    if (matching.length > state.drillShown) {
      var remaining = matching.length - state.drillShown;
      var more = el("button", { class: "btn btn-secondary btn-full", type: "button" },
        "Show " + Math.min(DRILL_PAGE, remaining) + " more (" + remaining + " remaining)");
      more.style.marginTop = "14px";
      more.addEventListener("click", function () { state.drillShown += DRILL_PAGE; renderDrill(); });
      box.appendChild(more);
    }
  }

  $("drillSearch").addEventListener("input", function () { state.drillShown = DRILL_PAGE; renderDrill(); });

  /** Every "← Back to dashboard" button returns to the overview. */
  document.querySelectorAll("[data-back]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.drill = null;
      showTab("overview");
      window.scrollTo(0, 0);
    });
  });

  /* ================================================================ *
   * Live refresh — a cheap check every 30s; the full reload (charts
   * included) only runs when the event set actually changed.
   * ================================================================ */
  var LIVE_MS = 30000;
  var liveBusy = false;

  async function checkForNewEvents() {
    if (liveBusy || document.hidden || !state.companyId) return;
    liveBusy = true;
    try {
      var since = new Date(Date.now() - state.rangeDays * 86400000).toISOString();
      var res = await sb.from("flagged_events")
        .select("id", { count: "exact" })
        .gte("timestamp", since)
        .order("id", { ascending: false })
        .limit(1);
      if (res.error) return;
      var newestId = res.data && res.data[0] ? res.data[0].id : null;
      var currentNewest = state.events.reduce(function (m, e) { return Math.max(m, e.id || 0); }, 0) || null;
      // loadAll() caps at 5000 rows, so compare against the capped count.
      if (Math.min(res.count, 5000) !== state.events.length || newestId !== currentNewest) await loadAll();
      $("liveStamp").textContent = "Live · checked " + new Date().toLocaleTimeString();
    } finally {
      liveBusy = false;
    }
  }

  setInterval(checkForNewEvents, LIVE_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) checkForNewEvents(); });

  /* ================================================================ *
   * Charts
   * ================================================================ */
  function renderTimeChart() {
    var days = Math.min(state.rangeDays, 30);
    var labels = [];
    var textCounts = [];
    var fileCounts = [];

    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(Date.now() - i * 86400000);
      var key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));

      var onDay = state.events.filter(function (e) { return e.timestamp.slice(0, 10) === key; });
      textCounts.push(onDay.filter(function (e) { return e.source !== "file"; }).length);
      fileCounts.push(onDay.filter(function (e) { return e.source === "file"; }).length);
    }

    C.lines("timeChart", labels, [
      { label: "Typed messages", values: textCounts },
      { label: "File uploads", values: fileCounts },
    ]);
  }

  function renderDeptChart() {
    var counts = tally(state.events, "department");
    var entries = sortedEntries(counts);
    if (!entries.length) entries = [["No data", 0]];
    C.bars("deptChart", entries.map(function (e) { return e[0]; }), entries.map(function (e) { return e[1]; }));
  }

  function renderPatternChart() {
    var counts = {};
    state.events.forEach(function (e) {
      (e.pattern_types || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var entries = sortedEntries(counts, 8);
    if (!entries.length) entries = [["No data", 0]];
    C.barsHorizontal(
      "patternChart",
      entries.map(function (e) { return patternLabel(e[0]); }),
      entries.map(function (e) { return e[1]; })
    );
  }

  function renderRiskChart() {
    var order = ["Low", "Medium", "High"];
    var counts = tally(state.events, "risk_level");
    C.ordinalBars("riskChart", order, order.map(function (r) { return counts[r] || 0; }));

    // Identity is never colour-alone: the ramp gets a written legend.
    var p = C.palette();
    var legend = $("riskLegend");
    legend.textContent = "";
    [["Low", p.riskLow], ["Medium", p.riskMed], ["High", p.riskHigh]].forEach(function (pair) {
      var item = el("span", { class: "legend-item" });
      var sw = el("span", { class: "legend-swatch" });
      sw.style.background = pair[1];
      item.appendChild(sw);
      item.appendChild(el("span", null, pair[0] + " risk"));
      legend.appendChild(item);
    });
  }

  function renderComplianceChart() {
    var counts = {};
    state.events.forEach(function (e) {
      (e.compliance_frameworks || []).forEach(function (f) { counts[f] = (counts[f] || 0) + 1; });
    });
    var entries = sortedEntries(counts, 6);
    if (!entries.length) entries = [["No data", 0]];
    C.barsHorizontal(
      "complianceChart",
      entries.map(function (e) { return e[0]; }),
      entries.map(function (e) { return e[1]; })
    );
  }

  /* ================================================================ *
   * Feature 18 — digest (server-side aggregation)
   * ================================================================ */
  async function loadDigest() {
    var res = await sb.rpc("get_weekly_digest", { p_days: 7 });
    if (res.error || !res.data) {
      $("digestText").textContent = "Digest unavailable: " + (res.error ? res.error.message : "no data");
      return;
    }
    var d = res.data;
    var box = $("digestText");
    box.textContent = "";

    if (!d.total) {
      box.textContent = "No flagged events in the last 7 days. Either nobody pasted anything sensitive, or nobody has the extension installed yet.";
      return;
    }

    function add(text, bold) {
      box.appendChild(bold ? el("b", null, text) : document.createTextNode(text));
    }

    add("In the last 7 days, ");
    add(String(d.total), true);
    add(d.total === 1 ? " event was flagged. " : " events were flagged. ");
    if (d.topDepartment) {
      add(d.topDepartment, true);
      add(" accounted for the most (" + d.topDepartmentCount + "). ");
    }
    add(String(d.mandatoryRedactions), true);
    add(" required mandatory redaction, and ");
    add(String(d.overrides), true);
    add(" were sent anyway after a warning. ");
    if (d.confirmedLeaks > 0) {
      add(String(d.confirmedLeaks), true);
      add(" honeytoken match" + (d.confirmedLeaks === 1 ? " was" : "es were") + " recorded — those are confirmed leaks, not guesses. ");
    }
    add(String(d.newToolsCount), true);
    add(" distinct AI tool" + (d.newToolsCount === 1 ? " was" : "s were") + " seen in use.");
    if (d.falsePositives > 0) {
      add(" Employees marked ");
      add(String(d.falsePositives), true);
      add(" of these as false alarms — worth reviewing the rules below.");
    }
  }

  /* ================================================================ *
   * Feature 15 — discovered tools
   * ================================================================ */
  async function loadTools(since) {
    var container = $("toolsTable");
    var res = await sb.from("discovered_tools").select("ai_tool, employee_hash").gte("timestamp", since);

    if (res.error) return emptyState(container, "Could not load: " + res.error.message);
    if (!res.data.length) return emptyState(container, "No other AI tools seen yet. The discovery script covers 12 additional sites.");

    var byTool = {};
    res.data.forEach(function (r) {
      if (!byTool[r.ai_tool]) byTool[r.ai_tool] = { visits: 0, people: {} };
      byTool[r.ai_tool].visits++;
      byTool[r.ai_tool].people[r.employee_hash] = true;
    });

    var rows = Object.keys(byTool)
      .map(function (t) { return { tool: t, visits: byTool[t].visits, people: Object.keys(byTool[t].people).length }; })
      .sort(function (a, b) { return b.visits - a.visits; });

    var max = rows[0].visits;
    container.textContent = "";
    var table = el("table");
    var thead = el("thead");
    var hr = el("tr");
    ["Tool", "People", "Visits"].forEach(function (h, i) {
      hr.appendChild(el("th", { class: i ? "num" : "" }, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      var td = el("td");
      var cell = el("div", { class: "bar-cell" });
      cell.appendChild(el("span", null, r.tool));
      var track = el("div", { class: "bar-track" });
      var fill = el("div", { class: "bar-fill" });
      fill.style.width = Math.round((r.visits / max) * 100) + "%";
      track.appendChild(fill);
      cell.appendChild(track);
      td.appendChild(cell);
      tr.appendChild(td);
      tr.appendChild(el("td", { class: "num" }, r.people));
      tr.appendChild(el("td", { class: "num" }, r.visits));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  /* ================================================================ *
   * Feature 13 — false positives
   * ================================================================ */
  function renderFalsePositives() {
    var container = $("fpTable");
    var fps = state.events.filter(function (e) { return e.action === "marked_false_positive"; });

    if (!fps.length) {
      return emptyState(container, "No false positives reported. Either the rules are well tuned, or nobody has used the feedback button yet.");
    }

    var byReason = tally(fps, "false_positive_reason");
    var byPattern = {};
    fps.forEach(function (e) {
      (e.pattern_types || []).forEach(function (t) { byPattern[t] = (byPattern[t] || 0) + 1; });
    });

    container.textContent = "";

    var rate = Math.round((fps.length / Math.max(state.events.length, 1)) * 100);
    var summary = el("p", { class: "card-sub" });
    summary.appendChild(el("b", null, rate + "%"));
    summary.appendChild(document.createTextNode(" of all flagged events were marked as false alarms."));
    container.appendChild(summary);

    var table = el("table");
    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(el("th", null, "Reason given"));
    hr.appendChild(el("th", { class: "num" }, "Count"));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    sortedEntries(byReason).forEach(function (entry) {
      var tr = el("tr");
      tr.appendChild(el("td", null, CFG.FP_REASON_LABELS[entry[0]] || entry[0]));
      tr.appendChild(el("td", { class: "num" }, entry[1]));
      tbody.appendChild(tr);
    });

    sortedEntries(byPattern, 4).forEach(function (entry) {
      var tr = el("tr");
      var td = el("td");
      td.appendChild(el("span", { class: "pill", "data-tone": "warning" }, "noisy rule"));
      td.appendChild(document.createTextNode(" " + patternLabel(entry[0])));
      tr.appendChild(td);
      tr.appendChild(el("td", { class: "num" }, entry[1]));
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  }

  /* ================================================================ *
   * Feature 14 — repeated overrides
   * ================================================================ */
  async function loadOverrides() {
    var container = $("overrideTable");
    var res = await sb.rpc("get_repeated_overrides", { p_days: 30 });

    if (res.error) return emptyState(container, "Could not load: " + res.error.message);
    if (!res.data || !res.data.length) {
      return emptyState(container, "Nobody has crossed the override threshold. Good sign — the warnings are landing.");
    }

    container.textContent = "";
    var table = el("table");
    var thead = el("thead");
    var hr = el("tr");
    ["Anonymous ID", "Department", "Overrides"].forEach(function (h, i) {
      hr.appendChild(el("th", { class: i === 2 ? "num" : "" }, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    res.data.forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("td", { class: "mono" }, r.employee_hash));
      tr.appendChild(el("td", null, r.department || "Unspecified"));
      var td = el("td", { class: "num" });
      td.appendChild(el("span", { class: "pill", "data-tone": "critical" }, "⚠ " + r.override_count));
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    var note = el("p", { class: "note" },
      "These are anonymous IDs. Mapping one to a person is not possible from this dashboard — " +
      "the table holding that link denies access to admin accounts. Treat this as a signal to " +
      "improve training or adjust a noisy rule, not to identify an individual.");
    container.appendChild(note);
  }

  /* ================================================================ *
   * Feature 8 — policy engine
   * ================================================================ */
  async function loadPolicies() {
    var container = $("policyTable");
    var res = await sb.from("policies").select("pattern_type, tier").eq("company_id", state.companyId);

    if (res.error) return emptyState(container, "Could not load policies: " + res.error.message);

    var current = {};
    (res.data || []).forEach(function (r) { current[r.pattern_type] = r.tier; });

    container.textContent = "";
    var table = el("table");
    var thead = el("thead");
    var hr = el("tr");
    ["Detection type", "Group", "Enforcement"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");

    CFG.PATTERN_TYPES.forEach(function (p) {
      var tr = el("tr");
      tr.appendChild(el("td", null, p.label));
      tr.appendChild(el("td", null, p.group));

      var td = el("td");
      var select = el("select", { class: "tier-select" });
      [["Warn", "Warn — employee decides"], ["MandatoryRedaction", "Mandatory redaction"]].forEach(function (opt) {
        var option = el("option", { value: opt[0] }, opt[1]);
        select.appendChild(option);
      });
      select.value = current[p.type] || "Warn";

      select.addEventListener("change", async function () {
        var previous = current[p.type] || "Warn";
        var next = select.value;
        select.disabled = true;

        var up = await sb.from("policies")
          .upsert({ company_id: state.companyId, pattern_type: p.type, tier: next, updated_at: new Date().toISOString() },
                  { onConflict: "company_id,pattern_type" });

        select.disabled = false;
        if (up.error) {
          select.value = previous;              // optimistic update, rolled back
          notify("Could not update " + p.label + ": " + up.error.message);
        } else {
          current[p.type] = next;
          notify(p.label + " set to " + (next === "Warn" ? "Warn" : "Mandatory redaction") + ". Extensions pick this up within seconds.", "ok");
        }
      });

      td.appendChild(select);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    // Honeytokens are shown, but deliberately not editable.
    var htRow = el("tr");
    htRow.appendChild(el("td", null, "Honeytoken match"));
    htRow.appendChild(el("td", null, "Confirmed leak"));
    var htCell = el("td");
    htCell.appendChild(el("span", { class: "pill", "data-tone": "critical" }, "Always mandatory"));
    htRow.appendChild(htCell);
    tbody.appendChild(htRow);

    table.appendChild(tbody);
    container.appendChild(table);
  }

  /* ================================================================ *
   * Features 3 & 9 — honeytokens and keywords
   * ================================================================ */
  function renderList(container, rows, labelKey, onDelete, emptyMessage) {
    container.textContent = "";
    if (!rows.length) return emptyState(container, emptyMessage);

    var table = el("table");
    var tbody = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr");
      tr.appendChild(el("td", { class: "mono" }, row[labelKey]));
      var td = el("td", { class: "num" });
      var btn = el("button", { class: "btn btn-ghost" }, "Remove");
      btn.addEventListener("click", function () { onDelete(row.id); });
      td.appendChild(btn);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  async function loadHoneytokens() {
    var res = await sb.from("honeytokens").select("id, token").eq("company_id", state.companyId).order("created_at", { ascending: false });
    if (res.error) return emptyState($("honeytokenList"), res.error.message);
    renderList($("honeytokenList"), res.data || [], "token", deleteHoneytoken,
      "No honeytokens yet. Plant one in a real internal document — any match is a confirmed leak.");
  }

  async function deleteHoneytoken(id) {
    var res = await sb.from("honeytokens").delete().eq("id", id);
    if (res.error) return notify(res.error.message);
    loadHoneytokens();
  }

  $("addHoneytoken").addEventListener("click", async function () {
    var value = $("honeytokenInput").value.trim();
    if (value.length < 4) return notify("A honeytoken must be at least 4 characters — short strings match everything.");
    var res = await sb.from("honeytokens").insert({ company_id: state.companyId, token: value });
    if (res.error) return notify(res.error.message);
    $("honeytokenInput").value = "";
    notify("Honeytoken added. Extensions sync it within seconds.", "ok");
    loadHoneytokens();
  });

  async function loadKeywords() {
    var res = await sb.from("custom_keywords").select("id, keyword").eq("company_id", state.companyId).order("created_at", { ascending: false });
    if (res.error) return emptyState($("keywordList"), res.error.message);
    renderList($("keywordList"), res.data || [], "keyword", deleteKeyword,
      "No custom keywords yet. Add client names or project codenames.");
  }

  async function deleteKeyword(id) {
    var res = await sb.from("custom_keywords").delete().eq("id", id);
    if (res.error) return notify(res.error.message);
    loadKeywords();
  }

  $("addKeyword").addEventListener("click", async function () {
    var value = $("keywordInput").value.trim();
    if (value.length < 2) return notify("Keyword is too short.");
    var res = await sb.from("custom_keywords").insert({ company_id: state.companyId, keyword: value });
    if (res.error) return notify(res.error.message);
    $("keywordInput").value = "";
    notify("Keyword added.", "ok");
    loadKeywords();
  });

  /* ================================================================ *
   * Feature 11 — sanctioned tool
   * ================================================================ */
  async function loadSanctioned() {
    var container = $("sanctionedList");
    var res = await sb.from("companies")
      .select("sanctioned_ai_tool_name, sanctioned_ai_tool_url")
      .eq("id", state.companyId)
      .single();
    if (res.error) return emptyState(container, res.error.message);

    var name = res.data.sanctioned_ai_tool_name;
    var url = res.data.sanctioned_ai_tool_url;
    container.textContent = "";
    if (!url) return emptyState(container, "No approved tool yet. Add a name and URL, then Save.");

    var table = el("table");
    var tbody = el("tbody");
    var tr = el("tr");
    var info = el("td");
    info.appendChild(el("div", null, name || url));
    var link = el("a", { class: "mono", href: url, target: "_blank", rel: "noopener noreferrer" }, url);
    info.appendChild(link);
    tr.appendChild(info);
    var td = el("td", { class: "num" });
    var btn = el("button", { class: "btn btn-ghost" }, "Remove");
    btn.addEventListener("click", removeSanctioned);
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
    table.appendChild(tbody);
    container.appendChild(table);
  }

  async function removeSanctioned() {
    var res = await sb.from("companies")
      .update({ sanctioned_ai_tool_name: null, sanctioned_ai_tool_url: null })
      .eq("id", state.companyId)
      .select("id");
    if (res.error) return notify(res.error.message);
    if (!res.data || !res.data.length) return notify("Could not remove — only workspace admins can change the approved tool.");
    notify("Approved tool removed.", "ok");
    loadSanctioned();
  }

  $("saveSanctioned").addEventListener("click", async function () {
    var name = $("sanctionedName").value.trim();
    var url = $("sanctionedUrl").value.trim();
    if (!name || !url) return notify("Enter both a tool name and a URL.");
    if (!/^https?:\/\/\S+$/i.test(url)) return notify("The URL must start with http:// or https://");

    var btn = $("saveSanctioned");
    btn.disabled = true;
    var res = await sb.from("companies")
      .update({ sanctioned_ai_tool_name: name, sanctioned_ai_tool_url: url })
      .eq("id", state.companyId)
      .select("id");
    btn.disabled = false;

    if (res.error) return notify(res.error.message);
    // Supabase returns no error when RLS silently matches zero rows.
    if (!res.data || !res.data.length) return notify("Could not save — only workspace admins can change the approved tool.");
    $("sanctionedName").value = "";
    $("sanctionedUrl").value = "";
    notify("Approved tool saved. It now appears as an option in the employee warning.", "ok");
    loadSanctioned();
  });

  /* ================================================================ *
   * Section tabs
   * ================================================================ */
  var TABS = ["overview", "tuning", "policies", "profile", "events"];
  var PAGE_VIEWS = ["profile", "events"];   // full pages with a back button, no hero

  function showTab(name, keepUrl) {
    if (TABS.indexOf(name) === -1) name = "overview";
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.setAttribute("aria-selected", String(btn.getAttribute("data-tab") === name));
    });
    document.querySelectorAll(".tab-panel").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-tab") !== name;
    });
    $("pageHero").hidden = PAGE_VIEWS.indexOf(name) !== -1;
    closeProfileMenu();
    if (!keepUrl) { try { history.replaceState(null, "", window.location.pathname + "#" + name); } catch (e) {} }
    // Charts drawn while their tab was hidden have zero size until resized.
    if (window.Chart && Chart.instances) {
      Object.keys(Chart.instances).forEach(function (k) { Chart.instances[k].resize(); });
    }
  }

  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () { showTab(btn.getAttribute("data-tab")); });
  });

  /* ================================================================ *
   * Profile menu (top right): avatar, account summary, sign out
   * ================================================================ */
  function closeProfileMenu() {
    if (!$("profileMenu")) return;
    $("profileMenu").hidden = true;
    $("avatarBtn").setAttribute("aria-expanded", "false");
  }
  $("avatarBtn").addEventListener("click", function (e) {
    e.stopPropagation();
    var open = $("profileMenu").hidden;
    $("profileMenu").hidden = !open;
    this.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", function (e) {
    if (!$("profileMenu").hidden && !e.target.closest(".profile-menu")) closeProfileMenu();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeProfileMenu(); });
  $("menuProfile").addEventListener("click", function () {
    showTab("profile", true);
    try { history.pushState({ view: "profile" }, "", window.location.pathname + "#profile"); } catch (e) {}
    window.scrollTo(0, 0);
  });

  function fillProfileMenu(email, role) {
    var initial = (email || "?").trim().charAt(0).toUpperCase();
    $("avatarInitial").textContent = initial;
    $("menuAvatar").textContent = initial;
    $("menuEmail").textContent = email || "—";
    if (role) $("menuRole").textContent = role;
  }

  /* ================================================================ *
   * Profile — account, alert settings, sign-in methods
   * ================================================================ */
  var PROVIDER_LABELS = { email: "Email & password", google: "Google (SSO)" };

  function formatDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  async function loadProfile() {
    var userRes = await sb.auth.getUser();
    var user = userRes.data && userRes.data.user;
    if (!user) return;
    state.user = user;

    $("profEmail").textContent = user.email || "—";
    fillProfileMenu(user.email);
    $("profSince").textContent = formatDate(user.created_at);
    $("profLastSignIn").textContent = formatDate(user.last_sign_in_at);
    if (state.company) {
      $("profJoinCode").textContent = state.company.join_code;
      $("profCompanyName").value = state.company.name || "";
    }

    var prof = await sb.from("admin_profiles")
      .select("role, notification_email, digest_opt_in")
      .eq("id", user.id)
      .maybeSingle();
    if (prof.data) {
      $("profRole").textContent = prof.data.role.charAt(0).toUpperCase() + prof.data.role.slice(1);
      fillProfileMenu(user.email, $("profRole").textContent + " · " + (state.company ? state.company.name : ""));
      $("profNotifyEmail").value = prof.data.notification_email || "";
      $("profDigest").checked = !!prof.data.digest_opt_in;
    }

    renderIdentities(user.identities || []);
    loadMembers();
  }

  async function loadMembers() {
    var box = $("memberList");
    if (state.company) $("membersJoinCode").textContent = state.company.join_code;

    var res = await sb.from("company_members")
      .select("email, joined_at")
      .eq("company_id", state.companyId)
      .order("joined_at", { ascending: true });

    if (res.error) {
      $("membersMeta").textContent = "";
      return emptyState(box, /company_members/.test(res.error.message)
        ? "Team list isn't set up yet — run supabase/migrations/006_company_members.sql in the Supabase SQL editor."
        : res.error.message);
    }

    var rows = res.data || [];
    $("membersMeta").textContent = rows.length + (rows.length === 1 ? " member" : " members");
    box.textContent = "";
    if (!rows.length) return emptyState(box, "Nobody has joined yet. Share the join code with your team.");

    var table = el("table");
    var head = el("thead");
    var hr = el("tr");
    hr.appendChild(el("th", null, "Email"));
    hr.appendChild(el("th", { class: "num" }, "Joined"));
    head.appendChild(hr);
    table.appendChild(head);

    var tbody = el("tbody");
    rows.forEach(function (m) {
      var tr = el("tr");
      var who = el("td", null, m.email);
      if (state.user && m.email === state.user.email) {
        who.appendChild(document.createTextNode(" "));
        who.appendChild(el("span", { class: "pill" }, "You"));
      }
      tr.appendChild(who);
      tr.appendChild(el("td", { class: "num" }, formatDate(m.joined_at)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function renderIdentities(identities) {
    var box = $("identityList");
    box.textContent = "";
    if (!identities.length) return emptyState(box, "No sign-in methods found.");

    identities.forEach(function (identity) {
      var row = el("div", { class: "identity" });
      var info = el("div");
      info.appendChild(el("div", null, PROVIDER_LABELS[identity.provider] || identity.provider));
      var who = (identity.identity_data && identity.identity_data.email) || "";
      info.appendChild(el("small", null, (who ? who + " · " : "") + "connected " + formatDate(identity.created_at)));
      row.appendChild(info);

      // Never allow removing the last way in.
      if (identity.provider !== "email" && identities.length > 1) {
        var btn = el("button", { class: "btn btn-ghost", type: "button" }, "Disconnect");
        btn.addEventListener("click", async function () {
          var res = await sb.auth.unlinkIdentity(identity);
          if (res.error) return notify(res.error.message);
          notify((PROVIDER_LABELS[identity.provider] || identity.provider) + " disconnected.", "ok");
          loadProfile();
        });
        row.appendChild(btn);
      } else {
        row.appendChild(el("span", { class: "pill", "data-tone": "good" }, "Active"));
      }
      box.appendChild(row);
    });

    var hasGoogle = identities.some(function (i) { return i.provider === "google"; });
    $("linkGoogle").hidden = hasGoogle;
  }

  $("saveCompanyName").addEventListener("click", async function () {
    var name = $("profCompanyName").value.trim();
    if (!name) return notify("Company name can't be empty.");
    var res = await sb.from("companies").update({ name: name }).eq("id", state.companyId).select("name");
    if (res.error) return notify(res.error.message);
    if (!res.data || !res.data.length) return notify("Could not save — only workspace admins can rename the company.");
    state.company.name = name;
    $("companyLabel").textContent = name;
    notify("Company name updated.", "ok");
  });

  $("saveNotify").addEventListener("click", async function () {
    var email = $("profNotifyEmail").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return notify("Enter a valid alert email address.");
    var res = await sb.from("admin_profiles")
      .update({ notification_email: email, digest_opt_in: $("profDigest").checked })
      .eq("id", state.user.id)
      .select("id");
    if (res.error) return notify(res.error.message);
    if (!res.data || !res.data.length) return notify("Could not save alert settings.");
    notify("Alert settings saved. The notifier uses them from its next run.", "ok");
  });

  $("savePassword").addEventListener("click", async function () {
    var pw = $("newPassword").value;
    if (pw.length < 8) return notify("Use at least 8 characters.");
    if (pw !== $("confirmPassword").value) return notify("The two passwords don't match.");
    this.disabled = true;
    var res = await sb.auth.updateUser({ password: pw });
    this.disabled = false;
    if (res.error) return notify(res.error.message);
    $("newPassword").value = "";
    $("confirmPassword").value = "";
    notify("Password updated.", "ok");
    loadProfile();
  });

  $("linkGoogle").addEventListener("click", async function () {
    this.disabled = true;
    try { sessionStorage.setItem("sag-return-tab", "profile"); } catch (e) {}
    var res = await sb.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (res.error) {
      this.disabled = false;
      notify("Couldn't start Google linking: " + res.error.message +
        ". Enable the Google provider and Manual linking in Supabase first.");
    }
  });

  $("signOutAll").addEventListener("click", async function () {
    if (!confirm("Sign out of the dashboard on every device, including this one?")) return;
    await sb.auth.signOut({ scope: "global" });
    window.location.href = "index.html";
  });

  /** Returning from a Google link attempt: land back on Profile, surface errors. */
  function handleOAuthReturn() {
    var params = new URLSearchParams(window.location.search);
    var hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    var error = params.get("error_description") || hash.get("error_description");
    var returnTab = null;
    try {
      returnTab = sessionStorage.getItem("sag-return-tab");
      sessionStorage.removeItem("sag-return-tab");
    } catch (e) {}
    if (error) notify("Google sign-in linking failed: " + error);
    if (returnTab || error || params.has("code")) {
      history.replaceState(null, "", window.location.pathname);
      return returnTab || "profile";
    }
    return null;
  }

  /* ================================================================ *
   * Chrome
   * ================================================================ */
  $("rangeSelect").addEventListener("change", loadAll);

  $("signOutBtn").addEventListener("click", async function () {
    await sb.auth.signOut();
    window.location.href = "index.html";
  });

  $("joinCode").addEventListener("click", function () {
    var code = $("joinCodeValue").textContent;
    navigator.clipboard.writeText(code).then(function () {
      notify("Join code " + code + " copied.", "ok");
    });
  });

  /** Route from the URL: #tuning, #profile, #events/sent-anyway-key, ... */
  function routeFromHash(fromHistory) {
    var h = window.location.hash.replace(/^#/, "");
    if (h.indexOf("events/") === 0) {
      state.drill = DRILL[h.slice(7)] ? h.slice(7) : "all";
      showTab("events", true);
      if (fromHistory) renderDrill();
    } else {
      state.drill = null;
      showTab(h, true);
    }
  }
  window.addEventListener("popstate", function () { routeFromHash(true); window.scrollTo(0, 0); });

  // Open the view named in the URL without touching it yet — an OAuth
  // ?code= may still be waiting for supabase-js to read it.
  routeFromHash(false);
  boot();
})();
