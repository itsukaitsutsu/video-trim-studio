import json
import os
import socket
import subprocess
import sys
import time

# Path to your installed FilmCraft executable
FILMCRAFT_EXE = r"C:\Program Files\FilmCraft\filmcraft.exe"
# Or if portable: r"C:\path\to\filmcraft-portable\filmcraft.exe"

CONTROL_PORT = 9876


def send_command(sock, method, params=None):
  """Send a JSON-RPC command to FilmCraft control port."""
  payload = {'method': method, 'params': params or {}}
  msg = json.dumps(payload) + '\n'
  sock.sendall(msg.encode('utf-8'))
  response = sock.recv(65536).decode('utf-8')
  return json.loads(response.strip())


def launch_and_connect():
  """Starts FilmCraft with the control server and connects."""
  print(f'[*] Starting FilmCraft on port {CONTROL_PORT}...')
  subprocess.Popen([FILMCRAFT_EXE, '--control', str(CONTROL_PORT)])

  # Wait a moment for FilmCraft to start up
  for attempt in range(10):
    time.sleep(1)
    try:
      s = socket.create_connection(('127.0.0.1', CONTROL_PORT), timeout=2)
      print('[+] Connected to FilmCraft!')
      return s
    except (ConnectionRefusedError, socket.timeout):
      continue
  raise RuntimeError(
      'Could not connect to FilmCraft. Make sure the path is correct.'
  )


def process_and_send(video_path, srt_path=None):
  video_path = os.path.abspath(video_path)

  # 1. Run auto-caption if no SRT is provided
  if not srt_path:
    srt_path = os.path.splitext(video_path)[0] + '.srt'
    if not os.path.exists(srt_path):
      print('[*] Running faster-whisper auto-captioning...')
      subprocess.run([
          sys.executable,
          'auto_caption.py',
          video_path,
          '--model',
          'small',
          '--output',
          srt_path,
      ])

  # 2. Connect to FilmCraft
  sock = launch_and_connect()

  # 3. Create a new project and import media + captions
  print(f'[*] Importing video: {video_path}')
  send_command(sock, 'engine.execute', {
      'command': 'file.import',
      'params': {'paths': [video_path]},
  })

  if os.path.exists(srt_path):
    print(f'[*] Importing captions: {srt_path}')
    send_command(sock, 'engine.execute', {
        'command': 'file.import',
        'params': {'paths': [srt_path]},
    })

  print('[+] Done! FilmCraft is ready for editing and grading.')
  sock.close()


if __name__ == '__main__':
  if len(sys.argv) < 2:
    print('Usage: python send_to_filmcraft.py <path_to_video.mp4>')
  else:
    process_and_send(sys.argv[1])