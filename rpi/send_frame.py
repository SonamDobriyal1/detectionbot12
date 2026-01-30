import cv2
import json
import threading
import time
import urllib.request
from websocket import create_connection, WebSocketTimeoutException

try:
    import RPi.GPIO as GPIO
except Exception:
    GPIO = None

SERVER_BASE = "wss://legionm3.onrender.com"
SERVER_HTTP = "https://legionm3.onrender.com"
ROBOT_UUID = "robot-001"
ROBOT_TYPE = "rpi-rover"

TARGET_FPS = 8
FRAME_WIDTH = 640
FRAME_HEIGHT = 360
JPEG_QUALITY = 60
MAX_FRAME_DROP = 5

USB_CAM_INDEX = 0
THERMAL_CAM_INDEX = 1
THERMAL_FPS = 8
THERMAL_FRAME_WIDTH = 320
THERMAL_FRAME_HEIGHT = 240
THERMAL_JPEG_QUALITY = 70

VIDEO_URL = f"{SERVER_BASE}/ws/video/robot/{ROBOT_UUID}"
THERMAL_URL = f"{SERVER_BASE}/ws/thermal/robot/{ROBOT_UUID}"
COMMAND_URL = f"{SERVER_BASE}/ws/command/robot/{ROBOT_UUID}"
TELEMETRY_URL = f"{SERVER_BASE}/ws/telemetry/robot/{ROBOT_UUID}"

MOTOR_PINS = {
    "in1": 17,
    "in2": 27,
    "in3": 23,
    "in4": 24,
    "ena": 18,
    "enb": 25,
}
MOTOR_SPEED = 70


def _connect(url, timeout=10):
    ws = create_connection(url, timeout=timeout)
    return ws


def _register_robot():
    payload = json.dumps({"uuid": ROBOT_UUID, "type": ROBOT_TYPE}).encode("utf-8")
    req = urllib.request.Request(
        f"{SERVER_HTTP}/api/robots/register",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                print(f"Device registered: {ROBOT_UUID}")
            return resp.status == 200
    except Exception as e:
        print(f"Robot register error: {e}")
        return False


def _command_listener():
    ws = None
    while True:
        if ws is None:
            try:
                ws = _connect(COMMAND_URL, timeout=10)
                ws.settimeout(5)
                print("Command socket connected")
            except Exception as e:
                print(f"Command socket error: {e}")
                time.sleep(2)
                continue
        try:
            msg = ws.recv()
            if msg is None:
                raise RuntimeError("Command socket closed")
            print(f"[COMMAND] {msg}")
            _handle_command(msg)
        except WebSocketTimeoutException:
            try:
                ws.ping()
            except Exception:
                try:
                    ws.close()
                except Exception:
                    pass
                ws = None
                time.sleep(1)
        except Exception as e:
            print(f"Command recv error: {e}")
            try:
                ws.close()
            except Exception:
                pass
            ws = None
            time.sleep(1)


def _handle_command(msg):
    command = msg
    if isinstance(msg, str):
        try:
            payload = json.loads(msg)
            command = payload.get("command", msg)
        except Exception:
            command = msg
    if not command:
        return
    if command == "MOVE_FORWARD":
        _motor_forward()
    elif command == "MOVE_BACK":
        _motor_back()
    elif command == "MOVE_LEFT":
        _motor_left()
    elif command == "MOVE_RIGHT":
        _motor_right()
    elif command == "STOP":
        _motor_stop()


def _telemetry_sender():
    ws = None
    while True:
        if ws is None:
            try:
                ws = _connect(TELEMETRY_URL)
                print("Telemetry socket connected")
            except Exception as e:
                print(f"Telemetry socket error: {e}")
                time.sleep(2)
                continue
        payload = {
            "uuid": ROBOT_UUID,
            "gas_ppm": 0,
            "temperature_c": None,
            "ts": int(time.time()),
        }
        try:
            ws.send(json.dumps(payload))
        except Exception as e:
            print(f"Telemetry send error: {e}")
            try:
                ws.close()
            except Exception:
                pass
            ws = None
            time.sleep(1)
        time.sleep(1)


def _open_capture(index, width, height, name):
    cap = cv2.VideoCapture(index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if not cap.isOpened():
        print(f"{name} camera not available at index {index}")
    return cap


def _frame_sender(cap, ws_url, stream_name, target_fps, jpeg_quality):
    ws = None
    next_frame_time = time.monotonic()
    while True:
        if ws is None:
            try:
                ws = _connect(ws_url)
                print(f"{stream_name} socket connected")
            except Exception as e:
                print(f"{stream_name} socket error: {e}")
                time.sleep(2)
                continue
        now = time.monotonic()
        if now < next_frame_time:
            time.sleep(next_frame_time - now)
        else:
            lateness = now - next_frame_time
            if lateness > 0:
                drop_count = min(int(lateness * target_fps), MAX_FRAME_DROP)
                for _ in range(drop_count):
                    cap.grab()
            next_frame_time = now
        if not cap.grab():
            continue
        ret, frame = cap.retrieve()
        if not ret:
            continue
        _, buffer = cv2.imencode(
            ".jpg",
            frame,
            [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_quality],
        )
        try:
            ws.send(buffer.tobytes(), opcode=0x2)
        except Exception as e:
            print(f"{stream_name} send error: {e}")
            try:
                ws.close()
            except Exception:
                pass
            ws = None
            time.sleep(1)
            continue
        next_frame_time += 1.0 / target_fps


def _setup_gpio():
    if GPIO is None:
        print("RPi.GPIO not available; motor control disabled")
        return
    GPIO.setmode(GPIO.BCM)
    for pin in MOTOR_PINS.values():
        GPIO.setup(pin, GPIO.OUT)
    GPIO.output(MOTOR_PINS["in1"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in2"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in3"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in4"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["ena"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["enb"], GPIO.HIGH)
    try:
        pwm_a = GPIO.PWM(MOTOR_PINS["ena"], 1000)
        pwm_b = GPIO.PWM(MOTOR_PINS["enb"], 1000)
        pwm_a.start(MOTOR_SPEED)
        pwm_b.start(MOTOR_SPEED)
        globals()["_pwm_a"] = pwm_a
        globals()["_pwm_b"] = pwm_b
    except Exception:
        pass


def _motor_forward():
    if GPIO is None:
        return
    GPIO.output(MOTOR_PINS["in1"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["in2"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in3"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["in4"], GPIO.LOW)


def _motor_back():
    if GPIO is None:
        return
    GPIO.output(MOTOR_PINS["in1"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in2"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["in3"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in4"], GPIO.HIGH)


def _motor_left():
    if GPIO is None:
        return
    GPIO.output(MOTOR_PINS["in1"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in2"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["in3"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["in4"], GPIO.LOW)


def _motor_right():
    if GPIO is None:
        return
    GPIO.output(MOTOR_PINS["in1"], GPIO.HIGH)
    GPIO.output(MOTOR_PINS["in2"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in3"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in4"], GPIO.HIGH)


def _motor_stop():
    if GPIO is None:
        return
    GPIO.output(MOTOR_PINS["in1"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in2"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in3"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["in4"], GPIO.LOW)


if __name__ == "__main__":
    _register_robot()
    _setup_gpio()
    usb_cap = _open_capture(USB_CAM_INDEX, FRAME_WIDTH, FRAME_HEIGHT, "USB")
    thermal_cap = _open_capture(
        THERMAL_CAM_INDEX, THERMAL_FRAME_WIDTH, THERMAL_FRAME_HEIGHT, "Thermal"
    )
    threading.Thread(target=_command_listener, daemon=True).start()
    threading.Thread(target=_telemetry_sender, daemon=True).start()
    threading.Thread(
        target=_frame_sender,
        args=(usb_cap, VIDEO_URL, "Video", TARGET_FPS, JPEG_QUALITY),
        daemon=True,
    ).start()
    threading.Thread(
        target=_frame_sender,
        args=(thermal_cap, THERMAL_URL, "Thermal", THERMAL_FPS, THERMAL_JPEG_QUALITY),
        daemon=True,
    ).start()
    while True:
        time.sleep(1)
