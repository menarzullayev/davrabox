// Applies the saved theme before first paint (external file: the CSP forbids inline scripts). Dark is the default.
// On the landing page (path "/") it also starts the hero screenshot early: the image is the LCP element and would otherwise
// be discovered only after the app bundle ran.
var theme = 'dark';
try {
  var saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') {
    theme = saved;
    document.documentElement.setAttribute('data-theme', saved);
  }
} catch (e) {
  /* storage unavailable: stay on the default theme */
}
if (location.pathname === '/' || location.pathname === '') {
  var l = document.createElement('link');
  l.rel = 'preload';
  l.as = 'image';
  l.type = 'image/webp';
  l.href = '/landing/call-davra-' + theme + '-1280.webp';
  l.setAttribute('imagesrcset', '/landing/call-davra-' + theme + '-640.webp 640w, /landing/call-davra-' + theme + '-1280.webp 1280w');
  l.setAttribute('imagesizes', '(max-width: 959px) calc(100vw - 48px), 640px');
  l.setAttribute('fetchpriority', 'high');
  document.head.appendChild(l);
}
