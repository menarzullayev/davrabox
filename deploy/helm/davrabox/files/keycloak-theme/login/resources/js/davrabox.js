// Makes the sign-in page follow the look the person chose in the app. The app and this page share one origin, so the choice
// the app keeps in localStorage ("theme": dark or light) is readable here. Nothing from storage is used except the two names.
// The stock theme also sets its own dark class from the browser's colour scheme, so the choice is re-applied whenever it changes.
(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (e) {
    /* storage unavailable: the default (dark) applies */
  }
  var root = document.documentElement;
  function apply() {
    root.setAttribute('data-theme', theme);
    var has = root.classList.contains('pf-v5-theme-dark');
    if (theme === 'dark' && !has) root.classList.add('pf-v5-theme-dark');
    if (theme === 'light' && has) root.classList.remove('pf-v5-theme-dark');
  }
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
})();
