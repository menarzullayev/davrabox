// The look of each style. A style is only data: colour overrides per mode (held to the WCAG tests for every style x mode) and
// plain CSS variables (radius, shadows, border width, fonts, blur, sheen, background image). Components never branch on the
// style. Rules every style keeps (they are what makes a style usable, not decoration): control borders (border-strong) stay
// visible against every surface at 3:1, text reaches 4.5:1, and the border width never drops below 1px.
import type { StyleDef } from './tokens.js';

const noShadow = { shadow1: 'none', shadow2: 'none', shadow3: 'none' } as const;
const MONO = "ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, 'Liberation Mono', monospace";
const SERIF = "Georgia, 'Times New Roman', 'Noto Serif', serif";
const sharp = { radiusXs: '0px', radiusSm: '0px', radiusMd: '0px', radiusLg: '0px', radiusXl: '0px' } as const;

export const styleDefs = {
  /** The base look the product was built on: soft cards. Overrides nothing. */
  dashboard: {},

  /** Lines and typography: no radius, no shadows, strong rules, white paper. */
  swiss: {
    vars: { ...sharp, radiusLg: '2px', radiusXl: '2px', ...noShadow, fontHeading: "'Onest', system-ui, sans-serif" },
    colours: {
      dark: { border: '#8e96d6', surface1: '#0a0d21', surface2: '#10142f' },
      light: { bg: '#ffffff', surface3: '#f0f1f6', border: '#1a1d3a' },
    },
  },

  /** No shadows, clean fills, quiet borders. */
  flat: {
    vars: { ...noShadow, radiusMd: '8px', radiusLg: '10px' },
    colours: {
      dark: { border: '#1c2147' },
      light: { border: '#dfe2f0' },
    },
  },

  /** Elevation: layered shadows, no hairlines, rounded corners. */
  material: {
    vars: { radiusXs: '4px', radiusSm: '4px', radiusMd: '8px', radiusLg: '12px', radiusXl: '16px' },
    modeVars: {
      dark: {
        shadow1: '0 1px 3px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.6)',
        shadow2: '0 3px 6px rgba(0, 0, 0, 0.55), 0 3px 6px rgba(0, 0, 0, 0.5)',
        shadow3: '0 10px 20px rgba(0, 0, 0, 0.6), 0 6px 6px rgba(0, 0, 0, 0.55)',
      },
      light: {
        shadow1: '0 1px 3px rgba(18, 22, 58, 0.18), 0 1px 2px rgba(18, 22, 58, 0.24)',
        shadow2: '0 3px 6px rgba(18, 22, 58, 0.2), 0 3px 6px rgba(18, 22, 58, 0.22)',
        shadow3: '0 10px 20px rgba(18, 22, 58, 0.22), 0 6px 6px rgba(18, 22, 58, 0.2)',
      },
    },
    colours: {
      dark: { surface1: '#151a3a', surface2: '#1c2247', surface3: '#262d5a', border: '#151a3a' },
      light: { border: '#f4f5fb' },
    },
  },

  /** Serif headings, hairline rules, warm paper. */
  editorial: {
    vars: { fontHeading: SERIF, radiusXs: '0px', radiusSm: '2px', radiusMd: '2px', radiusLg: '3px', radiusXl: '4px', ...noShadow },
    colours: {
      dark: { bg: '#14110d', surface1: '#1b1712', surface2: '#221d17', surface3: '#2c261e', text: '#f2ede3', textMuted: '#c9c1b0', textSubtle: '#aaa391', border: '#3a3328', borderStrong: '#8f8672' },
      light: { bg: '#faf6ee', surface1: '#fffdf8', surface2: '#fffdf8', surface3: '#f1ebde', text: '#1c1a17', textMuted: '#5a554b', textSubtle: '#6a6458', border: '#ddd5c4', borderStrong: '#7a7260' },
    },
  },

  /** Thick borders, hard offset shadows, sharp corners, loud accent. */
  neobrutalism: {
    vars: { ...sharp, borderW: '3px' },
    modeVars: {
      dark: { shadow1: '3px 3px 0 #eef0fc', shadow2: '5px 5px 0 #eef0fc', shadow3: '8px 8px 0 #eef0fc' },
      light: { shadow1: '3px 3px 0 #111111', shadow2: '5px 5px 0 #111111', shadow3: '8px 8px 0 #111111' },
    },
    colours: {
      dark: { border: '#eef0fc', borderStrong: '#eef0fc' },
      light: {
        bg: '#fff4d6', surface1: '#ffffff', surface2: '#ffffff', surface3: '#ffe9a8', border: '#111111', borderStrong: '#111111',
        accent: '#1d4ed8', accentHover: '#1e40af', accentActive: '#1e3a8a', accentSoft: '#dbe6ff', textOnAccent: '#ffffff', focusRing: '#2f6bff',
      },
    },
  },

  /** Monospace, sharp, phosphor green on black. */
  terminal: {
    vars: { ...sharp, ...noShadow, fontSans: MONO, fontHeading: MONO },
    colours: {
      dark: {
        bg: '#000000', surface1: '#050a05', surface2: '#0a140a', surface3: '#102010', text: '#d6ffd6', textMuted: '#a6e0a6', textSubtle: '#8cc58c',
        border: '#1f4d1f', borderStrong: '#3fa03f', focusRing: '#7dffa0', accent: '#33ff66', accentHover: '#66ff8c', accentActive: '#22cc4f', accentSoft: '#0d3318', textOnAccent: '#001a08',
      },
      light: {
        bg: '#f2f7f2', surface1: '#ffffff', surface2: '#f7fbf7', surface3: '#e6efe6', text: '#0b2e12', textMuted: '#2f5a39', textSubtle: '#3f6a49',
        border: '#9cc09c', borderStrong: '#2e7a3f', focusRing: '#0a7a2a', accent: '#0a7a2a', accentHover: '#08631f', accentActive: '#065016', accentSoft: '#e3f3e6', textOnAccent: '#ffffff',
      },
    },
  },

  /** Frosted surfaces over a soft gradient. */
  glassmorphism: {
    vars: { blur: '16px', radiusLg: '18px', radiusXl: '24px' },
    modeVars: {
      dark: {
        bgImage: 'radial-gradient(1100px 600px at 8% -10%, rgba(76, 86, 190, 0.5), transparent), radial-gradient(900px 520px at 100% 0%, rgba(20, 150, 140, 0.4), transparent)',
        surface1: 'rgba(23, 28, 61, 0.62)', surface2: 'rgba(32, 38, 77, 0.7)', surface3: 'rgba(42, 49, 99, 0.74)', border: 'rgba(238, 240, 252, 0.2)',
        shadow1: '0 4px 14px rgba(0, 0, 0, 0.35)', shadow2: '0 10px 30px rgba(0, 0, 0, 0.4)', shadow3: '0 24px 60px rgba(0, 0, 0, 0.5)',
      },
      light: {
        bgImage: 'radial-gradient(1100px 600px at 8% -10%, rgba(125, 138, 255, 0.35), transparent), radial-gradient(900px 520px at 100% 0%, rgba(61, 214, 200, 0.3), transparent)',
        surface1: 'rgba(255, 255, 255, 0.66)', surface2: 'rgba(255, 255, 255, 0.78)', surface3: 'rgba(236, 238, 248, 0.8)', border: 'rgba(18, 22, 58, 0.14)',
        shadow1: '0 4px 14px rgba(18, 22, 58, 0.1)', shadow2: '0 10px 30px rgba(18, 22, 58, 0.14)', shadow3: '0 24px 60px rgba(18, 22, 58, 0.2)',
      },
    },
  },

  /** Soft embossing: surfaces share the page colour and rise or sink with paired light and dark shadows. */
  neumorphism: {
    vars: { radiusMd: '14px', radiusLg: '18px', radiusXl: '24px' },
    colours: {
      dark: { bg: '#1b1f3b', surface1: '#1b1f3b', surface2: '#1b1f3b', surface3: '#232850', border: '#1b1f3b' },
      light: { bg: '#e6e9f2', surface1: '#e6e9f2', surface2: '#e6e9f2', surface3: '#dde1ec', border: '#e6e9f2' },
    },
    modeVars: {
      dark: { shadow1: '4px 4px 8px #10132a, -4px -4px 8px #262b50', shadow2: '8px 8px 16px #10132a, -8px -8px 16px #262b50', shadow3: '12px 12px 24px #10132a, -12px -12px 24px #262b50' },
      light: { shadow1: '4px 4px 8px #c4c9d8, -4px -4px 8px #ffffff', shadow2: '8px 8px 16px #c4c9d8, -8px -8px 16px #ffffff', shadow3: '12px 12px 24px #c4c9d8, -12px -12px 24px #ffffff' },
    },
  },

  /** Puffy, rounded, dimensional surfaces in candy colours. */
  claymorphism: {
    vars: { radiusSm: '12px', radiusMd: '16px', radiusLg: '22px', radiusXl: '28px', borderW: '2px' },
    modeVars: {
      dark: {
        shadow1: 'inset -3px -3px 6px rgba(0, 0, 0, 0.3), inset 3px 3px 6px rgba(255, 255, 255, 0.08), 3px 5px 10px rgba(0, 0, 0, 0.4)',
        shadow2: 'inset -4px -4px 8px rgba(0, 0, 0, 0.3), inset 4px 4px 8px rgba(255, 255, 255, 0.1), 6px 8px 16px rgba(0, 0, 0, 0.45)',
        shadow3: 'inset -6px -6px 12px rgba(0, 0, 0, 0.3), inset 6px 6px 12px rgba(255, 255, 255, 0.1), 10px 14px 28px rgba(0, 0, 0, 0.5)',
      },
      light: {
        shadow1: 'inset -3px -3px 6px rgba(120, 80, 140, 0.16), inset 3px 3px 6px rgba(255, 255, 255, 0.9), 3px 5px 10px rgba(120, 80, 140, 0.2)',
        shadow2: 'inset -4px -4px 8px rgba(120, 80, 140, 0.16), inset 4px 4px 8px rgba(255, 255, 255, 0.9), 6px 8px 16px rgba(120, 80, 140, 0.24)',
        shadow3: 'inset -6px -6px 12px rgba(120, 80, 140, 0.16), inset 6px 6px 12px rgba(255, 255, 255, 0.9), 10px 14px 28px rgba(120, 80, 140, 0.28)',
      },
    },
    colours: {
      dark: { bg: '#1f1530', surface1: '#2a1c40', surface2: '#34244f', surface3: '#402e5f', border: '#5a4380', borderStrong: '#9a80c4' },
      light: { bg: '#fdeef6', surface1: '#fff5fa', surface2: '#ffffff', surface3: '#f7dcec', border: '#ecc3dc' },
    },
  },

  /** A gradient field behind frosted panels. */
  aurora: {
    vars: { blur: '12px', radiusLg: '16px', radiusXl: '22px' },
    modeVars: {
      dark: {
        bgImage: 'linear-gradient(135deg, #0a0d21 0%, #14214f 38%, #0e4f55 68%, #3b1d5c 100%)',
        surface1: 'rgba(16, 20, 47, 0.62)', surface2: 'rgba(23, 28, 61, 0.7)', surface3: 'rgba(32, 38, 77, 0.76)', border: 'rgba(238, 240, 252, 0.18)',
      },
      light: {
        bgImage: 'linear-gradient(135deg, #f4f5fb 0%, #dff7f3 45%, #e9e1fb 100%)',
        surface1: 'rgba(255, 255, 255, 0.6)', surface2: 'rgba(255, 255, 255, 0.74)', surface3: 'rgba(236, 238, 248, 0.78)', border: 'rgba(18, 22, 58, 0.14)',
      },
    },
  },

  /** Metal and relief: sheen over surfaces, bevelled highlights. */
  skeuomorphism: {
    vars: { radiusMd: '8px', radiusLg: '10px', sheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(0, 0, 0, 0.14))' },
    modeVars: {
      dark: {
        shadow1: 'inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 1px 3px rgba(0, 0, 0, 0.55)',
        shadow2: 'inset 0 1px 0 rgba(255, 255, 255, 0.26), 0 4px 10px rgba(0, 0, 0, 0.5)',
        shadow3: 'inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 12px 28px rgba(0, 0, 0, 0.6)',
      },
      light: {
        shadow1: 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 3px rgba(18, 22, 58, 0.3)',
        shadow2: 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 4px 10px rgba(18, 22, 58, 0.28)',
        shadow3: 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 12px 28px rgba(18, 22, 58, 0.34)',
      },
    },
    colours: {
      dark: { surface1: '#1d2240', surface2: '#252b4f', surface3: '#272d52' },
      light: { surface1: '#fafbfe', surface2: '#f1f3fa', surface3: '#e2e6f3' },
    },
  },

  /**
   * Liquid glass: translucent material that bends the light of what is behind it (an SVG displacement map in the backdrop
   * filter, see apps/web/src/glass), continuous large corners, capsules, a floating control bar and spring motion. Behind the
   * glass is a deep colour field (or live video); the glass opacity is chosen so text stays AA over pure black and pure white.
   */
  'liquid-glass': {
    ownChrome: true,
    vars: {
      radiusXs: '8px', radiusSm: '12px', radiusMd: '16px', radiusLg: '22px', radiusXl: '30px',
      blur: '18px',
      fontSans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Onest', system-ui, 'Segoe UI', Roboto, sans-serif",
      fontHeading: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Onest', system-ui, 'Segoe UI', Roboto, sans-serif",
      controlH: '44px',
      // Glass material: the CSS part (blur + vibrancy). The refraction (displacement) is added by the runtime where supported.
      glassBlur: '14px',
      glassSat: '1.9',
      glassRefractBlur: '3px',
      // Springs (CSS linear() easing sampled from a damped spring): a bouncy one for things that appear, a calm one for moves.
      easeSpring: 'linear(0, 0.053, 0.184, 0.355, 0.535, 0.705, 0.85, 0.964, 1.045, 1.096, 1.121, 1.126, 1.117, 1.099, 1.077, 1.054, 1.033, 1.016, 1.002, 0.993, 0.987, 0.984, 0.984, 0.986, 1)',
      easeSpringCalm: 'linear(0, 0.053, 0.175, 0.324, 0.473, 0.609, 0.723, 0.814, 0.883, 0.934, 0.968, 0.991, 1.005, 1.012, 1.015, 1.015, 1)',
      durSpring: '400ms',
    },
    glass: {
      dark: { tint: '#0c1029', clear: 0.7, regular: 0.9 },
      light: { tint: '#ffffff', clear: 0.76, regular: 0.9 },
    },
    colours: {
      dark: { bg: '#060818', surface1: '#0f1430', surface2: '#151b3c', surface3: '#1e2550', border: '#2c3468' },
      light: { bg: '#eaeef8', surface1: '#ffffff', surface2: '#ffffff', surface3: '#e6e9f5', border: '#d3d8ec' },
    },
    modeVars: {
      dark: {
        bgImage:
          'radial-gradient(900px 620px at 12% 8%, rgba(61, 214, 200, 0.34), transparent 62%), radial-gradient(820px 600px at 92% 18%, rgba(118, 92, 255, 0.36), transparent 60%), radial-gradient(900px 700px at 70% 100%, rgba(244, 194, 79, 0.16), transparent 60%), linear-gradient(160deg, #060818 0%, #0b1030 55%, #070a1d 100%)',
        glassRim: 'inset 0 1px 0 rgba(255, 255, 255, 0.28), inset 0 -1px 0 rgba(255, 255, 255, 0.06), inset 0 0 0 1px rgba(255, 255, 255, 0.12)',
        glassSheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0) 42%)',
        glassShadow: '0 10px 34px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.28)',
        glassPressed: 'rgba(255, 255, 255, 0.1)',
        shadow1: '0 2px 10px rgba(0, 0, 0, 0.32)',
        shadow2: '0 10px 30px rgba(0, 0, 0, 0.4)',
        shadow3: '0 24px 64px rgba(0, 0, 0, 0.52)',
      },
      light: {
        bgImage:
          'radial-gradient(900px 620px at 12% 8%, rgba(61, 214, 200, 0.42), transparent 62%), radial-gradient(820px 600px at 92% 18%, rgba(140, 120, 255, 0.36), transparent 60%), radial-gradient(900px 700px at 70% 100%, rgba(255, 196, 120, 0.4), transparent 60%), linear-gradient(160deg, #eef1fa 0%, #e4e9f8 55%, #f1eef8 100%)',
        glassRim: 'inset 0 1px 0 rgba(255, 255, 255, 0.9), inset 0 -1px 0 rgba(255, 255, 255, 0.4), inset 0 0 0 1px rgba(18, 22, 58, 0.08)',
        glassSheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0) 45%)',
        glassShadow: '0 10px 30px rgba(18, 22, 58, 0.16), 0 2px 8px rgba(18, 22, 58, 0.1)',
        glassPressed: 'rgba(18, 22, 58, 0.06)',
        shadow1: '0 2px 10px rgba(18, 22, 58, 0.08)',
        shadow2: '0 10px 30px rgba(18, 22, 58, 0.14)',
        shadow3: '0 24px 64px rgba(18, 22, 58, 0.2)',
      },
    },
  },
} as const satisfies Record<string, StyleDef>;
