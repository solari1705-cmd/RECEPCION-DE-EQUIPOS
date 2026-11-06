@echo off
chcp 65001 >nul
title Postventa - servidor
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 servidor.py
) else (
  python servidor.py
)
echo.
echo El servidor se detuvo. Si hubo un error, esta escrito arriba.
pause
