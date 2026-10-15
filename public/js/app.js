// Progressive enhancements for the app shell. Every page works without
// this file: the sidebar simply stays visible as a normal list.
(function () {
  'use strict';
  var root = document.documentElement;
  var sidebar = document.getElementById('sidebar');
  var overlay = document.querySelector('.nav-overlay');
  var navToggle = document.querySelector('.nav-toggle');
  var collapseToggle = document.querySelector('.collapse-toggle');
  var mobile = window.matchMedia('(max-width: 880px)');

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode: fine */ } }

  // ---- Desktop: collapse the sidebar to an icon rail, remembered per browser
  if (collapseToggle && sidebar) {
    collapseToggle.hidden = false;
    var syncCollapse = function () {
      var collapsed = root.classList.contains('sidebar-collapsed');
      collapseToggle.setAttribute('aria-pressed', String(collapsed));
      var label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      collapseToggle.title = label;
      collapseToggle.querySelector('.sr-only').textContent = label;
    };
    collapseToggle.addEventListener('click', function () {
      root.classList.toggle('sidebar-collapsed');
      store('fws.sidebar', root.classList.contains('sidebar-collapsed') ? 'collapsed' : 'expanded');
      syncCollapse();
    });
    syncCollapse();
  }

  // ---- Narrow screens: sidebar becomes a slide-in drawer
  if (navToggle && sidebar && overlay) {
    navToggle.hidden = false;
    var lastFocus = null;
    var setOpen = function (open) {
      root.classList.toggle('nav-open', open);
      navToggle.setAttribute('aria-expanded', String(open));
      overlay.hidden = !open;
      if (open) {
        lastFocus = document.activeElement;
        var first = sidebar.querySelector('a');
        if (first) first.focus();
      } else if (lastFocus) {
        lastFocus.focus();
      }
    };
    navToggle.addEventListener('click', function () { setOpen(!root.classList.contains('nav-open')); });
    overlay.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('nav-open')) setOpen(false);
    });
    mobile.addEventListener('change', function () { if (!mobile.matches) setOpen(false); });
  }

  // ---- Toasts: dismissible, auto-hide after 6 s (errors stay until closed)
  document.querySelectorAll('.toast').forEach(function (toast) {
    var close = function () { toast.classList.add('toast-hide'); setTimeout(function () { toast.remove(); }, 200); };
    toast.querySelector('.toast-close').addEventListener('click', close);
    if (toast.classList.contains('toast-success')) setTimeout(close, 6000);
  });
})();
