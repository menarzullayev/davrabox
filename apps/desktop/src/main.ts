import { app, BrowserWindow, Menu, desktopCapturer, dialog, session, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { DEEP_LINK_SCHEME, appOriginFrom, isAllowedNavigation, isAllowedPermission, isSafeExternalUrl, parseDeepLink } from './security';

// The desktop app is a hardened shell around the web client. It opens no local port, exposes no Node.js to the page,
// refuses navigation away from the app origin and only passes a minimal, fixed bridge through the preload script.
const APP_ORIGIN = appOriginFrom(process.env.DAVRABOX_URL);
const START_URL = `${APP_ORIGIN}/`;

let win: BrowserWindow | null = null;
let pendingLink: string | null = null;

function openMeeting(code: string): void {
  if (!win) return;
  void win.loadURL(`${START_URL}?join=${code}`);
  if (win.isMinimized()) win.restore();
  win.focus();
}

function handleDeepLink(raw: string | undefined): void {
  if (!raw) return;
  const link = parseDeepLink(raw);
  if (!link) return;
  if (win) openMeeting(link.code);
  else pendingLink = link.code;
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(isAllowedPermission(permission, wc.getURL(), APP_ORIGIN)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isAllowedPermission(permission, requestingOrigin, APP_ORIGIN));
  ses.setDevicePermissionHandler(() => false); // no USB/HID/serial devices
  // Screen sharing: the web client calls getDisplayMedia; the shell decides which source is offered.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!isAllowedNavigation(request.frame?.url ?? '', APP_ORIGIN)) return callback({});
      void (async () => {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length === 0) return callback({});
        let chosen = sources[0]!;
        if (sources.length > 1) {
          const buttons = sources.slice(0, 4).map((s) => s.name);
          const { response } = await dialog.showMessageBox(win ?? undefined!, { type: 'question', message: 'Which screen do you want to share?', buttons: [...buttons, 'Cancel'], cancelId: buttons.length });
          if (response >= buttons.length) return callback({});
          chosen = sources[response]!;
        }
        callback({ video: chosen, audio: process.platform === 'win32' ? 'loopback' : undefined });
      })();
    },
    { useSystemPicker: false },
  );
}

function hardenContents(wc: WebContents): void {
  wc.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, APP_ORIGIN)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });
  wc.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, APP_ORIGIN)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1419',
    title: 'DavraBox',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(pendingLink ? `${START_URL}?join=${pendingLink}` : START_URL);
  pendingLink = null;
}

app.on('web-contents-created', (_e, wc) => {
  hardenContents(wc);
  wc.on('will-attach-webview', (event) => event.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    handleDeepLink(argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`)));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  void app.whenReady().then(() => {
    hardenSession();
    if (app.isPackaged) Menu.setApplicationMenu(null);
    handleDeepLink(process.argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`)));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
