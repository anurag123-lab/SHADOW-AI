@echo off
rem Keeps the notifier running: if it ever exits or crashes, it restarts after 30s.
rem Started hidden at logon by the "ShadowAI Notifier" scheduled task
rem (install with: npm run notifier:install). Output: notifier\logs\notifier.log
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
echo [%date% %time%] notifier starting>> logs\notifier.log
node "%~dp0index.js" >> logs\notifier.log 2>&1
echo [%date% %time%] notifier exited (code %errorlevel%) - restarting in 30s>> logs\notifier.log
timeout /t 30 /nobreak >nul
goto loop
