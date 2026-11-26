// Makes the sign-in page follow the look the person chose in the app. The app and this page share one origin, so the choice
// the app keeps in localStorage ("theme": dark or light, "style": a short id) is readable here. Nothing else from storage is used.
// The stock theme also sets its own dark class from the browser's colour scheme, so the choice is re-applied whenever it changes.
(function () {
  var theme = 'dark';
  var style = 'liquid-glass'; // the product default when the app has saved no choice in this browser
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
    // The app's style too (only a short id): a style with a sign-in look of its own (liquid-glass) applies it here.
    var savedStyle = localStorage.getItem('style');
    if (savedStyle && /^[a-z-]{1,32}$/.test(savedStyle)) style = savedStyle;
  } catch (e) {
    /* storage unavailable: the default (dark) applies */
  }
  var root = document.documentElement;
  function apply() {
    root.setAttribute('data-theme', theme);
    if (style) root.setAttribute('data-style', style);
    var has = root.classList.contains('pf-v5-theme-dark');
    if (theme === 'dark' && !has) root.classList.add('pf-v5-theme-dark');
    if (theme === 'light' && has) root.classList.remove('pf-v5-theme-dark');
  }
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
})();

// The language choice as three short buttons (links) instead of the browser's own dropdown: no native popup, no script needed to follow them.
(function () {
  function init() {
  var select = document.getElementById('login-select-toggle');
  if (!select || !select.options.length) return;
  var box = document.createElement('div');
  box.className = 'dx-kc-langs';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', select.getAttribute('aria-label') || 'Language');
  Array.prototype.forEach.call(select.options, function (o) {
    var m = /[?&]kc_locale=([a-z-]+)/i.exec(o.value);
    var a = document.createElement('a');
    a.href = o.value;
    a.textContent = (m ? m[1] : o.text).toUpperCase().slice(0, 2);
    a.title = o.text.trim();
    a.setAttribute('aria-label', o.text.trim());
    a.setAttribute('lang', m ? m[1] : '');
    if (o.selected) a.setAttribute('aria-current', 'true');
    box.appendChild(a);
  });
  var holder = select.closest('.pf-v5-c-login__main-header-utilities') || select.parentNode;
  holder.appendChild(box);
  }
  // The script is loaded in <head>: wait for the page before looking for the language select.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
