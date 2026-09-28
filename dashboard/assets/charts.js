/* eslint-disable */
/**
 * Shadow AI Guard — chart layer
 * =============================
 * Thin wrappers over Chart.js that apply one consistent set of rules, so
 * every chart on the page reads as the same system:
 *
 *   - marks: thin, 4px rounded data-ends anchored to the baseline,
 *     2px lines, 2px surface gap between adjacent bars
 *   - chrome: solid hairline gridlines one shade off the surface, no
 *     dashes, no border boxes, recessive axes
 *   - text: always an ink token, never the series colour
 *   - legend: present only when there are 2+ series (a single-series
 *     chart is named by its card title instead)
 *   - hover: a tooltip on every chart, index mode on the line chart so
 *     one hover reads both series
 *
 * Colour comes from CSS custom properties, so light/dark swap in one
 * place and the charts follow the page.
 */
(function (root) {
  "use strict";

  var registry = [];

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function palette() {
    return {
      series1: token("--series-1"),
      series2: token("--series-2"),
      riskLow: token("--risk-low"),
      riskMed: token("--risk-med"),
      riskHigh: token("--risk-high"),
      ink: token("--ink"),
      ink2: token("--ink-2"),
      muted: token("--muted"),
      grid: token("--grid"),
      axis: token("--axis"),
      surface: token("--surface"),
    };
  }

  function baseOptions(p) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 260 },
      layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: p.ink,
          titleColor: p.surface,
          bodyColor: p.surface,
          borderWidth: 0,
          padding: 10,
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 9,
          boxHeight: 9,
          boxPadding: 4,
          titleFont: { family: "Inter, system-ui, sans-serif", size: 12, weight: "600" },
          bodyFont: { family: "Inter, system-ui, sans-serif", size: 12 },
        },
      },
    };
  }

  function axisFont() {
    return { family: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif", size: 11 };
  }

  function linearAxis(p, horizontal) {
    return {
      beginAtZero: true,
      border: { display: false },
      grid: {
        color: p.grid,
        drawTicks: false,
        lineWidth: 1,          // hairline, solid — never dashed
        z: -1,                 // behind the marks; a grid line crossing a
                               // bar reads as a division in the data
      },
      ticks: {
        color: p.muted,
        font: axisFont(),
        padding: 8,
        precision: 0,
        maxTicksLimit: horizontal ? 6 : 5,
      },
    };
  }

  function categoryAxis(p) {
    return {
      border: { color: p.axis, width: 1 },
      grid: { display: false },
      ticks: { color: p.ink2, font: axisFont(), padding: 6, autoSkip: false },
    };
  }

  function remember(chart, rebuild) {
    registry.push({ chart: chart, rebuild: rebuild });
    return chart;
  }

  function destroyIn(canvasId) {
    var existing = Chart.getChart(canvasId);
    if (existing) existing.destroy();
    registry = registry.filter(function (r) { return r.chart.canvas.id !== canvasId; });
  }

  /* ================================================================ *
   * Vertical bar — one series, one colour.
   * A value-ramp here would double-encode bar length as hue.
   * ================================================================ */
  function bars(canvasId, labels, values, opts) {
    opts = opts || {};
    destroyIn(canvasId);
    var p = palette();
    var options = baseOptions(p);
    var colors = opts.colors || labels.map(function () { return p.series1; });

    options.scales = { x: categoryAxis(p), y: linearAxis(p, false) };
    options.plugins.tooltip.callbacks = {
      label: function (ctx) { return " " + ctx.parsed.y + (opts.unit || " events"); },
    };

    var chart = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
          borderSkipped: "bottom",       // rounded end only, anchored to baseline
          borderWidth: 2,
          borderColor: p.surface,        // 2px surface gap between adjacent bars
          maxBarThickness: 46,
        }],
      },
      options: options,
    });
    return remember(chart, function () { bars(canvasId, labels, values, opts); });
  }

  /* ================================================================ *
   * Horizontal bar — for long category names.
   * ================================================================ */
  function barsHorizontal(canvasId, labels, values, opts) {
    opts = opts || {};
    destroyIn(canvasId);
    var p = palette();
    var options = baseOptions(p);
    options.indexAxis = "y";
    options.scales = { x: linearAxis(p, true), y: categoryAxis(p) };
    options.plugins.tooltip.callbacks = {
      label: function (ctx) { return " " + ctx.parsed.x + (opts.unit || " events"); },
    };

    var chart = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: opts.colors || p.series1,
          borderRadius: { topRight: 4, bottomRight: 4, topLeft: 0, bottomLeft: 0 },
          borderSkipped: "left",
          borderWidth: 2,
          borderColor: p.surface,
          maxBarThickness: 22,
        }],
      },
      options: options,
    });
    return remember(chart, function () { barsHorizontal(canvasId, labels, values, opts); });
  }

  /* ================================================================ *
   * Line — two series (typed text vs file uploads).
   * Legend shown, because identity must never be colour-alone.
   * ================================================================ */
  function lines(canvasId, labels, series) {
    destroyIn(canvasId);
    var p = palette();
    var colors = [p.series1, p.series2];
    var options = baseOptions(p);

    options.interaction = { mode: "index", intersect: false };
    options.scales = { x: categoryAxis(p), y: linearAxis(p, false) };
    options.scales.x.ticks.autoSkip = true;
    options.scales.x.ticks.maxTicksLimit = 8;

    options.plugins.legend = {
      display: series.length > 1,
      position: "top",
      align: "end",
      labels: {
        color: p.ink2,
        font: axisFont(),
        boxWidth: 10,
        boxHeight: 10,
        usePointStyle: true,
        pointStyle: "rectRounded",
        padding: 14,
      },
    };

    var chart = new Chart(document.getElementById(canvasId), {
      type: "line",
      data: {
        labels: labels,
        datasets: series.map(function (s, i) {
          return {
            label: s.label,
            data: s.values,
            borderColor: colors[i],
            backgroundColor: colors[i],
            borderWidth: 2,              // thin marks
            tension: 0.28,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: p.surface,
            fill: false,
          };
        }),
      },
      options: options,
    });
    return remember(chart, function () { lines(canvasId, labels, series); });
  }

  /* ================================================================ *
   * Ordinal bars — for genuinely ORDERED categories (risk level).
   * Single hue, light -> dark, validated with --ordinal.
   * ================================================================ */
  function ordinalBars(canvasId, labels, values) {
    var p = palette();
    var ramp = { Low: p.riskLow, Medium: p.riskMed, High: p.riskHigh };
    return bars(canvasId, labels, values, {
      colors: labels.map(function (l) { return ramp[l] || p.series1; }),
    });
  }

  /* Re-render everything when the OS theme flips, so tokens re-resolve. */
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      var pending = registry.slice();
      registry = [];
      pending.forEach(function (r) { try { r.rebuild(); } catch (e) {} });
    });
  }

  root.SAGCharts = {
    bars: bars,
    barsHorizontal: barsHorizontal,
    lines: lines,
    ordinalBars: ordinalBars,
    palette: palette,
  };
})(window);
