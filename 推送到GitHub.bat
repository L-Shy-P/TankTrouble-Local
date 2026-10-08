@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Push to GitHub

echo ============================================================
echo   Vantage - 推送到 GitHub
echo   （只推送，不做本地提交）
echo ============================================================
echo.

echo [1/3] 当前状态：
git status -sb
echo.

echo [2/3] 本地领先 origin 的提交：
git log --oneline origin/main..HEAD 2>nul
if errorlevel 1 echo     （读不到 origin/main，可能是第一次推送或远程未获取）
echo.

echo [3/3] 开始推送...
echo ------------------------------------------------------------
git push origin main
set PUSH_RESULT=%ERRORLEVEL%
echo ------------------------------------------------------------
echo.

if "%PUSH_RESULT%"=="0" (
    echo   [成功] 已经推送到 GitHub。
) else (
    echo   [失败] 退出码 %PUSH_RESULT%
    echo.
    echo   常见原因：
    echo     1. 网络不通（多试几次，或挂上代理再试）
    echo     2. 需要登录 / token 过期
    echo     3. 本地没提交（本脚本只推送，不提交）
)

echo.
echo 按任意键关闭...
pause >nul
