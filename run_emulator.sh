#!/usr/bin/env bash
set -euo pipefail

# Installs and launches BabyCam View on an Android device.
# Uses a USB-connected device if one is attached, otherwise starts/uses
# the emulator. Waits for boot, installs the newest APK from build_release/
# and launches the BabyCam View app.
#
# Usage: run_emulator.sh [AVD] [options]
#   AVD              AVD name (default: Medium_Phone_API_36.1)
#   --device SERIAL  use a specific device (adb serial, USB or emulator)
#   --headless       run the emulator without a window (CI / no display)
#   --wipe-data      wipe the emulator user data when starting it
#   --apk PATH       install a specific APK instead of the newest one
#   --screenshot     capture a screenshot to build_release/emulator_screen.png
#   -h, --help       show this help

cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
EMU="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"
LOG="build_release/emulator.log"

AVD="Medium_Phone_API_36.1"
MODE="windowed"
APK_PATH=""
SCREENSHOT=0
DEVICE_SERIAL=""
WIPE=0

usage() {
    sed -n '3,14p' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --headless) MODE="headless"; shift ;;
        --wipe-data) WIPE=1; shift ;;
        --apk) APK_PATH="${2:?--apk requires a path}"; shift 2 ;;
        --device) DEVICE_SERIAL="${2:?--device requires a serial}"; shift 2 ;;
        --screenshot) SCREENSHOT=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) AVD="$1"; shift ;;
    esac
done

log() { printf '\n\033[1;34m[emulator]\033[0m %s\n' "$*"; }

if [ ! -x "$ADB" ]; then
    echo "ERROR: adb not found: $ADB" >&2
    exit 1
fi

USB_DEVICES="$("$ADB" devices 2>/dev/null | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/{print $1}')"

TARGET=""
if [ -n "$DEVICE_SERIAL" ]; then
    if ! "$ADB" devices 2>/dev/null | awk '$2=="device"{print $1}' | grep -qx "$DEVICE_SERIAL"; then
        echo "ERROR: device '$DEVICE_SERIAL' not found (online)." >&2
        "$ADB" devices >&2
        exit 1
    fi
    TARGET="$DEVICE_SERIAL"
    log "Using device: $TARGET"
elif [ -n "$USB_DEVICES" ]; then
    count="$(printf '%s\n' "$USB_DEVICES" | wc -l)"
    if [ "$count" -gt 1 ]; then
        echo "ERROR: Multiple USB devices connected. Pick one with --device SERIAL:" >&2
        printf '%s\n' "$USB_DEVICES" >&2
        exit 1
    fi
    TARGET="$USB_DEVICES"
    log "Using USB device: $TARGET"
fi

if [ -z "$TARGET" ]; then
    if [ ! -x "$EMU" ]; then
        echo "ERROR: emulator not found: $EMU" >&2
        exit 1
    fi
    if ! "$EMU" -list-avds 2>/dev/null | grep -qx "$AVD"; then
        echo "ERROR: AVD '$AVD' not available. Available AVDs:" >&2
        "$EMU" -list-avds >&2
        exit 1
    fi
fi

if [ -z "$APK_PATH" ]; then
    APK_PATH="$(ls -t build_release/*_android.apk build_release/*.apk 2>/dev/null | head -1 || true)"
    if [ -z "$APK_PATH" ]; then
        echo "ERROR: No APK found in build_release/." >&2
        echo "Build one with: ./build_release.sh" >&2
        exit 1
    fi
fi

if [ ! -f "$APK_PATH" ]; then
    echo "ERROR: APK not found: $APK_PATH" >&2
    exit 1
fi

mkdir -p build_release

if [ -z "$TARGET" ]; then
    EXISTING="$("$ADB" devices 2>/dev/null | awk '/emulator-[0-9]+[[:space:]]+device/{print $1; exit}')"

    if [ -n "$EXISTING" ]; then
        log "Running emulator found: $EXISTING"
        TARGET="$EXISTING"
    else
        log "Starting emulator '$AVD' ($MODE) ..."
        EMU_ARGS=(-avd "$AVD" -no-boot-anim -no-snapshot-save -no-audio)
        [ "$MODE" = "headless" ] && EMU_ARGS+=(-no-window)
        [ "$WIPE" = "1" ] && EMU_ARGS+=(-wipe-data)
        nohup "$EMU" "${EMU_ARGS[@]}" > "$LOG" 2>&1 &
        echo "  PID: $! | Log: $LOG"
    fi
fi

if [ -z "$TARGET" ]; then
    echo "ERROR: No target device (USB or emulator) available." >&2
    exit 1
fi

ADB_TARGET() { "$ADB" -s "$TARGET" "$@"; }

log "Waiting for device '$TARGET' ..."
"$ADB" -s "$TARGET" wait-for-device

booted=0
for i in $(seq 1 36); do
    boot="$(ADB_TARGET shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    if [ "$boot" = "1" ]; then
        booted=1
        break
    fi
    sleep 5
done
if [ "$booted" = "0" ]; then
    echo "ERROR: Boot timeout (180s). See $LOG" >&2
    exit 1
fi
log "Device booted"

ADB_TARGET shell wm dismiss-keyguard >/dev/null 2>&1 || true

log "Installing $APK_PATH ..."
if ! ADB_TARGET install -r "$APK_PATH"; then
    echo "  Install failed, cleaning package state and retrying ..."
    sleep 3
    ADB_TARGET uninstall com.oelpingu.babcamview >/dev/null 2>&1 || true
    ADB_TARGET install -r "$APK_PATH"
fi

log "Starting BabyCam View ..."
ADB_TARGET shell am start -n com.oelpingu.babcamview/.MainActivity

if [ "$SCREENSHOT" = "1" ]; then
    sleep 4
    ADB_TARGET exec-out screencap -p > build_release/emulator_screen.png
    log "Screenshot: build_release/emulator_screen.png"
fi

log "Done."
