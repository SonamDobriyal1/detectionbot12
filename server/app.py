import os
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from flask_sock import Sock
import threading
import time

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})
sock = Sock(app)

robots = {}
robots_lock = threading.Lock()
ONLINE_TTL_SECONDS = 30

video_clients = {}
video_clients_lock = threading.Lock()
latest_frames = {}
latest_frame_seq = {}
latest_frames_lock = threading.Lock()

thermal_clients = {}
thermal_clients_lock = threading.Lock()
latest_thermal_frames = {}
latest_thermal_seq = {}
latest_thermal_lock = threading.Lock()

command_robot = {}
command_clients = {}
command_lock = threading.Lock()

telemetry_clients = {}
telemetry_lock = threading.Lock()


@app.route("/api/robots", methods=["GET"])
def list_robots():
    online_only = request.args.get("online") == "1"
    with robots_lock:
        data = [
            {
                "uuid": rid,
                "type": info.get("type"),
                "last_seen": info.get("last_seen"),
                "online": _is_online(info),
            }
            for rid, info in robots.items()
        ]
    if online_only:
        data = [robot for robot in data if robot.get("online")]
    return jsonify({"robots": data})


@app.route("/api/robots/register", methods=["POST"])
def register_robot():
    payload = request.get_json(force=True, silent=True) or {}
    robot_id = str(payload.get("uuid", "")).strip()
    robot_type = str(payload.get("type", "")).strip()
    if not robot_id:
        return jsonify({"error": "uuid is required"}), 400
    _touch_robot(robot_id, robot_type=robot_type)
    return jsonify({"ok": True, "uuid": robot_id})


@app.route("/api/clients/register", methods=["POST"])
def register_client():
    payload = request.get_json(force=True, silent=True) or {}
    client_id = str(payload.get("client_id", "")).strip()
    if not client_id:
        return jsonify({"error": "client_id is required"}), 400
    return jsonify({"ok": True, "client_id": client_id})


@sock.route("/ws/video/robot/<robot_id>")
def ws_video_robot(ws, robot_id):
    print(f"[ws] video robot connected: {robot_id}")
    _touch_robot(robot_id)
    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            if isinstance(data, str):
                continue
            _touch_robot(robot_id)
            with latest_frames_lock:
                latest_frames[robot_id] = data
                latest_frame_seq[robot_id] = latest_frame_seq.get(robot_id, 0) + 1
            _broadcast_video(robot_id, data)
    finally:
        print(f"[ws] video robot disconnected: {robot_id}")


@sock.route("/ws/video/client/<robot_id>")
def ws_video_client(ws, robot_id):
    print(f"[ws] video client connected: {robot_id}")
    with video_clients_lock:
        video_clients.setdefault(robot_id, set()).add(ws)
    try:
        with latest_frames_lock:
            data = latest_frames.get(robot_id)
        if data:
            ws.send(data)
        while True:
            msg = ws.receive()
            if msg is None:
                break
    finally:
        with video_clients_lock:
            clients = video_clients.get(robot_id, set())
            clients.discard(ws)
        print(f"[ws] video client disconnected: {robot_id}")


@sock.route("/ws/thermal/robot/<robot_id>")
def ws_thermal_robot(ws, robot_id):
    print(f"[ws] thermal robot connected: {robot_id}")
    _touch_robot(robot_id)
    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            if isinstance(data, str):
                continue
            _touch_robot(robot_id)
            with latest_thermal_lock:
                latest_thermal_frames[robot_id] = data
                latest_thermal_seq[robot_id] = latest_thermal_seq.get(robot_id, 0) + 1
            _broadcast_thermal(robot_id, data)
    finally:
        print(f"[ws] thermal robot disconnected: {robot_id}")


@sock.route("/ws/thermal/client/<robot_id>")
def ws_thermal_client(ws, robot_id):
    print(f"[ws] thermal client connected: {robot_id}")
    with thermal_clients_lock:
        thermal_clients.setdefault(robot_id, set()).add(ws)
    try:
        with latest_thermal_lock:
            data = latest_thermal_frames.get(robot_id)
        if data:
            ws.send(data)
        while True:
            msg = ws.receive()
            if msg is None:
                break
    finally:
        with thermal_clients_lock:
            clients = thermal_clients.get(robot_id, set())
            clients.discard(ws)
        print(f"[ws] thermal client disconnected: {robot_id}")


@sock.route("/ws/command/robot/<robot_id>")
def ws_command_robot(ws, robot_id):
    print(f"[ws] command robot connected: {robot_id}")
    with command_lock:
        command_robot[robot_id] = ws
    _touch_robot(robot_id)
    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
            _touch_robot(robot_id)
            _broadcast_command(robot_id, msg, source="robot")
    finally:
        with command_lock:
            if command_robot.get(robot_id) is ws:
                del command_robot[robot_id]
        print(f"[ws] command robot disconnected: {robot_id}")


@sock.route("/ws/command/client/<robot_id>")
def ws_command_client(ws, robot_id):
    print(f"[ws] command client connected: {robot_id}")
    with command_lock:
        command_clients.setdefault(robot_id, set()).add(ws)
    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
            _send_command_to_robot(robot_id, msg)
    finally:
        with command_lock:
            clients = command_clients.get(robot_id, set())
            clients.discard(ws)
        print(f"[ws] command client disconnected: {robot_id}")


@sock.route("/ws/telemetry/robot/<robot_id>")
def ws_telemetry_robot(ws, robot_id):
    print(f"[ws] telemetry robot connected: {robot_id}")
    _touch_robot(robot_id)
    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
            _touch_robot(robot_id)
            _broadcast_telemetry(robot_id, msg)
    finally:
        print(f"[ws] telemetry robot disconnected: {robot_id}")


@sock.route("/ws/telemetry/client/<robot_id>")
def ws_telemetry_client(ws, robot_id):
    print(f"[ws] telemetry client connected: {robot_id}")
    with telemetry_lock:
        telemetry_clients.setdefault(robot_id, set()).add(ws)
    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
    finally:
        with telemetry_lock:
            clients = telemetry_clients.get(robot_id, set())
            clients.discard(ws)
        print(f"[ws] telemetry client disconnected: {robot_id}")


def _broadcast_video(robot_id, data):
    dead = []
    with video_clients_lock:
        for client in video_clients.get(robot_id, set()):
            try:
                client.send(data)
            except Exception:
                dead.append(client)
        for client in dead:
            video_clients.get(robot_id, set()).discard(client)


def _broadcast_thermal(robot_id, data):
    dead = []
    with thermal_clients_lock:
        for client in thermal_clients.get(robot_id, set()):
            try:
                client.send(data)
            except Exception:
                dead.append(client)
        for client in dead:
            thermal_clients.get(robot_id, set()).discard(client)


def _mjpeg_stream(robot_id, fps=8):
    boundary = "frame"
    last_seq = -1
    while True:
        with latest_frames_lock:
            data = latest_frames.get(robot_id)
            seq = latest_frame_seq.get(robot_id, 0)
        if data and seq != last_seq:
            last_seq = seq
            yield (
                b"--" + boundary.encode() + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n"
                + data
                + b"\r\n"
            )
        time.sleep(1 / fps)


@app.route("/mjpeg/<robot_id>")
def mjpeg_stream(robot_id):
    return Response(
        stream_with_context(_mjpeg_stream(robot_id)),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def _mjpeg_stream_thermal(robot_id, fps=8):
    boundary = "frame"
    last_seq = -1
    while True:
        with latest_thermal_lock:
            data = latest_thermal_frames.get(robot_id)
            seq = latest_thermal_seq.get(robot_id, 0)
        if data and seq != last_seq:
            last_seq = seq
            yield (
                b"--" + boundary.encode() + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n"
                + data
                + b"\r\n"
            )
        time.sleep(1 / fps)


@app.route("/mjpeg/thermal/<robot_id>")
def mjpeg_stream_thermal(robot_id):
    return Response(
        stream_with_context(_mjpeg_stream_thermal(robot_id)),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def _broadcast_command(robot_id, msg, source):
    dead = []
    with command_lock:
        for client in command_clients.get(robot_id, set()):
            try:
                client.send(msg)
            except Exception:
                dead.append(client)
        for client in dead:
            command_clients.get(robot_id, set()).discard(client)


def _send_command_to_robot(robot_id, msg):
    with command_lock:
        robot_ws = command_robot.get(robot_id)
    if robot_ws is None:
        return
    try:
        robot_ws.send(msg)
    except Exception:
        pass


def _broadcast_telemetry(robot_id, msg):
    dead = []
    with telemetry_lock:
        for client in telemetry_clients.get(robot_id, set()):
            try:
                client.send(msg)
            except Exception:
                dead.append(client)
        for client in dead:
            telemetry_clients.get(robot_id, set()).discard(client)


def _touch_robot(robot_id, robot_type=None):
    now = int(time.time())
    with robots_lock:
        info = robots.get(robot_id, {})
        if robot_type:
            info["type"] = robot_type
        info["last_seen"] = now
        robots[robot_id] = info


def _is_online(info):
    last_seen = info.get("last_seen")
    if not last_seen:
        return False
    return (time.time() - last_seen) <= ONLINE_TTL_SECONDS


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
