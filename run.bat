@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Virtual environment missing. Run setup.bat first.
  pause
  exit /b 1
)
.venv\Scripts\python.exe -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 (
  echo Python 3.10+ is required. Delete .venv and rerun setup.bat with Python 3.11 installed.
  pause
  exit /b 1
)
echo Starting Video Trim Studio at http://127.0.0.1:8765
echo Keep this window open while editing. Press Ctrl+C to stop.
echo.
.venv\Scripts\python.exe server.py
pause
