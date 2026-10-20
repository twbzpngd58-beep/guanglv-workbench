@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYVER="
for %%V in (3.12 3.13 3.11) do (
  py -%%V -c "import sys" >nul 2>&1
  if not errorlevel 1 (
    set "PYVER=%%V"
    goto :run
  )
)
echo 需要 Python 3.11 或更高版本（建议 3.12）。
echo 请从 https://www.python.org/downloads/ 安装后重试。
pause
exit /b 1

:run
py -%PYVER% start.py %*
if errorlevel 1 pause
exit /b %errorlevel%
