#!/usr/bin/env bash
# 端到端：装包 → 相册导入真实样张 → 审核页截图 → 右转 90° 再截图 → 把成品拉回本地。
#
# 为什么值得有这么一个脚本：自动裁切的「算法对不对」在 JVM 验证台上已经能测，
# 但「App 有没有真的把框用上」只有跑在机器上、点一遍界面才知道。
# 之前每次都是手点，改一轮就要重点八下，点错一步整轮作废。
#
# 用法：bash tools/e2e/run.sh [apk 路径]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ADB="${ADB:-/c/Users/HAOHAO/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
PKG=com.tapscanner.app
APK="${1:-$ROOT/android/app/build/outputs/apk/release/app-release.apk}"
OUT="$ROOT/qa-out/e2e"
TAP="$HERE/tap.sh"
mkdir -p "$OUT"

ui() { "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; "$ADB" shell cat /sdcard/ui.xml | tr '>' '\n'; }
tap() {
  local line center
  line="$(ui | grep -F "$1" | head -1)"
  if [ -z "$line" ]; then echo "[e2e] 找不到「$1」"; return 1; fi
  local b="$(printf '%s\n' "$line" | awk -F'bounds="' '{print $2}' | cut -d'"' -f1)"
  read -r x1 y1 x2 y2 <<< "$(printf '%s' "$b" | grep -o '[0-9][0-9]*' | tr '\n' ' ')"
  echo "[e2e] 点「$1」($(( (x1+x2)/2 )),$(( (y1+y2)/2 )))"
  "$ADB" shell input tap "$(( (x1+x2)/2 ))" "$(( (y1+y2)/2 ))"
}
shot() { "$ADB" exec-out screencap -p > "$OUT/$1.png"; echo "[e2e] 截图 $OUT/$1.png"; }

echo "[e2e] 安装 $APK"
# adb 是 Windows 程序，只吃 C:\ 那种路径（MSYS 的 /d/... 它会当成相对路径找不到）
APK_WIN="$(cygpath -w "$APK")"
"$ADB" install -r -g "$APK_WIN" 2>&1 | tail -1
[ "${PIPESTATUS[0]}" = "0" ] || { echo "[e2e] 装包失败，后面点了也是旧包"; exit 1; }
"$ADB" shell pm grant $PKG android.permission.CAMERA
"$ADB" shell pm grant $PKG android.permission.READ_MEDIA_IMAGES
# 样张必须在媒体库里（相册导入走的是系统 PhotoPicker）。每次无条件重推：
# 模拟器重启后 MediaStore 有时会丢索引，条件判断反而让脚本静默点空
"$ADB" push "$(cygpath -w "$ROOT/samples/20261024_093429.jpg")" /sdcard/DCIM/Camera/tap-sample.jpg >/dev/null 2>&1
"$ADB" shell "content call --uri content://media/external/file --method scan_file --arg /sdcard/DCIM/Camera/tap-sample.jpg" >/dev/null 2>&1
sleep 2
"$ADB" shell am force-stop $PKG
"$ADB" shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 6
ui | grep -q "跳过" && tap "跳过"
sleep 2
tap "从相册导入"; sleep 4
tap "Photo taken on"; sleep 2
tap "Done"; sleep 12
tap "查看已拍的" || true
sleep 2
shot 10-review
# 展开「调整」面板 → 先截一张证明左转/右转按钮真的在界面上，再点右转看成品
tap "调整"; sleep 2
shot 11-panel
# 旋正按钮在顶栏（v0.2.4 从「调整」面板里挪出来的：面板要滚动才看得见）
if ui | grep -q "向右旋转 90 度"; then
  tap "↻"; sleep 12
  shot 12-rotated
else
  echo "[e2e] 顶栏找不到「向右旋转 90 度」——旋正按钮没渲染出来"
fi

DOC="$("$ADB" shell "ls -d /data/user/0/$PKG/files/scans/*/ | head -1" | tr -d '\r')"
if [ -n "$DOC" ]; then
  PAGE="$("$ADB" shell "ls $DOC/page_*.jpg | head -1" | tr -d '\r')"
  "$ADB" pull "$PAGE" "$OUT/12-app-page.jpg" >/dev/null 2>&1 && echo "[e2e] 成品拉回 $OUT/12-app-page.jpg"
fi
echo "[e2e] 完成"
