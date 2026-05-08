const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_DAYS_MS = 10 * DAY_MS;

const state = {
  map: null,
  zones: [],
  trackers: {},
  activeTrackerId: "crow-01",
  alerts: [],
  timeline: { playing: true, speed: 1, index: 0 },
  charts: {},
  heatLayer: null,
  zoneArmed: false,
};

const zoneRiskPalette = {
  low: "#22c55e",
  medium: "#f59e0b",
  high: "#ef4444",
  restricted: "#dc2626",
};

function uid(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 8)}`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([12.9716, 77.5946], 13);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap & CARTO",
    maxZoom: 19,
  }).addTo(state.map);

  if (typeof L.heatLayer === "function") {
    state.heatLayer = L.heatLayer([], {
      radius: 25,
      blur: 20,
      maxZoom: 18,
      gradient: { 0.2: "#0ea5e9", 0.4: "#22c55e", 0.7: "#f59e0b", 1.0: "#ef4444" },
    }).addTo(state.map);
  } else {
    // Keep the dashboard usable even if the plugin failed to load.
    state.heatLayer = { setLatLngs: () => {} };
    pushAlert("startup", "Heatmap plugin unavailable. Other controls remain active.");
  }

  state.map.on("click", onMapClickAddZone);
}

function createTracker(device_id, baseLat = 12.9716, baseLng = 77.5946) {
  const marker = L.circleMarker([baseLat, baseLng], {
    radius: 7,
    color: "#93c5fd",
    fillColor: "#38bdf8",
    fillOpacity: 0.95,
    weight: 2,
  }).addTo(state.map);

  const path = L.polyline([], { color: "#38bdf8", weight: 4, opacity: 0.9 }).addTo(state.map);
  const predicted = L.polyline([], { color: "#facc15", dashArray: "6 8", weight: 3, opacity: 0.8 }).addTo(state.map);

  state.trackers[device_id] = {
    device_id,
    marker,
    path,
    predicted,
    warningMarkers: [],
    records: [],
    status: "online",
    paused: false,
    anomalyCount: 0,
    zoneVisits: {},
    lastSignalTs: Date.now(),
    lastDirection: null,
  };
}

function generateInitialData(device_id, days = 10) {
  const tracker = state.trackers[device_id];
  const now = Date.now();
  let lat = 12.9716 + randomInRange(-0.02, 0.02);
  let lng = 77.5946 + randomInRange(-0.02, 0.02);

  for (let d = days; d >= 0; d--) {
    for (let i = 0; i < 72; i++) {
      const ts = now - d * DAY_MS + i * 20 * 60 * 1000;
      lat += randomInRange(-0.0015, 0.0015);
      lng += randomInRange(-0.0015, 0.0015);
      const speed = Math.max(0, randomInRange(1, 14));
      const acceleration = randomInRange(-2.3, 3.2);
      const point = {
        device_id,
        latitude: lat,
        longitude: lng,
        speed,
        acceleration,
        timestamp: ts,
        zone_name: "",
        anomaly_score: 0,
        risk_level: "low",
      };
      tracker.records.push(point);
    }
  }
}

function onMapClickAddZone(evt) {
  if (!state.zoneArmed) {
    pushAlert("zone", "Enable Zone Marking, then click map to place a zone.");
    return;
  }
  const nameInput = document.getElementById("zoneName");
  const radiusInput = document.getElementById("zoneRadius");
  const riskInput = document.getElementById("zoneRisk");
  const name = (nameInput.value || `Zone ${state.zones.length + 1}`).trim();
  const radius = Math.max(20, Number(radiusInput.value) || 300);
  const risk_level = (riskInput.value || "medium").toLowerCase();
  const color = zoneRiskPalette[risk_level] || "#06b6d4";
  const zone = {
    id: uid("zone"),
    name,
    center: [evt.latlng.lat, evt.latlng.lng],
    radius,
    risk_level,
    color,
    visits: 0,
    riskScore: 0,
  };
  zone.circle = L.circle(zone.center, {
    radius: zone.radius,
    color: zone.color,
    fillColor: zone.color,
    fillOpacity: 0.14,
    weight: 2,
  }).addTo(state.map);
  zone.circle.bindPopup(`${zone.name} (${zone.risk_level})`);
  state.zones.push(zone);
  nameInput.value = `Zone ${state.zones.length + 1}`;
  state.zoneArmed = false;
  updateZoneArmButton();
  renderZones();
}

function updateZoneArmButton() {
  const btn = document.getElementById("zoneArmBtn");
  if (!btn) return;
  btn.textContent = state.zoneArmed ? "Click map to place zone..." : "Enable Zone Marking";
  btn.classList.toggle("ring-2", state.zoneArmed);
  btn.classList.toggle("ring-cyan-400", state.zoneArmed);
}

function distanceDaily(records) {
  const byDay = {};
  for (let i = 1; i < records.length; i++) {
    const p1 = records[i - 1];
    const p2 = records[i];
    const day = new Date(p2.timestamp).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + haversineMeters({ lat: p1.latitude, lng: p1.longitude }, { lat: p2.latitude, lng: p2.longitude }) / 1000;
  }
  return byDay;
}

function detectAnomalies(tracker) {
  const records = tracker.records.filter((r) => Date.now() - r.timestamp <= TEN_DAYS_MS);
  if (!records.length) return;

  let suspicious = false;
  const stayByDay = {};

  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];
    const dist = haversineMeters({ lat: prev.latitude, lng: prev.longitude }, { lat: curr.latitude, lng: curr.longitude });
    const dtHr = Math.max((curr.timestamp - prev.timestamp) / 3600000, 1 / 60);
    const computedSpeed = dist / 1000 / dtHr;
    const day = new Date(curr.timestamp).toISOString().slice(0, 10);

    if (dist < 25) stayByDay[day] = (stayByDay[day] || 0) + (curr.timestamp - prev.timestamp);

    const direction = Math.atan2(curr.longitude - prev.longitude, curr.latitude - prev.latitude);
    const directionDelta = tracker.lastDirection != null ? Math.abs(direction - tracker.lastDirection) : 0;
    tracker.lastDirection = direction;

    let score = 0;
    if (computedSpeed > 40 || curr.speed > 40) score += 0.4;
    if (directionDelta > 2.6) score += 0.25;

    for (const zone of state.zones) {
      const inZone = haversineMeters({ lat: curr.latitude, lng: curr.longitude }, { lat: zone.center[0], lng: zone.center[1] }) <= zone.radius;
      if (inZone) {
        curr.zone_name = zone.name;
        tracker.zoneVisits[zone.name] = (tracker.zoneVisits[zone.name] || 0) + 1;
        zone.visits += 1;
        if (zone.risk_level === "high" || zone.risk_level === "restricted") score += 0.35;
      }
    }

    curr.anomaly_score = Math.min(1, score);
    curr.risk_level = curr.anomaly_score > 0.7 ? "high" : curr.anomaly_score > 0.35 ? "medium" : "low";
    if (curr.anomaly_score > 0.65) suspicious = true;
  }

  for (const [day, ms] of Object.entries(stayByDay)) {
    if (ms >= 12 * 3600000) {
      suspicious = true;
      pushAlert("abnormal", `${tracker.device_id} stayed too long on ${day}`);
    }
  }

  tracker.path.setStyle({ color: suspicious ? "#ef4444" : "#38bdf8" });
  if (suspicious) {
    tracker.anomalyCount += 1;
    const last = records[records.length - 1];
    const marker = L.marker([last.latitude, last.longitude]).addTo(state.map).bindPopup("Suspicious movement detected");
    tracker.warningMarkers.push(marker);
    pushAlert("abnormal", `${tracker.device_id} abnormal behavior detected`);
    highlightSuspiciousZones();
  }
}

function highlightSuspiciousZones() {
  state.zones.forEach((zone) => {
    zone.riskScore = (zone.visits || 0) * (zone.risk_level === "restricted" ? 1.8 : zone.risk_level === "high" ? 1.3 : 0.7);
    if (zone.riskScore > 20) zone.circle.setStyle({ color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.22 });
  });
}

function predictRoute(tracker) {
  const rec = tracker.records;
  if (rec.length < 3) return;
  const last = rec[rec.length - 1];
  const prev = rec[rec.length - 2];
  const dLat = last.latitude - prev.latitude;
  const dLng = last.longitude - prev.longitude;
  const points = [];
  for (let i = 1; i <= 5; i++) points.push([last.latitude + dLat * i, last.longitude + dLng * i]);
  tracker.predicted.setLatLngs([[last.latitude, last.longitude], ...points]);
}

function animateMovement(tracker, from, to, duration = 950) {
  const start = performance.now();
  const animate = (t) => {
    const k = Math.min((t - start) / duration, 1);
    const lat = from.latitude + (to.latitude - from.latitude) * k;
    const lng = from.longitude + (to.longitude - from.longitude) * k;
    tracker.marker.setLatLng([lat, lng]);
    if (k < 1) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

function renderZones() {
  const zoneList = document.getElementById("zoneList");
  zoneList.innerHTML = "";
  state.zones.forEach((z) => {
    const row = document.createElement("div");
    row.className = "p-2 rounded-lg border border-slate-700/50";
    row.innerHTML = `<div class="font-semibold">${z.name}</div>
      <div class="text-xs text-slate-300">radius: ${z.radius}m | risk: ${z.risk_level}</div>
      <div class="text-xs" style="color:${z.color}">risk score: ${z.riskScore.toFixed(1)}</div>`;
    zoneList.appendChild(row);
  });
}

function pushAlert(type, message) {
  const alert = { id: uid("alert"), type, message, ts: Date.now() };
  state.alerts.unshift(alert);
  const panel = document.getElementById("alertPanel");
  const el = document.createElement("div");
  el.className = "alert glass rounded-xl p-3 border border-red-400/60";
  el.innerHTML = `<div class="text-xs uppercase text-red-300">${type}</div><div>${message}</div>`;
  panel.prepend(el);
  setTimeout(() => el.remove(), 9000);
}

function getActiveTracker() {
  return state.trackers[state.activeTrackerId];
}

function updateHeatmap() {
  const tracker = getActiveTracker();
  const points = tracker.records.slice(-3000).map((r) => [r.latitude, r.longitude, Math.min(1, Math.max(0.2, r.speed / 25))]);
  state.heatLayer.setLatLngs(points);
}

function renderStats() {
  const tracker = getActiveTracker();
  const latest = tracker.records[tracker.records.length - 1];
  const stats = {
    Device: tracker.device_id,
    Speed: `${latest.speed.toFixed(1)} km/h`,
    Accel: `${latest.acceleration.toFixed(2)} m/s²`,
    Zone: latest.zone_name || "None",
    "Anomaly Score": latest.anomaly_score.toFixed(2),
    "Risk Level": latest.risk_level,
    "Total Records": tracker.records.length,
    Alerts: tracker.anomalyCount,
  };
  const panel = document.getElementById("statsPanel");
  panel.innerHTML = "";
  for (const [k, v] of Object.entries(stats)) {
    const d = document.createElement("div");
    d.className = "p-2 rounded-lg border border-slate-700/50";
    d.innerHTML = `<div class="text-xs opacity-80">${k}</div><div class="font-semibold">${v}</div>`;
    panel.appendChild(d);
  }
}

function renderTrackerStatus() {
  const wrap = document.getElementById("trackerStatus");
  wrap.innerHTML = "";
  Object.values(state.trackers).forEach((tracker) => {
    const offline = Date.now() - tracker.lastSignalTs > 50000;
    const paused = tracker.paused;
    if (offline && tracker.status !== "offline") {
      tracker.status = "offline";
      pushAlert("signal", `${tracker.device_id} tracker stopped transmitting`);
    }
    const row = document.createElement("div");
    row.className = "p-2 rounded-lg border border-slate-700/50 flex items-center justify-between";
    row.innerHTML = `<div>${tracker.device_id} <span class="text-xs opacity-70">(${paused ? "paused" : "active"})</span></div><div class="pulse ${offline || paused ? "offline" : ""}"></div>`;
    wrap.appendChild(row);
  });
}

function initCharts() {
  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: "#cbd5e1" } } },
    scales: { x: { ticks: { color: "#94a3b8" } }, y: { ticks: { color: "#94a3b8" } } },
  };

  const mk = (id, label, color) =>
    new Chart(document.getElementById(id), {
      type: "line",
      data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + "55", tension: 0.25 }] },
      options: commonOpts,
    });

  state.charts.distance = mk("distanceChart", "Daily Distance (km)", "#22d3ee");
  state.charts.speed = mk("speedChart", "Speed Trend (km/h)", "#f59e0b");
  state.charts.zoneVisit = new Chart(document.getElementById("zoneVisitChart"), {
    type: "bar",
    data: { labels: [], datasets: [{ label: "Zone Visits", data: [], backgroundColor: "#8b5cf6" }] },
    options: commonOpts,
  });
  state.charts.anomaly = new Chart(document.getElementById("anomalyChart"), {
    type: "line",
    data: { labels: [], datasets: [{ label: "Abnormal Activity Frequency", data: [], borderColor: "#ef4444", backgroundColor: "#ef444455" }] },
    options: commonOpts,
  });
}

function updateCharts() {
  const tracker = getActiveTracker();
  const daily = distanceDaily(tracker.records);
  const labels = Object.keys(daily).slice(-10);
  state.charts.distance.data.labels = labels;
  state.charts.distance.data.datasets[0].data = labels.map((d) => daily[d].toFixed(2));

  const speedPoints = tracker.records.slice(-120);
  state.charts.speed.data.labels = speedPoints.map((r) => new Date(r.timestamp).toLocaleTimeString());
  state.charts.speed.data.datasets[0].data = speedPoints.map((r) => r.speed);

  const zoneKeys = Object.keys(tracker.zoneVisits);
  state.charts.zoneVisit.data.labels = zoneKeys;
  state.charts.zoneVisit.data.datasets[0].data = zoneKeys.map((z) => tracker.zoneVisits[z]);

  const anomalyByDay = {};
  tracker.records.forEach((r) => {
    if (r.anomaly_score > 0.65) {
      const day = new Date(r.timestamp).toISOString().slice(0, 10);
      anomalyByDay[day] = (anomalyByDay[day] || 0) + 1;
    }
  });
  const aLabels = Object.keys(anomalyByDay).slice(-10);
  state.charts.anomaly.data.labels = aLabels;
  state.charts.anomaly.data.datasets[0].data = aLabels.map((d) => anomalyByDay[d]);

  Object.values(state.charts).forEach((chart) => chart.update("none"));
}

function addLiveRecord(tracker) {
  const last = tracker.records[tracker.records.length - 1];
  const next = {
    device_id: tracker.device_id,
    latitude: last.latitude + randomInRange(-0.0013, 0.0013),
    longitude: last.longitude + randomInRange(-0.0013, 0.0013),
    speed: Math.max(0, last.speed + randomInRange(-2.5, 3.2)),
    acceleration: randomInRange(-2, 2.4),
    timestamp: Date.now(),
    zone_name: "",
    anomaly_score: 0,
    risk_level: "low",
  };
  if (Math.random() < 0.015) next.speed = randomInRange(42, 58);
  tracker.records.push(next);
  tracker.lastSignalTs = Date.now();
  if (tracker.records.length > 12000) tracker.records.splice(0, 1500);

  animateMovement(tracker, last, next);
  tracker.path.addLatLng([next.latitude, next.longitude]);
}

function playbackToIndex(idx) {
  const tracker = getActiveTracker();
  const slice = tracker.records.slice(0, idx + 1);
  tracker.path.setLatLngs(slice.map((r) => [r.latitude, r.longitude]));
  if (slice.length) {
    const last = slice[slice.length - 1];
    tracker.marker.setLatLng([last.latitude, last.longitude]);
  }
}

function bindUi() {
  document.getElementById("themeToggle").addEventListener("click", () => {
    document.body.classList.toggle("theme-dark");
    document.body.classList.toggle("theme-light");
  });
  document.getElementById("playBtn").addEventListener("click", () => {
    state.timeline.playing = true;
    state.timeline.speed = 1;
  });
  document.getElementById("pauseBtn").addEventListener("click", () => {
    state.timeline.playing = false;
  });
  document.getElementById("rewindBtn").addEventListener("click", () => {
    state.timeline.playing = true;
    state.timeline.speed = -3;
    state.timeline.index = Math.max(0, state.timeline.index - 5);
    playbackToIndex(state.timeline.index);
  });
  document.getElementById("ffBtn").addEventListener("click", () => {
    state.timeline.playing = true;
    state.timeline.speed = 4;
    const tracker = getActiveTracker();
    state.timeline.index = Math.min(tracker.records.length - 1, state.timeline.index + 5);
    playbackToIndex(state.timeline.index);
  });
  document.getElementById("timelineRange").addEventListener("input", (e) => {
    const tracker = getActiveTracker();
    const max = Math.max(tracker.records.length - 1, 1);
    const idx = Math.floor((Number(e.target.value) / 100) * max);
    state.timeline.index = idx;
    playbackToIndex(idx);
  });
  document.getElementById("exportJson").addEventListener("click", exportJson);
  document.getElementById("exportCsv").addEventListener("click", exportCsv);
  document.getElementById("addTrackerBtn").addEventListener("click", () => {
    const input = document.getElementById("newTrackerId");
    const id = (input.value || uid("crow")).trim();
    if (!id) return;
    if (state.trackers[id]) {
      pushAlert("tracker", `Tracker ${id} already exists`);
      return;
    }
    createTracker(id, 12.96 + randomInRange(-0.03, 0.03), 77.58 + randomInRange(-0.03, 0.03));
    generateInitialData(id, 10);
    state.activeTrackerId = id;
    updateTrackerSelect();
    input.value = "";
    refreshAll();
    pushAlert("tracker", `Tracker ${id} added`);
  });
  document.getElementById("zoneArmBtn").addEventListener("click", () => {
    state.zoneArmed = !state.zoneArmed;
    updateZoneArmButton();
  });
  document.getElementById("removeLastZoneBtn").addEventListener("click", () => {
    const last = state.zones.pop();
    if (!last) {
      pushAlert("zone", "No zones to remove");
      return;
    }
    state.map.removeLayer(last.circle);
    renderZones();
    pushAlert("zone", `Removed zone: ${last.name}`);
  });
  document.getElementById("clearZonesBtn").addEventListener("click", () => {
    state.zones.forEach((z) => state.map.removeLayer(z.circle));
    state.zones = [];
    renderZones();
    pushAlert("zone", "Cleared all zones");
  });
  document.getElementById("toggleTrackingBtn").addEventListener("click", () => {
    const tracker = getActiveTracker();
    if (!tracker) return;
    tracker.paused = !tracker.paused;
    const btn = document.getElementById("toggleTrackingBtn");
    btn.textContent = tracker.paused ? "Resume Selected" : "Stop Selected";
    renderTrackerStatus();
    pushAlert("tracker", `${tracker.device_id} ${tracker.paused ? "paused" : "resumed"}`);
  });
  document.getElementById("deleteTrackerBtn").addEventListener("click", () => {
    const tracker = getActiveTracker();
    if (!tracker) return;
    if (Object.keys(state.trackers).length <= 1) {
      pushAlert("tracker", "At least one tracker is required");
      return;
    }
    state.map.removeLayer(tracker.marker);
    state.map.removeLayer(tracker.path);
    state.map.removeLayer(tracker.predicted);
    tracker.warningMarkers.forEach((m) => state.map.removeLayer(m));
    delete state.trackers[tracker.device_id];
    state.activeTrackerId = Object.keys(state.trackers)[0];
    updateTrackerSelect();
    refreshAll();
    pushAlert("tracker", `Deleted tracker: ${tracker.device_id}`);
  });
  document.getElementById("trackerSelect").addEventListener("change", (e) => {
    state.activeTrackerId = e.target.value;
    const tracker = getActiveTracker();
    document.getElementById("toggleTrackingBtn").textContent = tracker?.paused ? "Resume Selected" : "Stop Selected";
    refreshAll();
  });
  updateZoneArmButton();
}

function exportJson() {
  const tracker = getActiveTracker();
  downloadBlob(JSON.stringify(tracker.records, null, 2), `${tracker.device_id}-movement.json`, "application/json");
}

function exportCsv() {
  const tracker = getActiveTracker();
  const headers = ["device_id", "latitude", "longitude", "speed", "acceleration", "timestamp", "zone_name", "anomaly_score", "risk_level"];
  const rows = tracker.records.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(","));
  downloadBlob([headers.join(","), ...rows].join("\n"), `${tracker.device_id}-movement.csv`, "text/csv");
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function updateTrackerSelect() {
  const sel = document.getElementById("trackerSelect");
  sel.innerHTML = "";
  Object.keys(state.trackers).forEach((id) => {
    const op = document.createElement("option");
    op.value = id;
    op.textContent = id;
    sel.appendChild(op);
  });
  sel.value = state.activeTrackerId;
}

function refreshAll() {
  const tracker = getActiveTracker();
  if (!tracker) return;
  tracker.path.setLatLngs(tracker.records.map((r) => [r.latitude, r.longitude]));
  const last = tracker.records[tracker.records.length - 1];
  if (last) tracker.marker.setLatLng([last.latitude, last.longitude]);
  updateHeatmap();
  detectAnomalies(tracker);
  predictRoute(tracker);
  renderZones();
  renderStats();
  renderTrackerStatus();
  updateCharts();
  document.getElementById("toggleTrackingBtn").textContent = tracker.paused ? "Resume Selected" : "Stop Selected";
}

function liveLoop() {
  Object.values(state.trackers).forEach((tracker) => {
    if (tracker.paused) return;
    addLiveRecord(tracker);
    detectAnomalies(tracker);
    predictRoute(tracker);
  });
  refreshAll();
}

function timelineLoop() {
  const tracker = getActiveTracker();
  if (state.timeline.playing) {
    state.timeline.index += state.timeline.speed;
    const max = tracker.records.length - 1;
    if (state.timeline.index > max) state.timeline.index = max;
    if (state.timeline.index < 0) state.timeline.index = 0;
    playbackToIndex(state.timeline.index);
    const pct = max > 0 ? (state.timeline.index / max) * 100 : 0;
    document.getElementById("timelineRange").value = String(Math.round(pct));
  }
}

function checkRestrictedZoneAlerts() {
  const tracker = getActiveTracker();
  const last = tracker.records[tracker.records.length - 1];
  if (!last) return;
  for (const zone of state.zones) {
    const inside = haversineMeters({ lat: last.latitude, lng: last.longitude }, { lat: zone.center[0], lng: zone.center[1] }) <= zone.radius;
    if (inside && zone.risk_level === "restricted") {
      pushAlert("restricted-zone", `${tracker.device_id} entered restricted zone: ${zone.name}`);
    }
  }
}

function boot() {
  initMap();
  createTracker("crow-01");
  createTracker("crow-02", 12.984, 77.63);
  generateInitialData("crow-01", 10);
  generateInitialData("crow-02", 10);
  initCharts();
  bindUi();
  updateTrackerSelect();
  refreshAll();
  setInterval(liveLoop, 2600);
  setInterval(timelineLoop, 800);
  setInterval(renderTrackerStatus, 5000);
  setInterval(checkRestrictedZoneAlerts, 4500);
}

boot();
