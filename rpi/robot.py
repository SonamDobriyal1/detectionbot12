import json
import threading
import time
import urllib.request

import cv2
import numpy as np

# --- THERMAL INTEGRATION DISABLED ---
# import board
# import busio
# import adafruit_mlx90640

from websocket import create_connection, WebSocketTimeoutException

try:
    import RPi.GPIO as GPIO
except Exception:
    GPIO = None

SERVER_BASE = "wss://detectionbot12-colo.onrender.com"
SERVER_HTTP = "https://detectionbot12-colo.onrender.com"
ROBOT_UUID = "Agraid"
ROBOT_TYPE = "rpi-rover"
WARMUP_URL = SERVER_HTTP
WARMUP_ATTEMPTS = 3
WARMUP_DELAY_S = 2

TARGET_FPS = 12
FRAME_WIDTH = 480
FRAME_HEIGHT = 270
JPEG_QUALITY = 50
MAX_FRAME_DROP = 5

USB_CAM_INDEX = 0
USB_CAM_CANDIDATES = [USB_CAM_INDEX, 1, 2, 3]

# --- THERMAL SETTINGS DISABLED ---
# THERMAL_FPS = 8
# THERMAL_FRAME_WIDTH = 320
# THERMAL_FRAME_HEIGHT = 240
# THERMAL_JPEG_QUALITY = 70
# TEMP_MIN = 20.0
# TEMP_MAX = 40.0

VIDEO_URL = f"{SERVER_BASE}/ws/video/robot/{ROBOT_UUID}"
# THERMAL_URL = f"{SERVER_BASE}/ws/thermal/robot/{ROBOT_UUID}"
COMMAND_URL = f"{SERVER_BASE}/ws/command/robot/{ROBOT_UUID}"
# TELEMETRY_URL = f"{SERVER_BASE}/ws/telemetry/robot/{ROBOT_UUID}"

MOTOR_PINS = {
    "motor1Pin1": 17,  # IN1
    "motor1Pin2": 27,  # IN2
    "motor2Pin1": 23,  # IN3
    "motor2Pin2": 24,  # IN4
    "ena": 25,
    "enb": 18,
}
PWM_FREQUENCY = 1000

_forward_backward = 0
_left_right = 0
_current_speed = 100
_pwm_a = None
_pwm_b = None

# --- THERMAL STATE DISABLED ---
# _mlx_lock = threading.Lock()
# _mlx = None

_latest_usb_frame = None
_latest_usb_lock = threading.Lock()


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


def _wake_server():
    for attempt in range(1, WARMUP_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(WARMUP_URL, timeout=10) as resp:
                print(f"Warmup request ok (attempt {attempt}): {resp.status}")
                return True
        except urllib.error.HTTPError as e:
            print(f"Warmup request returned {e.code} (attempt {attempt})")
            return True
        except Exception as e:
            print(f"Warmup request failed (attempt {attempt}): {e}")
            time.sleep(WARMUP_DELAY_S)
    return False


# -------------------------
# COMMAND RECEIVER (KEEP)
# -------------------------
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
            print(f"[COMMAND] {msg}")  # logs kept
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
            if isinstance(payload, dict):
                speed = payload.get("speed")
                if speed is not None:
                    _set_speed(speed)
                forward_backward = payload.get("forwardBackward")
                left_right = payload.get("leftRight")
                if forward_backward is not None or left_right is not None:
                    _update_motion(
                        forward_backward=forward_backward, left_right=left_right
                    )
                    return
            command = payload.get("command", msg)
        except Exception:
            command = msg
    if not command:
        return
    if command == "MOVE_FORWARD":
        _update_motion(forward_backward=1)
    elif command == "MOVE_BACK":
        _update_motion(forward_backward=-1)
    elif command == "MOVE_LEFT":
        _update_motion(left_right=-1)
    elif command == "MOVE_RIGHT":
        _update_motion(left_right=1)
    elif command == "FORWARD_STOP" or command == "BACK_STOP":
        _update_motion(forward_backward=0)
    elif command == "LEFT_STOP" or command == "RIGHT_STOP":
        _update_motion(left_right=0)
    elif command == "STOP":
        _set_speed(0)
        _update_motion(forward_backward=0, left_right=0)


# -------------------------
# TELEMETRY SENDER (DISABLED)
# -------------------------
# def _telemetry_sender():
#     ws = None
#     while True:
#         if ws is None:
#             try:
#                 ws = _connect(TELEMETRY_URL)
#                 print("Telemetry socket connected")
#             except Exception as e:
#                 print(f"Telemetry socket error: {e}")
#                 time.sleep(2)
#                 continue
#         max_temp = _get_max_temp()
#         payload = {
#             "uuid": ROBOT_UUID,
#             "gas_ppm": 0,
#             "temperature_c": max_temp,
#             "ts": int(time.time()),
#         }
#         try:
#             ws.send(json.dumps(payload))
#         except Exception as e:
#             print(f"Telemetry send error: {e}")
#             try:
#                 ws.close()
#             except Exception:
#                 pass
#             ws = None
#             time.sleep(1)
#         time.sleep(1)


# -------------------------
# CAMERA CAPTURE (KEEP)
# -------------------------
def _open_capture(index, width, height, name, backend):
    cap = cv2.VideoCapture(index, backend)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
    return cap


def _open_capture_with_fallbacks(width, height, name):
    backends = [cv2.CAP_V4L2, cv2.CAP_ANY]
    for index in USB_CAM_CANDIDATES:
        for backend in backends:
            cap = _open_capture(index, width, height, name, backend)
            if cap is None:
                continue
            ok, _ = cap.read()
            if ok:
                print(f"{name} camera opened at index {index}")
                return cap
            cap.release()
    print(f"{name} camera not available on indexes: {USB_CAM_CANDIDATES}")
    return None


def _capture_latest_frames(cap):
    global _latest_usb_frame
    while True:
        if cap is None or not cap.isOpened():
            time.sleep(0.2)
            continue
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.01)
            continue
        with _latest_usb_lock:
            _latest_usb_frame = frame


def _video_sender(ws_url, target_fps, jpeg_quality):
    ws = None
    next_frame_time = time.monotonic()
    while True:
        if ws is None:
            try:
                ws = _connect(ws_url)
                print("Video socket connected")
            except Exception as e:
                print(f"Video socket error: {e}")
                time.sleep(2)
                continue
        now = time.monotonic()
        if now < next_frame_time:
            time.sleep(next_frame_time - now)
        else:
            next_frame_time = now
        with _latest_usb_lock:
            frame = None if _latest_usb_frame is None else _latest_usb_frame.copy()
        if frame is None:
            time.sleep(0.01)
            continue
        ok, buffer = cv2.imencode(
            ".jpg",
            frame,
            [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_quality],
        )
        if not ok:
            continue
        try:
            ws.send(buffer.tobytes(), opcode=0x2)
        except Exception as e:
            print(f"Video send error: {e}")
            try:
                ws.close()
            except Exception:
                pass
            ws = None
            time.sleep(1)
            continue
        next_frame_time += 1.0 / target_fps


# -------------------------
# THERMAL FUNCTIONS (DISABLED)
# -------------------------
# def _init_mlx():
#     global _mlx
#     try:
#         i2c = busio.I2C(board.SCL, board.SDA, frequency=400000)
#         mlx = adafruit_mlx90640.MLX90640(i2c)
#         mlx.refresh_rate = adafruit_mlx90640.RefreshRate.REFRESH_2_HZ
#         _mlx = mlx
#         print("MLX90640 sensor initialized")
#     except Exception as e:
#         _mlx = None
#         print(f"MLX90640 init error: {e}")
#
#
# def _get_thermal_frame():
#     if _mlx is None:
#         return None
#     frame = np.zeros(24 * 32, dtype=np.float32)
#     try:
#         with _mlx_lock:
#             _mlx.getFrame(frame)
#     except Exception:
#         return None
#     return frame.reshape((24, 32))
#
#
# def _thermal_to_image(temp):
#     temp = np.clip(temp, TEMP_MIN, TEMP_MAX)
#     norm = (temp - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)
#     img = (norm * 255).astype(np.uint8)
#     img = cv2.applyColorMap(img, cv2.COLORMAP_JET)
#     img = cv2.resize(
#         img, (THERMAL_FRAME_WIDTH, THERMAL_FRAME_HEIGHT), interpolation=cv2.INTER_CUBIC
#     )
#     return img
#
#
# def _get_max_temp():
#     temp = _get_thermal_frame()
#     if temp is None:
#         return None
#     return float(np.max(temp))
#
#
# def _thermal_sender():
#     ws = None
#     next_frame_time = time.monotonic()
#     while True:
#         if _mlx is None:
#             time.sleep(2)
#             continue
#         if ws is None:
#             try:
#                 ws = _connect(THERMAL_URL)
#                 print("Thermal socket connected")
#             except Exception as e:
#                 print(f"Thermal socket error: {e}")
#                 time.sleep(2)
#                 continue
#         now = time.monotonic()
#         if now < next_frame_time:
#             time.sleep(next_frame_time - now)
#         else:
#             next_frame_time = now
#         temp = _get_thermal_frame()
#         if temp is None:
#             continue
#         image = _thermal_to_image(temp)
#         ok, buffer = cv2.imencode(
#             ".jpg",
#             image,
#             [int(cv2.IMWRITE_JPEG_QUALITY), THERMAL_JPEG_QUALITY],
#         )
#         if not ok:
#             continue
#         try:
#             ws.send(buffer.tobytes(), opcode=0x2)
#         except Exception as e:
#             print(f"Thermal send error: {e}")
#             try:
#                 ws.close()
#             except Exception:
#                 pass
#             ws = None
#             time.sleep(1)
#             continue
#         next_frame_time += 1.0 / THERMAL_FPS


# -------------------------
# MOTOR CONTROL (KEEP)
# -------------------------
def _setup_gpio():
    if GPIO is None:
        print("RPi.GPIO not available; motor control disabled")
        return
    GPIO.setmode(GPIO.BCM)
    for pin in MOTOR_PINS.values():
        GPIO.setup(pin, GPIO.OUT)
    GPIO.output(MOTOR_PINS["motor1Pin1"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["motor1Pin2"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["motor2Pin1"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["motor2Pin2"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["ena"], GPIO.LOW)
    GPIO.output(MOTOR_PINS["enb"], GPIO.LOW)
    _init_pwm()
    _set_speed(_current_speed)


def _init_pwm():
    global _pwm_a, _pwm_b
    if GPIO is None:
        return
    try:
        _pwm_a = GPIO.PWM(MOTOR_PINS["ena"], PWM_FREQUENCY)
        _pwm_b = GPIO.PWM(MOTOR_PINS["enb"], PWM_FREQUENCY)
        _pwm_a.start(0)
        _pwm_b.start(100)
    except Exception:
        _pwm_a = None
        _pwm_b = None


def _set_speed(value):
    global _current_speed
    if value is None:
        return
    try:
        speed = int(value)
    except Exception:
        return
    speed = max(0, min(255, speed))
    _current_speed = speed
    if _pwm_a is None or _pwm_b is None:
        return
    duty = int((speed / 255) * 100)
    try:
        _pwm_a.ChangeDutyCycle(duty)
    except Exception:
        pass


def _update_motion(forward_backward=None, left_right=None):
    global _forward_backward, _left_right
    if forward_backward is not None:
        _forward_backward = forward_backward
    if left_right is not None:
        _left_right = left_right
    _apply_motor_state()


def _apply_motor_state():
    if GPIO is None:
        return
    # Forward/backward motor (motor1)
    if _forward_backward == 1:
        GPIO.output(MOTOR_PINS["motor1Pin1"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor1Pin2"], GPIO.HIGH)
    elif _forward_backward == -1:
        GPIO.output(MOTOR_PINS["motor1Pin1"], GPIO.HIGH)
        GPIO.output(MOTOR_PINS["motor1Pin2"], GPIO.LOW)
    else:
        GPIO.output(MOTOR_PINS["motor1Pin1"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor1Pin2"], GPIO.LOW)

    # Steering motor (motor2)
    if _left_right == 1:
        GPIO.output(MOTOR_PINS["motor2Pin1"], GPIO.HIGH)
        GPIO.output(MOTOR_PINS["motor2Pin2"], GPIO.LOW)
    elif _left_right == -1:
        GPIO.output(MOTOR_PINS["motor2Pin1"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor2Pin2"], GPIO.HIGH)
    else:
        GPIO.output(MOTOR_PINS["motor2Pin1"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor2Pin2"], GPIO.LOW)

    # Stop when both are neutral
    if _forward_backward == 0 and _left_right == 0:
        GPIO.output(MOTOR_PINS["motor1Pin1"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor1Pin2"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor2Pin1"], GPIO.LOW)
        GPIO.output(MOTOR_PINS["motor2Pin2"], GPIO.LOW)


if __name__ == "__main__":
    _wake_server()
    _register_robot()
    _setup_gpio()

    # --- THERMAL INIT DISABLED ---
    # _init_mlx()

    usb_cap = _open_capture_with_fallbacks(FRAME_WIDTH, FRAME_HEIGHT, "USB")

    threading.Thread(target=_command_listener, daemon=True).start()

    # --- SENSOR TELEMETRY DISABLED ---
    # threading.Thread(target=_telemetry_sender, daemon=True).start()

    threading.Thread(target=_capture_latest_frames, args=(usb_cap,), daemon=True).start()

    threading.Thread(
        target=_video_sender,
        args=(VIDEO_URL, TARGET_FPS, JPEG_QUALITY),
        daemon=True,
    ).start()

    # --- THERMAL STREAM DISABLED ---
    # threading.Thread(target=_thermal_sender, daemon=True).start()

    while True:
        time.sleep(1)