import ctypes
import ctypes.util
import fcntl
import glob
import json
import os
import re
import struct
import subprocess
import sys
import time


def command(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2).stdout


def snapshot():
    session = os.environ.get("XDG_SESSION_TYPE", "").lower()
    wayland = session == "wayland" or (session != "x11" and bool(os.environ.get("WAYLAND_DISPLAY")))
    if wayland:
        if not os.environ.get("HYPRLAND_INSTANCE_SIGNATURE"):
            raise RuntimeError("Cannot identify the focused window on this Wayland desktop")
        active = json.loads(command("hyprctl", "-j", "activewindow"))
        if not active.get("address") or not active.get("pid"):
            raise RuntimeError("No focused window")
        return ["hyprland", active["address"], int(active["pid"])]
    root = command("xprop", "-root", "_NET_ACTIVE_WINDOW")
    match = re.search(r"#\s*(0x[0-9a-fA-F]+)", root)
    if not match or int(match.group(1), 16) == 0:
        raise RuntimeError("No focused window")
    window = match.group(1)
    props = command("xprop", "-id", window, "_NET_WM_PID")
    match = re.search(r"=\s*(\d+)\s*$", props)
    if not match:
        raise RuntimeError("Cannot identify focused application")
    return ["x11", int(window, 16), int(match.group(1)), x11_focus()]


def x11_focus():
    lib = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    lib.XOpenDisplay.restype = ctypes.c_void_p
    lib.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
    lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = lib.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Cannot connect to X11")
    try:
        focus, revert = ctypes.c_ulong(), ctypes.c_int()
        lib.XGetInputFocus(display, ctypes.byref(focus), ctypes.byref(revert))
        if focus.value <= 1:
            raise RuntimeError("No focused input")
        return focus.value
    finally:
        lib.XCloseDisplay(display)


def modifiers_pressed():
    # EVIOCGKEY reads current key state without consuming keyboard events.
    found = False
    for path in glob.glob("/dev/input/event*"):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                supported = bytearray(96)
                fcntl.ioctl(fd, 0x80604521, supported, True)
                if not all(supported[key // 8] & (1 << (key % 8)) for key in (29, 47)):
                    continue
                keys = bytearray(96)
                fcntl.ioctl(fd, 0x80604518, keys, True)
                found = True
                if any(keys[key // 8] & (1 << (key % 8)) for key in (29, 42, 54, 56, 97, 100, 125, 126)):
                    return True
            finally:
                os.close(fd)
        except OSError:
            continue
    if not found:
        raise RuntimeError("Cannot check keyboard modifiers")
    return False


def create_keyboard():
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    try:
        fcntl.ioctl(fd, 0x40045564, 1)
        for key in (29, 47):
            fcntl.ioctl(fd, 0x40045565, key)
        device = bytearray(1116)
        device[:15] = b"Wox Dictation\0\0"
        if os.write(fd, device) != len(device):
            raise RuntimeError("Could not initialize input device")
        fcntl.ioctl(fd, 0x5501)
        return fd
    except BaseException:
        os.close(fd)
        raise


def paste(fd):
    # struct input_event uses two native longs for its timestamp.
    for kind, code, value in ((1, 29, 1), (1, 47, 1), (0, 0, 0), (1, 47, 0), (0, 0, 0), (1, 29, 0), (0, 0, 0)):
        event = struct.pack("@llHHi", 0, 0, kind, code, value)
        if os.write(fd, event) != len(event):
            raise RuntimeError("Could not send paste shortcut")


def main():
    expected_pid = int(sys.argv[1])
    target = snapshot()
    if target[2] != expected_pid:
        raise RuntimeError("The original application is no longer focused")
    fd = create_keyboard()
    try:
        time.sleep(0.5)
        if snapshot() != target:
            raise RuntimeError("The original window is no longer focused")
        print("ready", flush=True)
        if json.loads(sys.stdin.readline()).get("op") != "check" or snapshot() != target:
            raise RuntimeError("The original window is no longer focused")
        for _ in range(20):
            if not modifiers_pressed():
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("Keyboard shortcut is still pressed")
        print("checked", flush=True)
        if json.loads(sys.stdin.readline()).get("op") != "paste" or snapshot() != target or modifiers_pressed():
            raise RuntimeError("The original window is no longer focused")
        paste(fd)
        time.sleep(0.15)
        print("done", flush=True)
    finally:
        try:
            fcntl.ioctl(fd, 0x5502)
        finally:
            os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
