#!/usr/bin/env bash
# Builds Sakura.apk with plain build-tools (no Gradle): aapt -> javac -> d8 -> zipalign -> apksigner.
# The old aapt can't read non-ASCII paths, so everything is staged in an ASCII temp dir.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="/c/Users/$USERNAME/AppData/Local/Temp/lt-apk"
rm -rf "$W" && mkdir -p "$W/gen" "$W/classes" "$W/res/drawable" "$W/tools"
cp "$HERE/AndroidManifest.xml" "$W/"
cp -r "$HERE/src" "$W/"
# default addresses baked into the APK (optional, from ../sakura.config.json)
URL=$(node -e "try{const c=require(process.argv[1]);process.stdout.write(c.apkDefaultUrl||'')}catch{}" "$HERE/../sakura.config.json")
ALT=$(node -e "try{const c=require(process.argv[1]);process.stdout.write(c.apkAltUrl||'')}catch{}" "$HERE/../sakura.config.json")
printf 'package com.sakura.litetavern;

final class Defaults {
    static final String URL = "%s";
    static final String ALT_URL = "%s";
}
' "$URL" "$ALT" > "$W/src/com/sakura/litetavern/Defaults.java"
cp "$HERE/../public/icon-192.png" "$W/res/drawable/icon.png"
cp "$ANDROID_HOME/platforms/android-36/android.jar" "$W/android.jar"
cp -r "$ANDROID_HOME/build-tools/36.0.0/." "$W/tools/"
[ -f "$HERE/lt.keystore" ] && cp "$HERE/lt.keystore" "$W/"
cd "$W"
BT="$W/tools"
"$BT/aapt.exe" package -f -m -J gen -M AndroidManifest.xml -S res -I android.jar -F base.apk
javac -encoding UTF-8 --release 8 -nowarn -classpath android.jar -d classes $(find src gen -name '*.java') 2>&1 | grep -v "^warning\|^1 warning\|^注" || true
cmd.exe //c "tools\\d8.bat --release --min-api 24 --lib android.jar --output . $(find classes -name '*.class' | tr '\n' ' ')"
"$BT/aapt.exe" add base.apk classes.dex >/dev/null
"$BT/zipalign.exe" -f 4 base.apk aligned.apk
if [ ! -f lt.keystore ]; then
  keytool -genkeypair -keystore lt.keystore -storepass litetavern -keypass litetavern -alias lt -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Sakura" >/dev/null 2>&1
  cp lt.keystore "$HERE/"
fi
cmd.exe //c "tools\\apksigner.bat sign --ks lt.keystore --ks-pass pass:litetavern --key-pass pass:litetavern --out LiteTavern.apk aligned.apk"
cp LiteTavern.apk "$HERE/../Sakura.apk"
echo "APK built: $(ls -la "$HERE/../Sakura.apk")"
