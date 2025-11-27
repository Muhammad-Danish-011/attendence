@echo off
title ZKTeco Auto Service Starter
echo ========================================
echo    ZKTeco Auto Attendance Service
echo ========================================
echo.

cd /d "C:\Users\%USERNAME%\Desktop\zkteco-attendance"

echo 1. Checking Node.js...
node --version
if errorlevel 1 (
    echo ERROR: Node.js not installed!
    echo Please install Node.js from nodejs.org
    pause
    exit
)

echo.
echo 2. Installing dependencies...
call npm install

echo.
echo 3. Installing PM2...
call npm install -g pm2

echo.
echo 4. Starting service...
pm2 start app.js --name zkteco-service

echo.
echo 5. Setting up auto-start...
pm2 save
pm2 startup

echo.
echo ========================================
echo        SETUP COMPLETED SUCCESSFULLY!
echo ========================================
echo.
echo ✅ Service is now running
echo 🔄 Auto-start enabled
echo 📊 Check: http://localhost:5000
echo 📁 Data Folder: Desktop\zkteco-attendance\data
echo.
echo ⚡ Ab ye service har baar computer on hote hi
echo    automatically start ho jayegi!
echo.
pause