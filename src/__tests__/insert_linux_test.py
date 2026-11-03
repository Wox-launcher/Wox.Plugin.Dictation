import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("insert_linux", Path(__file__).parent.parent / "insert-linux.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class LinuxInsertTest(unittest.TestCase):
    def test_x11_window_and_input_focus(self):
        outputs = ["_NET_ACTIVE_WINDOW(WINDOW): window id # 0x12", "_NET_WM_PID(CARDINAL) = 123\n"]
        with patch.dict(helper.os.environ, {"XDG_SESSION_TYPE": "x11", "WAYLAND_DISPLAY": "wayland-0"}, clear=True), \
             patch.object(helper, "command", side_effect=outputs), patch.object(helper, "x11_focus", return_value=77):
            self.assertEqual(helper.snapshot(), ["x11", 18, 123, 77])

    def test_wayland_hyprland_and_unknown_compositor(self):
        payload = json.dumps({"address": "0x123", "pid": 123})
        with patch.dict(helper.os.environ, {"WAYLAND_DISPLAY": "wayland-0", "HYPRLAND_INSTANCE_SIGNATURE": "test"}, clear=True), \
             patch.object(helper, "command", return_value=payload):
            self.assertEqual(helper.snapshot(), ["hyprland", "0x123", 123])
        with patch.dict(helper.os.environ, {"WAYLAND_DISPLAY": "wayland-0"}, clear=True):
            with self.assertRaises(RuntimeError):
                helper.snapshot()

    def test_paste_emits_control_v_press_and_release(self):
        events = []
        with patch.object(helper.os, "write", side_effect=lambda _fd, data: events.append(data) or len(data)):
            helper.paste(7)
        self.assertEqual([struct.unpack("@llHHi", event)[2:] for event in events], [
            (1, 29, 1), (1, 47, 1), (0, 0, 0), (1, 47, 0), (0, 0, 0), (1, 29, 0), (0, 0, 0)
        ])

    def test_focus_change_rejects_paste_and_closes_device(self):
        target = ["x11", 18, 123, 77]
        with patch.object(helper.sys, "argv", ["helper", "123"]), \
             patch.object(helper.sys, "stdin", io.StringIO('{"op":"check"}\n')), \
             patch.object(helper.sys, "stdout", io.StringIO()), \
             patch.object(helper, "snapshot", side_effect=[target, target, ["x11", 19, 123, 77]]), \
             patch.object(helper, "create_keyboard", return_value=7), \
             patch.object(helper.time, "sleep"), \
             patch.object(helper, "paste") as paste, \
             patch.object(helper.fcntl, "ioctl") as ioctl, patch.object(helper.os, "close") as close:
            with self.assertRaises(RuntimeError):
                helper.main()
            paste.assert_not_called()
            ioctl.assert_called_with(7, 0x5502)
            close.assert_called_with(7)

    def test_verified_target_sends_paste_and_closes_device(self):
        target = ["x11", 18, 123, 77]
        output = io.StringIO()
        with patch.object(helper.sys, "argv", ["helper", "123"]), \
             patch.object(helper.sys, "stdin", io.StringIO('{"op":"check"}\n{"op":"paste"}\n')), \
             patch.object(helper.sys, "stdout", output), \
             patch.object(helper, "snapshot", return_value=target), \
             patch.object(helper, "create_keyboard", return_value=7), \
             patch.object(helper, "modifiers_pressed", return_value=False), \
             patch.object(helper.time, "sleep"), patch.object(helper, "paste") as paste, \
             patch.object(helper.fcntl, "ioctl") as ioctl, patch.object(helper.os, "close") as close:
            helper.main()
            self.assertEqual(output.getvalue().splitlines(), ["ready", "checked", "done"])
            paste.assert_called_once_with(7)
            ioctl.assert_called_with(7, 0x5502)
            close.assert_called_with(7)


if __name__ == "__main__":
    unittest.main()
