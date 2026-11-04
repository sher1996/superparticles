@echo off
REM Double-click to start the bol Opportunity Engine on Windows.
cd /d "%~dp0"
if not exist .venv (
  echo Creating Python environment, first time only...
  py -3 -m venv .venv || python -m venv .venv
  call .venv\Scripts\activate.bat
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate.bat
)
if not exist .env copy .env.example .env
start "" http://127.0.0.1:8000
python run.py
pause
