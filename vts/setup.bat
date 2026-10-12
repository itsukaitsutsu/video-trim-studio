@echo off
setlocal
cd /d "%~dp0"

echo === Video Trim Studio setup ===
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo WARNING: ffmpeg was not found on PATH.
  echo Install it first: winget install --id Gyan.FFmpeg
  echo Then close and reopen this window.
  echo.
)
where ffprobe >nul 2>nul
if errorlevel 1 (
  echo WARNING: ffprobe was not found on PATH. It is included with standard FFmpeg builds.
  echo Reinstall FFmpeg and ensure its bin folder is on PATH.
  echo.
)

if not exist ".venv\Scripts\python.exe" (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 -m venv .venv
  ) else (
    python -m venv .venv
  )
  if errorlevel 1 (
    echo Could not create a Python virtual environment. Install Python 3.10+ and try again.
    pause
    exit /b 1
  )
)

.venv\Scripts\python.exe -c "import sys; print('Using Python', sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 (
  echo Video Trim Studio needs Python 3.10 or newer. Install Python 3.11, delete .venv, and rerun setup.bat.
  pause
  exit /b 1
)

.venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto :failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo.
echo Setup complete. Double-click run.bat to start the app.
echo.
echo Optional: auto-captioning (transcribe video to .srt/.vtt/.json in the UI).
echo It is a large download and is not installed by default. To enable it:
echo   .venv\Scripts\python.exe -m pip install -r requirements-caption.txt
pause
exit /b 0

:failed
echo.
echo Setup failed while installing packages. Check your internet connection and try again.
pause
exit /b 1
