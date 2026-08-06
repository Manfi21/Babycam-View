#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Load secrets from .env (gitignored). Not required, but recommended:
#   KEYSTORE_PASSWORD=...
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

# Usage: build_release.sh [TAG]
#   TAG   optional git tag used for artifact naming
#
# Builds on this Linux:
#   - Android APK via Kotlin-WebView app (android/, Gradle assembleRelease)
#   - Linux AppImage via electron-builder (npm run dist)
# Windows: must be built on a Windows machine:
#   npx electron-builder --win nsis

VERSION=""
if [ $# -gt 0 ]; then
    NEW_TAG="$1"
    MSG="${2:-Release $NEW_TAG}"
    echo "Creating new Git tag: $NEW_TAG"
    git tag -a "$NEW_TAG" -m "$MSG"
    VERSION="$NEW_TAG"
    shift
fi

if [ -z "$VERSION" ]; then
    VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "no-tag")
fi

DATE_STR=$(date +%Y_%m_%d)
BASE_NAME="${DATE_STR}_BabyCam-View_${VERSION}"
echo $BASE_NAME

BUILD_DIR="$(pwd)/build_release"

KEYSTORE_DIR="$HOME/.keystores"
KEYSTORE="$KEYSTORE_DIR/babycam-view.keystore"
KEY_ALIAS="babycam"
KEYSTORE_PROPERTIES="android/keystore.properties"

if [ -z "${KEYSTORE_PASSWORD:-}" ]; then
    echo "ERROR: KEYSTORE_PASSWORD is not set. Add it to .env (gitignored) or export it." >&2
    exit 1
fi

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

mkdir -p "$BUILD_DIR"

log() { printf '\n\033[1;34m[build_release]\033[0m %s\n' "$*"; }

check_android_config() {
  if [ ! -f "$KEYSTORE_PROPERTIES" ]; then
    echo "ERROR: $KEYSTORE_PROPERTIES is missing." >&2
    exit 1
  fi
  if ! grep -q "signingConfigs" android/app/build.gradle.kts; then
    echo "ERROR: Signing configuration missing in android/app/build.gradle.kts." >&2
    exit 1
  fi
}

ensure_keystore() {
  mkdir -p "$KEYSTORE_DIR"
  if [ ! -f "$KEYSTORE" ]; then
    log "Generating keystore $KEYSTORE ..."
    keytool -genkey -v \
      -keystore "$KEYSTORE" \
      -alias "$KEY_ALIAS" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
      -dname "CN=BabyCam View, OU=BabyCam, O=BabyCam, L=Home, ST=Home, C=DE"
    chmod 600 "$KEYSTORE"
  fi
}

write_keystore_properties() {
  cat > "$KEYSTORE_PROPERTIES" <<EOF
storeFile=$KEYSTORE
storePassword=$KEYSTORE_PASSWORD
keyAlias=$KEY_ALIAS
keyPassword=$KEYSTORE_PASSWORD
EOF
  if [ ! -f "android/local.properties" ]; then
    echo "sdk.dir=$ANDROID_HOME" > android/local.properties
  fi
}

# versionCode is incremented by 1 on every NEW valid tag build.
ANDROID_VERSION_FILE="android/version.properties"

is_valid_tag() {
  [[ "$1" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

read_version_state() {
  last_name=""
  last_code="0"
  if [ -f "$ANDROID_VERSION_FILE" ]; then
    last_name="$(sed -n 's/^lastVersionName=//p' "$ANDROID_VERSION_FILE" | head -1)"
    last_code="$(sed -n 's/^lastVersionCode=//p' "$ANDROID_VERSION_FILE" | head -1)"
  fi
}

build_android() {
  log "Building Android APK (Gradle assembleRelease) ..."
  local version_name=""
  local version_code=""
  if is_valid_tag "$VERSION"; then
    version_name="${VERSION#v}"
    read_version_state
    if [ "$version_name" != "$last_name" ]; then
      version_code=$(( last_code + 1 ))
      printf 'lastVersionName=%s\nlastVersionCode=%s\n' "$version_name" "$version_code" > "$ANDROID_VERSION_FILE"
      log "New tag $VERSION -> versionName=$version_name, versionCode=$version_code"
    else
      version_code="$last_code"
      log "Tag $VERSION already built -> versionName=$version_name, versionCode=$version_code (no bump)"
    fi
  else
    log "No valid SemVer tag ('$VERSION') -> Gradle defaults (0.2.0 / 2)"
  fi

  local gradle_args=()
  if [ -n "$version_name" ]; then
    gradle_args=(-PversionName="$version_name" -PversionCode="$version_code")
  fi
  (cd android && ./gradlew assembleRelease --console=plain "${gradle_args[@]}")
  apk="android/app/build/outputs/apk/release/app-release.apk"
  if [ ! -f "$apk" ]; then
    echo "ERROR: $apk not found." >&2
    exit 1
  fi
  dest="$BUILD_DIR/${BASE_NAME}_android.apk"
  cp "$apk" "$dest"
  log "APK -> $dest"
}

build_linux_appimage() {
  if is_valid_tag "$VERSION"; then
    local pkg_version="${VERSION#v}"
    log "Setting package.json version to $pkg_version"
    node -e '
      const fs = require("fs");
      const p = "package.json";
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.version = process.argv[1];
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    ' "$pkg_version"
  fi
  log "Building Linux AppImage (electron-builder) ..."
  npx electron-builder --linux AppImage
  appimage="$(ls dist/*.AppImage 2>/dev/null | head -1 || true)"
  if [ -z "$appimage" ]; then
    echo "ERROR: No AppImage found in dist/." >&2
    exit 1
  fi
  dest="$BUILD_DIR/${BASE_NAME}_x86_64.AppImage"
  cp "$appimage" "$dest"
  chmod +x "$dest"
  log "AppImage -> $dest"
}

build_windows() {
  if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != CYGWIN* && "$(uname -s)" != MSYS* ]]; then
    log "Skipping Windows build (Windows installers must be built on a Windows machine):"
    log "  npx electron-builder --win nsis"
    return
  fi
  log "Building Windows NSIS ..."
  npx electron-builder --win nsis
  dest="$BUILD_DIR/${BASE_NAME}_x64.exe"
  cp "$(ls dist/*.exe 2>/dev/null | head -1)" "$dest"
  log "Installer -> $dest"
}

ensure_keystore
write_keystore_properties
check_android_config
build_android
build_linux_appimage
build_windows

log "Done. Artifacts in $BUILD_DIR:"
ls -lh "$BUILD_DIR"
