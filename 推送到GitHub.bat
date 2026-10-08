@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Push to GitHub

echo ============================================================
echo   Vantage - push to GitHub
echo   (push only; this script does NOT commit)
echo ============================================================
echo.

echo [1/4] Current status:
echo ------------------------------------------------------------
git -c core.quotepath=false status -sb
echo.

echo [2/4] Commits ahead of origin/main:
echo ------------------------------------------------------------
git -c core.quotepath=false log --oneline origin/main..HEAD
echo.

echo [3/4] Checking remote...
echo ------------------------------------------------------------
git remote -v
echo.

echo [4/4] Pushing to origin main ...
echo ------------------------------------------------------------
git push origin main
set PUSH_RESULT=%ERRORLEVEL%
echo ------------------------------------------------------------
echo.

if not "%PUSH_RESULT%"=="0" goto FAILED
echo   [OK] Pushed to GitHub.
goto END

:FAILED
echo   [FAIL] git push returned %PUSH_RESULT%
echo.
echo   Common causes:
echo     1. Network unreachable -- retry, or turn on a proxy / VPN
echo     2. Login or token expired
echo     3. Nothing to push -- this script does not commit, commit first

:END
echo.
echo Press any key to close...
pause >nul
