import { contextBridge, ipcRenderer } from 'electron';

// What the page learns about the shell: that it runs inside it, and on which platform. The one thing it may tell the
// shell is its colour mode ('light' or 'dark', checked again in the main process) so the title bar matches.
// No ipcRenderer, no Node.js APIs and no file system access are exposed.
contextBridge.exposeInMainWorld(
  'davraDesktop',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    setTheme: (mode: unknown) => {
      if (mode === 'light' || mode === 'dark') ipcRenderer.send('davra:theme', mode);
    },
  }),
);
