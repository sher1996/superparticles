@echo off
REM Runs the daily funnel once (for Windows Task Scheduler). Logs go to logs\engine.log
cd /d "%~dp0"
call .venv\Scripts\activate.bat
python run_pipeline.py
