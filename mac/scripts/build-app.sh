#!/bin/zsh
# Compila Charla para Mac y arma dist/Charla.app y dist/Charla.dmg.
# Uso: ./scripts/build-app.sh   (basta con las Command Line Tools; no hace falta Xcode)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="1.0.0"
DIST="dist"
# Se arma fuera del Escritorio: iCloud le pone atributos que codesign rechaza.
BUILD=$(mktemp -d)
APP="$BUILD/Charla.app"

# Universal: funciona en Macs con Apple Silicon y con Intel. Se compila una
# arquitectura por vez y se juntan con lipo (compilar las dos juntas pide Xcode).
swift build -c release --triple arm64-apple-macosx13.0
swift build -c release --triple x86_64-apple-macosx13.0

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create .build/arm64-apple-macosx/release/Charla .build/x86_64-apple-macosx/release/Charla \
  -output "$APP/Contents/MacOS/Charla"

if [[ ! -f .build/AppIcon.icns ]]; then
  TMP=$(mktemp -d)
  swift scripts/make-icon.swift "$TMP/icon.png"
  mkdir -p "$TMP/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/AppIcon.iconset" -o .build/AppIcon.icns
  rm -rf "$TMP"
fi
cp .build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>es</string>
  <key>CFBundleDisplayName</key><string>Charla</string>
  <key>CFBundleName</key><string>Charla</string>
  <key>CFBundleExecutable</key><string>Charla</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.everfreshmedia.charla</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.business</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Everfresh Media</string>
</dict>
</plist>
PLIST

# Firma ad-hoc (igual que Susurro y Toma). La primera vez que alguien la abre,
# macOS pide confirmarla en Ajustes → Privacidad y seguridad → "Abrir igualmente".
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"

mkdir -p "$DIST"
rm -rf "$DIST/Charla.app"
ditto --noextattr "$APP" "$DIST/Charla.app"

STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DIST/Charla.dmg"
hdiutil create -volname "Charla" -srcfolder "$STAGE" -ov -format UDZO "$DIST/Charla.dmg" >/dev/null
rm -rf "$STAGE" "$BUILD"

echo "Listo: $DIST/Charla.app y $DIST/Charla.dmg"
