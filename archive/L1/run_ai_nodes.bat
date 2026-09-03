@echo off
rem NexusGenesis - 一键多节点启动脚本
rem 功能：在本地启动多个 AI 节点，无需 Docker
rem 使用：run_ai_nodes.bat [节点数量]

setlocal enabledelayedexpansion

rem 默认节点数量
if "%1"=="" (
    set NODE_COUNT=3
) else (
    set NODE_COUNT=%1
)

rem 验证节点数量范围
if %NODE_COUNT% lss 3 set NODE_COUNT=3
if %NODE_COUNT% gtr 8 set NODE_COUNT=8

rem 起始端口
set START_PORT=9847

rem 工作目录
set WORK_DIR=%~dp0
set NODE_SCRIPT=%WORK_DIR%start-node.bat

rem 检查必要文件
if not exist "%NODE_SCRIPT%" (
    echo 错误：找不到 start-node.bat 文件
    pause
    exit /b 1
)

rem 显示启动信息
echo ========================================
echo NexusGenesis - 一键多节点启动
echo 节点数量：%NODE_COUNT%
echo 起始端口：%START_PORT%
echo 工作目录：%WORK_DIR%
echo ========================================
echo.

rem 清理之前的节点状态
echo [1/3] 清理之前的节点状态...
del /f /q "%WORK_DIR%data\state\*.json" 2>nul
rmdir /s /q "%WORK_DIR%data\state" 2>nul
mkdir "%WORK_DIR%data\state" 2>nul

echo [2/3] 生成节点配置...
rem 生成节点配置文件
for /l %%i in (1,1,%NODE_COUNT%) do (
    set PORT=!START_PORT!
    set /a PORT+=%%i-1
    
    rem 创建节点配置文件
    set CONFIG_FILE=%WORK_DIR%data\state\node%%i.json
    echo {
    echo   "nodeId": "nexus-node-%%i",
    echo   "port": !PORT!,
    echo   "status": "OFFLINE",
    echo   "startTime": null,
    echo   "peers": [],
    echo   "balance": 10000000
    echo } > "!CONFIG_FILE!"
    
    echo 生成节点 %%i 配置：端口 !PORT!
)

echo.
echo [3/3] 启动节点...
echo 注意：按 Ctrl+C 可以停止所有节点
echo.

rem 启动节点
for /l %%i in (1,1,%NODE_COUNT%) do (
    set PORT=!START_PORT!
    set /a PORT+=%%i-1
    
    echo 启动节点 %%i（端口 !PORT!）...
    start "Nexus Node %%i" cmd /c "cd "%WORK_DIR%" && node start-multi-nodes.js --count 1 --port !PORT!"
    
    rem 给节点一些启动时间
    timeout /t 2 /nobreak >nul
)

echo.
echo ========================================
echo 所有节点已启动
请在各自的窗口中查看节点状态
按任意键退出...
echo ========================================
pause >nul
exit /b 0
