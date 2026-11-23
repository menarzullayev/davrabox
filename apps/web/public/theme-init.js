// Applies the saved theme before first paint (external file: the CSP forbids inline scripts). Dark is the default.
try {
  var theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
} catch (e) {
  /* storage unavailable: stay on the default theme */
}
