(() => {
    const STAGES = ['Seedling', 'Vegetative', 'Flowering', 'Fruiting'];
    const SEASONS = ['auto', 'dry', 'wet'];
    const REMARKS = ['Wet threshold reached', 'Safety limit reached', 'Manual override (administrator)'];
    const SAVE_INTERVAL_MS = 30000;
    const ALERT_COOLDOWN_MS = 300000;
    const STALE_AFTER_MS = 180000;

    const link = {
        port: null,
        writer: null,
        reader: null,
        firstLine: true,
        lastSave: 0,
        lastHistory: 0,
        lastCommand: 0
    };
    const shownAlerts = {};

    Object.assign(STATE, { source: 'none', lastDataTs: 0, rawAdc: null });

    const quiet = promise => Promise.resolve(promise).catch(() => {});

    const setNote = text => {
        if ($('linkNote')) $('linkNote').textContent = text;
    };

    const formatAge = ms => {
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return `${seconds} s`;
        if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
        return `${(seconds / 3600).toFixed(1)} h`;
    };

    const simulateDemo = window.evaluateIrrigationLogic;
    window.evaluateIrrigationLogic = function (advance = true) {
        if (STATE.source === 'demo') simulateDemo(advance);
        else checkAlertConditions();
    };

    const logAlert = window.logSystemAlertToSupabase;
    window.logSystemAlertToSupabase = (...args) => {
        if (STATE.source === 'usb') return logAlert(...args);
    };

    const showAlert = window.showCenterAlert;
    window.showCenterAlert = (title, message, severity) => {
        const fresh = STATE.source === 'usb'
            || (STATE.source === 'db' && Date.now() - STATE.lastDataTs < ALERT_COOLDOWN_MS);
        const key = title + message.slice(0, 40);

        if (!fresh || Date.now() - (shownAlerts[key] || 0) < ALERT_COOLDOWN_MS) return;

        shownAlerts[key] = Date.now();
        showAlert(title.replace(/^IoT /, 'System '), message, severity);
    };

    async function loadSavedReadings() {
        try {
            const sensors = await supabaseFetch(
                'sensor_data?select=sensor_id,timestamp,soil_moisture_value,raw_adc&order=timestamp.desc&limit=1500'
            );

            if (!Array.isArray(sensors) || !sensors.length) {
                STATE.source = 'none';
                return;
            }

            const temperatures = await supabaseFetch(
                'temperature_data?select=sensor_id,temperature_value&order=timestamp.desc&limit=1500'
            ).catch(() => []);

            const tempBySensor = new Map(
                (temperatures || []).map(row => [row.sensor_id, Number(row.temperature_value)])
            );

            let lastTs = 0;
            STATE.history = [];

            sensors.slice().reverse().forEach(row => {
                const ts = parseDbTime(row.timestamp);
                if (ts - lastTs < 55000) return;
                lastTs = ts;

                STATE.history.push({
                    ts,
                    m: Number(row.soil_moisture_value),
                    t: tempBySensor.get(row.sensor_id) ?? STATE.currentTemp,
                    p: STATE.activityLogs.some(l => ts <= l.ts && ts >= l.ts - l.dur * 60000)
                });
            });

            const latest = STATE.history[STATE.history.length - 1];

            Object.assign(STATE, {
                source: 'db',
                lastDataTs: latest.ts,
                rawAdc: sensors[0].raw_adc,
                currentMoisture: latest.m,
                currentTemp: latest.t
            });
        } catch (err) {
            console.error('Saved readings error:', err);
        }
    }

    const fetchTelemetry = window.fetchLatestTelemetry;
    window.fetchLatestTelemetry = async function () {
        const keep = { ...STATE };
        await fetchTelemetry();

        if (STATE.source === 'usb' || STATE.source === 'demo') {
            ['currentMoisture', 'currentTemp', 'dryThreshold', 'wetThreshold', 'maxDuration', 'stage', 'season']
                .forEach(key => { STATE[key] = keep[key]; });
            syncSettingsToUI();
        } else {
            await loadSavedReadings();
        }

        renderDashboard();
    };

    const renderBase = window.renderDashboard;
    window.renderDashboard = function () {
        renderBase();

        const source = STATE.source;
        const age = Date.now() - STATE.lastDataTs;
        let text = 'No data yet';
        let stale = true;

        if (source === 'usb') {
            text = 'Live from Arduino UNO';
            stale = false;
        } else if (source === 'demo') {
            text = 'DEMO DATA (simulated)';
        } else if (source === 'db') {
            stale = age > STALE_AFTER_MS;
            text = `Saved data, updated ${formatAge(age)} ago${stale ? ' (may be outdated)' : ''}`;
        }

        if ($('liveStatus')) {
            $('liveStatus').textContent = text;
            $('liveStatus').className = stale ? 'chip stale' : 'chip';
        }

        if (source === 'none') {
            ['mPct', 'tVal', 'mAdc'].forEach(id => { if ($(id)) $(id).textContent = '--'; });
        }

        if (source === 'db') {
            if ($('pState')) $('pState').textContent = '--';
            if ($('pSub')) $('pSub').textContent = 'Live pump state needs the Arduino connection';
        }
    };

    const sendLine = line => {
        if (link.writer) link.writer.write(`${line}\n`).catch(() => {});
    };

    const sendSettings = () => {
        const values = [
            Math.round(STATE.dryThreshold),
            Math.round(STATE.wetThreshold),
            Math.round(STATE.maxDuration),
            STAGES.indexOf(STATE.stage),
            SEASONS.indexOf(STATE.season)
        ];
        sendLine(`C,${values.join(',')}`);
    };

    const saveSettings = window.saveSettingsToSupabase;
    window.saveSettingsToSupabase = async function () {
        const saved = await saveSettings();
        if (saved) sendSettings();
        return saved;
    };

    const setControlModeBase = window.setControlMode;
    window.setControlMode = mode => {
        if (STATE.role !== 'A') return;
        link.lastCommand = Date.now();
        setControlModeBase(mode);
        sendLine(`M,${mode}`);
    };

    async function saveSample() {
        if (STATE.role !== 'A' || Date.now() - link.lastSave < SAVE_INTERVAL_MS) return;
        link.lastSave = Date.now();

        try {
            const sensor = await supabaseFetch('sensor_data', {
                method: 'POST',
                body: JSON.stringify([{
                    soil_moisture_value: Number(STATE.currentMoisture.toFixed(1)),
                    raw_adc: STATE.rawAdc
                }])
            });

            const sensorId = sensor?.[0]?.sensor_id;
            if (sensorId) STATE.currentSensorId = sensorId;

            await supabaseFetch('temperature_data', {
                method: 'POST',
                body: JSON.stringify([{
                    sensor_id: sensorId,
                    temperature_value: Number(STATE.currentTemp.toFixed(1))
                }])
            });

            setNote('Live, saved to database');
        } catch (err) {
            setNote('Database offline. The SD card keeps logging.');
        }
    }

    async function saveRun(seconds, reasonCode) {
        const minutes = Number((seconds / 60).toFixed(1));
        const remarks = REMARKS[reasonCode] || 'Automatic';
        let entry = { id: '-', ts: Date.now(), dur: minutes, rm: remarks };

        try {
            const saved = await supabaseFetch('watering_activity', {
                method: 'POST',
                body: JSON.stringify([{
                    pump_id: STATE.currentPumpId,
                    setting_id: STATE.currentSettingId,
                    admin_id: STATE.userAccount?.id ?? null,
                    pump_status: 'OFF',
                    watering_duration: minutes,
                    operational_remarks: remarks
                }])
            });

            const row = Array.isArray(saved) ? saved[0] : null;
            if (row) entry = { id: row.activity_id, ts: parseDbTime(row.timestamp), dur: minutes, rm: remarks };
        } catch (err) {
            console.error('Watering log error:', err);
        }

        STATE.activityLogs.unshift(entry);
        renderDashboard();
    }

    function handleLine(raw) {
        const parts = raw.trim().split(',');

        if (parts[0] === 'S' && parts.length >= 12) {
            Object.assign(STATE, {
                source: 'usb',
                lastDataTs: Date.now(),
                currentMoisture: Number(parts[1]) / 10,
                rawAdc: Number(parts[2]),
                currentTemp: Number(parts[3]) / 10,
                pumpActive: parts[4] === '1',
                currentRunDuration: Math.floor(Number(parts[11]) / 60)
            });

            if (Date.now() - link.lastCommand > 3000) STATE.controlMode = parts[5];

            if (link.firstLine) {
                link.firstLine = false;
                Object.assign(STATE, {
                    dryThreshold: Number(parts[6]),
                    wetThreshold: Number(parts[7]),
                    maxDuration: Number(parts[8]),
                    stage: STAGES[Number(parts[9])] || STATE.stage,
                    season: SEASONS[Number(parts[10])] || 'auto'
                });
                syncSettingsToUI();
            }

            if (Date.now() - link.lastHistory > 59000) {
                link.lastHistory = Date.now();
                STATE.history.push({
                    ts: Date.now(),
                    m: STATE.currentMoisture,
                    t: STATE.currentTemp,
                    p: STATE.pumpActive
                });
                if (STATE.history.length > 1440) STATE.history.shift();
            }

            document.querySelectorAll('#modes button').forEach(btn => {
                btn.classList.toggle('on', btn.dataset.m === STATE.controlMode);
            });

            checkAlertConditions();
            saveSample();
            renderDashboard();
        } else if (parts[0] === 'L' && parts.length >= 5) {
            saveRun(Number(parts[3]), Number(parts[4]));
        }
    }

    async function connectArduino() {
        if (link.port) return disconnectArduino();

        if (!('serial' in navigator)) {
            setNote('Use Chrome or Edge on a PC.');
            return;
        }

        try {
            link.port = await navigator.serial.requestPort();
            await link.port.open({ baudRate: 9600 });

            const encoder = new TextEncoderStream();
            encoder.readable.pipeTo(link.port.writable);
            link.writer = encoder.writable.getWriter();

            const decoder = new TextDecoderStream();
            link.port.readable.pipeTo(decoder.writable);
            link.reader = decoder.readable.getReader();

            STATE.source = 'usb';
            STATE.history = [];
            link.firstLine = true;
            $('btnUsb').textContent = 'Disconnect Arduino';
            setNote('Connected, waiting for data...');

            let buffer = '';
            for (;;) {
                const { value, done } = await link.reader.read();
                if (done) break;

                buffer += value;
                let end;
                while ((end = buffer.indexOf('\n')) >= 0) {
                    handleLine(buffer.slice(0, end));
                    buffer = buffer.slice(end + 1);
                }
            }
        } catch (err) {
            setNote(`Could not connect: ${err.message}`);
        }

        await disconnectArduino();
    }

    async function disconnectArduino() {
        const { reader, writer, port } = link;
        link.port = link.writer = link.reader = null;

        await quiet(reader?.cancel());
        await quiet(writer?.close());
        await quiet(port?.close());

        if (STATE.source === 'usb') STATE.source = 'none';
        if ($('btnUsb')) $('btnUsb').textContent = 'Connect Arduino';
        setNote('Not connected');

        window.fetchLatestTelemetry();
    }

    function toggleDemo() {
        if (STATE.source === 'demo') {
            STATE.source = 'none';
            STATE.history = [];
            $('btnDemo').textContent = 'Start demo data';
            window.fetchLatestTelemetry();
            return;
        }

        if (link.port) {
            setNote('Disconnect the Arduino first.');
            return;
        }

        Object.assign(STATE, { source: 'demo', history: [], currentMoisture: 55, rawAdc: null, lastDataTs: Date.now() });

        for (let i = 360; i >= 0; i--) {
            STATE.history.push({
                ts: Date.now() - i * 60000,
                m: 50 + Math.sin(i / 10) * 8,
                t: 28 + Math.cos(i / 15) * 3,
                p: false
            });
        }

        $('btnDemo').textContent = 'Stop demo data';
        renderDashboard();
    }

    window.runHardwareCheck = function () {
        if (STATE.role !== 'A') return;

        const live = STATE.source === 'usb' && Date.now() - STATE.lastDataTs < 5000;
        const raw = STATE.rawAdc;
        const temp = STATE.currentTemp;

        const rows = [
            ['Arduino UNO', live ? ['ok', 'Connected'] : ['bad', 'Not connected']],
            ['Soil moisture sensor', !live ? ['mut', 'Unknown']
                : raw >= 1020 ? ['warn', 'Reads maximum: in air or unplugged?']
                : ['ok', `Reading ${raw}`]],
            ['Temperature sensor', !live ? ['mut', 'Unknown']
                : (temp < -50 || temp > 80) ? ['bad', 'Not detected']
                : ['ok', `${temp.toFixed(1)} C`]],
            ['Relay and pump', ['mut', live ? `Commanded ${STATE.pumpActive ? 'ON' : 'OFF'}. Confirm by eye` : 'Unknown']],
            ['Sprinkler, water, power', ['mut', 'Not measured. Check on site']]
        ];

        $('hw').innerHTML = rows.map(([name, [cls, status]]) =>
            `<div class="row"><span>${escapeHtml(name)}</span><span class="${cls}">${escapeHtml(status)}</span></div>`
        ).join('');

        $('hwT').textContent = `Checked at ${formatTimestamp(Date.now())}`;
    };

    document.addEventListener('DOMContentLoaded', () => {
        $('btnUsb')?.addEventListener('click', connectArduino);
        $('btnDemo')?.addEventListener('click', toggleDemo);

        ['stage', 'season', 'dry', 'wet', 'max'].forEach(id => {
            $(id)?.addEventListener('input', () => { link.lastCommand = Date.now(); });
        });

        window.addEventListener('resize', () => renderHistoryChart());
    });
})();
