const statusEl = document.getElementById("status");
const serverUrlInput = document.getElementById("serverUrl");
const saveServerBtn = document.getElementById("saveServer");
const clientIdInput = document.getElementById("clientId");
const robotIdInput = document.getElementById("robotId");
const robotList = document.getElementById("robotList");
const registerClientBtn = document.getElementById("registerClient");
const refreshRobotsBtn = document.getElementById("refreshRobots");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const videoEl = document.getElementById("video");
const useMjpegEl = document.getElementById("useMjpeg");
const telemetryEl = document.getElementById("telemetry");
const commandInput = document.getElementById("commandInput");
const sendCommandBtn = document.getElementById("sendCommand");
const commandLog = document.getElementById("commandLog");
const logEl = document.getElementById("log");

let videoWs = null;
let telemetryWs = null;
let commandWs = null;
let currentVideoUrl = null;
let firstFrameSeen = false;
let videoFramePending = false;

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(line);
  if (logEl) {
    logEl.textContent = `${line}\n${logEl.textContent}`;
  }
}
function getServerBase() {
  const stored = localStorage.getItem("legion_server");
  const value = serverUrlInput.value.trim() || stored || "";
  return value.replace(/\/+$/, "");
}

function getWsBase() {
  const httpBase = getServerBase();
  if (!httpBase) return "";
  return httpBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function saveServerUrl() {
  const value = serverUrlInput.value.trim().replace(/\/+$/, "");
  if (value) {
    localStorage.setItem("legion_server", value);
    setStatus(`server set: ${value}`);
    log(`server set: ${value}`);
  }
}


function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function ensureClientId() {
  if (!clientIdInput.value.trim()) {
    clientIdInput.value = `client-${Math.random().toString(16).slice(2, 8)}`;
  }
  return clientIdInput.value.trim();
}

async function registerClient() {
  const clientId = ensureClientId();
  const base = getServerBase();
  if (!base) {
    setStatus("server url required");
    return;
  }
  const res = await fetch(`${base}/api/clients/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    setStatus(`client register failed: ${data.error || res.status}`);
    log(`client register failed: ${data.error || res.status}`);
    return;
  }
  setStatus(`client registered: ${clientId}`);
  log(`client registered: ${clientId}`);
}

async function refreshRobots() {
  const base = getServerBase();
  if (!base) {
    setStatus("server url required");
    return;
  }
  const res = await fetch(`${base}/api/robots?online=1`);
  const data = await res.json();
  robotList.innerHTML = "";
  (data.robots || []).forEach((robot) => {
    const option = document.createElement("option");
    option.value = robot.uuid;
    option.textContent = `${robot.uuid} (${robot.type || "unknown"})`;
    robotList.appendChild(option);
  });
  if (robotList.options.length > 0) {
    robotIdInput.value = robotList.options[0].value;
    log(`online robots: ${robotList.options.length}`);
  } else {
    log("online robots: 0");
  }
}

function connectSockets(robotId) {
  disconnectSockets();
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
    currentVideoUrl = null;
    videoFramePending = false;
    setStatus(`video connected: ${robotId} (mjpeg)`);
    log("mjpeg stream connected");
  } else {
    videoWs = new WebSocket(`${wsBase}/ws/video/client/${robotId}`);
    videoWs.binaryType = "arraybuffer";
    videoWs.onmessage = (event) => {
      if (videoFramePending) {
        return;
      }
      const blob = new Blob([event.data], { type: "image/jpeg" });
      const nextUrl = URL.createObjectURL(blob);
      videoFramePending = true;
      videoEl.src = nextUrl;
      if (currentVideoUrl) {
        URL.revokeObjectURL(currentVideoUrl);
      }
      currentVideoUrl = nextUrl;
    };
    videoWs.onopen = () => {
      setStatus(`video connected: ${robotId}`);
      log("video socket connected");
    };
    videoWs.onclose = () => {
      setStatus("video disconnected");
      log("video socket disconnected");
    };
    videoWs.onerror = () => log("video socket error");
  }

  telemetryWs = new WebSocket(`${wsBase}/ws/telemetry/client/${robotId}`);
  telemetryWs.onmessage = (event) => {
    telemetryEl.textContent = event.data;
    log("telemetry received");
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
  [videoWs, telemetryWs, commandWs].forEach((ws) => {
    if (ws && ws.readyState <= 1) {
      ws.close();
    }
  });
  videoWs = null;
  telemetryWs = null;
  commandWs = null;
  firstFrameSeen = false;
  videoFramePending = false;
  if (videoEl) {
    videoEl.src = "";
  }
  setStatus("disconnected");
  log("disconnected");
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

registerClientBtn.addEventListener("click", registerClient);
refreshRobotsBtn.addEventListener("click", refreshRobots);
saveServerBtn.addEventListener("click", saveServerUrl);
connectBtn.addEventListener("click", () => {
  const robotId = robotIdInput.value.trim();
  if (!robotId) {
    setStatus("robot uuid required");
    return;
  }
  connectSockets(robotId);
});
disconnectBtn.addEventListener("click", disconnectSockets);
sendCommandBtn.addEventListener("click", sendCommand);

commandInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendCommand();
  }
});

const storedServer = localStorage.getItem("legion_server");
if (storedServer) {
  serverUrlInput.value = storedServer;
}
refreshRobots();
log("ui ready");

videoEl.addEventListener("load", () => {
  if (videoFramePending) {
    videoFramePending = false;
  }
  if (!firstFrameSeen) {
    firstFrameSeen = true;
    log("live started: first video frame received");
  }
});

