#!/usr/bin/env bash
# E2E 驱动小工具：按「界面上看得见的字」点按钮，不靠猜坐标。
#   tap.sh 跳过            → 找到 content-desc/text 含「跳过」的节点，点它中心
#   shot.sh 02-home        → 截图到 qa-out/e2e/02-home.png
#   dump.sh                → 打印当前界面所有可点击节点的说明（找下一步点哪个）
set -u
ADB="${ADB:-/c/Users/HAOHAO/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/qa-out/e2e"
mkdir -p "$OUT"

ui_dump() {
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  "$ADB" shell cat /sdcard/ui.xml 2>/dev/null | tr '>' '\n'
}

case "${1:-}" in
  tap)
    label="${2:?要点的文字}"
    line="$(ui_dump | grep -F "$label" | head -1)"
    if [ -z "$line" ]; then echo "[tap] 找不到「$label」"; ui_dump | grep -o 'content-desc="[^"]*"\|text="[^"]*"' | sort -u | head -30; exit 1; fi
    # bounds="[x1,y1][x2,y2]" → 抠出 4 个数字（tr 不会把 ][ 变成逗号，所以直接抠数）
    b="$(printf '%s\n' "$line" | awk -F'bounds="' '{print $2}' | cut -d'"' -f1)"
    read -r x1 y1 x2 y2 <<< "$(printf '%s' "$b" | grep -o '[0-9][0-9]*' | tr '\n' ' ')"
    if [ -z "${y2:-}" ]; then echo "[tap] 「$label」 没有 bounds（b=[$b]）"; exit 1; fi
    cx=$(( (x1 + x2) / 2 )); cy=$(( (y1 + y2) / 2 ))
    echo "[tap] 「$label」 [$x1,$y1][$x2,$y2] → ($cx,$cy)"
    "$ADB" shell input tap "$cx" "$cy"
    ;;
  shot)
    name="${2:-shot}"
    "$ADB" exec-out screencap -p > "$OUT/$name.png"
    echo "[shot] $OUT/$name.png"
    ;;
  dump)
    ui_dump | grep -o 'content-desc="[^"]*"\|text="[^"]*"\|clickable="[^"]*"\|bounds="[^"]*"' | paste -d' ' - - - - 2>/dev/null | grep -v 'text="" content-desc=""' | head -40
    ;;
  *)
    echo "用法: tap.sh tap|shot|dump [参数]"; exit 1
    ;;
esac
