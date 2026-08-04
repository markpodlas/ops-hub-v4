// ─────────────────────────────────────────────────────────────────────────
// NITM Ops Hub — shared top navigation.
//
// SINGLE SOURCE OF TRUTH for the nav across every module page. To add, rename,
// remove, or reorder a module link, edit MODULES below — every page updates.
//
// Each page just needs:  <script defer src="/shared/nav.js"></script>
// This script removes any old hard-coded top nav and injects the canonical one,
// highlighting the active module based on the current URL.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  // ── Theme (light/dark), saved per browser ──────────────────────────────
  // Apply the saved choice ASAP (before the nav builds) to minimize flash.
  function getTheme() { try { var t = localStorage.getItem("nitm-theme"); return t === "dark" ? "dark" : "light"; } catch (e) { return "light"; } }
  document.documentElement.setAttribute("data-theme", getTheme());

  var themeCss = "" +
    ":root{--bg:#f7f7f5;--panel:#ffffff;--surface:#f1f3f5;--border:#e7e7e3;--border2:#d6dae0;" +
      "--text:#111827;--text2:#374151;--muted:#6b7280;--faint:#9ca3af;color-scheme:light;}" +
    ":root[data-theme=\"dark\"]{--bg:#0f1216;--panel:#181c23;--surface:#232a35;--border:#2b323d;--border2:#3a4350;" +
      "--text:#e6e9ef;--text2:#c2c8d2;--muted:#8a93a2;--faint:#6b7280;color-scheme:dark;}" +
    ".nitm-theme-toggle{position:fixed;top:6px;right:12px;z-index:1001;background:rgba(20,28,40,0.75);border:1px solid rgba(255,255,255,0.12);cursor:pointer;font-size:15px;line-height:1;padding:5px 8px;border-radius:8px;}" +
    ".nitm-theme-toggle:hover{background:rgba(40,52,71,0.95);}";

  var MODULES = [
    { href: "/", label: "Hub" },
    { href: "/calendar/", label: "Calendar" },
    { href: "/inventory/", label: "Inventory" },
    { href: "/3pl/", label: "3PL" },
    { href: "/med-supplies/", label: "Med Supplies" },
    { href: "/tracker/", label: "Tracker" },
    { href: "/video-review/", label: "Video Review" },
    { href: "/social/", label: "Social" },
    { href: "/ambassadors/", label: "Ambassadors" },
    { href: "/growth/", label: "Growth" },
    { href: "/icp/", label: "ICP" },
    { href: "/cx-agent/", label: "CX Agent" },
    { href: "/stage/", label: "Stage Timing" },
    { href: "/campaign-router/", label: "Campaign Router" },
  ];

  var path = location.pathname;
  function isActive(href) {
    if (href === "/") return path === "/" || path === "";
    return path === href || path.indexOf(href) === 0;
  }

  var css = "" +
    ".nitm-nav{background:linear-gradient(180deg,#1a2332 0%,#141c28 100%);" +
      "padding:11px 24px;display:flex;align-items:center;gap:22px;" +
      "border-bottom:1px solid #1e293b;font-family:'DM Sans',system-ui,-apple-system,sans-serif;" +
      "overflow-x:auto;white-space:nowrap;position:sticky;top:0;z-index:1000;}" +
    ".nitm-nav::-webkit-scrollbar{height:0;}" +
    ".nitm-nav .nitm-brand{color:#f1f5f9;font-weight:700;font-size:14px;text-decoration:none;letter-spacing:.5px;flex:0 0 auto;}" +
    ".nitm-nav a:not(.nitm-brand){color:#64748b;text-decoration:none;font-size:13px;font-weight:500;transition:color .15s;flex:0 0 auto;}" +
    ".nitm-nav a:not(.nitm-brand):hover{color:#cbd5e1;}" +
    ".nitm-nav a.nitm-active{color:#f1f5f9;}";

  var style = document.createElement("style");
  style.textContent = themeCss + css;
  document.head.appendChild(style);

  function makeToggle() {
    var btn = document.createElement("button");
    btn.className = "nitm-theme-toggle";
    var sync = function () {
      var dark = document.documentElement.getAttribute("data-theme") === "dark";
      btn.textContent = dark ? "☀️" : "🌙";
      btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    };
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("nitm-theme", next); } catch (e) {}
      sync();
    });
    sync();
    return btn;
  }

  function build() {
    // Remove any pre-existing top nav (old hard-coded ones, or a prior inject).
    var moduleLink = /href="\/(calendar|inventory|3pl|med-supplies|tracker|video-review|social|ambassadors|growth|icp|cx-agent|stage|campaign-router)\/?"/;
    Array.prototype.slice.call(document.querySelectorAll("nav")).forEach(function (n) {
      if (n.classList.contains("nitm-nav")) { n.remove(); return; }
      if (n.classList.contains("top-nav") || moduleLink.test(n.innerHTML)) n.remove();
    });

    var nav = document.createElement("nav");
    nav.className = "nitm-nav";
    var html = '<a class="nitm-brand" href="/">NITM Ops</a>';
    MODULES.forEach(function (m) {
      if (m.href === "/") return; // brand already links to the hub
      html += '<a href="' + m.href + '"' + (isActive(m.href) ? ' class="nitm-active"' : "") + ">" + m.label + "</a>";
    });
    nav.innerHTML = html;
    nav.appendChild(makeToggle());
    document.body.insertBefore(nav, document.body.firstChild);
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
