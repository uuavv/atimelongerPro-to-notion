@echo off
setlocal
cd /d "%~dp0"
node scripts\github-deploy-atimelogger-notion-worker.mjs
pause
