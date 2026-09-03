@echo off
echo ========================================
echo  NexusGenesis - Second Node Setup
echo ========================================
echo.

echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Starting Genesis Node...
echo.

REM Get this computer's local IP for connection
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set LOCAL_IP=%%a
)
set LOCAL_IP=%LOCAL_IP: =%

echo Your Local IP: %LOCAL_IP%
echo.
echo [3/3] To connect to the first node, the first node must:
echo    1. Allow through firewall
echo    2. Be accessible on port 9847
echo.
echo Starting node...

REM Start the node
node src\node\genesisNode.js

pause
