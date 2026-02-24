const statusEl = document.getElementById("status");
const serverUrlInput = document.getElementById("serverUrl");
const robotIdInput = document.getElementById("robotId");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const videoEl = document.getElementById("video");
const useMjpegEl = document.getElementById("useMjpeg");
const thermalEl = document.getElementById("thermalVideo");
const useMjpegThermalEl = document.getElementById("useMjpegThermal");
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
const captureFrameBtn = document.getElementById("captureFrame");
const predictionStatusEl = document.getElementById("predictionStatus");
const predictionLabelEl = document.getElementById("predictionLabel");
const predictionConfidenceEl = document.getElementById("predictionConfidence");
const predictionListEl = document.getElementById("predictionList");
const capturePreviewEl = document.getElementById("capturePreview");

const SERVER_HTTP_BASE = "https://detectionbot12-colo.onrender.com";
const ROBOT_UUID = "Agraid";
const CLIENT_ID = "web-control";
const MODEL_API_URL = "https://leaf-disease-api-v3fr.onrender.com/predict";
const MODEL_API_TIMEOUT_MS = 30000;
const MODEL_IMAGE_FIELD = "file";

const ROBOT_OFFLINE_MS = 10000; // no frame/telemetry for this long = robot offline
const ROBOT_OFFLINE_CHECK_MS = 2000;

let videoWs = null;
let thermalWs = null;
let commandWs = null;
let firstFrameSeen = false;
let lastLiveDataAt = 0;
let robotOfflineCheckTimer = null;
let liveFrameCount = 0;
let firstLiveFrameAt = 0;
let lastVideoBuffer = null;
let predictionInFlight = false;
const videoState = { pending: false, currentUrl: null };
const thermalState = { pending: false, currentUrl: null };
const pressedKeys = new Set();

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(line);
}

function setPredictionStatus(text) {
  if (predictionStatusEl) {
    predictionStatusEl.textContent = text;
  }
}

function formatConfidence(value) {
  if (value === null || value === undefined) return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const pct = num <= 1 ? num * 100 : num;
  return `${Math.round(pct)}%`;
}

function formatConfidenceValue(value) {
  if (value === null || value === undefined) return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const pct = num <= 1 ? num * 100 : num;
  return `${pct.toFixed(2)}%`;
}

function extractPrediction(payload) {
  if (!payload || typeof payload !== "object") return { label: "--", confidence: "--" };
  const label =
    payload.predicted_label ??
    payload.label ??
    payload.prediction ??
    payload.class ??
    payload.result ??
    (payload.healthy !== undefined ? (payload.healthy ? "Healthy" : "Unhealthy") : null);
  const confidence =
    payload.confidence ??
    payload.predicted_confidence ??
    payload.score ??
    payload.probability ??
    (Array.isArray(payload.scores) ? Math.max(...payload.scores) : null);
  return {
    label: label ?? "--",
    confidence: confidence ?? "--",
  };
}

function renderAllConfidences(confidences) {
  if (!predictionListEl) return;
  if (!confidences || typeof confidences !== "object") {
    predictionListEl.textContent = "--";
    return;
  }
  const entries = Object.entries(confidences)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) {
    predictionListEl.textContent = "--";
    return;
  }
  predictionListEl.innerHTML = entries
    .map(
      ([label, value]) =>
        `<div class="prediction-item"><span>${label}</span><span>${formatConfidenceValue(
          value
        )}</span></div>`
    )
    .join("");
}

async function blobFromImageElement(imgEl) {
  if (!imgEl || !imgEl.src) {
    throw new Error("No frame available");
  }
  if (imgEl.src.startsWith("blob:")) {
    const res = await fetch(imgEl.src);
    return await res.blob();
  }
  const canvas = document.createElement("canvas");
  const width = imgEl.naturalWidth || imgEl.width || 0;
  const height = imgEl.naturalHeight || imgEl.height || 0;
  if (!width || !height) {
    throw new Error("Frame not ready");
  }
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas not supported");
  }
  ctx.drawImage(imgEl, 0, 0, width, height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to capture frame"));
    }, "image/jpeg");
  });
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


async function captureAndPredict() {
  if (predictionInFlight) return;
  if (!MODEL_API_URL) {
    setPredictionStatus("MODEL_API_URL not configured.");
    return;
  }
  predictionInFlight = true;
  if (captureFrameBtn) {
    captureFrameBtn.disabled = true;
  }
  setPredictionStatus("Capturing frame...");
  try {
    if (useMjpegEl && useMjpegEl.checked && !lastVideoBuffer) {
      setPredictionStatus("Capturing MJPEG frame (may require CORS).");
    }
    let blob = null;
    if (lastVideoBuffer) {
      blob = new Blob([lastVideoBuffer], { type: "image/jpeg" });
    } else {
      blob = await blobFromImageElement(videoEl);
    }

    if (capturePreviewEl) {
      const previewUrl = URL.createObjectURL(blob);
      capturePreviewEl.src = previewUrl;
      setTimeout(() => URL.revokeObjectURL(previewUrl), 30000);
    }

    setPredictionStatus("Sending to model...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODEL_API_TIMEOUT_MS);
    const formData = new FormData();
    formData.append(MODEL_IMAGE_FIELD, blob, "capture.jpg");

    const response = await fetch(MODEL_API_URL, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Model error (${response.status}): ${errText}`);
    }
    let payload = null;
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch (e) {
      payload = { raw: text };
    }

    const { label, confidence } = extractPrediction(payload);
    if (predictionLabelEl) predictionLabelEl.textContent = label;
    if (predictionConfidenceEl) predictionConfidenceEl.textContent = formatConfidence(confidence);
    renderAllConfidences(payload.all_confidences);
    setPredictionStatus("Prediction complete.");
  } catch (err) {
    const message = err && err.message ? err.message : "Prediction failed";
    if (useMjpegEl && useMjpegEl.checked && !lastVideoBuffer) {
      setPredictionStatus("Capture failed. MJPEG may be blocked by CORS; switch to WebSocket and try again.");
    } else {
      setPredictionStatus(message);
    }
    if (predictionListEl) predictionListEl.textContent = "--";
  } finally {
    predictionInFlight = false;
    if (captureFrameBtn) {
      captureFrameBtn.disabled = false;
    }
  }
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
      lastVideoBuffer = event.data;
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

  if (thermalEl) {
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
  }

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
  [videoWs, thermalWs, commandWs].forEach((ws) => {
    if (ws && ws.readyState <= 1) {
      ws.close();
    }
  });
  videoWs = null;
  thermalWs = null;
  commandWs = null;
  firstFrameSeen = false;
  lastVideoBuffer = null;
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

if (captureFrameBtn) {
  captureFrameBtn.addEventListener("click", captureAndPredict);
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

if (thermalEl) {
  thermalEl.addEventListener("load", () => {
    if (thermalState.pending) {
      thermalState.pending = false;
    }
  });
}

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
