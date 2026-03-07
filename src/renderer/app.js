// Application state
let credentials = null;
let updateInterval = null;
let countdownInterval = null;
let latestUsageData = null;
let isExpanded = false;
let widgetMode = 'tiny'; // 'tiny' or 'full'
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const WIDGET_HEIGHT_COLLAPSED = 155;
const WIDGET_ROW_HEIGHT = 30;

// Debug logging — only shows in DevTools (development mode).
// Regular users won't see verbose logs in production.
const DEBUG = (new URLSearchParams(window.location.search)).has('debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

// DOM elements
const elements = {
    loadingContainer: document.getElementById('loadingContainer'),
    loginContainer: document.getElementById('loginContainer'),
    noUsageContainer: document.getElementById('noUsageContainer'),
    mainContent: document.getElementById('mainContent'),
    loginStep1: document.getElementById('loginStep1'),
    loginStep2: document.getElementById('loginStep2'),
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    autoDetectError: document.getElementById('autoDetectError'),
    openBrowserLink: document.getElementById('openBrowserLink'),
    nextStepBtn: document.getElementById('nextStepBtn'),
    backStepBtn: document.getElementById('backStepBtn'),
    sessionKeyInput: document.getElementById('sessionKeyInput'),
    connectBtn: document.getElementById('connectBtn'),
    sessionKeyError: document.getElementById('sessionKeyError'),
    refreshBtn: document.getElementById('refreshBtn'),
    minimizeBtn: document.getElementById('minimizeBtn'),
    closeBtn: document.getElementById('closeBtn'),

    sessionPercentage: document.getElementById('sessionPercentage'),
    sessionProgress: document.getElementById('sessionProgress'),
    sessionTimer: document.getElementById('sessionTimer'),
    sessionTimeText: document.getElementById('sessionTimeText'),

    weeklyPercentage: document.getElementById('weeklyPercentage'),
    weeklyProgress: document.getElementById('weeklyProgress'),
    weeklyTimer: document.getElementById('weeklyTimer'),
    weeklyTimeText: document.getElementById('weeklyTimeText'),
    weeklyResetsAt: document.getElementById('weeklyResetsAt'),

    sessionResetsAt: document.getElementById('sessionResetsAt'),

    expandToggle: document.getElementById('expandToggle'),
    expandArrow: document.getElementById('expandArrow'),
    expandSection: document.getElementById('expandSection'),
    extraRows: document.getElementById('extraRows'),

    // Tiny view elements
    tinyView: document.getElementById('tinyView'),
    tinyPct: document.getElementById('tinyPct'),
    tinyBarFill: document.getElementById('tinyBarFill'),
    tinyTime: document.getElementById('tinyTime'),
    tinyWeeklyCircle: document.getElementById('tinyWeeklyCircle'),
    tinyExpandBtn: document.getElementById('tinyExpandBtn'),
    collapseBtn: document.getElementById('collapseBtn'),

    settingsBtn: document.getElementById('settingsBtn'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    autoStartToggle: document.getElementById('autoStartToggle'),
    minimizeToTrayToggle: document.getElementById('minimizeToTrayToggle'),
    alwaysOnTopToggle: document.getElementById('alwaysOnTopToggle'),
    warnThreshold: document.getElementById('warnThreshold'),
    dangerThreshold: document.getElementById('dangerThreshold'),
    themeBtns: document.querySelectorAll('.theme-btn')
};

// Initialize
async function init() {
    setupEventListeners();
    credentials = await window.electronAPI.getCredentials();

    // Apply saved theme and load thresholds immediately
    const settings = await window.electronAPI.getSettings();
    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
    warnThreshold = settings.warnThreshold;
    dangerThreshold = settings.dangerThreshold;

    // Apply saved widget mode
    widgetMode = await window.electronAPI.getWidgetMode();
    applyMode(widgetMode);

    if (credentials.sessionKey && credentials.organizationId) {
        showMainContent();
        await fetchUsageData();
        startAutoUpdate();
    } else {
        showLoginRequired();
    }
}

// Event Listeners
function setupEventListeners() {
    // Step 1: Login via BrowserWindow
    elements.autoDetectBtn.addEventListener('click', handleAutoDetect);

    // Step navigation
    elements.nextStepBtn.addEventListener('click', () => {
        elements.loginStep1.style.display = 'none';
        elements.loginStep2.style.display = 'block';
        elements.sessionKeyInput.focus();
    });

    elements.backStepBtn.addEventListener('click', () => {
        elements.loginStep2.style.display = 'none';
        elements.loginStep1.style.display = 'flex';
        elements.sessionKeyError.textContent = '';
    });

    // Open browser link in step 2
    elements.openBrowserLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal('https://claude.ai');
    });

    // Step 2: Manual sessionKey connect
    elements.connectBtn.addEventListener('click', handleConnect);
    elements.sessionKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleConnect();
        elements.sessionKeyError.textContent = '';
    });

    elements.refreshBtn.addEventListener('click', async () => {
        debugLog('Refresh button clicked');
        elements.refreshBtn.classList.add('spinning');
        await fetchUsageData();
        elements.refreshBtn.classList.remove('spinning');
    });

    elements.minimizeBtn.addEventListener('click', () => {
        window.electronAPI.minimizeWindow();
    });

    elements.closeBtn.addEventListener('click', () => {
        window.electronAPI.closeWindow();
    });

    // Expand/collapse toggle
    elements.expandToggle.addEventListener('click', () => {
        isExpanded = !isExpanded;
        elements.expandArrow.classList.toggle('expanded', isExpanded);
        elements.expandSection.style.display = isExpanded ? 'block' : 'none';
        resizeWidget();
    });

    // Settings open/close
    elements.settingsBtn.addEventListener('click', async () => {
        await loadSettings();
        elements.settingsOverlay.style.display = 'flex';
        window.electronAPI.resizeWindow(260);
    });

    elements.closeSettingsBtn.addEventListener('click', async () => {
        await saveSettings();
        elements.settingsOverlay.style.display = 'none';
        resizeWidget();
    });

    elements.logoutBtn.addEventListener('click', async () => {
        await window.electronAPI.deleteCredentials();
        credentials = { sessionKey: null, organizationId: null };
        elements.settingsOverlay.style.display = 'none';
        showLoginRequired();
    });

    // Theme buttons
    elements.themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.themeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyTheme(btn.dataset.theme);
        });
    });

    // Listen for refresh requests from tray
    window.electronAPI.onRefreshUsage(async () => {
        await fetchUsageData();
    });

    // Listen for session expiration events (403 errors)
    window.electronAPI.onSessionExpired(() => {
        debugLog('Session expired event received');
        credentials = { sessionKey: null, organizationId: null };
        showLoginRequired();
    });

    // Tiny/Full mode toggle
    elements.tinyExpandBtn.addEventListener('click', () => toggleMode());
    elements.collapseBtn.addEventListener('click', () => toggleMode());

    // Listen for mode changes from main process (e.g. tray menu)
    window.electronAPI.onModeChanged((mode) => {
        widgetMode = mode;
        applyMode(mode);
    });

    // Right-click context menu on tiny view
    elements.tinyView.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.electronAPI.showTinyContextMenu();
    });

    // Open settings from context menu
    window.electronAPI.onOpenSettings(async () => {
        await loadSettings();
        elements.settingsOverlay.style.display = 'flex';
        window.electronAPI.resizeWindow(260);
    });
}

// Handle manual sessionKey connect
async function handleConnect() {
    const sessionKey = elements.sessionKeyInput.value.trim();
    if (!sessionKey) {
        elements.sessionKeyError.textContent = 'Please paste your session key';
        return;
    }

    elements.connectBtn.disabled = true;
    elements.connectBtn.textContent = '...';
    elements.sessionKeyError.textContent = '';

    try {
        const result = await window.electronAPI.validateSessionKey(sessionKey);
        if (result.success) {
            credentials = { sessionKey, organizationId: result.organizationId };
            await window.electronAPI.saveCredentials(credentials);
            elements.sessionKeyInput.value = '';
            showMainContent();
            await fetchUsageData();
            startAutoUpdate();
            // Return to tiny mode after login
            toggleMode();
        } else {
            elements.sessionKeyError.textContent = result.error || 'Invalid session key';
        }
    } catch (error) {
        elements.sessionKeyError.textContent = 'Connection failed. Check your key.';
    } finally {
        elements.connectBtn.disabled = false;
        elements.connectBtn.textContent = 'Connect';
    }
}

// Handle auto-detect from browser cookies
async function handleAutoDetect() {
    elements.autoDetectBtn.disabled = true;
    elements.autoDetectBtn.textContent = 'Waiting...';
    elements.autoDetectError.textContent = '';

    try {
        const result = await window.electronAPI.detectSessionKey();
        if (!result.success) {
            elements.autoDetectError.textContent = result.error || 'Login failed';
            return;
        }

        // Got sessionKey from login, now validate it
        elements.autoDetectBtn.textContent = 'Validating...';
        const validation = await window.electronAPI.validateSessionKey(result.sessionKey);

        if (validation.success) {
            credentials = {
                sessionKey: result.sessionKey,
                organizationId: validation.organizationId
            };
            await window.electronAPI.saveCredentials(credentials);
            showMainContent();
            await fetchUsageData();
            startAutoUpdate();
            // Return to tiny mode after login
            toggleMode();
        } else {
            elements.autoDetectError.textContent =
                'Session invalid. Try again or use Manual →';
        }
    } catch (error) {
        elements.autoDetectError.textContent = error.message || 'Login failed';
    } finally {
        elements.autoDetectBtn.disabled = false;
        elements.autoDetectBtn.textContent = 'Log in';
    }
}

// Fetch usage data from Claude API
async function fetchUsageData() {
    debugLog('fetchUsageData called');

    if (!credentials.sessionKey || !credentials.organizationId) {
        debugLog('Missing credentials, showing login');
        showLoginRequired();
        return;
    }

    try {
        debugLog('Calling electronAPI.fetchUsageData...');
        const data = await window.electronAPI.fetchUsageData();
        debugLog('Received usage data:', data);
        updateUI(data);
    } catch (error) {
        console.error('Error fetching usage data:', error);
        if (error.message.includes('SessionExpired') || error.message.includes('Unauthorized')) {
            credentials = { sessionKey: null, organizationId: null };
            showLoginRequired();
        } else {
            debugLog('Failed to fetch usage data');
        }
    }
}

// Check if there's no usage data
function hasNoUsage(data) {
    const sessionUtilization = data.five_hour?.utilization || 0;
    const sessionResetsAt = data.five_hour?.resets_at;
    const weeklyUtilization = data.seven_day?.utilization || 0;
    const weeklyResetsAt = data.seven_day?.resets_at;

    return sessionUtilization === 0 && !sessionResetsAt &&
        weeklyUtilization === 0 && !weeklyResetsAt;
}

// Update UI with usage data
// Extra row label mapping for API fields
const EXTRA_ROW_CONFIG = {
    seven_day_sonnet: { label: 'Sonnet (7d)', color: 'weekly' },
    seven_day_opus: { label: 'Opus (7d)', color: 'opus' },
    seven_day_cowork: { label: 'Cowork (7d)', color: 'weekly' },
    seven_day_oauth_apps: { label: 'OAuth Apps (7d)', color: 'weekly' },
    extra_usage: { label: 'Extra Usage', color: 'extra' },
};

function buildExtraRows(data) {
    elements.extraRows.innerHTML = '';
    let count = 0;

    for (const [key, config] of Object.entries(EXTRA_ROW_CONFIG)) {
        const value = data[key];
        // extra_usage is valid with utilization OR balance_cents (prepaid only)
        const hasUtilization = value && value.utilization !== undefined;
        const hasBalance = key === 'extra_usage' && value && value.balance_cents != null;
        if (!hasUtilization && !hasBalance) continue;

        const utilization = value.utilization || 0;
        const resetsAt = value.resets_at;
        const colorClass = config.color;

        let percentageHTML;
        let timerHTML;

        if (key === 'extra_usage') {
            // Percentage area → spending amounts
            if (value.used_cents != null && value.limit_cents != null) {
                const usedDollars = (value.used_cents / 100).toFixed(0);
                const limitDollars = (value.limit_cents / 100).toFixed(0);
                percentageHTML = `<span class="usage-percentage extra-spending">$${usedDollars}/$${limitDollars}</span>`;
            } else {
                percentageHTML = `<span class="usage-percentage">${Math.round(utilization)}%</span>`;
            }
            // Timer area → prepaid balance
            if (value.balance_cents != null) {
                const balanceDollars = (value.balance_cents / 100).toFixed(0);
                timerHTML = `<span class="timer-text extra-balance">Bal $${balanceDollars}</span>`;
            } else {
                timerHTML = `<span class="timer-text"></span>`;
            }
        } else {
            percentageHTML = `<span class="usage-percentage">${Math.round(utilization)}%</span>`;
            const totalMinutes = key.includes('seven_day') ? 7 * 24 * 60 : 5 * 60;
            timerHTML = `<div class="timer-text" data-resets="${resetsAt || ''}" data-total="${totalMinutes}">--:--</div>`;
        }

        const row = document.createElement('div');
        row.className = 'usage-section';
        row.innerHTML = `
            <span class="usage-label">${config.label}</span>
            <div class="usage-bar-group">
                <div class="progress-bar">
                    <div class="progress-fill ${colorClass}" style="width: ${Math.min(utilization, 100)}%"></div>
                </div>
                ${percentageHTML}
            </div>
            <div class="usage-timer-group">
                <svg class="mini-timer" width="24" height="24" viewBox="0 0 24 24">
                    <circle class="timer-bg" cx="12" cy="12" r="10" />
                    <circle class="timer-progress ${colorClass}" cx="12" cy="12" r="10"
                        style="stroke-dasharray: 63; stroke-dashoffset: 63" />
                </svg>
                ${timerHTML}
            </div>
        `;

        // Apply warning/danger classes
        const progressEl = row.querySelector('.progress-fill');
        if (utilization >= 90) progressEl.classList.add('danger');
        else if (utilization >= 75) progressEl.classList.add('warning');

        elements.extraRows.appendChild(row);
        count++;
    }

    // Hide toggle if no extra rows
    elements.expandToggle.style.display = count > 0 ? 'flex' : 'none';
    if (count === 0 && isExpanded) {
        isExpanded = false;
        elements.expandArrow.classList.remove('expanded');
        elements.expandSection.style.display = 'none';
    }

    return count;
}

function refreshExtraTimers() {
    const timerTexts = elements.extraRows.querySelectorAll('.timer-text');
    const timerCircles = elements.extraRows.querySelectorAll('.timer-progress');

    timerTexts.forEach((textEl, i) => {
        const resetsAt = textEl.dataset.resets;
        const totalMinutes = parseInt(textEl.dataset.total);
        const circleEl = timerCircles[i];
        if (resetsAt && circleEl) {
            updateTimer(circleEl, textEl, resetsAt, totalMinutes);
        }
    });
}

function resizeWidget() {
    const extraCount = elements.extraRows.children.length;
    if (isExpanded && extraCount > 0) {
        const expandedHeight = WIDGET_HEIGHT_COLLAPSED + 12 + (extraCount * WIDGET_ROW_HEIGHT);
        window.electronAPI.resizeWindow(expandedHeight);
    } else {
        window.electronAPI.resizeWindow(WIDGET_HEIGHT_COLLAPSED);
    }
}

function updateUI(data) {
    latestUsageData = data;

    if (hasNoUsage(data)) {
        showNoUsage();
        return;
    }

    showMainContent();
    buildExtraRows(data);
    refreshTimers();
    updateTinyView();
    if (isExpanded) refreshExtraTimers();
    resizeWidget();
    startCountdown();
}

// Track if we've already triggered a refresh for expired timers
let sessionResetTriggered = false;
let weeklyResetTriggered = false;

function refreshTimers() {
    if (!latestUsageData) return;

    // Session data
    const sessionUtilization = latestUsageData.five_hour?.utilization || 0;
    const sessionResetsAt = latestUsageData.five_hour?.resets_at;

    // Check if session timer has expired and we need to refresh
    if (sessionResetsAt) {
        const sessionDiff = new Date(sessionResetsAt) - new Date();
        if (sessionDiff <= 0 && !sessionResetTriggered) {
            sessionResetTriggered = true;
            debugLog('Session timer expired, triggering refresh...');
            // Wait a few seconds for the server to update, then refresh
            setTimeout(() => {
                fetchUsageData();
            }, 3000);
        } else if (sessionDiff > 0) {
            sessionResetTriggered = false; // Reset flag when timer is active again
        }
    }

    updateProgressBar(
        elements.sessionProgress,
        elements.sessionPercentage,
        sessionUtilization
    );

    updateTimer(
        elements.sessionTimer,
        elements.sessionTimeText,
        sessionResetsAt,
        5 * 60 // 5 hours in minutes
    );
    elements.sessionResetsAt.textContent = formatResetsAt(sessionResetsAt, false);
    elements.sessionResetsAt.style.opacity = sessionResetsAt ? '1' : '0.4';

    // Weekly data
    const weeklyUtilization = latestUsageData.seven_day?.utilization || 0;
    const weeklyResetsAt = latestUsageData.seven_day?.resets_at;

    // Check if weekly timer has expired and we need to refresh
    if (weeklyResetsAt) {
        const weeklyDiff = new Date(weeklyResetsAt) - new Date();
        if (weeklyDiff <= 0 && !weeklyResetTriggered) {
            weeklyResetTriggered = true;
            debugLog('Weekly timer expired, triggering refresh...');
            setTimeout(() => {
                fetchUsageData();
            }, 3000);
        } else if (weeklyDiff > 0) {
            weeklyResetTriggered = false;
        }
    }

    updateProgressBar(
        elements.weeklyProgress,
        elements.weeklyPercentage,
        weeklyUtilization,
        true
    );

    updateTimer(
        elements.weeklyTimer,
        elements.weeklyTimeText,
        weeklyResetsAt,
        7 * 24 * 60 // 7 days in minutes
    );
    elements.weeklyResetsAt.textContent = formatResetsAt(weeklyResetsAt, true);
    elements.weeklyResetsAt.style.opacity = weeklyResetsAt ? '1' : '0.4';
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        refreshTimers();
        updateTinyView();
        if (isExpanded) refreshExtraTimers();
    }, 1000);
}

// Update progress bar
function updateProgressBar(progressElement, percentageElement, value, isWeekly = false) {
    const percentage = Math.min(Math.max(value, 0), 100);

    progressElement.style.width = `${percentage}%`;
    percentageElement.textContent = `${Math.round(percentage)}%`;

    progressElement.classList.remove('warning', 'danger');
    if (percentage >= dangerThreshold) {
        progressElement.classList.add('danger');
    } else if (percentage >= warnThreshold) {
        progressElement.classList.add('warning');
    }
}

// Format reset date for the "Resets At" column
// Session: shows time like "10:00 PM"
// Weekly: shows date like "Feb 28"
function formatResetsAt(resetsAt, isWeekly) {
    if (!resetsAt) return '—';
    const date = new Date(resetsAt);
    if (isWeekly) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const day = date.getDate();
        return `${months[date.getMonth()]} ${day}`;
    } else {
        let hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        return `${hours}:${minutes} ${ampm}`;
    }
}

// Update circular timer
function updateTimer(timerElement, textElement, resetsAt, totalMinutes) {
    if (!resetsAt) {
        textElement.textContent = 'Not started';
        textElement.style.opacity = '0.4';
        textElement.style.fontSize = '10px';
        textElement.title = 'Starts when a message is sent';
        timerElement.style.strokeDashoffset = 63;
        return;
    }

    // Clear the greyed out styling when timer is active
    textElement.style.opacity = '1';
    textElement.style.fontSize = '';
    textElement.title = '';

    const resetDate = new Date(resetsAt);
    const now = new Date();
    const diff = resetDate - now;

    if (diff <= 0) {
        textElement.textContent = 'Resetting...';
        timerElement.style.strokeDashoffset = 0;
        return;
    }

    // Calculate remaining time
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    // const seconds = Math.floor((diff % (1000 * 60)) / 1000); // Optional seconds

    // Format time display
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        textElement.textContent = `${days}d ${remainingHours}h`;
    } else if (hours > 0) {
        textElement.textContent = `${hours}h ${minutes}m`;
    } else {
        textElement.textContent = `${minutes}m`;
    }

    // Calculate progress (elapsed percentage)
    const totalMs = totalMinutes * 60 * 1000;
    const elapsedMs = totalMs - diff;
    const elapsedPercentage = (elapsedMs / totalMs) * 100;

    // Update circle (63 is ~2*pi*10)
    const circumference = 63;
    const offset = circumference - (elapsedPercentage / 100) * circumference;
    timerElement.style.strokeDashoffset = offset;

    // Update color based on remaining time
    timerElement.classList.remove('warning', 'danger');
    if (elapsedPercentage >= 90) {
        timerElement.classList.add('danger');
    } else if (elapsedPercentage >= 75) {
        timerElement.classList.add('warning');
    }
}

// UI State Management
function showLoginRequired() {
    // Force full mode for login
    if (widgetMode === 'tiny') {
        window.electronAPI.toggleWidgetMode().then((mode) => {
            widgetMode = mode;
            applyMode(mode);
        });
    }
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'flex';
    elements.noUsageContainer.style.display = 'none';
    elements.mainContent.style.display = 'none';
    // Reset to step 1
    elements.loginStep1.style.display = 'flex';
    elements.loginStep2.style.display = 'none';
    elements.sessionKeyError.textContent = '';
    elements.sessionKeyInput.value = '';
    stopAutoUpdate();
}

function showNoUsage() {
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'none';
    elements.noUsageContainer.style.display = 'flex';
    elements.mainContent.style.display = 'none';
}

function showMainContent() {
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'none';
    elements.noUsageContainer.style.display = 'none';
    elements.mainContent.style.display = 'block';
}

// Auto-update management
function startAutoUpdate() {
    stopAutoUpdate();
    updateInterval = setInterval(() => {
        fetchUsageData();
    }, UPDATE_INTERVAL);
}

function stopAutoUpdate() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
}

// ========================================
// Widget Mode (Tiny / Full)
// ========================================

async function toggleMode() {
    const newMode = await window.electronAPI.toggleWidgetMode();
    widgetMode = newMode;
    applyMode(newMode);
}

function applyMode(mode) {
    document.body.classList.remove('mode-tiny', 'mode-full');
    document.body.classList.add(`mode-${mode}`);

    // When switching to full mode and we need login, show it
    if (mode === 'full' && !credentials?.sessionKey) {
        showLoginRequired();
    }
}

function updateTinyView() {
    if (!latestUsageData) return;

    const sessionUtilization = latestUsageData.five_hour?.utilization || 0;
    const sessionResetsAt = latestUsageData.five_hour?.resets_at;
    const weeklyUtilization = latestUsageData.seven_day?.utilization || 0;

    // Session percentage
    const pct = Math.round(Math.min(Math.max(sessionUtilization, 0), 100));
    elements.tinyPct.textContent = `${pct}%`;

    // Session progress bar
    elements.tinyBarFill.style.width = `${pct}%`;
    elements.tinyBarFill.classList.remove('warning', 'danger');
    if (pct >= dangerThreshold) {
        elements.tinyBarFill.classList.add('danger');
    } else if (pct >= warnThreshold) {
        elements.tinyBarFill.classList.add('warning');
    }

    // Session remaining time
    if (sessionResetsAt) {
        const diff = new Date(sessionResetsAt) - new Date();
        if (diff <= 0) {
            elements.tinyTime.textContent = '0m';
        } else {
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            if (hours >= 24) {
                const days = Math.floor(hours / 24);
                const rh = hours % 24;
                elements.tinyTime.textContent = `${days}d${rh}h`;
            } else if (hours > 0) {
                elements.tinyTime.textContent = `${hours}h${minutes}m`;
            } else {
                elements.tinyTime.textContent = `${minutes}m`;
            }
        }
    } else {
        elements.tinyTime.textContent = '--:--';
    }

    // Weekly circle
    const weeklyPct = Math.min(Math.max(weeklyUtilization, 0), 100);
    const weeklyResetsAt = latestUsageData.seven_day?.resets_at;
    const totalMs = 7 * 24 * 60 * 60 * 1000;

    if (weeklyResetsAt) {
        const diff = new Date(weeklyResetsAt) - new Date();
        const elapsedMs = totalMs - Math.max(diff, 0);
        const elapsedPct = (elapsedMs / totalMs) * 100;
        const circumference = 63;
        const offset = circumference - (elapsedPct / 100) * circumference;
        elements.tinyWeeklyCircle.style.strokeDashoffset = offset;

        elements.tinyWeeklyCircle.classList.remove('warning', 'danger');
        if (elapsedPct >= 90) {
            elements.tinyWeeklyCircle.classList.add('danger');
        } else if (elapsedPct >= 75) {
            elements.tinyWeeklyCircle.classList.add('warning');
        }
    } else {
        elements.tinyWeeklyCircle.style.strokeDashoffset = 63;
    }
}

// Add spinning animation for refresh button
const style = document.createElement('style');
style.textContent = `
    @keyframes spin-refresh {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    
    .refresh-btn.spinning svg {
        animation: spin-refresh 1s linear;
    }
`;
document.head.appendChild(style);

// Settings management
let warnThreshold = 75;
let dangerThreshold = 90;

async function loadSettings() {
    const settings = await window.electronAPI.getSettings();

    elements.autoStartToggle.checked = settings.autoStart;
    elements.minimizeToTrayToggle.checked = settings.minimizeToTray;
    elements.alwaysOnTopToggle.checked = settings.alwaysOnTop;
    elements.warnThreshold.value = settings.warnThreshold;
    elements.dangerThreshold.value = settings.dangerThreshold;

    warnThreshold = settings.warnThreshold;
    dangerThreshold = settings.dangerThreshold;

    elements.themeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === settings.theme);
    });

    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
}

async function saveSettings() {
    const activeThemeBtn = document.querySelector('.theme-btn.active');
    const warn = parseInt(elements.warnThreshold.value) || 75;
    const danger = parseInt(elements.dangerThreshold.value) || 90;

    warnThreshold = warn;
    dangerThreshold = danger;

    const settings = {
        autoStart: elements.autoStartToggle.checked,
        minimizeToTray: elements.minimizeToTrayToggle.checked,
        alwaysOnTop: elements.alwaysOnTopToggle.checked,
        theme: activeThemeBtn ? activeThemeBtn.dataset.theme : 'dark',
        warnThreshold: warn,
        dangerThreshold: danger
    };
    await window.electronAPI.saveSettings(settings);
    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
}

function applyTheme(theme) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = theme === 'dark' || (theme === 'system' && prefersDark);
    document.body.classList.toggle('theme-light', !useDark);
}

// Start the application
init();

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    stopAutoUpdate();
    if (countdownInterval) clearInterval(countdownInterval);
});
