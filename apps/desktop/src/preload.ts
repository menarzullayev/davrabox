import { contextBridge, ipcRenderer } from 'electron';

// What the page learns about the shell: that it runs inside it, and on which platform. The one thing it may tell the
// shell is its colour mode ('light' or 'dark', checked again in the main process) and, for a style with its own page
// background, the style's name (a short id, looked up in a fixed table there), so the title bar and window match.
// No ipcRenderer, no Node.js APIs and no file system access are exposed.
contextBridge.exposeInMainWorld(
  'davraDesktop',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    setTheme: (mode: unknown, style?: unknown) => {
      if (mode !== 'light' && mode !== 'dark') return;
      if (typeof style === 'string' && /^[a-z-]{1,32}$/.test(style)) ipcRenderer.send('davra:theme', mode, style);
      else ipcRenderer.send('davra:theme', mode);
    },
  }),
);
