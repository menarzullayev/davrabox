import { contextBridge } from 'electron';

// The only thing the page learns about the shell: that it runs inside it, and on which platform.
// No ipcRenderer, no Node.js APIs and no file system access are exposed.
contextBridge.exposeInMainWorld('davraDesktop', Object.freeze({ isDesktop: true, platform: process.platform }));
