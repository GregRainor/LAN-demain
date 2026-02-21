@echo off
echo ===================================================
echo   LAN Demain - Local Server
echo ===================================================
echo.
echo Starting a local web server to test the application.
echo Please open your browser to: http://localhost:8000
echo.
echo Press Ctrl+C to stop the server when you are done.
echo.
python3 -m http.server 8000
pause
