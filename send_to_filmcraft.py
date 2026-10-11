#!/usr/bin/env python3
"""Bridge between Video Trim Studio and FilmCraft Native Desktop."""

import json
import os
import socket
import subprocess
import sys
import time

# List of common paths where FilmCraft .exe might be located
CANDIDATE_PATHS = [
    r'D:\filmcraft\filmcraft.exe',
    r'C:\Program Files\FilmCraft\filmcraft.exe',
    os.path.expanduser(
        r'~\Downloads\filmcraft-0.6.0-windows-x64-portable\filmcraft.exe'
    ),
    os.path.expanduser(r'~\Desktop\filmcraft.exe'),
]

CONTROL_PORT = 9876


def find_filmcraft_exe():
  # Check environment variable first
  env_path = os.environ.get('FILMCRAFT_EXE')
  if env_path and os.path.isfile(env_path):
    return env_path

  for p in CANDIDATE_PATHS:
    if os.path.isfile(p):
      return p
  return None


def send_command(sock, method, params=None):
  """Send a JSON command to FilmCraft over TCP."""
  payload = {'method': method, 'params': params or {}}
  msg = json.dumps(payload) + '\n'
  sock.sendall(msg.encode('utf-8'))
  res = sock.recv(65536).decode('utf-8')
  return json.loads(res.strip())


def main():
  if len(sys.argv) < 2:
    print('Usage: python send_to_filmcraft.py <video_path> [srt_path]')
    sys.exit(1)

  video_path = os.path.abspath(sys.argv[1])
  srt_path = (
      os.path.abspath(sys.argv[2])
      if len(sys.argv) > 2 and sys.argv[2]
      else None
  )

  exe_path = find_filmcraft_exe()
  if not exe_path:
    print(
        '[-] FilmCraft .exe not found! Please set FILMCRAFT_EXE environment'
        ' variable or update CANDIDATE_PATHS in send_to_filmcraft.py'
    )
    sys.exit(1)

  print(f'[*] Found FilmCraft at: {exe_path}')
  print(f'[*] Starting FilmCraft on control port {CONTROL_PORT}...')
  subprocess.Popen([exe_path, '--control', str(CONTROL_PORT)])

  # Connect to FilmCraft
  sock = None
  for attempt in range(12):
    time.sleep(0.5)
    try:
      sock = socket.create_connection(('127.0.0.1', CONTROL_PORT), timeout=2)
      print('[+] Connected to FilmCraft!')
      break
    except (ConnectionRefusedError, socket.timeout):
      continue

  if not sock:
    print('[-] Failed to connect to FilmCraft control port.')
    sys.exit(1)

  try:
    # Import video
    print(f'[*] Importing video: {video_path}')
    send_command(
        sock,
        'engine.execute',
        {'command': 'file.import', 'params': {'paths': [video_path]}},
    )

    # Import subtitles if available
    if srt_path and os.path.exists(srt_path):
      print(f'[*] Importing captions: {srt_path}')
      send_command(
          sock,
          'engine.execute',
          {'command': 'file.import', 'params': {'paths': [srt_path]}},
      )

    print('[+] FilmCraft is ready!')
  finally:
    sock.close()


if __name__ == '__main__':
  main()