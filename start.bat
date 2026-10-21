@echo off
rem Serves AniVLC on http://localhost:8765 and opens it in the default browser.
cd /d "%~dp0"
start "" http://localhost:8765
python -m http.server 8765 --bind 127.0.0.1
