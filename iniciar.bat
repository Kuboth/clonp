@echo off
title Clonr Local - Servidor Pessoal
cd /d "%~dp0"

echo ========================================================
echo   Iniciando Clonr Local...
echo ========================================================
echo.

REM Inicia o servidor em segundo plano e abre o navegador
start "" "http://localhost:3000"
npm start

pause

