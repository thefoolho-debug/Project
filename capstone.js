const SUPABASE_URL = "https://kyqeuzyknibkidjgimql.supabase.co";
const SUPABASE_KEY = "sb_publishable_FyZRa-B1VRGWS_pGW0Ygxw_tbkJTA23";
const offlineErr = new Error('Could not load the database library. Check the internet connection.');
const supabaseClient = window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : {
        auth: {
            getSession: async () => ({ data: {}, error: offlineErr }),
            signOut: async () => ({ error: null }),
            signInWithPassword: async () => ({ data: {}, error: offlineErr })
        },
        functions: { invoke: async () => ({ data: null, error: offlineErr }) }
    };

const STAGES = {
    Seedling: { dry: 60, wet: 75 },
    Vegetative: { dry: 55, wet: 70 },
    Flowering: { dry: 50, wet: 65 },
    Fruiting: { dry: 55, wet: 65 }
};

const STATE = {
    role: null,
    selectedLoginTab: 'USER',
    userAccount: null,

    stage: 'Flowering',
    season: 'auto',

    dryThreshold: 50,
    wetThreshold: 65,
    maxDuration: 15,

    controlMode: 'AUTO',

    pumpActive: false,
    currentRunDuration: 0,

    currentMoisture: 55,
    currentTemp: 28.5,

    currentSensorId: 1,
    currentPumpId: 1,
    currentSettingId: 1,

    timeframe: 360,

    history: [],
    activityLogs: [],
    alertList: [],
    alertCooldowns: {},

    managedUsers: []
};

const $ = id => document.getElementById(id);

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function supabaseFetch(endpoint, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
    const { data } = await supabaseClient.auth.getSession();
    const session = data?.session;

    const headers = {
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(options.headers || {})
    };

    if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
    }

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;

        try {
            const body = await response.json();
            detail = body.message || body.details || body.hint || detail;
        } catch (_) {}

        const error = new Error(detail);
        error.status = response.status;
        throw error;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : [];
}

function explainDatabaseError(message) {
    const lower = String(message || '').toLowerCase();

    if (lower.includes('does not exist') || lower.includes('relation')) {
        return 'The users table is missing. Apply the Supabase migration in supabase/migrations.';
    }

    if (lower.includes('invalid api key') || lower.includes('jwt') || lower.includes('unauthorized')) {
        return 'The Supabase key or sign-in session is invalid. Check the project key and sign in again.';
    }

    if (lower.includes('permission denied') || lower.includes('row-level security') || lower.includes('rls')) {
        return 'Supabase denied this operation. Confirm you are signed in and have applied the account migration and policies.';
    }

    if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
        return 'The browser could not reach Supabase. Check your internet connection or whether the project is paused.';
    }

    return message;
}

function showCenterAlert(title, message, severity = 'WARNING') {
    let backdrop = $('sysAlertModal');

    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'sysAlertModal';
        backdrop.className = 'sys-modal-backdrop';
        backdrop.innerHTML = `
            <div class="sys-modal-card">
                <div id="sysModalBadge" class="sys-modal-badge">!</div>
                <h3 id="sysModalTitle" class="sys-modal-title">System Alert</h3>
                <div id="sysModalBody" class="sys-modal-body"></div>
                <button id="sysModalClose" class="sys-modal-btn" type="button">Acknowledge</button>
            </div>
        `;

        document.body.appendChild(backdrop);

        $('sysModalClose').onclick = () =>
            backdrop.classList.remove('active');
    }

    const badge = $('sysModalBadge');
    badge.className = `sys-modal-badge ${severity}`;
    badge.textContent = severity === 'CRITICAL' ? '!!' : severity === 'WARNING' ? '!' : 'i';

    $('sysModalTitle').textContent = title;
    $('sysModalBody').textContent = message;

    requestAnimationFrame(() => backdrop.classList.add('active'));
}

const formatTimestamp = (ts, detailed = false) =>
    new Date(ts).toLocaleString([], detailed
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' });

const getActiveSeason = () => {
    if (STATE.season !== 'auto') return STATE.season;
    return new Date().getMonth() < 5 ? 'dry' : 'wet';
};

const parseDbTime = value =>
    new Date(/[zZ]$|[+-]\d\d(:?\d\d)?$/.test(value) ? value : `${value}Z`).getTime();

function applyPresetThresholds() {
    const base = STAGES[STATE.stage];
    const offset = getActiveSeason() === 'dry' ? 5 : -5;

    STATE.dryThreshold = Math.max(5, Math.min(90, base.dry + offset));
    STATE.wetThreshold = Math.max(STATE.dryThreshold + 10, Math.min(95, base.wet + offset));

    syncSettingsToUI();
}

function syncSettingsToUI() {
    if ($('stage')) $('stage').value = STATE.stage;
    if ($('season')) $('season').value = STATE.season;
    if ($('dry')) $('dry').value = STATE.dryThreshold;
    if ($('wet')) $('wet').value = STATE.wetThreshold;
    if ($('max')) $('max').value = STATE.maxDuration;

    if ($('dryV')) $('dryV').textContent = `${STATE.dryThreshold.toFixed(0)}%`;
    if ($('wetV')) $('wetV').textContent = `${STATE.wetThreshold.toFixed(0)}%`;
    if ($('maxV')) $('maxV').textContent = `${STATE.maxDuration} min`;
}

async function fetchManagedUsers() {
    try {
        const users = await supabaseFetch(
            "users?select=id,email,full_name,role,status&auth_user_id=not.is.null&order=id.asc"
        );

        STATE.managedUsers = Array.isArray(users) ? users : [];
    } catch (err) {
        console.error("User list error:", err);
        setUserMsg(explainDatabaseError(err.message), false);
        return;
    }

    renderUserTable();
}

function renderUserTable() {
    if (!$('userRows')) return;

    const userList = STATE.managedUsers.filter(u => u.role === 'User');

    $('userRows').innerHTML = userList.map(u => `
        <tr>
            <td>${escapeHtml(u.id)}</td>
            <td>${escapeHtml(u.full_name || '')}</td>
            <td>${escapeHtml(u.email)}</td>
            <td class="${u.status === 'Active' ? 'ok' : 'bad'}">${escapeHtml(u.status)}</td>
            <td>
                <button class="btn" type="button" data-act="toggle" data-id="${escapeHtml(u.id)}">
                    ${u.status === 'Active' ? 'Deactivate' : 'Activate'}
                </button>
                <button class="btn" type="button" data-act="pass" data-id="${escapeHtml(u.id)}">Set Password</button>
                <button class="btn" type="button" data-act="del" data-id="${escapeHtml(u.id)}">Delete</button>
            </td>
        </tr>
    `).join('') || `
        <tr><td colspan="5" class="mut">No user accounts created yet.</td></tr>
    `;

    $('userRows').querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => handleUserAction(btn.dataset.act, btn.dataset.id));
    });
}

async function handleUserAction(action, userId) {
    if (STATE.role !== 'A') return;

    const target = STATE.managedUsers.find(u => String(u.id) === String(userId));
    if (!target) return;

    try {
        if (action === 'toggle') {
            const nextStatus = target.status === 'Active' ? 'Inactive' : 'Active';
            await callAdminUserFunction({ action, userId, status: nextStatus });
            setUserMsg(`Account ${nextStatus.toLowerCase()}.`);
        }

        if (action === 'pass') {
            const replacement = window.prompt(`New password for ${target.email}:`);
            if (!replacement) return;

            await callAdminUserFunction({ action, userId, password: replacement });
            setUserMsg('Password updated.');
        }

        if (action === 'del') {
            if (!window.confirm(`Delete the account ${target.email}? This cannot be undone.`)) return;

            await callAdminUserFunction({ action, userId });
            setUserMsg('Account deleted.');
        }
    } catch (err) {
        setUserMsg(explainDatabaseError(err.message), false);
    }

    await fetchManagedUsers();
}

async function callAdminUserFunction(payload) {
    const { data, error } = await supabaseClient.functions.invoke('admin-users', {
        body: payload
    });

    if (error) {
        let detail = data?.error;
        const response = error.context;
        if (!detail && response && typeof response.clone === 'function') {
            const body = await response.clone().json().catch(() => null);
            detail = body?.error;
        }
        throw new Error(detail || error.message);
    }

    if (data?.error) {
        throw new Error(data.error);
    }

    return data;
}

function setUserMsg(text, ok = true) {
    if (!$('userMsg')) return;

    $('userMsg').style.color = ok ? 'var(--green)' : 'var(--red)';
    $('userMsg').textContent = text;
}

async function createUserAccount() {
    if (STATE.role !== 'A') return;

    const name = $('nuName')?.value.trim();
    const email = $('nuEmail')?.value.trim();
    const pass = $('nuPass')?.value.trim();

    if (!name || !email || !pass) {
        setUserMsg('Full name, email and password are all required.', false);
        return;
    }

    const exists = STATE.managedUsers.some(
        u => String(u.email).toLowerCase() === email.toLowerCase()
    );

    if (exists) {
        setUserMsg('An account with that email address already exists.', false);
        return;
    }

    try {
        await callAdminUserFunction({ action: 'create', email, password: pass, fullName: name });
    } catch (err) {
        setUserMsg(explainDatabaseError(err.message), false);
        return;
    }

    $('nuName').value = '';
    $('nuEmail').value = '';
    $('nuPass').value = '';

    setUserMsg('User account created successfully.');

    await fetchManagedUsers();
}

async function fetchAccountProfile(authUserId) {
    const profiles = await supabaseFetch(
        `users?select=id,email,full_name,role,status&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
    );
    return profiles[0] || null;
}

async function handleLogin() {
    const inputVal = $('authEmail').value.trim();
    const pass = $('authPass').value;
    const errBox = $('authErr');

    errBox.textContent = '';

    if (!inputVal || !pass) {
        errBox.textContent = 'Please fill out all fields.';
        return;
    }

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: inputVal,
            password: pass
        });

        if (error) throw error;

        const profile = await fetchAccountProfile(data.user.id);
        if (!profile) {
            await supabaseClient.auth.signOut();
            errBox.textContent = 'This login has no dashboard account profile. Contact the administrator.';
            return;
        }

        if (profile.status !== 'Active') {
            await supabaseClient.auth.signOut();
            errBox.textContent = 'This account is inactive. Contact the administrator.';
            return;
        }

        if (STATE.selectedLoginTab === 'ADMIN' && profile.role !== 'Admin') {
            await supabaseClient.auth.signOut();
            errBox.textContent = 'This account is not an administrator.';
            return;
        }

        if (STATE.selectedLoginTab === 'USER' && profile.role === 'Admin') {
            await supabaseClient.auth.signOut();
            errBox.textContent = 'Admin accounts must use Admin Sign In.';
            return;
        }

        enterDashboard(profile);
    } catch (err) {
        const message = String(err.message || '');
        errBox.textContent = message.toLowerCase().includes('invalid login credentials')
            ? 'Invalid email or password.'
            : `Sign-in failed: ${explainDatabaseError(message)}`;
    }
}

function enterDashboard(profile) {
    STATE.role = profile.role === 'Admin' ? 'A' : 'F';
    STATE.userAccount = profile;
    $('authOverlay').classList.remove('active');
    $('mainDashboard').style.display = 'grid';

    updateRoleAccess();
    renderDashboard();

    fetchLatestTelemetry();

    if (STATE.role === 'A') {
        fetchManagedUsers();
    }
}

function setLoginTab(mode) {
    STATE.selectedLoginTab = mode;
    $('authErr').textContent = '';

    const isUser = mode === 'USER';

    $('tabUserLogin').classList.toggle('active', isUser);
    $('tabAdminLogin').classList.toggle('active', !isUser);

    $('loginTitle').textContent = isUser ? 'User Sign In' : 'Admin Sign In';
    $('loginDesc').textContent = isUser
        ? 'Please authenticate to access the tomato monitoring dashboard.'
        : 'System administrator access and irrigation configuration.';
}

function updateRoleAccess() {
    const isAdmin = STATE.role === 'A';

    document.querySelectorAll('.adm-only').forEach(el => {
        el.style.display = isAdmin ? 'block' : 'none';
    });

    document.querySelectorAll('.adm').forEach(el => {
        el.disabled = !isAdmin;
    });

    if ($('dashSubtitle')) {
        $('dashSubtitle').textContent = isAdmin
            ? 'Admin Dashboard - System Control, Configuration and Maintenance'
            : 'User Dashboard - Tomato Health Monitoring and Irrigation Status';
    }

    if ($('who')) {
        $('who').textContent = isAdmin
            ? 'Administrator'
            : (STATE.userAccount?.full_name || STATE.userAccount?.email || 'User');
    }
}

async function fetchLatestTelemetry() {
    try {
        const sensors = await supabaseFetch(
            "sensor_data?select=*&order=timestamp.desc&limit=1"
        );

        if (Array.isArray(sensors) && sensors.length) {
            STATE.currentMoisture = Number(sensors[0].soil_moisture_value);
            STATE.currentSensorId = sensors[0].sensor_id;
        }
    } catch (_) {}

    try {
        const temps = await supabaseFetch(
            "temperature_data?select=*&order=timestamp.desc&limit=1"
        );

        if (Array.isArray(temps) && temps.length) {
            STATE.currentTemp = Number(temps[0].temperature_value);
        }
    } catch (_) {}

    try {
        const settings = await supabaseFetch(
            "system_settings?select=*&order=updated_at.desc&limit=1"
        );

        if (Array.isArray(settings) && settings.length) {
            STATE.dryThreshold = Number(settings[0].moisture_threshold);
            STATE.maxDuration = Number(settings[0].watering_duration);
            STATE.currentSettingId = settings[0].setting_id;

            if (settings[0].wet_threshold != null) {
                STATE.wetThreshold = Number(settings[0].wet_threshold);
            }

            if (settings[0].growth_stage) STATE.stage = settings[0].growth_stage;
            if (settings[0].season_mode) STATE.season = settings[0].season_mode;

            if (STATE.wetThreshold < STATE.dryThreshold + 10) {
                STATE.wetThreshold = Math.min(95, STATE.dryThreshold + 15);
            }

            syncSettingsToUI();
        }
    } catch (_) {}

    try {
        const logs = await supabaseFetch(
            "watering_activity?select=*&order=timestamp.desc&limit=50"
        );

        if (Array.isArray(logs)) {
            STATE.activityLogs = logs.map(item => ({
                id: item.activity_id,
                ts: parseDbTime(item.timestamp),
                dur: Number(item.watering_duration || 0),
                rm: item.operational_remarks || 'System operation'
            }));
        }
    } catch (_) {}

    evaluateIrrigationLogic(false);
    renderDashboard();
}

async function saveSettingsToSupabase() {
    if (STATE.role !== 'A') return false;

    const payload = [{
        admin_id: STATE.userAccount?.id ?? null,
        growth_stage: STATE.stage,
        season_mode: STATE.season,
        moisture_threshold: STATE.dryThreshold,
        wet_threshold: STATE.wetThreshold,
        watering_duration: STATE.maxDuration
    }];

    try {
        const saved = await supabaseFetch(
            "system_settings",
            { method: "POST", body: JSON.stringify(payload) }
        );

        if (Array.isArray(saved) && saved[0]) {
            STATE.currentSettingId = saved[0].setting_id;
        }
    } catch (err) {
        if ($('settingsMsg')) {
            $('settingsMsg').style.color = 'var(--red)';
            $('settingsMsg').textContent = explainDatabaseError(err.message);
        }

        return false;
    }

    if ($('settingsMsg')) {
        $('settingsMsg').style.color = 'var(--green)';
        $('settingsMsg').textContent = 'Irrigation settings saved successfully.';

        setTimeout(() => {
            if ($('settingsMsg')) $('settingsMsg').textContent = '';
        }, 2500);
    }

    return true;
}

async function logSystemAlertToSupabase(type, message, severity) {
    const key = `${type}:${message}`;
    const last = STATE.alertCooldowns[key] || 0;

    if (Date.now() - last < 60000) return;

    STATE.alertCooldowns[key] = Date.now();

    try {
        await supabaseFetch(
            "system_alerts",
            {
                method: "POST",
                body: JSON.stringify([{
                    sensor_id: STATE.currentSensorId,
                    alert_type: type,
                    alert_message: message,
                    severity_level: severity,
                    is_resolved: false
                }])
            }
        );
    } catch (err) {
        console.error("Alert log error:", err);
    }
}

function evaluateIrrigationLogic(advance = true) {
    const previousState = STATE.pumpActive;
    const m = STATE.currentMoisture;

    if (STATE.controlMode === 'ON') {
        STATE.pumpActive = true;
    } else if (STATE.controlMode === 'OFF') {
        STATE.pumpActive = false;
    } else {
        if (!STATE.pumpActive && m <= STATE.dryThreshold) {
            STATE.pumpActive = true;
        } else if (STATE.pumpActive && (m >= STATE.wetThreshold || STATE.currentRunDuration >= STATE.maxDuration)) {
            STATE.pumpActive = false;
        }
    }

    if (STATE.pumpActive && !previousState) {
        STATE.currentRunDuration = 0;
    }

    if (advance) {
        if (STATE.pumpActive) {
            STATE.currentRunDuration++;
            STATE.currentMoisture = Math.min(98, STATE.currentMoisture + 1.8);
        } else {
            STATE.currentMoisture = Math.max(5, STATE.currentMoisture - 0.08);
        }

        STATE.history.push({
            ts: Date.now(),
            m: STATE.currentMoisture,
            t: STATE.currentTemp,
            p: STATE.pumpActive
        });

        if (STATE.history.length > 1440) STATE.history.shift();
    }

    checkAlertConditions();
}

function checkAlertConditions() {
    const activeAlerts = [];
    const m = STATE.currentMoisture;

    if (m < STATE.dryThreshold - 10) {
        const msg = `Critical low moisture: soil moisture is ${m.toFixed(1)}%, below the watering threshold of ${STATE.dryThreshold.toFixed(0)}%.`;

        activeAlerts.push(msg);

        if (!STATE.pumpActive && STATE.controlMode === 'AUTO') {
            showCenterAlert('IoT Abnormality Detected', msg, 'CRITICAL');
            logSystemAlertToSupabase('CRITICAL_LOW_MOISTURE', msg, 'CRITICAL');
        }
    }

    if (STATE.currentTemp >= 35) {
        const msg = `High temperature warning: surrounding temperature reached ${STATE.currentTemp.toFixed(1)} C.`;

        activeAlerts.push(msg);
        showCenterAlert('IoT System Warning', msg, 'WARNING');
        logSystemAlertToSupabase('HIGH_TEMPERATURE', msg, 'WARNING');
    }

    if (STATE.controlMode === 'OFF' && m < STATE.dryThreshold) {
        activeAlerts.push('Soil is dry while the pump is set to Manual Off.');
    }

    if (m > STATE.wetThreshold + 8) {
        activeAlerts.push(`Soil moisture is above the target range at ${m.toFixed(1)}%.`);
    }

    STATE.alertList = activeAlerts;
}

function renderSparkline() {
    if (!$('spark')) return;

    const subset = STATE.history.slice(-360).filter((_, i) => i % 6 === 0);
    if (subset.length < 2) return;

    const lo = 20;
    const hi = 40;

    const points = subset.map((q, i) => {
        const x = (i * 300 / (subset.length - 1)).toFixed(1);
        const y = (46 - ((q.t - lo) / (hi - lo)) * 42).toFixed(1);
        return `${x},${y}`;
    }).join(' ');

    $('spark').innerHTML =
        `<polyline class="tl" style="stroke:var(--sky)" points="${points}"/>`;
}

function renderHistoryChart() {
    if (!$('chart')) return;

    const box = $('chart').getBoundingClientRect().width || 700;
    const W = Math.max(300, Math.min(900, Math.round(box))), H = box < 500 ? 220 : 260, L = 38, R = 10, T = 10, B = 26;
    $('chart').setAttribute('viewBox', `0 0 ${W} ${H}`);

    const n = Math.min(STATE.timeframe, STATE.history.length);
    if (n < 2) return;

    const P = STATE.history.slice(-n);

    const x = i => L + (W - L - R) * i / (n - 1);
    const y = v => T + (H - T - B) * (1 - v / 100);

    let gridHtml = '';
    let polylinePts = '';
    let runBars = '';
    let runStart = -1;

    for (let v = 0; v <= 100; v += 25) {
        gridHtml += `
            <line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
            <text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>
        `;
    }

    P.forEach((q, i) => {
        polylinePts += `${x(i).toFixed(1)},${y(q.m).toFixed(1)} `;

        if (q.p && runStart < 0) runStart = i;

        if ((!q.p || i === n - 1) && runStart >= 0) {
            runBars += `
                <rect class="run" x="${x(runStart)}" y="${H - B - 6}"
                      width="${Math.max(2, x(i) - x(runStart))}" height="6"/>
            `;

            runStart = -1;
        }
    });

    $('chart').innerHTML = `
        ${gridHtml}

        <rect x="${L}" y="${y(STATE.wetThreshold)}" width="${W - L - R}"
              height="${Math.abs(y(STATE.dryThreshold) - y(STATE.wetThreshold))}"
              fill="#16a06c" opacity=".12"/>

        <line x1="${L}" x2="${W - R}" y1="${y(STATE.dryThreshold)}" y2="${y(STATE.dryThreshold)}"
              stroke="var(--amber)" stroke-dasharray="5 4"/>
        <text class="ax" x="${W - R - 2}" y="${y(STATE.dryThreshold) + 13}"
              text-anchor="end" style="fill:var(--amber)">water at ${STATE.dryThreshold}%</text>

        <line x1="${L}" x2="${W - R}" y1="${y(STATE.wetThreshold)}" y2="${y(STATE.wetThreshold)}"
              stroke="var(--sky)" stroke-dasharray="5 4"/>
        <text class="ax" x="${W - R - 2}" y="${y(STATE.wetThreshold) - 5}"
              text-anchor="end" style="fill:var(--sky)">stop at ${STATE.wetThreshold}%</text>

        <polyline class="tl" points="${polylinePts}"/>

        ${runBars}
    `;
}

function renderDashboard() {
    if (!STATE.role) return;

    const m = STATE.currentMoisture;

    if ($('clock')) $('clock').textContent = formatTimestamp(Date.now(), true);
    if ($('mPct')) $('mPct').textContent = m.toFixed(1);
    if ($('mAdc')) $('mAdc').textContent = (STATE.rawAdc ?? '--');

    if ($('band')) {
        $('band').style.cssText =
            `left:${STATE.dryThreshold}%;width:${Math.max(0, STATE.wetThreshold - STATE.dryThreshold)}%`;
    }

    if ($('needle')) {
        $('needle').style.left = `${Math.min(100, Math.max(0, m))}%`;
    }

    if ($('tVal')) $('tVal').textContent = STATE.currentTemp.toFixed(1);

    if ($('pState')) {
        $('pState').textContent = STATE.pumpActive ? 'ON' : 'OFF';
        $('pState').className = `big ${STATE.pumpActive ? 'inf' : ''}`;
    }

    if ($('pSub')) {
        $('pSub').textContent = STATE.pumpActive
            ? `Watering for ${STATE.currentRunDuration} min`
            : 'Standing by';
    }

    if ($('pMode')) {
        $('pMode').textContent = {
            AUTO: 'Automatic',
            ON: 'Manual On',
            OFF: 'Manual Off'
        }[STATE.controlMode];
    }

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recentRuns = STATE.activityLogs.filter(l => l.ts >= since);
    const totalMinutes = recentRuns.reduce((sum, l) => sum + Number(l.dur || 0), 0);

    if ($('pRuns')) $('pRuns').textContent = recentRuns.length;
    if ($('pMin')) $('pMin').textContent = `${totalMinutes} min`;

    let condTitle, condClass, condSub;

    if (m < STATE.dryThreshold) {
        condTitle = 'Soil is dry';
        condClass = 'warn';
        condSub = `Irrigation is required at or below ${STATE.dryThreshold.toFixed(0)}%.`;
    } else if (m > STATE.wetThreshold + 8) {
        condTitle = 'Soil is too wet';
        condClass = 'bad';
        condSub = 'Excessive moisture may contribute to crop stress and root problems.';
    } else {
        condTitle = 'Receiving proper water';
        condClass = 'ok';
        condSub = `${STATE.stage} stage target is ${STATE.dryThreshold.toFixed(0)}%-${STATE.wetThreshold.toFixed(0)}% moisture.`;
    }

    if ($('cond')) {
        $('cond').textContent = condTitle;
        $('cond').className = condClass;
    }

    if ($('condSub')) $('condSub').textContent = condSub;

    if ($('alerts')) {
        const alertList = STATE.alertList.length
            ? STATE.alertList
            : ['No active alerts. Readings are within the configured monitoring range.'];

        $('alerts').innerHTML = alertList
            .map(txt => `<li>${escapeHtml(txt)}</li>`)
            .join('');
    }

    if ($('logb')) {
        $('logb').innerHTML = STATE.activityLogs.slice(0, 12).map(l => `
            <tr>
                <td>${escapeHtml(l.id)}</td>
                <td>${escapeHtml(formatTimestamp(l.ts, true))}</td>
                <td>${escapeHtml(l.dur)} min</td>
                <td>${escapeHtml(l.rm)}</td>
            </tr>
        `).join('') || `
            <tr><td colspan="4" class="mut">No watering runs recorded.</td></tr>
        `;
    }

    renderSparkline();
    renderHistoryChart();
}

function setControlMode(mode) {
    if (STATE.role !== 'A') return;

    STATE.controlMode = mode;

    document.querySelectorAll('#modes button').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.m === mode);
    });

    evaluateIrrigationLogic(false);
    renderDashboard();
}

function runHardwareCheck() {
    if (STATE.role !== 'A') return;

    const hwItems = [
        'Soil moisture sensor',
        'Temperature sensor',
        'Arduino UNO',
        'Relay module',
        'Water pump',
        'Sprinkler system',
        'Power supply'
    ];

    if ($('hw')) {
        $('hw').innerHTML = hwItems.map(item => `
            <div class="row">
                <span>${escapeHtml(item)}</span>
                <span class="ok">Ready</span>
            </div>
        `).join('');
    }

    if ($('hwT')) {
        $('hwT').textContent = `Check completed at ${formatTimestamp(Date.now())}`;
    }

    showCenterAlert(
        'Pre-operation Check',
        'The dashboard checklist is complete. Confirm the physical wiring, water source, sensor placement, relay, pump, sprinkler and power supply on the prototype before operation.',
        'INFO'
    );
}

function exportCsv() {
    const rows = [
        ['activity_id', 'timestamp', 'pump_id', 'pump_status', 'watering_duration_min', 'operational_remarks'],
        ...STATE.activityLogs.map(l => [
            l.id,
            new Date(l.ts).toISOString(),
            STATE.currentPumpId,
            'OFF',
            l.dur,
            l.rm
        ])
    ];

    const csvRows = rows.map(row =>
        row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    if ($('csv')) $('csv').value = csvRows;
    if ($('csvbox')) $('csvbox').hidden = false;
    if ($('csvmsg')) $('csvmsg').textContent = 'Watering activity CSV prepared.';

    try {
        const blob = new Blob([csvRows], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');

        link.href = URL.createObjectURL(blob);
        link.download = `watering-activity-log-${Date.now()}.csv`;

        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (err) {
        console.error('CSV export failed:', err);
    }
}

function bindUIEvents() {
    $('tabUserLogin')?.addEventListener('click', () => setLoginTab('USER'));
    $('tabAdminLogin')?.addEventListener('click', () => setLoginTab('ADMIN'));
    $('btnLogin')?.addEventListener('click', handleLogin);

    $('authPass')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') handleLogin();
    });

    $('authEmail')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') handleLogin();
    });

    $('toggleAuthPass')?.addEventListener('click', () => {
        const input = $('authPass');
        const show = input.type === 'password';

        input.type = show ? 'text' : 'password';
        $('toggleAuthPass').textContent = show ? 'Hide' : 'Show';
    });

    $('btnLogout')?.addEventListener('click', async () => {
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
            showCenterAlert('Sign out failed', error.message, 'WARNING');
            return;
        }

        STATE.userAccount = null;
        STATE.role = null;

        $('mainDashboard').style.display = 'none';
        $('authOverlay').classList.add('active');

        $('authEmail').value = '';
        $('authPass').value = '';
        $('userMsg').textContent = '';

        setLoginTab('USER');
    });

    $('btnCreateUser')?.addEventListener('click', createUserAccount);

    $('stage')?.addEventListener('change', e => {
        STATE.stage = e.target.value;
        applyPresetThresholds();
        renderDashboard();
    });

    $('season')?.addEventListener('change', e => {
        STATE.season = e.target.value;
        applyPresetThresholds();
        renderDashboard();
    });

    $('dry')?.addEventListener('input', e => {
        STATE.dryThreshold = Number(e.target.value);

        if (STATE.wetThreshold < STATE.dryThreshold + 10) {
            STATE.wetThreshold = Math.min(95, STATE.dryThreshold + 10);
        }

        syncSettingsToUI();
        renderDashboard();
    });

    $('wet')?.addEventListener('input', e => {
        STATE.wetThreshold = Number(e.target.value);

        if (STATE.dryThreshold > STATE.wetThreshold - 10) {
            STATE.dryThreshold = Math.max(20, STATE.wetThreshold - 10);
        }

        syncSettingsToUI();
        renderDashboard();
    });

    $('max')?.addEventListener('input', e => {
        STATE.maxDuration = Number(e.target.value);
        syncSettingsToUI();
    });

    document.querySelectorAll('#modes button').forEach(btn => {
        btn.addEventListener('click', () => setControlMode(btn.dataset.m));
    });

    $('saveSettings')?.addEventListener('click', saveSettingsToSupabase);
    $('hwBtn')?.addEventListener('click', runHardwareCheck);
    $('exp')?.addEventListener('click', exportCsv);

    document.querySelectorAll('#tfs button').forEach(btn => {
        btn.addEventListener('click', () => {
            STATE.timeframe = Number(btn.dataset.t);

            document.querySelectorAll('#tfs button').forEach(x =>
                x.classList.toggle('on', x === btn)
            );

            renderHistoryChart();
        });
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    applyPresetThresholds();
    bindUIEvents();
    renderDashboard();

    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;

        if (data.session?.user) {
            const profile = await fetchAccountProfile(data.session.user.id);

            if (profile?.status === 'Active') {
                enterDashboard(profile);
            } else {
                await supabaseClient.auth.signOut();
                $('authErr').textContent = profile
                    ? 'This account is inactive. Contact the administrator.'
                    : 'This login has no dashboard account profile. Contact the administrator.';
            }
        }
    } catch (err) {
        $('authErr').textContent = `Database error: ${explainDatabaseError(err.message)}`;
    }

    setInterval(() => {
        if (!STATE.role) return;

        evaluateIrrigationLogic(true);
        renderDashboard();
    }, 1000);

    setInterval(async () => {
        if (!STATE.role) return;

        await fetchLatestTelemetry();

        if (STATE.role === 'A') {
            await fetchManagedUsers();
        }
    }, 10000);
});
