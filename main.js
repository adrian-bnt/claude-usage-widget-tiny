const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { fetchViaWindow } = require('./src/fetch-via-window');

const store = new Store({
  encryptionKey: 'claude-widget-secure-key-2024'
});

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let tray = null;

const WIDGET_WIDTH = 530;
const WIDGET_HEIGHT = 155;
const TINY_WIDTH = 230;
const TINY_HEIGHT = 38;

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// Set sessionKey as a cookie in Electron's session
async function setSessionCookie(sessionKey) {
  await session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true
  });
  debugLog('sessionKey cookie set in Electron session');
}

function createMainWindow() {
  const mode = store.get('settings.widgetMode', 'tiny');
  const isTiny = mode === 'tiny';
  const savedPosition = store.get('windowPosition');

  // Default position: bottom-right of primary display
  let defaultX, defaultY;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
  if (isTiny) {
    defaultX = screenW - TINY_WIDTH - 20;
    defaultY = screenH - TINY_HEIGHT - 60;
  } else {
    defaultX = screenW - WIDGET_WIDTH - 20;
    defaultY = screenH - WIDGET_HEIGHT - 60;
  }

  const windowOptions = {
    width: isTiny ? TINY_WIDTH : WIDGET_WIDTH,
    height: isTiny ? TINY_HEIGHT : WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  // Use saved position, but reset if it's too close to the bottom edge
  // (fixes overlap from previous 20px offset)
  if (savedPosition && savedPosition.y < screenH - 80) {
    windowOptions.x = savedPosition.x;
    windowOptions.y = savedPosition.y;
  } else {
    windowOptions.x = defaultX;
    windowOptions.y = defaultY;
    store.delete('windowPosition');
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');

  mainWindow.on('move', () => {
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;

    // Clamp so the window stays fully within the work area
    let clamped = false;
    let x = bounds.x;
    let y = bounds.y;

    if (x < workArea.x) { x = workArea.x; clamped = true; }
    if (y < workArea.y) { y = workArea.y; clamped = true; }
    if (x + bounds.width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - bounds.width;
      clamped = true;
    }
    if (y + bounds.height > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - bounds.height;
      clamped = true;
    }

    if (clamped) {
      mainWindow.setPosition(x, y);
    }

    store.set('windowPosition', { x, y });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : 'assets/tray-icon.png'));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Widget',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createMainWindow();
          }
        }
      },
      {
        label: 'Refresh',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('refresh-usage');
          }
        }
      },
      {
        label: 'Toggle Size',
        click: () => {
          if (mainWindow) {
            const current = store.get('settings.widgetMode', 'tiny');
            const newMode = current === 'tiny' ? 'full' : 'tiny';
            store.set('settings.widgetMode', newMode);
            if (newMode === 'tiny') {
              mainWindow.setContentSize(TINY_WIDTH, TINY_HEIGHT);
            } else {
              mainWindow.setContentSize(WIDGET_WIDTH, WIDGET_HEIGHT);
            }
            clampToScreen();
            mainWindow.webContents.send('mode-changed', newMode);
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Log Out',
        click: async () => {
          store.delete('sessionKey');
          store.delete('organizationId');
          // Clear all Claude.ai cookies and session storage
          const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
          for (const cookie of cookies) {
            await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
          }
          await session.defaultSession.clearStorageData({
            storages: ['localstorage', 'sessionstorage', 'cachestorage'],
            origin: 'https://claude.ai'
          });
          if (mainWindow) {
            mainWindow.webContents.send('session-expired');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.quit();
        }
      }
    ]);

    tray.setToolTip('Claude Usage Widget');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      }
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

// IPC Handlers
ipcMain.handle('get-credentials', () => {
  return {
    sessionKey: store.get('sessionKey'),
    organizationId: store.get('organizationId')
  };
});

ipcMain.handle('save-credentials', async (event, { sessionKey, organizationId }) => {
  store.set('sessionKey', sessionKey);
  if (organizationId) {
    store.set('organizationId', organizationId);
  }
  // Also set cookie in Electron session for window-based fetching
  await setSessionCookie(sessionKey);
  return true;
});

ipcMain.handle('delete-credentials', async () => {
  store.delete('sessionKey');
  store.delete('organizationId');
  // Remove all Claude.ai cookies
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
  }
  // Clear any cached data from the Electron session (storage, cache)
  // so nothing lingers on shared machines
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    origin: 'https://claude.ai'
  });
  return true;
});

// Validate a sessionKey by fetching org ID via hidden BrowserWindow
ipcMain.handle('validate-session-key', async (event, sessionKey) => {
  debugLog('Validating session key:', sessionKey.substring(0, 20) + '...');
  try {
    // Set the cookie in Electron's session first
    await setSessionCookie(sessionKey);

    // Fetch organizations using hidden BrowserWindow (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations');

    if (data && Array.isArray(data) && data.length > 0) {
      const orgId = data[0].uuid || data[0].id;
      debugLog('Session key validated, org ID:', orgId);
      return { success: true, organizationId: orgId };
    }

    // Check if it's an error response
    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
    return { success: false, error: error.message };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('close-window', () => {
  app.quit();
});

ipcMain.on('resize-window', (event, height) => {
  if (mainWindow) {
    const mode = store.get('settings.widgetMode', 'tiny');
    if (mode === 'full') {
      mainWindow.setContentSize(WIDGET_WIDTH, height);
      clampToScreen();
    }
  }
});

ipcMain.handle('get-window-position', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    mainWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

// Clamp window position to stay within the display work area
function clampToScreen() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;

  let x = bounds.x;
  let y = bounds.y;

  if (x < workArea.x) x = workArea.x;
  if (y < workArea.y) y = workArea.y;
  if (x + bounds.width > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - bounds.width;
  }
  if (y + bounds.height > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - bounds.height;
  }

  if (x !== bounds.x || y !== bounds.y) {
    mainWindow.setPosition(x, y);
  }
}

// Widget mode toggle
ipcMain.handle('toggle-widget-mode', () => {
  const current = store.get('settings.widgetMode', 'tiny');
  const newMode = current === 'tiny' ? 'full' : 'tiny';
  store.set('settings.widgetMode', newMode);

  if (mainWindow) {
    if (newMode === 'tiny') {
      mainWindow.setContentSize(TINY_WIDTH, TINY_HEIGHT);
    } else {
      mainWindow.setContentSize(WIDGET_WIDTH, WIDGET_HEIGHT);
    }
    // Re-clamp after resize in case expanding pushes off-screen
    clampToScreen();
    mainWindow.webContents.send('mode-changed', newMode);
  }
  return newMode;
});

ipcMain.handle('get-widget-mode', () => {
  return store.get('settings.widgetMode', 'tiny');
});

// Tiny view right-click context menu
ipcMain.on('show-tiny-context-menu', () => {
  if (!mainWindow) return;
  const template = [
    {
      label: 'Refresh',
      click: () => { mainWindow.webContents.send('refresh-usage'); }
    },
    {
      label: 'Expand',
      click: () => {
        store.set('settings.widgetMode', 'full');
        mainWindow.setContentSize(WIDGET_WIDTH, WIDGET_HEIGHT);
        clampToScreen();
        mainWindow.webContents.send('mode-changed', 'full');
      }
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        // Switch to full mode first, then open settings
        store.set('settings.widgetMode', 'full');
        mainWindow.setContentSize(WIDGET_WIDTH, WIDGET_HEIGHT);
        clampToScreen();
        mainWindow.webContents.send('mode-changed', 'full');
        mainWindow.webContents.send('open-settings');
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => { app.quit(); }
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow });
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90)
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  store.set('settings.autoStart', settings.autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);

  app.setLoginItemSettings({
    openAtLogin: settings.autoStart,
    ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
  });

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  }

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
ipcMain.handle('detect-session-key', async () => {
  // Clear any leftover sessionKey cookie
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Log in to Claude',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let resolved = false;

    // Listen for sessionKey cookie being set after login
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
});

ipcMain.handle('fetch-usage-data', async () => {
  const sessionKey = store.get('sessionKey');
  const organizationId = store.get('organizationId');

  if (!sessionKey || !organizationId) {
    throw new Error('Missing credentials');
  }

  // Ensure cookie is set
  await setSessionCookie(sessionKey);

  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
  const overageUrl = `https://claude.ai/api/organizations/${organizationId}/overage_spend_limit`;
  const prepaidUrl = `https://claude.ai/api/organizations/${organizationId}/prepaid/credits`;

  // Fetch all endpoints in parallel. Usage is required; overage and prepaid are optional.
  const [usageResult, overageResult, prepaidResult] = await Promise.allSettled([
    fetchViaWindow(usageUrl),
    fetchViaWindow(overageUrl),
    fetchViaWindow(prepaidUrl)
  ]);

  // Usage endpoint is mandatory
  if (usageResult.status === 'rejected') {
    const error = usageResult.reason;
    debugLog('API request failed:', error.message);
    const isBlocked = error.message.startsWith('CloudflareBlocked')
      || error.message.startsWith('CloudflareChallenge')
      || error.message.startsWith('UnexpectedHTML');
    if (isBlocked) {
      store.delete('sessionKey');
      store.delete('organizationId');
      if (mainWindow) {
        mainWindow.webContents.send('session-expired');
      }
      throw new Error('SessionExpired');
    }
    throw error;
  }

  const data = usageResult.value;

  // Merge overage spending data into data.extra_usage
  if (overageResult.status === 'fulfilled' && overageResult.value) {
    const overage = overageResult.value;
    const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
    const used = overage.used_credits ?? overage.balance_cents;
    const enabled = overage.is_enabled !== undefined ? overage.is_enabled : (limit != null);

    if (enabled && typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      data.extra_usage = {
        utilization: (used / limit) * 100,
        resets_at: null,
        used_cents: used,
        limit_cents: limit,
      };
    }
  } else {
    debugLog('Overage fetch skipped or failed:', overageResult.reason?.message || 'no data');
  }

  // Merge prepaid balance into data.extra_usage
  if (prepaidResult.status === 'fulfilled' && prepaidResult.value) {
    const prepaid = prepaidResult.value;
    if (typeof prepaid.amount === 'number') {
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.balance_cents = prepaid.amount;
    }
  } else {
    debugLog('Prepaid fetch skipped or failed:', prepaidResult.reason?.message || 'no data');
  }

  return data;
});

// App lifecycle
app.whenReady().then(async () => {
  // Restore session cookie if we have stored credentials
  const sessionKey = store.get('sessionKey');
  if (sessionKey) {
    await setSessionCookie(sessionKey);
  }

  createMainWindow();
  createTray();

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
