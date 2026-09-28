/* eslint-disable */
/**
 * Shadow AI Guard — Landing page behaviour
 *
 * The landing page and the sign-in screen are two sections of ONE
 * document. Moving between them is a class toggle, not a navigation:
 * no reload, no white flash, and the animated background keeps running
 * underneath instead of restarting.
 *
 * The 3D background (a liquid-marble shader on three.js) is loaded only here, and only
 * after first paint, so text is readable immediately on the CSS-blob
 * fallback. The dashboard (admin.html) never loads either library.
 *
 * auth.js runs after this file and calls window.SAGLanding hooks when it
 * needs the sign-in screen visible (an error, a first-login setup step,
 * or a returning session).
 */
(function () {
  "use strict";

  document.documentElement.classList.add("js");
  var $ = function (id) { return document.getElementById(id); };
  if ($("year")) $("year").textContent = new Date().getFullYear();
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================================================================ *
   * Page switching
   * ================================================================ */
  var current = "landing";

  function showPage(name) {
    if (name === current) return;
    $("page-landing").classList.toggle("active", name === "landing");
    $("page-auth").classList.toggle("active", name === "auth");
    current = name;
    closeMenu();
    window.scrollTo(0, 0);
  }

  function openAuth(mode) {
    showPage("auth");
    // auth.js owns the tabs; clicking them keeps its internal mode in sync.
    var tab = $(mode === "signup" ? "tabSignUp" : "tabSignIn");
    if (tab && !$("loginForm").hidden && tab.getAttribute("aria-selected") !== "true") tab.click();
    setTimeout(function () {
      var field = $("email");
      if (field && !field.disabled && !$("loginForm").hidden) field.focus({ preventScroll: true });
    }, 60);
  }

  /** Only plain "#section-id" hashes are selectors; OAuth returns put tokens in the hash. */
  function sectionFor(hash) {
    if (!hash || !/^#[A-Za-z][\w-]*$/.test(hash)) return null;
    return document.getElementById(hash.slice(1));
  }

  function goLanding(hash) {
    showPage("landing");
    // "Home" means the very top of the page, not the hero's box under the sticky nav.
    if (hash === "#top") {
      requestAnimationFrame(function () { window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }); });
      return;
    }
    var target = sectionFor(hash);
    if (target) {
      // Let the landing page lay out before scrolling to a section on it.
      requestAnimationFrame(function () { target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); });
    }
  }

  /** Route from a hash: #signin / #signup open the auth screen, anything else is the landing page. */
  function route(hash, push) {
    if (hash === "#signin" || hash === "#signup") openAuth(hash.slice(1));
    else goLanding(hash);
    if (push) {
      try { history.pushState(null, "", hash || "#top"); } catch (e) {}
    }
  }

  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("[data-route]");
    if (!link) return;
    e.preventDefault();
    var r = link.getAttribute("data-route");
    if (r === "signin" || r === "signup") {
      route("#" + r, true);
    } else {
      route(link.getAttribute("href"), true);
    }
  });

  window.addEventListener("popstate", function () { route(window.location.hash, false); });

  /* ================================================================ *
   * Hooks for auth.js
   * ================================================================ */
  window.SAGLanding = {
    openAuth: function () { showPage("auth"); },
  };

  /* ================================================================ *
   * Mobile menu
   * ================================================================ */
  function closeMenu() {
    $("navLinks").classList.remove("open");
    $("navBurger").setAttribute("aria-expanded", "false");
  }
  $("navBurger").addEventListener("click", function () {
    var open = !$("navLinks").classList.contains("open");
    $("navLinks").classList.toggle("open", open);
    this.setAttribute("aria-expanded", String(open));
  });

  /* ================================================================ *
   * Active nav link while scrolling, and the back-to-top button
   * ================================================================ */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-links a"));
  var sections = navLinks
    .map(function (a) { return sectionFor(a.getAttribute("href")); })
    .filter(Boolean);

  function onScroll() {
    $("toTop").hidden = window.scrollY < 600;
    if (current !== "landing") return;
    var mark = window.scrollY + window.innerHeight * 0.35;
    var active = sections[0];
    sections.forEach(function (s) { if (s.offsetTop <= mark) active = s; });
    navLinks.forEach(function (a) {
      a.classList.toggle("is-active", a.getAttribute("href") === "#" + active.id);
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  $("toTop").addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });

  /* ================================================================ *
   * Feature carousel — the arrow brings in the next card, one at a time
   * ================================================================ */
  (function () {
    var track = $("featureTrack");
    if (!track) return;
    var cards = track.querySelectorAll(".feature");

    function step() {
      var first = cards[0];
      var gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap) || 16;
      return first ? first.getBoundingClientRect().width + gap : track.clientWidth;
    }
    function perView() { return Math.max(1, Math.round(track.clientWidth / step())); }

    function update() {
      var max = track.scrollWidth - track.clientWidth;
      var i = Math.round(track.scrollLeft / step());
      var per = Math.min(perView(), cards.length);
      var last = Math.min(cards.length, i + per);
      $("carPrev").disabled = track.scrollLeft <= 4;
      $("carNext").disabled = track.scrollLeft >= max - 4;
      $("carCount").textContent = (per > 1 ? (i + 1) + "–" + last : String(i + 1)) + " / " + cards.length;
      $("carBar").style.width = (last / cards.length * 100) + "%";
    }

    $("carNext").addEventListener("click", function () { track.scrollBy({ left: step(), behavior: reduceMotion ? "auto" : "smooth" }); });
    $("carPrev").addEventListener("click", function () { track.scrollBy({ left: -step(), behavior: reduceMotion ? "auto" : "smooth" }); });
    track.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); $("carNext").click(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); $("carPrev").click(); }
    });
    track.addEventListener("scroll", function () { requestAnimationFrame(update); }, { passive: true });
    window.addEventListener("resize", update);
    update();
  })();

  /* ================================================================ *
   * Scroll reveal
   * ================================================================ */
  var revealables = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add("in"); });
  }

  /* ================================================================ *
   * 3D background — liquid marble shader on three.js
   * ================================================================ *
   * Domain-warped fractal noise (noise fed through noise, twice) makes
   * the flowing folds; lighting the result with its own screen-space
   * slope turns those folds into ridges and valleys, which is what reads
   * as depth rather than a flat gradient. Rendered at reduced resolution
   * and stretched — the look is soft anyway, and it keeps the GPU cost
   * low. Loaded after first paint; the CSS blobs cover until then.
   * ================================================================ */
  var THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js";
  var RENDER_SCALE = 0.55;   // fraction of CSS pixels actually shaded

  // Tunable from index.html: <div id="bg" data-intensity data-speed data-calm>
  function num(v, d, lo, hi) { v = parseFloat(v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); }
  var BG = {
    intensity: num($("bg").getAttribute("data-intensity"), 0.85, 0, 1),
    speed: num($("bg").getAttribute("data-speed"), 1, 0, 4),
    calm: num($("bg").getAttribute("data-calm"), 0.35, 0, 1),
  };

  var VERT = [
    "varying vec2 vUv;",
    "void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  ].join("\n");

  var FRAG = [
    "precision highp float;",
    "uniform float uTime;",
    "uniform vec2 uRes;",
    "uniform vec2 uMouse;",
    "uniform float uStir;",
    "uniform float uIntensity;",
    "varying vec2 vUv;",

    "float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }",
    // quintic fade: smooth first AND second derivatives, so lighting has no grid seams
    "float noise(vec2 p) {",
    "  vec2 i = floor(p), f = fract(p);",
    "  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);",
    "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),",
    "             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);",
    "}",
    "float fbm(vec2 p) {",
    "  float v = 0.0, a = 0.5;",
    "  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);",
    "  for (int i = 0; i < 4; i++) { v += a * noise(p); p = m * p; a *= 0.5; }",
    "  return v;",
    "}",

    // two rounds of domain warping: broad, silky liquid folds
    "float pattern(vec2 p, float t, out vec2 q, out vec2 r) {",
    "  q = vec2(fbm(p + vec2(0.0, t * 0.6)), fbm(p + vec2(5.2, 1.3) - t * 0.5));",
    "  r = vec2(fbm(p + 2.8 * q + vec2(1.7, 9.2) + t * 0.9),",
    "           fbm(p + 2.8 * q + vec2(8.3, 2.8) - t * 0.7));",
    "  return fbm(p + 3.0 * r);",
    "}",

    "void main() {",
    "  float aspect = uRes.x / uRes.y;",
    "  vec2 uv = vUv;",
    "  vec2 base = (uv - 0.5) * vec2(aspect, 1.0);",
    "  vec2 mb = (uMouse - 0.5) * vec2(aspect, 1.0);",
    // cursor stir: swirl the fluid around the pointer; strength follows pointer speed
    "  vec2 d = base - mb;",
    "  float fall = exp(-dot(d, d) * 4.5);",
    "  float sa = fall * uStir;",
    "  base = mb + mat2(cos(sa), -sin(sa), sin(sa), cos(sa)) * d;",
    // rotate and stretch the field so the folds become long diagonal streaks
    "  float ang = 0.55;",
    "  vec2 p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * base;",
    "  p *= vec2(0.5, 1.3);",
    "  float t = uTime * 0.07;",

    "  vec2 q, r, qx, rx;",
    "  float f = pattern(p, t, q, r);",
    // soft relief from the field's own slope (kept gentle: smoke, not gloss)
    "  float e = 0.012;",
    "  float fx = pattern(p + vec2(e, 0.0), t, qx, rx);",
    "  float fy = pattern(p + vec2(0.0, e), t, qx, rx);",
    "  vec3 n = normalize(vec3((f - fx) / e * 0.45, (f - fy) / e * 0.45, 1.0));",
    "  vec3 L = normalize(vec3(-0.45, 0.55, 0.75));",
    "  float diff = clamp(dot(n, L), 0.0, 1.0);",
    "  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 14.0);",

    // palette from the violet reference: white core, lavender, violet, muted purple-grey
    "  vec3 cWhite = vec3(1.0);",
    "  vec3 cIce   = vec3(0.95, 0.93, 0.99);",
    "  vec3 cPeri  = vec3(0.79, 0.68, 0.92);",
    "  vec3 cBlue  = vec3(0.62, 0.45, 0.88);",
    "  vec3 cGrey  = vec3(0.60, 0.53, 0.72);",
    "  vec3 col = mix(cIce, cPeri, smoothstep(0.12, 0.5, f));",
    "  col = mix(col, cBlue, smoothstep(0.4, 0.95, length(q)) * 0.75);",
    "  col = mix(col, cGrey, smoothstep(0.55, 0.85, r.x) * 0.45);",
    "  col = mix(col, cWhite, smoothstep(0.6, 0.85, r.y) * 0.45);",
    // fine wispy streaks riding on the big folds
    "  float w = fbm(p * 3.2 + r * 2.5 + vec2(t * 0.5, 0.0));",
    "  col = mix(col, cWhite, smoothstep(0.6, 0.8, w) * 0.22);",

    // bright glowing core, like the reference
    "  vec2 c = (uv - vec2(0.6, 0.5)) * vec2(aspect, 1.0);",
    "  float glow = exp(-dot(c, c) * 3.2);",
    "  col = mix(col, cWhite, glow * 0.7);",
    // a soft light that follows the cursor
    "  col = mix(col, cWhite, fall * 0.12);",

    "  col *= 0.9 + 0.14 * diff;",
    "  col += spec * 0.1;",

    // blue-grey edges, like the reference
    "  float edge = smoothstep(0.45, 1.15, length((uv - 0.5) * vec2(aspect, 1.0)));",
    "  col = mix(col, vec3(0.55, 0.47, 0.66), edge * 0.5);",
    // intensity: 0 = soft pale fog, 1 = full marble
    "  vec3 soft = mix(vec3(0.93, 0.95, 0.995), cIce, 0.35);",
    "  col = mix(soft, col, uIntensity);",
    "  gl_FragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function webglAvailable() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { return false; }
  }

  function startMarble() {
    if (!webglAvailable()) return;   // CSS blobs remain as the background
    loadScript(THREE_URL).then(function () {
      var THREE = window.THREE;
      if (!THREE) return;

      var renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "low-power" });
      renderer.setPixelRatio(RENDER_SCALE);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      $("bg").appendChild(renderer.domElement);

      var uniforms = {
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2() },
        uMouse: { value: new THREE.Vector2(0.5, 0.5) },
        uStir: { value: 0 },
        uIntensity: { value: BG.intensity },
      };
      var material = new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        depthTest: false,
        depthWrite: false,
      });
      var scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        var buf = renderer.getDrawingBufferSize(new THREE.Vector2());
        uniforms.uRes.value.copy(buf);
      }
      resize();
      window.addEventListener("resize", resize);

      // The pointer stirs the fluid: its position sets where, its speed sets how much.
      var target = { x: 0.5, y: 0.5 };
      var stir = 0;
      window.addEventListener("pointermove", function (e) {
        var x = e.clientX / window.innerWidth;
        var y = 1 - e.clientY / window.innerHeight;
        var speed = Math.hypot(x - target.x, y - target.y);
        stir = Math.min(1.6, stir + speed * 3.2);
        target.x = x;
        target.y = y;
      }, { passive: true });

      var start = performance.now();
      var shown = false;
      function frame(now) {
        uniforms.uTime.value = ((now - start) / 1000) * BG.speed + 40.0;   // start mid-flow, not at a symmetric t=0
        // Calmer behind the reading sections: ease intensity down once past the hero.
        var past = Math.min(1, window.scrollY / Math.max(1, window.innerHeight * 0.8));
        var want = BG.intensity * (1 - BG.calm * past);
        uniforms.uIntensity.value += (want - uniforms.uIntensity.value) * 0.08;
        var m = uniforms.uMouse.value;
        m.x += (target.x - m.x) * 0.08;
        m.y += (target.y - m.y) * 0.08;
        stir *= 0.965;   // the swirl settles slowly once the pointer stops
        uniforms.uStir.value += (stir - uniforms.uStir.value) * 0.1;
        renderer.render(scene, camera);
        if (!shown) {
          shown = true;
          requestAnimationFrame(function () { $("bg").classList.add("gl-ready"); });
        }
        if (!reduceMotion) requestAnimationFrame(frame);
      }
      // Reduced motion: one still frame of the marble, no animation.
      requestAnimationFrame(frame);
    }).catch(function () { /* offline or CDN blocked: CSS blobs remain */ });
  }

  if (document.readyState === "complete") setTimeout(startMarble, 0);
  else window.addEventListener("load", function () { setTimeout(startMarble, 0); });

  /* ================================================================ *
   * Initial route (after auth.js has initialised its tabs)
   * ================================================================ */
  document.addEventListener("DOMContentLoaded", function () {
    var h = window.location.hash;
    if (h === "#signin" || h === "#signup") openAuth(h.slice(1));
    else if (sectionFor(h)) goLanding(h);
    onScroll();
  });
})();
