#!/usr/bin/env bash
# 组装 macOS 应用包并压成 dmg。需要 RUNTIME 指向已解压、已装好依赖的 python-build-standalone 目录。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME="${RUNTIME:?请设置 RUNTIME=已解压并装好依赖的 Python 运行时目录}"
RUNTIME="$(cd "$RUNTIME" && pwd)"
VERSION="$(cat "$ROOT/VERSION")"
STAGE="${STAGE_DIR:-$ROOT/build/macos}"
DIST="${DIST_DIR:-$ROOT/dist}"
APP_NAME="光律制图器"
APP="$STAGE/$APP_NAME.app"
ARCH="$(uname -m)"
DMG="$DIST/guanglv-workbench-$VERSION-macos-$ARCH.dmg"

[ -x "$RUNTIME/bin/python3" ] || { echo "运行时缺少可执行的 bin/python3：$RUNTIME"; exit 1; }

rm -rf "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

"$RUNTIME/bin/python3" "$ROOT/installer/pack.py" --out "$APP/Contents/Resources/app"
cp -a "$RUNTIME" "$APP/Contents/Resources/runtime"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.guanglv.workbench</string>
  <key>CFBundleExecutable</key><string>guanglv</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.professional-software</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>光律照明 v$VERSION</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/guanglv" <<'LAUNCH'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/Resources/runtime/bin/python3" -I -B "$DIR/Resources/app/installer/serve.py" "$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/guanglv"

ICON_SRC="$ROOT/installer/assets/app-icon.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$STAGE/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z $double $double "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

# 未做开发者签名，先打临时签名，避免 Gatekeeper 直接报「已损坏」。
codesign --force --deep --sign - "$APP"

mkdir -p "$DIST"
RM_ROOT="$STAGE/dmg-root"
mkdir -p "$RM_ROOT"
mv "$APP" "$RM_ROOT/"
ln -s /Applications "$RM_ROOT/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "$APP_NAME $VERSION" -srcfolder "$RM_ROOT" -ov -format UDZO "$DMG"
mv "$RM_ROOT/$APP_NAME.app" "$STAGE/"

echo "dmg: $DMG ($(du -h "$DMG" | cut -f1))"
shasum -a 256 "$DMG"
