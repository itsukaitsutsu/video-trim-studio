#!/usr/bin/env python3
"""
Bridge between Video Trim Studio and FilmCraft Native Desktop.
"""

import os
import sys
import json
import time
import socket
import subprocess
from pathlib import Path

# Paths to search for FilmCraft executable on Windows / Linux / macOS
CANDIDATE_PATHS = [
    # Custom / local workspace
    r"D:\filmcraft\filmcraft.exe",
    r"D:\FilmCraft\filmcraft.exe",
    r"C:\filmcraft\filmcraft.exe",
    r"C:\Program Files\FilmCraft\filmcraft.exe",
    r"C:\Program Files (x86)\FilmCraft\filmcraft.exe",
    # Downloads / Desktop portable releases
    os.path.expanduser(r"~\Downloads\filmcraft-0.6.0-windows-x64-portable\filmcraft.exe"),
    os.path.expanduser(r"~\Downloads\filmcraft.exe"),
    os.path.expanduser(r"~\Desktop\filmcraft.exe"),
    os.path.expanduser(r"~\Desktop\filmcraft-0.6.0-windows-x64-portable\filmcraft.exe"),
    # Linux / macOS binaries
    "/usr/local/bin/filmcraft",
    "/usr/bin/filmcraft",
    os.path.expanduser("~/.local/bin/filmcraft"),
]

CONTROL_PORT = 9876
CONFIG_FILE = Path(__file__).resolve().parent / "work" / "filmcraft_path.txt"


def find_filmcraft_exe():
    """Finds the FilmCraft executable path."""
    # 1. Environment variable
    env_path = os.environ.get("FILMCRAFT_EXE")
    if env_path and os.path.isfile(env_path):
        return env_path

    # 2. Config file in work directory
    if CONFIG_FILE.is_file():
        try:
            saved_path = CONFIG_FILE.read_text("utf-8").strip()
            if saved_path and os.path.isfile(saved_path):
                return saved_path
        except Exception:
            pass

    # 3. Known candidate locations
    for p in CANDIDATE_PATHS:
        if os.path.isfile(p):
            return p

    # 4. Check if filmcraft is in system PATH
    which_path = shutil_which("filmcraft.exe") or shutil_which("filmcraft")
    if which_path and os.path.isfile(which_path):
        return which_path

    return None


def shutil_which(cmd):
    import shutil
    return shutil.which(cmd)


def try_connect_socket(port=CONTROL_PORT, timeout=1.0):
    """Attempts to connect to FilmCraft control port."""
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        return s
    except (ConnectionRefusedError, socket.timeout, OSError):
        return None


def send_command(sock, method, params=None):
    """Send a JSON command to FilmCraft control socket."""
    payload = {"method": method, "params": params or {}}
    msg = json.dumps(payload) + "\n"
    sock.sendall(msg.encode("utf-8"))
    res = sock.recv(65536).decode("utf-8")
    return json.loads(res.strip())


def main():
    if len(sys.argv) < 2:
        print("Usage: python send_to_filmcraft.py <video_path> [srt_path]")
        sys.exit(1)

    video_path = os.path.abspath(sys.argv[1])
    srt_path = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None

    if not os.path.exists(video_path):
        print(f"[-] Video file does not exist: {video_path}")
        sys.exit(1)

    # 1. Check if FilmCraft is already running and listening
    sock = try_connect_socket(CONTROL_PORT, timeout=0.5)

    if sock:
        print(f"[+] FilmCraft is already running on port {CONTROL_PORT}!")
    else:
        # 2. Find executable and start FilmCraft
        exe_path = find_filmcraft_exe()
        if not exe_path:
            print("[-] FilmCraft executable was not found.")
            print("    Please set your FilmCraft path in work/filmcraft_path.txt or FILMCRAFT_EXE env var.")
            sys.exit(1)

        print(f"[*] Found FilmCraft at: {exe_path}")
        print(f"[*] Launching FilmCraft with media arguments...")

        cmd = [exe_path, "--control", str(CONTROL_PORT), video_path]
        if srt_path and os.path.exists(srt_path):
            cmd.append(srt_path)

        # Detached flags on Windows
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008  # DETACHED_PROCESS

        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
            close_fds=(sys.platform != "win32")
        )

        # 3. Wait for FilmCraft to open control port
        print(f"[*] Waiting for FilmCraft to initialize...")
        for attempt in range(20):  # Wait up to 10 seconds
            time.sleep(0.5)
            sock = try_connect_socket(CONTROL_PORT, timeout=1.0)
            if sock:
                print(f"[+] Connected to FilmCraft on port {CONTROL_PORT}!")
                break

    # 4. If connected, send import commands to ensure files are in project
    if sock:
        try:
            print(f"[*] Importing media into project: {video_path}")
            res_vid = send_command(sock, "engine.execute", {
                "command": "file.import",
                "params": {"paths": [video_path]}
            })
            print(f"    Video import response: {res_vid}")

            if srt_path and os.path.exists(srt_path):
                print(f"[*] Importing captions: {srt_path}")
                res_srt = send_command(sock, "engine.execute", {
                    "command": "file.import",
                    "params": {"paths": [srt_path]}
                })
                print(f"    Captions import response: {res_srt}")

            print("[+] FilmCraft project ready!")
        except Exception as e:
            print(f"[!] Warning communicating over socket: {e}")
        finally:
            sock.close()
    else:
        print("[*] FilmCraft launched (control port not connected, but files passed via CLI args).")

    print("[+] Done!")


if __name__ == "__main__":
    main()
