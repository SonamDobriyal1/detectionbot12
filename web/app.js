const statusEl = document.getElementById("status");
const serverUrlInput = document.getElementById("serverUrl");
const robotIdInput = document.getElementById("robotId");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const videoEl = document.getElementById("video");
const useMjpegEl = document.getElementById("useMjpeg");
const thermalEl = document.getElementById("thermalVideo");
const useMjpegThermalEl = document.getElementById("useMjpegThermal");
const metricTempEl = document.getElementById("metricTemp");
const metricHumidityEl = document.getElementById("metricHumidity");
const metricMethaneEl = document.getElementById("metricMethane");
const metricAmmoniaEl = document.getElementById("metricAmmonia");
const metricAlcoholEl = document.getElementById("metricAlcohol");
const lastTelemetryTsEl = document.getElementById("lastTelemetryTs");
const toggleRecordingBtn = document.getElementById("toggleRecording");
const downloadCsvBtn = document.getElementById("downloadCsv");
const recordingStatusEl = document.getElementById("recordingStatus");
const commandInput = document.getElementById("commandInput");
const sendCommandBtn = document.getElementById("sendCommand");
const commandLog = document.getElementById("commandLog");
const driveUpBtn = document.getElementById("driveUp");
const driveDownBtn = document.getElementById("driveDown");
const driveLeftBtn = document.getElementById("driveLeft");
const driveRightBtn = document.getElementById("driveRight");
const driveStopBtn = document.getElementById("driveStop");
const speedDial = document.getElementById("speedDial");
const speedValue = document.getElementById("speedValue");

const SERVER_HTTP_BASE = "https://detectionbot12-colo.onrender.com";
const ROBOT_UUID = "Agraid";
const CLIENT_ID = "web-control";

const ROBOT_OFFLINE_MS = 10000; // no frame/telemetry for this long = robot offline
const ROBOT_OFFLINE_CHECK_MS = 2000;

let videoWs = null;
let thermalWs = null;
let telemetryWs = null;
let commandWs = null;
let firstFrameSeen = false;
let lastLiveDataAt = 0;
let robotOfflineCheckTimer = null;
let liveFrameCount = 0;
let firstLiveFrameAt = 0;
const videoState = { pending: false, currentUrl: null };
const thermalState = { pending: false, currentUrl: null };
const pressedKeys = new Set();

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(line);
}
function getServerBase() {
  return SERVER_HTTP_BASE.replace(/\/+$/, "");
}

function getWsBase() {
  const httpBase = getServerBase();
  if (!httpBase) return "";
  return httpBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function updateImageFromBuffer(imgEl, buffer, state) {
  if (state.pending) {
    return;
  }
  const blob = new Blob([buffer], { type: "image/jpeg" });
  const nextUrl = URL.createObjectURL(blob);
  state.pending = true;
  imgEl.src = nextUrl;
  if (state.currentUrl) {
    URL.revokeObjectURL(state.currentUrl);
  }
  state.currentUrl = nextUrl;
}

function resetImageState(imgEl, state) {
  state.pending = false;
  if (state.currentUrl) {
    URL.revokeObjectURL(state.currentUrl);
  }
  state.currentUrl = null;
  if (imgEl) {
    imgEl.src = "";
  }
}

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function markLive() {
  lastLiveDataAt = Date.now();
}

function checkRobotOffline() {
  const now = Date.now();
  const onlyOneStaleFrame = liveFrameCount === 1 && firstLiveFrameAt && (now - firstLiveFrameAt > ROBOT_OFFLINE_MS);
  const wasLiveThenStopped = lastLiveDataAt > 0 && (now - lastLiveDataAt > ROBOT_OFFLINE_MS);
  if (onlyOneStaleFrame || wasLiveThenStopped) {
    setStatus("robot offline");
    resetImageState(videoEl, videoState);
    resetImageState(thermalEl, thermalState);
    if (videoEl && useMjpegEl && useMjpegEl.checked) {
      videoEl.src = "";
    }
    if (thermalEl && useMjpegThermalEl && useMjpegThermalEl.checked) {
      thermalEl.src = "";
    }
  }
}

function startRobotOfflineChecker() {
  stopRobotOfflineChecker();
  lastLiveDataAt = 0;
  robotOfflineCheckTimer = setInterval(checkRobotOffline, ROBOT_OFFLINE_CHECK_MS);
}

function stopRobotOfflineChecker() {
  if (robotOfflineCheckTimer) {
    clearInterval(robotOfflineCheckTimer);
    robotOfflineCheckTimer = null;
  }
  lastLiveDataAt = 0;
}

function ensureClientId() {
  return CLIENT_ID;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined) return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (Math.abs(num) >= 100) return String(Math.round(num));
  return num.toFixed(digits);
}

const lastGood = {
  temperature_c: null,
  humidity: null,
  methane_ppm: null,
  ammonia_ppm: null,
  alcohol_ppm: null,
};

function keepStandardIfZero(prev, next) {
  if (next === null || next === undefined) return prev;
  const n = Number(next);
  if (!Number.isFinite(n)) return prev;
  if (n === 0 && prev !== null && prev !== undefined) return prev;
  return n;
}

function updateMetric(el, value) {
  if (!el) return;
  el.textContent = value === null || value === undefined ? "--" : formatNumber(value);
}

function updateTelemetryUI(payload) {
  const nextTemp = payload.esp32_tempC ?? payload.temperature_c;
  lastGood.temperature_c = keepStandardIfZero(lastGood.temperature_c, nextTemp);
  lastGood.humidity = keepStandardIfZero(lastGood.humidity, payload.esp32_humidity);
  lastGood.methane_ppm = keepStandardIfZero(lastGood.methane_ppm, payload.methane_ppm);
  lastGood.ammonia_ppm = keepStandardIfZero(lastGood.ammonia_ppm, payload.ammonia_ppm);
  lastGood.alcohol_ppm = keepStandardIfZero(lastGood.alcohol_ppm, payload.alcohol_ppm);

  updateMetric(metricTempEl, lastGood.temperature_c);
  updateMetric(metricHumidityEl, lastGood.humidity);
  updateMetric(metricMethaneEl, lastGood.methane_ppm);
  updateMetric(metricAmmoniaEl, lastGood.ammonia_ppm);
  updateMetric(metricAlcoholEl, lastGood.alcohol_ppm);

  if (lastTelemetryTsEl) {
    const tsSeconds = payload.ts ? Number(payload.ts) : null;
    const date = tsSeconds ? new Date(tsSeconds * 1000) : new Date();
    lastTelemetryTsEl.textContent = `Last update: ${date.toLocaleString()}`;
  }
}

let isRecording = false;
let records = [];
let lastRecordedTs = null;

function setRecordingUi() {
  if (toggleRecordingBtn) {
    toggleRecordingBtn.textContent = isRecording ? "Stop record data" : "Start record data";
  }
  if (recordingStatusEl) {
    recordingStatusEl.textContent = isRecording
      ? `Recording (${records.length} rows)`
      : "Not recording";
  }
  if (downloadCsvBtn) {
    downloadCsvBtn.disabled = records.length === 0;
  }
}

function toIsoLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv() {
  if (!records.length) return;
  const headers = [
    "datetime_local",
    "ts",
    "uuid",
    "temperature_c",
    "humidity",
    "methane_ppm",
    "ammonia_ppm",
    "alcohol_ppm",
  ];
  const lines = [headers.join(",")];
  for (const row of records) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const filename =
    `telemetry_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.csv`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function connectSockets(robotId) {
  disconnectSockets();
  liveFrameCount = 0;
  firstLiveFrameAt = 0;
  lastLiveDataAt = 0;
  setStatus(`connecting to ${robotId}`);
  log(`connect requested: ${robotId}`);
  const wsBase = getWsBase();
  if (!wsBase) {
    setStatus("server url required");
    return;
  }
  const useMjpeg = useMjpegEl && useMjpegEl.checked;
  if (useMjpeg) {
    const httpBase = getServerBase();
    const streamUrl = `${httpBase}/mjpeg/${encodeURIComponent(robotId)}?t=${Date.now()}`;
    videoEl.src = streamUrl;
    videoState.pending = false;
    videoState.currentUrl = null;
    setStatus(`waiting for robot: ${robotId} (mjpeg)`);
    startRobotOfflineChecker();
    log("mjpeg stream connected");
  } else {
    videoWs = new WebSocket(`${wsBase}/ws/video/client/${robotId}`);
    videoWs.binaryType = "arraybuffer";
    videoWs.onmessage = (event) => {
      liveFrameCount++;
      if (liveFrameCount === 1) {
        firstLiveFrameAt = Date.now();
      } else {
        markLive();
        setStatus(`connected: ${robotId}`);
      }
      updateImageFromBuffer(videoEl, event.data, videoState);
    };
    videoWs.onopen = () => {
      setStatus(`waiting for robot: ${robotId}`);
      startRobotOfflineChecker();
      log("video socket connected");
    };
    videoWs.onclose = () => {
      stopRobotOfflineChecker();
      setStatus("disconnected");
      log("video socket disconnected");
    };
    videoWs.onerror = () => log("video socket error");
  }

  const useThermalMjpeg = useMjpegThermalEl && useMjpegThermalEl.checked;
  if (useThermalMjpeg) {
    const httpBase = getServerBase();
    const streamUrl = `${httpBase}/mjpeg/thermal/${encodeURIComponent(
      robotId
    )}?t=${Date.now()}`;
    thermalEl.src = streamUrl;
    thermalState.pending = false;
    thermalState.currentUrl = null;
    log("thermal mjpeg stream connected");
  } else {
    thermalWs = new WebSocket(`${wsBase}/ws/thermal/client/${robotId}`);
    thermalWs.binaryType = "arraybuffer";
    thermalWs.onmessage = (event) => {
      liveFrameCount++;
      if (liveFrameCount === 1) {
        firstLiveFrameAt = Date.now();
      } else {
        markLive();
        setStatus(`connected: ${robotId}`);
      }
      updateImageFromBuffer(thermalEl, event.data, thermalState);
    };
    thermalWs.onopen = () => log("thermal socket connected");
    thermalWs.onclose = () => log("thermal socket disconnected");
    thermalWs.onerror = () => log("thermal socket error");
  }

  telemetryWs = new WebSocket(`${wsBase}/ws/telemetry/client/${robotId}`);
  telemetryWs.onmessage = (event) => {
    markLive();
    setStatus(`connected: ${robotId}`);
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    updateTelemetryUI(payload);

    if (isRecording) {
      const tsSeconds = payload.ts ? Number(payload.ts) : Math.floor(Date.now() / 1000);
      if (lastRecordedTs !== tsSeconds) {
        lastRecordedTs = tsSeconds;
        const date = new Date(tsSeconds * 1000);
        records.push({
          datetime_local: toIsoLocal(date),
          ts: tsSeconds,
          uuid: payload.uuid ?? robotId,
          temperature_c: lastGood.temperature_c,
          humidity: lastGood.humidity,
          methane_ppm: lastGood.methane_ppm,
          ammonia_ppm: lastGood.ammonia_ppm,
          alcohol_ppm: lastGood.alcohol_ppm,
        });
        setRecordingUi();
      }
    }
  };
  telemetryWs.onopen = () => {
    setStatus(`telemetry connected: ${robotId}`);
    log("telemetry socket connected");
  };
  telemetryWs.onclose = () => {
    setStatus("telemetry disconnected");
    log("telemetry socket disconnected");
  };
  telemetryWs.onerror = () => log("telemetry socket error");

  commandWs = new WebSocket(`${wsBase}/ws/command/client/${robotId}`);
  commandWs.onmessage = (event) => {
    commandLog.textContent = `[ROBOT] ${event.data}\n` + commandLog.textContent;
    log("command received from robot");
  };
  commandWs.onopen = () => {
    setStatus(`command connected: ${robotId}`);
    log("command socket connected");
  };
  commandWs.onclose = () => {
    setStatus("command disconnected");
    log("command socket disconnected");
  };
  commandWs.onerror = () => log("command socket error");
}

function disconnectSockets() {
  stopRobotOfflineChecker();
  [videoWs, thermalWs, telemetryWs, commandWs].forEach((ws) => {
    if (ws && ws.readyState <= 1) {
      ws.close();
    }
  });
  videoWs = null;
  thermalWs = null;
  telemetryWs = null;
  commandWs = null;
  firstFrameSeen = false;
  resetImageState(videoEl, videoState);
  resetImageState(thermalEl, thermalState);
  if (videoEl && useMjpegEl && useMjpegEl.checked) {
    videoEl.src = "";
  }
  if (thermalEl && useMjpegThermalEl && useMjpegThermalEl.checked) {
    thermalEl.src = "";
  }
  setStatus("disconnected");
  log("disconnected");
}

function sendDriveCommand(command) {
  if (!commandWs || commandWs.readyState !== WebSocket.OPEN) {
    return;
  }
  const speed = speedDial ? Number(speedDial.value || 0) : 0;
  const payload = {
    client_id: ensureClientId(),
    command,
    speed,
    ts: Date.now(),
  };
  commandWs.send(JSON.stringify(payload));
  commandLog.textContent = `[CLIENT] ${command} speed=${speed}\n` + commandLog.textContent;
}

function sendCommand() {
  if (!commandWs || commandWs.readyState !== WebSocket.OPEN) {
    setStatus("command socket not connected");
    log("command send failed: socket not connected");
    return;
  }
  const text = commandInput.value.trim();
  if (!text) {
    return;
  }
  const payload = {
    client_id: ensureClientId(),
    command: text,
    ts: Date.now(),
  };
  commandWs.send(JSON.stringify(payload));
  commandLog.textContent = `[CLIENT] ${text}\n` + commandLog.textContent;
  log(`command sent: ${text}`);
  commandInput.value = "";
}

connectBtn.addEventListener("click", () => {
  connectSockets(ROBOT_UUID);
});
disconnectBtn.addEventListener("click", disconnectSockets);
sendCommandBtn.addEventListener("click", sendCommand);

if (toggleRecordingBtn) {
  toggleRecordingBtn.addEventListener("click", () => {
    isRecording = !isRecording;
    setRecordingUi();
  });
}

if (downloadCsvBtn) {
  downloadCsvBtn.addEventListener("click", downloadCsv);
}

function bindHoldButton(btn, command, stopCommand) {
  if (!btn) return;
  const start = (event) => {
    event.preventDefault();
    sendDriveCommand(command);
  };
  const stop = (event) => {
    event.preventDefault();
    sendDriveCommand(stopCommand);
  };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("touchstart", start);
  btn.addEventListener("mouseup", stop);
  btn.addEventListener("mouseleave", stop);
  btn.addEventListener("touchend", stop);
  btn.addEventListener("touchcancel", stop);
}

bindHoldButton(driveUpBtn, "MOVE_FORWARD", "FORWARD_STOP");
bindHoldButton(driveDownBtn, "MOVE_BACK", "BACK_STOP");
bindHoldButton(driveLeftBtn, "MOVE_LEFT", "LEFT_STOP");
bindHoldButton(driveRightBtn, "MOVE_RIGHT", "RIGHT_STOP");
if (driveStopBtn) {
  driveStopBtn.addEventListener("click", () => sendDriveCommand("STOP"));
}

commandInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendCommand();
  }
});

if (serverUrlInput) {
  serverUrlInput.value = SERVER_HTTP_BASE;
}
if (robotIdInput) {
  robotIdInput.value = ROBOT_UUID;
}
if (speedDial && speedValue) {
  speedValue.textContent = speedDial.value;
  speedDial.addEventListener("input", () => {
    speedValue.textContent = speedDial.value;
  });
}
setRecordingUi();
log("ui ready");
connectSockets(ROBOT_UUID);

videoEl.addEventListener("load", () => {
  if (videoState.pending) {
    videoState.pending = false;
  }
  if (!firstFrameSeen) {
    firstFrameSeen = true;
    log("live started: first video frame received");
  }
});

thermalEl.addEventListener("load", () => {
  if (thermalState.pending) {
    thermalState.pending = false;
  }
});

const keyDownCommands = {
  w: "MOVE_FORWARD",
  s: "MOVE_BACK",
  a: "MOVE_LEFT",
  d: "MOVE_RIGHT",
};
const keyUpCommands = {
  w: "FORWARD_STOP",
  s: "BACK_STOP",
  a: "LEFT_STOP",
  d: "RIGHT_STOP",
};

document.addEventListener("keydown", (event) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (["INPUT", "TEXTAREA"].includes(tag)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (!["w", "a", "s", "d"].includes(key)) {
    return;
  }
  if (pressedKeys.has(key)) {
    return;
  }
  event.preventDefault();
  pressedKeys.add(key);
  sendDriveCommand(keyDownCommands[key]);
});

document.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (!["w", "a", "s", "d"].includes(key)) {
    return;
  }
  event.preventDefault();
  pressedKeys.delete(key);
  sendDriveCommand(keyUpCommands[key]);
});

