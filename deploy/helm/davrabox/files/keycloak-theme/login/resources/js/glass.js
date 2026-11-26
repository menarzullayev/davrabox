// Liquid-glass refraction for the sign-in card (the app's own runtime is apps/web/src/glass; this is the same displacement
// map in plain ES5, because the sign-in page is Keycloak's and loads no app code). It only acts when davrabox.js has set
// data-style="liquid-glass", the browser is a Chromium engine (the only one that draws an SVG filter in backdrop-filter),
// and nothing asks for less: reduced transparency, more contrast, forced colours or a low, discharging battery. Otherwise the
// frosted CSS glass of davrabox.css shows. Nothing is read from the page except the card's size and corner radius.
(function () {
  var SVG = 'http://www.w3.org/2000/svg';
  var CARD = '.pf-v5-c-login__main';

  function chromium() {
    var b = navigator.userAgentData && navigator.userAgentData.brands;
    if (b && b.some(function (x) { return /Chromium/i.test(x.brand); })) return true;
    var ua = navigator.userAgent || '';
    return /\bChrome\/\d+/.test(ua) && !/\b(CriOS|EdgiOS|FxiOS|Firefox)\//.test(ua);
  }
  function reduced() {
    return ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].some(function (q) {
      return window.matchMedia && window.matchMedia(q).matches;
    });
  }

  // Same profile and direction as apps/web/src/glass/map.ts (sample from further inside near the rim).
  function map(w, h, r, bezel) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    var img = ctx.createImageData(w, h);
    var d = img.data;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    bezel = Math.max(1, Math.min(bezel, w / 2, h / 2));
    for (var j = 0; j < h; j++) {
      var py = j + 0.5 - h / 2;
      var qy = Math.abs(py) - (h / 2 - r);
      for (var i = 0; i < w; i++) {
        var px = i + 0.5 - w / 2;
        var qx = Math.abs(px) - (w / 2 - r);
        var ox = Math.max(qx, 0);
        var oy = Math.max(qy, 0);
        var nx = 0;
        var ny = 0;
        var dist;
        if (ox > 0 && oy > 0) {
          var len = Math.sqrt(ox * ox + oy * oy);
          dist = len - r;
          nx = (ox / len) * (px < 0 ? -1 : 1);
          ny = (oy / len) * (py < 0 ? -1 : 1);
        } else {
          dist = Math.max(qx, qy) - r;
          if (qx > qy) nx = px < 0 ? -1 : 1;
          else ny = py < 0 ? -1 : 1;
        }
        var depth = -dist;
        var m = 0;
        if (depth < bezel) {
          var t = 1 - Math.max(0, depth) / bezel;
          m = t * t * (3 - 2 * t) * t;
        }
        var k = (j * w + i) * 4;
        d[k] = 128 - Math.round(nx * m * 127);
        d[k + 1] = 128 - Math.round(ny * m * 127);
        d[k + 2] = 128;
        d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  var svg = null;
  var lastKey = '';
  var saver = false;
  function apply() {
    var card = document.querySelector(CARD);
    if (!card) return;
    var on = document.documentElement.getAttribute('data-style') === 'liquid-glass' && chromium() && !reduced() && !saver;
    if (!on) {
      card.style.removeProperty('--dx-refract');
      return;
    }
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    if (w < 8 || h < 8) return;
    var r = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
    var key = w + 'x' + h + ':' + r;
    if (key === lastKey) return;
    lastKey = key;
    var bezel = Math.max(8, Math.min(28, Math.min(w, h) * 0.34));
    var url = map(w, h, r, bezel);
    if (!url) return;
    if (!svg) {
      svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.appendChild(svg);
    }
    svg.innerHTML = '';
    var f = document.createElementNS(SVG, 'filter');
    f.setAttribute('id', 'dx-kc-refract');
    f.setAttribute('filterUnits', 'userSpaceOnUse');
    f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    var fi = document.createElementNS(SVG, 'feImage');
    var fd = document.createElementNS(SVG, 'feDisplacementMap');
    [f, fi].forEach(function (n) {
      n.setAttribute('x', '0');
      n.setAttribute('y', '0');
      n.setAttribute('width', String(w));
      n.setAttribute('height', String(h));
    });
    fi.setAttribute('href', url);
    fi.setAttribute('preserveAspectRatio', 'none');
    fi.setAttribute('result', 'map');
    fd.setAttribute('in', 'SourceGraphic');
    fd.setAttribute('in2', 'map');
    fd.setAttribute('scale', String(Math.round(bezel * 1.35)));
    fd.setAttribute('xChannelSelector', 'R');
    fd.setAttribute('yChannelSelector', 'G');
    f.appendChild(fi);
    f.appendChild(fd);
    svg.appendChild(f);
    card.style.setProperty('--dx-refract', 'url(#dx-kc-refract) blur(3px) saturate(1.9)');
  }

  function init() {
    apply();
    if (window.ResizeObserver) {
      var card = document.querySelector(CARD);
      if (card) new ResizeObserver(function () { apply(); }).observe(card);
    }
    ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].forEach(function (q) {
      var m = window.matchMedia && window.matchMedia(q);
      if (m && m.addEventListener) m.addEventListener('change', function () { lastKey = ''; apply(); });
    });
    if (navigator.getBattery) {
      navigator.getBattery().then(function (b) {
        function upd() {
          saver = !b.charging && b.level <= 0.2;
          lastKey = '';
          apply();
        }
        upd();
        b.addEventListener('levelchange', upd);
        b.addEventListener('chargingchange', upd);
      }).catch(function () {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
