#!/usr/bin/env python3
"""
DVCapture — Transfer DV camcorder footage to Mac
"""

import os
import re
import signal
import subprocess
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk


class DVCaptureApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("DV Capture")
        self.root.resizable(True, False)

        self.capture_process: subprocess.Popen | None = None
        self.is_capturing = False
        self.output_path = ""

        self._build_ui()
        self._refresh_devices()

    # ── UI ─────────────────────────────────────────────────────────────────

    def _build_ui(self):
        pad = {"padx": 12, "pady": 6}

        main = ttk.Frame(self.root, padding=16)
        main.grid(sticky="nsew")
        self.root.columnconfigure(0, weight=1)
        main.columnconfigure(1, weight=1)

        # Device
        ttk.Label(main, text="Device:").grid(row=0, column=0, sticky="w", **pad)
        row0 = ttk.Frame(main)
        row0.grid(row=0, column=1, sticky="ew", **pad)
        row0.columnconfigure(0, weight=1)

        self.device_var = tk.StringVar()
        self.device_combo = ttk.Combobox(row0, textvariable=self.device_var, state="readonly")
        self.device_combo.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ttk.Button(row0, text="Refresh", command=self._refresh_devices).grid(row=0, column=1)

        # Destination
        ttk.Label(main, text="Destination:").grid(row=1, column=0, sticky="w", **pad)
        row1 = ttk.Frame(main)
        row1.grid(row=1, column=1, sticky="ew", **pad)
        row1.columnconfigure(0, weight=1)

        self.dest_var = tk.StringVar(value=os.path.expanduser("~/Desktop"))
        self.dest_var.trace_add("write", self._update_preview)
        ttk.Entry(row1, textvariable=self.dest_var).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ttk.Button(row1, text="Browse…", command=self._browse_dest).grid(row=0, column=1)

        # Filename
        ttk.Label(main, text="Filename:").grid(row=2, column=0, sticky="w", **pad)
        row2 = ttk.Frame(main)
        row2.grid(row=2, column=1, sticky="ew", **pad)

        self.filename_var = tk.StringVar()
        self.filename_var.trace_add("write", self._update_preview)
        ttk.Entry(row2, textvariable=self.filename_var, width=32).pack(side="left")
        ttk.Label(row2, text=".dv", foreground="gray").pack(side="left", padx=(2, 0))

        # Output path preview
        ttk.Label(main, text="Output:").grid(row=3, column=0, sticky="w", **pad)
        self.preview_var = tk.StringVar(value="—")
        ttk.Label(
            main, textvariable=self.preview_var,
            foreground="gray", wraplength=420, justify="left"
        ).grid(row=3, column=1, sticky="w", **pad)

        ttk.Separator(main).grid(row=4, column=0, columnspan=2, sticky="ew", pady=10)

        # Buttons
        btn_row = ttk.Frame(main)
        btn_row.grid(row=5, column=0, columnspan=2, pady=6)

        self.start_btn = ttk.Button(btn_row, text="Start Import", command=self._start_capture)
        self.start_btn.pack(side="left", padx=6)

        self.stop_btn = ttk.Button(btn_row, text="Stop Import", command=self._stop_capture, state="disabled")
        self.stop_btn.pack(side="left", padx=6)

        ttk.Button(btn_row, text="Quit", command=self._quit).pack(side="left", padx=6)

        # Log
        ttk.Label(main, text="Log:").grid(row=6, column=0, sticky="nw", **pad)
        self.log_text = scrolledtext.ScrolledText(
            main, height=14, state="disabled", wrap="word", font=("Menlo", 10)
        )
        self.log_text.grid(row=7, column=0, columnspan=2, sticky="ew", padx=12, pady=(0, 4))

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(main, textvariable=self.status_var, foreground="gray").grid(
            row=8, column=0, columnspan=2, sticky="w", padx=12, pady=(0, 8)
        )

    def _update_preview(self, *_):
        dest = self.dest_var.get().rstrip("/")
        name = self.filename_var.get().strip()
        if dest and name:
            self.preview_var.set(f"{dest}/{name}.dv")
        else:
            self.preview_var.set("—")

    # ── Device discovery ───────────────────────────────────────────────────

    def _refresh_devices(self):
        self._log("Scanning for capture devices…")
        threading.Thread(target=self._scan_devices, daemon=True).start()

    def _scan_devices(self):
        for binary in ("ffmpeg-dl", "ffmpeg"):
            try:
                result = subprocess.run(
                    [binary, "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                    capture_output=True, text=True, timeout=10,
                )
                devices = self._parse_devices(result.stderr)
                self.root.after(0, self._populate_devices, devices)
                return
            except FileNotFoundError:
                continue
            except subprocess.TimeoutExpired:
                self.root.after(0, self._log, f"{binary} timed out while scanning devices.")
                return

        self.root.after(0, self._log, "ffmpeg not found. Install via: brew install ffmpeg")

    def _parse_devices(self, stderr: str) -> list[str]:
        devices = []
        in_video = False
        for line in stderr.splitlines():
            if "AVFoundation video devices" in line:
                in_video = True
                continue
            if "AVFoundation audio devices" in line:
                break
            if in_video:
                m = re.search(r'\[(\d+)\]\s+(.+)', line)
                if m:
                    devices.append(m.group(2).strip())
        return devices

    def _populate_devices(self, devices: list[str]):
        if not devices:
            self._log("No video devices found. Connect your camcorder and click Refresh.")
            return

        self.device_combo["values"] = devices

        # Pre-select known camcorder device names
        hints = ["PV-GS", "DV", "FireWire", "Panasonic", "Sony", "Canon"]
        for d in devices:
            if any(h.lower() in d.lower() for h in hints):
                self.device_var.set(d)
                break
        else:
            self.device_var.set(devices[0])

        self._log(f"Found {len(devices)} video device(s): {', '.join(devices)}")

    # ── File picker ────────────────────────────────────────────────────────

    def _browse_dest(self):
        path = filedialog.askdirectory(
            title="Select destination folder",
            initialdir=self.dest_var.get(),
        )
        if path:
            self.dest_var.set(path)

    # ── Capture control ────────────────────────────────────────────────────

    def _validate(self) -> bool:
        if not self.device_var.get():
            messagebox.showerror("Missing device", "Select a capture device.")
            return False
        if not self.dest_var.get():
            messagebox.showerror("Missing destination", "Select a destination folder.")
            return False
        if not self.filename_var.get().strip():
            messagebox.showerror("Missing filename", "Enter a filename.")
            return False

        path = f"{self.dest_var.get().rstrip('/')}/{self.filename_var.get().strip()}.dv"
        if os.path.exists(path):
            return messagebox.askyesno("File exists", f"{path}\nalready exists. Overwrite?")
        return True

    def _start_capture(self):
        if not self._validate():
            return

        device = self.device_var.get()
        dest = self.dest_var.get().rstrip("/")
        name = self.filename_var.get().strip()
        self.output_path = f"{dest}/{name}.dv"

        cmd = (
            f'ffmpeg-dl -f avfoundation -capture_raw_data true -i "{device}" '
            f'-c copy -f dv - '
            f'| tee "{self.output_path}" '
            f'| dvrescue - 2>/dev/null'
        )

        self._log(f"Device:  {device}")
        self._log(f"Output:  {self.output_path}")
        self._log(f"Command: {cmd}")
        self._log("─" * 60)

        try:
            self.capture_process = subprocess.Popen(
                cmd,
                shell=True,
                executable="/bin/zsh",
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                preexec_fn=os.setsid,
            )
        except Exception as e:
            self._log(f"Failed to launch: {e}")
            return

        self.is_capturing = True
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self.status_var.set("Capturing…")

        threading.Thread(target=self._stream_output, daemon=True).start()
        threading.Thread(target=self._poll_size, daemon=True).start()

    def _stop_capture(self):
        if self.capture_process:
            try:
                os.killpg(os.getpgid(self.capture_process.pid), signal.SIGINT)
            except Exception as e:
                self._log(f"Stop error: {e}")
        self._on_capture_ended("Stopped by user")

    def _on_capture_ended(self, reason: str):
        self.is_capturing = False
        self.capture_process = None
        self.start_btn.config(state="normal")
        self.stop_btn.config(state="disabled")
        self.status_var.set(reason)

        try:
            if self.output_path and os.path.exists(self.output_path):
                size = os.path.getsize(self.output_path)
                self._log(f"Final file size: {size / (1024 * 1024):.1f} MB → {self.output_path}")
        except Exception:
            pass

    # ── Background threads ─────────────────────────────────────────────────

    def _stream_output(self):
        """Stream dvrescue stdout to the log area."""
        proc = self.capture_process
        if not proc or not proc.stdout:
            return
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    self.root.after(0, self._log, line)
        except Exception:
            pass
        proc.wait()
        self.root.after(0, self._on_capture_ended, "Capture finished")

    def _poll_size(self):
        """Update the status bar with the current file size once per second."""
        start = time.time()
        while self.is_capturing:
            try:
                size = os.path.getsize(self.output_path) if os.path.exists(self.output_path) else 0
                elapsed = int(time.time() - start)
                m, s = divmod(elapsed, 60)
                label = f"Capturing — {size / (1024 * 1024):.1f} MB — {m:02d}:{s:02d}"
                self.root.after(0, self.status_var.set, label)
            except Exception:
                pass
            time.sleep(1)

    # ── Log ────────────────────────────────────────────────────────────────

    def _log(self, message: str):
        self.log_text.config(state="normal")
        ts = time.strftime("%H:%M:%S")
        self.log_text.insert("end", f"[{ts}] {message}\n")
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    # ── Quit ───────────────────────────────────────────────────────────────

    def _quit(self):
        if self.is_capturing:
            if not messagebox.askyesno("Quit", "Capture is running. Stop and quit?"):
                return
            self._stop_capture()
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    root.minsize(580, 420)
    DVCaptureApp(root)
    root.mainloop()
