@echo off
cd /d D:\cpp\programs\AI\LANchatroom
set ELECTRON_BUILDER_CACHE=D:\cpp\programs\AI\LANchatroom\.ebcache
set NODE_TLS_REJECT_UNAUTHORIZED=0
set PATH=D:\wintools\nodejs;%PATH%
echo BUILD_START > .build-status.txt
echo Starting build at %TIME% > .build-log.txt
call npm run dist:nsis >> .build-log.txt 2>&1
set EXITCODE=%ERRORLEVEL%
echo. >> .build-log.txt
echo BUILD_EXITCODE=%EXITCODE% >> .build-log.txt
echo BUILD_DONE_%EXITCODE% > .build-status.txt
exit /b %EXITCODE%
