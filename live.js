
(() => {
const L = { port: null, writer: null, reader: null, lastSave: 0, first: true, touch: 0, lastHist: 0 };
const STG = ['Seedling', 'Vegetative', 'Flowering', 'Fruiting'], SEA = ['auto', 'dry', 'wet'];
const RSN = ['Wet threshold reached', 'Safety limit reached', 'Manual override (administrator)'];
Object.assign(STATE, { source: 'none', lastDataTs: 0, rawAdc: null });
const note = t => { if ($('linkNote')) $('linkNote').textContent = t; };
const ago = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };

window.seedDemoHistory = () => {};                                   // no fake history on page load

const simulate = window.evaluateIrrigationLogic;
window.evaluateIrrigationLogic = function (advance = true) {
  if (STATE.source === 'demo') simulate(advance);                    // browser simulation only in demo mode
  else checkAlertConditions();                                       // live/saved data: the UNO decides, not the browser
};
const logAlert = window.logSystemAlertToSupabase;
window.logSystemAlertToSupabase = (...a) => { if (STATE.source === 'usb') return logAlert(...a); };
window.logWateringEventToSupabase = () => {};                        // runs are saved from the UNO's own reports

const showAlert = window.showCenterAlert, seen = {};
window.showCenterAlert = (title, msg, sev) => {
  const live = STATE.source === 'usb' || (STATE.source === 'db' && Date.now() - STATE.lastDataTs < 300000);
  const k = title + msg.slice(0, 40);
  if (!live || Date.now() - (seen[k] || 0) < 300000) return;         // no spam, no alerts from stale/fake data
  seen[k] = Date.now(); showAlert(title.replace(/^IoT /, 'System '), msg, sev);
};

async function loadSaved() {
  try {
    const s = await supabaseFetch('sensor_data?select=sensor_id,timestamp,soil_moisture_value,raw_adc&order=timestamp.desc&limit=1500');
    if (!Array.isArray(s) || !s.length) { STATE.source = 'none'; return; }
    const t = await supabaseFetch('temperature_data?select=sensor_id,temperature_value&order=timestamp.desc&limit=1500').catch(() => []);
    const tm = new Map((t || []).map(r => [r.sensor_id, Number(r.temperature_value)]));
    let last = 0; STATE.history = [];
    s.slice().reverse().forEach(r => {
      const ts = new Date(r.timestamp).getTime();
      if (ts - last < 55000) return; last = ts;                      // one point per minute, like the chart expects
      STATE.history.push({ ts, m: Number(r.soil_moisture_value), t: tm.get(r.sensor_id) ?? STATE.currentTemp,
        p: STATE.activityLogs.some(l => ts <= l.ts && ts >= l.ts - l.dur * 60000) });
    });
    const h = STATE.history[STATE.history.length - 1];
    Object.assign(STATE, { source: 'db', lastDataTs: h.ts, rawAdc: s[0].raw_adc, currentMoisture: h.m, currentTemp: h.t });
  } catch (_) {}
}
const fetchAll = window.fetchLatestTelemetry;
window.fetchLatestTelemetry = async function () {
  const keep = { ...STATE };
  await fetchAll();
  if (STATE.source === 'usb' || STATE.source === 'demo') {           // the UNO / demo is authoritative
    ['currentMoisture', 'currentTemp', 'dryThreshold', 'wetThreshold', 'maxDuration', 'stage', 'season'].forEach(k => STATE[k] = keep[k]);
    syncSettingsToUI();
  } else await loadSaved();
  renderDashboard();
};

const render = window.renderDashboard;
window.renderDashboard = function () {
  render();
  const src = STATE.source, age = Date.now() - STATE.lastDataTs, chip = $('liveStatus');
  let txt = 'No data yet', cls = 'stale';
  if (src === 'usb') { txt = 'Live from Arduino UNO'; cls = ''; }
  else if (src === 'demo') txt = 'DEMO DATA (simulated)';
  else if (src === 'db') { txt = `Saved data, updated ${ago(age)} ago`; cls = age > 180000 ? 'stale' : ''; if (cls) txt += ' (may be outdated)'; }
  if (chip) { chip.textContent = txt; chip.className = 'chip ' + cls; }
  if (STATE.rawAdc != null && src !== 'demo' && $('mAdc')) $('mAdc').textContent = STATE.rawAdc;
  if (src === 'none') ['mPct', 'tVal', 'mAdc'].forEach(i => $(i) && ($(i).textContent = '--'));
  if (src === 'db') { if ($('pState')) $('pState').textContent = '--'; if ($('pSub')) $('pSub').textContent = 'Live pump state needs the Arduino connection'; }
};

const send = line => { if (L.writer) L.writer.write(line + '\n').catch(() => {}); };
const sendCfg = () => send(`C,${Math.round(STATE.dryThreshold)},${Math.round(STATE.wetThreshold)},${Math.round(STATE.maxDuration)},${STG.indexOf(STATE.stage)},${SEA.indexOf(STATE.season)}`);
const saveSettings = window.saveSettingsToSupabase;
window.saveSettingsToSupabase = async function () { const ok = await saveSettings(); if (ok) sendCfg(); return ok; };
const setMode = window.setControlMode;
window.setControlMode = m => { if (STATE.role !== 'A') return; L.touch = Date.now(); setMode(m); send('M,' + m); };

async function saveSample() {                                        // sensor_data, then temperature_data linked to it
  if (Date.now() - L.lastSave < 30000 || STATE.role !== 'A') return; L.lastSave = Date.now();
  try {
    const s = await supabaseFetch('sensor_data', { method: 'POST', body: JSON.stringify([{ soil_moisture_value: +STATE.currentMoisture.toFixed(1), raw_adc: STATE.rawAdc }]) });
    const id = s?.[0]?.sensor_id; if (id) STATE.currentSensorId = id;
    await supabaseFetch('temperature_data', { method: 'POST', body: JSON.stringify([{ sensor_id: id, temperature_value: +STATE.currentTemp.toFixed(1) }]) });
    note('Live, saved to database');
  } catch (e) { note('Database offline. The SD card keeps logging.'); }
}
async function saveRun(sec, rsn) {
  const min = +(sec / 60).toFixed(1), rm = RSN[rsn] || 'Automatic';
  STATE.activityLogs.unshift({ id: '-', ts: Date.now(), dur: min, rm });
  try {
    await supabaseFetch('watering_activity', { method: 'POST', body: JSON.stringify([{ pump_id: STATE.currentPumpId, setting_id: STATE.currentSettingId,
      admin_id: STATE.userAccount?.id ?? null, pump_status: 'OFF', watering_duration: min, operational_remarks: rm }]) });
  } catch (_) {}
}

function onLine(l) {
  const p = l.trim().split(',');
  if (p[0] === 'S' && p.length >= 12) {
    Object.assign(STATE, { source: 'usb', lastDataTs: Date.now(), currentMoisture: +p[1] / 10, rawAdc: +p[2], currentTemp: +p[3] / 10,
      pumpActive: p[4] === '1', currentRunDuration: Math.floor(+p[11] / 60) });
    if (Date.now() - L.touch > 3000) STATE.controlMode = p[5];
    if (L.first) { L.first = false; Object.assign(STATE, { dryThreshold: +p[6], wetThreshold: +p[7], maxDuration: +p[8], stage: STG[+p[9]] || STATE.stage, season: SEA[+p[10]] || 'auto' }); syncSettingsToUI(); }
    if (Date.now() - L.lastHist > 59000) { L.lastHist = Date.now(); STATE.history.push({ ts: Date.now(), m: STATE.currentMoisture, t: STATE.currentTemp, p: STATE.pumpActive }); if (STATE.history.length > 1440) STATE.history.shift(); }
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.m === STATE.controlMode));
    checkAlertConditions(); saveSample(); renderDashboard();
  } else if (p[0] === 'L' && p.length >= 5) saveRun(+p[3], +p[4]);
}
async function connect() {
  if (L.port) return disconnect();
  if (!('serial' in navigator)) return note('Use Chrome or Edge on a PC.');
  try {
    L.port = await navigator.serial.requestPort(); await L.port.open({ baudRate: 9600 });
    const enc = new TextEncoderStream(); enc.readable.pipeTo(L.port.writable); L.writer = enc.writable.getWriter();
    STATE.source = 'usb'; STATE.history = []; L.first = true; $('btnUsb').textContent = 'Disconnect Arduino'; note('Connected, waiting for data...');
    const dec = new TextDecoderStream(); L.port.readable.pipeTo(dec.writable); L.reader = dec.readable.getReader();
    let buf = '';
    for (;;) { const { value, done } = await L.reader.read(); if (done) break; buf += value; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } }
  } catch (e) { note('Could not connect: ' + e.message); }
  await disconnect();
}
async function disconnect() {
  const r = L.reader, w = L.writer, p = L.port; L.port = L.writer = L.reader = null;
  try { r && await r.cancel(); } catch (_) {} try { w && await w.close(); } catch (_) {} try { p && await p.close(); } catch (_) {}
  if (STATE.source === 'usb') STATE.source = 'none';
  if ($('btnUsb')) $('btnUsb').textContent = 'Connect Arduino'; note('Not connected');
  window.fetchLatestTelemetry();
}
function demo() {
  if (STATE.source === 'demo') { STATE.source = 'none'; STATE.history = []; $('btnDemo').textContent = 'Start demo data'; return window.fetchLatestTelemetry(); }
  if (L.port) return note('Disconnect the Arduino first.');
  STATE.source = 'demo'; STATE.history = []; STATE.currentMoisture = 55; STATE.rawAdc = null; STATE.lastDataTs = Date.now();
  for (let i = 360; i >= 0; i--) STATE.history.push({ ts: Date.now() - i * 60000, m: 50 + Math.sin(i / 10) * 8, t: 28 + Math.cos(i / 15) * 3, p: false });
  $('btnDemo').textContent = 'Stop demo data'; renderDashboard();
}

window.runHardwareCheck = function () {                              // real status, only what the data can prove
  if (STATE.role !== 'A') return;
  const live = STATE.source === 'usb' && Date.now() - STATE.lastDataTs < 5000, raw = STATE.rawAdc, t = STATE.currentTemp;
  const rows = [
    ['Arduino UNO', live ? ['ok', 'Connected'] : ['bad', 'Not connected']],
    ['Soil moisture sensor', !live ? ['mut', 'Unknown'] : raw >= 1020 ? ['warn', 'Reads maximum: in air or unplugged?'] : ['ok', `Reading ${raw}`]],
    ['Temperature sensor', !live ? ['mut', 'Unknown'] : (t < -50 || t > 80) ? ['bad', 'Not detected'] : ['ok', `${t.toFixed(1)} C`]],
    ['Relay and pump', ['mut', live ? `Commanded ${STATE.pumpActive ? 'ON' : 'OFF'}. Confirm by eye` : 'Unknown']],
    ['Sprinkler, water, power', ['mut', 'Not measured. Check on site']]];
  $('hw').innerHTML = rows.map(([n, [c, s]]) => `<div class="row"><span>${escapeHtml(n)}</span><span class="${c}">${escapeHtml(s)}</span></div>`).join('');
  $('hwT').textContent = `Checked at ${formatTimestamp(Date.now())}`;
};

document.addEventListener('DOMContentLoaded', () => {
  $('btnUsb')?.addEventListener('click', connect); $('btnDemo')?.addEventListener('click', demo);
  ['stage', 'season', 'dry', 'wet', 'max'].forEach(id => $(id)?.addEventListener('input', () => { L.touch = Date.now(); }));
  window.addEventListener('resize', () => renderHistoryChart());
});
})();
