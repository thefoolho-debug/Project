(function () {
    const SAVE_EVERY = 15000;
    const STALE_AFTER = 60000;
    const ALERT_PAUSE = 300000;

    const STAGE_NAMES = ['Seedling', 'Vegetative', 'Flowering', 'Fruiting'];
    const SEASON_NAMES = ['auto', 'dry', 'wet'];
    const RUN_REASONS = ['Wet threshold reached', 'Safety limit reached', 'Manual override (administrator)'];

    let usbPort = null;
    let usbWriter = null;
    let usbReader = null;
    let firstLine = true;
    let lastSaveTime = 0;
    let lastHistoryTime = 0;
    let lastCommandTime = 0;
    const lastAlertTime = {};
    let liveChannel = null;
    let liveReady = false;
    let liveRetryAt = 0;

    STATE.source = 'none';
    STATE.lastDataTs = 0;
    STATE.rawAdc = null;

    function setNote(text) {
        if ($('linkNote')) $('linkNote').textContent = text;
    }

    function formatAge(ms) {
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return seconds + ' s';
        if (seconds < 3600) return Math.round(seconds / 60) + ' min';
        return (seconds / 3600).toFixed(1) + ' h';
    }

    const originalEvaluate = window.evaluateIrrigationLogic;
    window.evaluateIrrigationLogic = function (advance) {
        if (STATE.source === 'demo') {
            originalEvaluate(advance);
        } else {
            checkAlertConditions();
        }
    };

    const originalLogAlert = window.logSystemAlertToSupabase;
    window.logSystemAlertToSupabase = function (type, message, severity) {
        if (STATE.source === 'usb') {
            return originalLogAlert(type, message, severity);
        }
    };

    const originalShowAlert = window.showCenterAlert;
    window.showCenterAlert = function (title, message, severity) {
        const dataIsFresh = STATE.source === 'usb' || STATE.source === 'live' ||
            (STATE.source === 'db' && Date.now() - STATE.lastDataTs < ALERT_PAUSE);
        const key = title + message.slice(0, 40);

        if (!dataIsFresh) return;
        if (Date.now() - (lastAlertTime[key] || 0) < ALERT_PAUSE) return;

        lastAlertTime[key] = Date.now();
        originalShowAlert(title.replace(/^IoT /, 'System '), message, severity);
    };

    async function startLiveChannel() {
        if (liveChannel || !STATE.role) return;
        if (Date.now() < liveRetryAt) return;
        if (typeof supabaseClient.channel !== 'function') return;

        try {
            if (supabaseClient.realtime && typeof supabaseClient.realtime.setAuth === 'function') {
                await supabaseClient.realtime.setAuth();
            }
        } catch (err) {
            console.warn('Realtime auth failed:', err.message);
        }

        const channel = supabaseClient.channel('hanggang-bunga-live', { config: { private: true } });
        liveChannel = channel;

        channel.on('broadcast', { event: 'reading' }, message => {
            handleLiveReading(message.payload);
        });

        channel.subscribe(status => {
            if (liveChannel !== channel) return;
            liveReady = status === 'SUBSCRIBED';

            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                console.warn('Live channel status:', status);
                liveChannel = null;
                liveRetryAt = Date.now() + 60000;
                supabaseClient.removeChannel(channel);
            }
        });
    }

    function handleLiveReading(data) {
        if (STATE.role === 'A') return;

        STATE.source = 'live';
        STATE.lastDataTs = Date.now();
        STATE.currentMoisture = Number(data.moisture);
        STATE.rawAdc = Number(data.adc);
        STATE.currentTemp = Number(data.temp);
        STATE.pumpActive = data.pump === true;
        STATE.controlMode = data.mode;
        STATE.currentRunDuration = Number(data.run);
        STATE.dryThreshold = Number(data.dry);
        STATE.wetThreshold = Number(data.wet);
        STATE.maxDuration = Number(data.max);
        STATE.stage = data.stage;
        STATE.season = data.season;
        syncSettingsToUI();

        if (Date.now() - lastHistoryTime > 59000) {
            lastHistoryTime = Date.now();
            STATE.history.push({
                ts: Date.now(),
                m: STATE.currentMoisture,
                t: STATE.currentTemp,
                p: STATE.pumpActive
            });
            if (STATE.history.length > 1440) STATE.history.shift();
        }

        checkAlertConditions();
        renderDashboard();
    }

    function broadcastReading() {
        if (!liveChannel || !liveReady || STATE.role !== 'A') return;

        liveChannel.send({
            type: 'broadcast',
            event: 'reading',
            payload: {
                moisture: STATE.currentMoisture,
                adc: STATE.rawAdc,
                temp: STATE.currentTemp,
                pump: STATE.pumpActive,
                mode: STATE.controlMode,
                run: STATE.currentRunDuration,
                dry: STATE.dryThreshold,
                wet: STATE.wetThreshold,
                max: STATE.maxDuration,
                stage: STATE.stage,
                season: STATE.season
            }
        });
    }

    async function loadSavedReadings() {
        try {
            const sensors = await supabaseFetch(
                'sensor_data?select=sensor_id,timestamp,soil_moisture_value,raw_adc,pump_on&order=timestamp.desc&limit=1500'
            );

            if (!Array.isArray(sensors) || sensors.length === 0) {
                STATE.source = 'none';
                return;
            }

            let temperatures = [];
            try {
                temperatures = await supabaseFetch(
                    'temperature_data?select=sensor_id,temperature_value&order=timestamp.desc&limit=1500'
                );
            } catch (err) {
                console.warn('Could not load temperatures:', err.message);
            }

            const tempBySensor = new Map();
            temperatures.forEach(row => {
                tempBySensor.set(row.sensor_id, Number(row.temperature_value));
            });

            STATE.history = [];
            let lastTs = 0;

            sensors.reverse().forEach(row => {
                const ts = parseDbTime(row.timestamp);
                if (ts - lastTs < 55000) return;
                lastTs = ts;

                const pumpWasOn = row.pump_on === true ||
                    STATE.activityLogs.some(run => ts <= run.ts && ts >= run.ts - run.dur * 60000);
                const temp = tempBySensor.has(row.sensor_id) ? tempBySensor.get(row.sensor_id) : STATE.currentTemp;

                STATE.history.push({
                    ts: ts,
                    m: Number(row.soil_moisture_value),
                    t: temp,
                    p: pumpWasOn
                });
            });

            const latest = STATE.history[STATE.history.length - 1];
            STATE.source = 'db';
            STATE.lastDataTs = latest.ts;
            STATE.rawAdc = sensors[sensors.length - 1].raw_adc;
            STATE.currentMoisture = latest.m;
            STATE.currentTemp = latest.t;
            STATE.pumpActive = sensors[sensors.length - 1].pump_on === true;
        } catch (err) {
            console.error('Saved readings error:', err);
        }
    }

    const originalFetchTelemetry = window.fetchLatestTelemetry;
    window.fetchLatestTelemetry = async function () {
        const keep = {
            currentMoisture: STATE.currentMoisture,
            currentTemp: STATE.currentTemp,
            dryThreshold: STATE.dryThreshold,
            wetThreshold: STATE.wetThreshold,
            maxDuration: STATE.maxDuration,
            stage: STATE.stage,
            season: STATE.season
        };

        await startLiveChannel();
        await originalFetchTelemetry();

        const liveIsFresh = STATE.source === 'live' && Date.now() - STATE.lastDataTs < 5000;

        if (STATE.source === 'usb' || STATE.source === 'demo' || liveIsFresh) {
            Object.assign(STATE, keep);
            syncSettingsToUI();
        } else {
            await loadSavedReadings();
        }

        renderDashboard();
    };

    const originalRender = window.renderDashboard;
    window.renderDashboard = function () {
        originalRender();

        let text = 'No data yet';
        let stale = true;
        const age = Date.now() - STATE.lastDataTs;

        if (STATE.source === 'usb') {
            text = 'Live from Arduino UNO';
            stale = false;
        } else if (STATE.source === 'live') {
            text = 'Live from Arduino UNO';
            stale = age > 5000;
            if (stale) text += ' (connection lost)';
        } else if (STATE.source === 'demo') {
            text = 'DEMO DATA (simulated)';
        } else if (STATE.source === 'db') {
            stale = age > STALE_AFTER;
            text = 'Saved data, updated ' + formatAge(age) + ' ago';
            if (stale) text += ' (may be outdated)';
        }

        if ($('liveStatus')) {
            $('liveStatus').textContent = text;
            $('liveStatus').className = stale ? 'chip stale' : 'chip';
        }

        if (STATE.source === 'none') {
            ['mPct', 'tVal', 'mAdc'].forEach(id => {
                if ($(id)) $(id).textContent = '--';
            });
        }

        if (STATE.source === 'db' && stale) {
            if ($('pState')) $('pState').textContent = '--';
            if ($('pSub')) $('pSub').textContent = 'No recent data from the Arduino';
        }
    };

    function sendToArduino(text) {
        if (!usbWriter) return;
        usbWriter.write(text + '\n').catch(err => console.warn('Send failed:', err.message));
    }

    function sendSettings() {
        const values = [
            Math.round(STATE.dryThreshold),
            Math.round(STATE.wetThreshold),
            Math.round(STATE.maxDuration),
            STAGE_NAMES.indexOf(STATE.stage),
            SEASON_NAMES.indexOf(STATE.season)
        ];
        sendToArduino('C,' + values.join(','));
    }

    const originalSaveSettings = window.saveSettingsToSupabase;
    window.saveSettingsToSupabase = async function () {
        const saved = await originalSaveSettings();
        if (saved) sendSettings();
        return saved;
    };

    const originalSetMode = window.setControlMode;
    window.setControlMode = function (mode) {
        if (STATE.role !== 'A') return;
        lastCommandTime = Date.now();
        originalSetMode(mode);
        sendToArduino('M,' + mode);
    };

    async function saveReading() {
        if (STATE.role !== 'A') return;
        if (Date.now() - lastSaveTime < SAVE_EVERY) return;
        lastSaveTime = Date.now();

        try {
            const sensorRows = await supabaseFetch('sensor_data', {
                method: 'POST',
                body: JSON.stringify([{
                    soil_moisture_value: Number(STATE.currentMoisture.toFixed(1)),
                    raw_adc: STATE.rawAdc,
                    pump_on: STATE.pumpActive
                }])
            });

            const sensorId = sensorRows[0] ? sensorRows[0].sensor_id : null;
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
            if (err.status) {
                setNote('Database refused the data: ' + err.message);
            } else {
                setNote('Database offline. The SD card keeps logging.');
            }
        }
    }

    async function saveRun(seconds, reasonCode) {
        const minutes = Number((seconds / 60).toFixed(1));
        const remarks = RUN_REASONS[reasonCode] || 'Automatic';
        let entry = { id: '-', ts: Date.now(), dur: minutes, rm: remarks };

        try {
            const saved = await supabaseFetch('watering_activity', {
                method: 'POST',
                body: JSON.stringify([{
                    pump_id: STATE.currentPumpId,
                    setting_id: STATE.currentSettingId,
                    admin_id: STATE.userAccount ? STATE.userAccount.id : null,
                    pump_status: 'OFF',
                    watering_duration: minutes,
                    operational_remarks: remarks
                }])
            });

            if (saved[0]) {
                entry = {
                    id: saved[0].activity_id,
                    ts: parseDbTime(saved[0].timestamp),
                    dur: minutes,
                    rm: remarks
                };
            }
        } catch (err) {
            console.error('Watering log error:', err);
        }

        STATE.activityLogs.unshift(entry);
        renderDashboard();
    }

    function readStatusLine(parts) {
        STATE.source = 'usb';
        STATE.lastDataTs = Date.now();
        STATE.currentMoisture = Number(parts[1]) / 10;
        STATE.rawAdc = Number(parts[2]);
        STATE.currentTemp = Number(parts[3]) / 10;
        STATE.pumpActive = parts[4] === '1';
        STATE.currentRunDuration = Math.floor(Number(parts[11]) / 60);

        if (Date.now() - lastCommandTime > 3000) {
            STATE.controlMode = parts[5];
        }

        if (firstLine) {
            firstLine = false;
            STATE.dryThreshold = Number(parts[6]);
            STATE.wetThreshold = Number(parts[7]);
            STATE.maxDuration = Number(parts[8]);
            STATE.stage = STAGE_NAMES[Number(parts[9])] || STATE.stage;
            STATE.season = SEASON_NAMES[Number(parts[10])] || 'auto';
            syncSettingsToUI();
        }

        if (Date.now() - lastHistoryTime > 59000) {
            lastHistoryTime = Date.now();
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
        saveReading();
        broadcastReading();
        renderDashboard();
    }

    function handleLine(text) {
        const parts = text.trim().split(',');

        if (parts[0] === 'S' && parts.length >= 12) {
            readStatusLine(parts);
        } else if (parts[0] === 'L' && parts.length >= 5) {
            saveRun(Number(parts[3]), Number(parts[4]));
        }
    }

    async function connectArduino() {
        if (usbPort) {
            await disconnectArduino();
            return;
        }

        if (!('serial' in navigator)) {
            setNote('Use Chrome or Edge on a PC.');
            return;
        }

        try {
            usbPort = await navigator.serial.requestPort();
            await usbPort.open({ baudRate: 9600 });

            const encoder = new TextEncoderStream();
            encoder.readable.pipeTo(usbPort.writable);
            usbWriter = encoder.writable.getWriter();

            const decoder = new TextDecoderStream();
            usbPort.readable.pipeTo(decoder.writable);
            usbReader = decoder.readable.getReader();

            STATE.source = 'usb';
            STATE.history = [];
            firstLine = true;
            $('btnUsb').textContent = 'Disconnect Arduino';
            setNote('Connected, waiting for data...');

            let buffer = '';
            while (true) {
                const result = await usbReader.read();
                if (result.done) break;

                buffer += result.value;
                let newline = buffer.indexOf('\n');
                while (newline >= 0) {
                    handleLine(buffer.slice(0, newline));
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf('\n');
                }
            }
        } catch (err) {
            setNote('Could not connect: ' + err.message);
        }

        await disconnectArduino();
    }

    async function disconnectArduino() {
        const reader = usbReader;
        const writer = usbWriter;
        const port = usbPort;

        usbReader = null;
        usbWriter = null;
        usbPort = null;

        try { if (reader) await reader.cancel(); } catch (err) { console.warn(err.message); }
        try { if (writer) await writer.close(); } catch (err) { console.warn(err.message); }
        try { if (port) await port.close(); } catch (err) { console.warn(err.message); }

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

        if (usbPort) {
            setNote('Disconnect the Arduino first.');
            return;
        }

        STATE.source = 'demo';
        STATE.history = [];
        STATE.currentMoisture = 55;
        STATE.rawAdc = null;
        STATE.lastDataTs = Date.now();

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

        const connected = STATE.source === 'usb' && Date.now() - STATE.lastDataTs < 5000;
        const rows = [];

        rows.push(['Arduino UNO', connected ? 'ok' : 'bad', connected ? 'Connected' : 'Not connected']);

        if (!connected) {
            rows.push(['Soil moisture sensor', 'mut', 'Unknown']);
            rows.push(['Temperature sensor', 'mut', 'Unknown']);
            rows.push(['Relay and pump', 'mut', 'Unknown']);
        } else {
            if (STATE.rawAdc >= 1020) {
                rows.push(['Soil moisture sensor', 'warn', 'Reads maximum: in air or unplugged?']);
            } else {
                rows.push(['Soil moisture sensor', 'ok', 'Reading ' + STATE.rawAdc]);
            }

            if (STATE.currentTemp < -50 || STATE.currentTemp > 80) {
                rows.push(['Temperature sensor', 'bad', 'Not detected']);
            } else {
                rows.push(['Temperature sensor', 'ok', STATE.currentTemp.toFixed(1) + ' C']);
            }

            rows.push(['Relay and pump', 'mut', 'Commanded ' + (STATE.pumpActive ? 'ON' : 'OFF') + '. Confirm by eye']);
        }

        rows.push(['Sprinkler, water, power', 'mut', 'Not measured. Check on site']);

        $('hw').innerHTML = rows.map(row =>
            '<div class="row"><span>' + escapeHtml(row[0]) + '</span><span class="' + row[1] + '">' +
            escapeHtml(row[2]) + '</span></div>'
        ).join('');

        $('hwT').textContent = 'Checked at ' + formatTimestamp(Date.now());
    };

    document.addEventListener('DOMContentLoaded', function () {
        if ($('btnUsb')) $('btnUsb').addEventListener('click', connectArduino);
        if ($('btnDemo')) $('btnDemo').addEventListener('click', toggleDemo);

        ['stage', 'season', 'dry', 'wet', 'max'].forEach(id => {
            if ($(id)) $(id).addEventListener('input', () => { lastCommandTime = Date.now(); });
        });

        window.addEventListener('resize', renderHistoryChart);
    });
})();
