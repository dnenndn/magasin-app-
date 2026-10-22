@echo off
rem Builds the Android app and installs it on a phone connected by USB.
rem Double-click this file. Needs: Node.js, Java 17 (or Android Studio), Android SDK.
setlocal
title Build and install Stock GMAO

cd /d "%~dp0" || goto :fail
if not exist "android" goto :noandroid

echo.
echo === 1/4  Copying the app files into the Android project
call npx cap sync android
if errorlevel 1 goto :fail

rem ---- Java: use the one in PATH, else the one bundled with Android Studio
where java >nul 2>nul && goto :javaok
if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr" & goto :javaok
goto :nojava
:javaok

rem ---- Android SDK: tell Gradle where it is, if it does not know already
if defined ANDROID_HOME goto :sdkok
if exist "android\local.properties" goto :sdkok
set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not exist "%SDK%" goto :nosdk
set "SDKP=%SDK:\=\\%"
> "android\local.properties" echo sdk.dir=%SDKP%
:sdkok

echo.
echo === 2/4  Building the APK (the first time can take several minutes)
pushd android
call gradlew.bat assembleDebug
set "RC=%errorlevel%"
popd
if not "%RC%"=="0" goto :fail
set "APK=%~dp0android\app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK%" goto :fail

rem ---- adb: the one in PATH, else the one from the Android SDK
set "ADB=adb"
where adb >nul 2>nul && goto :adbok
set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB%" goto :noadb
:adbok

echo.
echo === 3/4  Phones connected (USB debugging must be on)
"%ADB%" devices
set "SERIAL="
set /p "SERIAL=If several devices are listed, type the serial of the phone (or just press Enter): "
set "TARGET="
if defined SERIAL set "TARGET=-s %SERIAL%"

echo.
echo === 4/4  Installing on the phone
"%ADB%" %TARGET% install -r "%APK%"
if not errorlevel 1 goto :done

echo.
echo The install failed. If the message above says INSTALL_FAILED_UPDATE_INCOMPATIBLE, the
echo app on the phone was built on another computer. It must be uninstalled first
echo (its saved server address and login are lost, the data on the server is not).
set "ANS="
set /p "ANS=Uninstall the old app and install again? (y/N): "
if /i not "%ANS%"=="y" goto :fail
"%ADB%" %TARGET% uninstall com.gmao.stockapp
"%ADB%" %TARGET% install "%APK%"
if errorlevel 1 goto :fail

:done
echo.
echo DONE: the app is installed. Open "Stock GMAO" on the phone.
goto :end

:noandroid
echo ERROR: the "android" folder was not found next to this file.
goto :end
:nojava
echo ERROR: Java was not found. Install JDK 17, or Android Studio, then try again.
goto :end
:nosdk
echo ERROR: Android SDK not found in %LOCALAPPDATA%\Android\Sdk. Install Android Studio, or set ANDROID_HOME.
goto :end
:noadb
echo ERROR: adb was not found. Install the Android SDK Platform-Tools, or Android Studio.
goto :end
:fail
echo.
echo FAILED. See the messages above.
:end
echo.
pause
