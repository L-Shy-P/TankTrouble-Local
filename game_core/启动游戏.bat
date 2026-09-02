@echo off
chcp 65001 >nul
echo ========================================
echo Tank Trouble 游戏核心启动器
echo ========================================
echo.

REM 检查Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到Python，请先安装Python 3.7+
    pause
    exit /b 1
)

echo [启动] 正在启动游戏服务器...
echo [提示] 浏览器会自动打开游戏页面
echo [提示] 按 Ctrl+C 停止服务器
echo.
python server.py

pause
