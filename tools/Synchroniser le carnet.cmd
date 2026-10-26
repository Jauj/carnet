@echo off
chcp 65001 >nul
title Synchroniser le carnet
node "C:\Users\FERRIER\carnet\tools\sync.mjs" sync %*
echo.
pause
