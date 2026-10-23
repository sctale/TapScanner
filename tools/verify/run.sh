#!/usr/bin/env bash
# 在 JVM 上验证文档边界检测（无需 Android SDK / 真机）
# 用法：bash tools/verify/run.sh
#
# 跑的是 native/android 里**要打包进 APK 的同一份源码**（QuadDetect.kt / Metrics.kt），
# 不是另写一份原型 —— 否则「验证通过」不代表真机通过。
# 之所以能脱离 Android 运行：这些文件只 import org.opencv.* / java.io / kotlin 标准库，没有 android.*。
#
# 桌面绑定用 org.openpnp:opencv（jar 里自带 windows/linux 的 so/dll，loadLocally 解到临时目录）。
# 版本与设备端 AAR（4.13.0）差一个小版本：用到的 API 完全一致（已逐个 javap 比对），
# 差异只在优化上，所以 IoU 结论跨版本成立；最终仍以真机 release 包为准。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# kotlinc.bat / java.exe 是 Windows 程序：MSYS 形式的 /d/... 路径和 : 分隔的 classpath
# 会把它们直接搞崩（Illegal char <:>），所以凡是要交给 Windows 侧的参数都先转成 C:\... 与 ;。
WIN_ENV=0
SEP=":"
if command -v cygpath >/dev/null 2>&1; then
  WIN_ENV=1
  SEP=";"
fi
win() {
  if [ "$WIN_ENV" = 1 ]; then
    cygpath -w "$1"
  else
    echo "$1"
  fi
}

OPENCV_JAR="$ROOT/tools/verify/lib/opencv-desktop.jar"
if [ ! -f "$OPENCV_JAR" ]; then
  cat >&2 <<EOF
缺少桌面版 OpenCV：$OPENCV_JAR
离线补一次（约 110MB，之后不再需要网络）：
  curl -L -o "$OPENCV_JAR" \\
    https://repo1.maven.org/maven2/org/openpnp/opencv/4.9.0-0/opencv-4.9.0-0.jar
EOF
  exit 1
fi

find_kotlinc() {
  if command -v kotlinc >/dev/null 2>&1; then
    command -v kotlinc
    return 0
  fi

  if [ -n "${KOTLIN_HOME:-}" ] && [ -x "${KOTLIN_HOME}/bin/kotlinc" ]; then
    echo "${KOTLIN_HOME}/bin/kotlinc"
    return 0
  fi

  local candidates=(
    "/c/Program Files/Android/Android Studio/plugins/Kotlin/kotlinc/bin/kotlinc"
    "${LOCALAPPDATA:-}/Programs/Android/Android Studio/plugins/Kotlin/kotlinc/bin/kotlinc"
    "${LOCALAPPDATA:-}/Android/Android Studio/plugins/Kotlin/kotlinc/bin/kotlinc"
    "/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc"
    "$HOME/android-studio/plugins/Kotlin/kotlinc/bin/kotlinc"
    "/opt/android-studio/plugins/Kotlin/kotlinc/bin/kotlinc"
  )

  local c
  for c in "${candidates[@]}"; do
    if [ -n "$c" ] && [ -f "$c" ]; then
      echo "$c"
      return 0
    fi
  done

  return 1
}

if ! KOTLINC="$(find_kotlinc)"; then
  cat >&2 <<'EOF'
未找到 kotlinc。可选任一方式：
  1) 安装 Kotlin 命令行工具并加入 PATH：https://kotlinlang.org/docs/command-line.html
  2) 设置 KOTLIN_HOME 指向 Kotlin 发行版目录
  3) 安装 Android Studio（其 plugins/Kotlin/kotlinc 会被自动发现）
EOF
  exit 1
fi

KOTLIN_LIB="$(dirname "$KOTLINC")/../lib"
KOTLIN_STDLIB="$KOTLIN_LIB/kotlin-stdlib.jar"
if [ ! -f "$KOTLIN_STDLIB" ]; then
  echo "找不到 kotlin-stdlib.jar（应在 $KOTLIN_STDLIB）" >&2
  exit 1
fi

# 验证台只需要 OpenCV；顺手把整条 CV 链路（错误码 + 增强管线）一起类型检查，很便宜
SOURCES=(
  "$ROOT/native/android/Metrics.kt"
  "$ROOT/native/android/ScanErrors.kt"
  "$ROOT/native/android/QuadDetect.kt"
  "$ROOT/native/android/DocPipeline.kt"
  "$ROOT/tools/verify/QuadDetectVerify.kt"
)
CP_COMPILE=("$OPENCV_JAR")
SDK="${ANDROID_HOME:-${LOCALAPPDATA:-}/Android/Sdk}"
ANDROID_JAR=""
for api in 36 35 34; do
  if [ -f "$SDK/platforms/android-$api/android.jar" ]; then
    ANDROID_JAR="$SDK/platforms/android-$api/android.jar"
    break
  fi
done
if [ -n "$ANDROID_JAR" ]; then
  CP_COMPILE+=("$ANDROID_JAR")
  SOURCES+=("$ROOT/native/android/ExifOrientation.kt")
else
  echo "提示：没找到 android.jar，跳过 ExifOrientation 的类型检查"
fi
# ScannerModule.kt / ScannerPackage.kt 依赖 React Native 的 Java 类，这里编不动 ——
# 它们由 scripts/release-app.ps1 的 :app:compileReleaseKotlin 负责，别指望这个脚本全覆盖。

echo "使用 kotlinc: $KOTLINC"

# kotlinc 的报错走 System.err，默认按控制台代码页（GBK）编码 —— Git Bash 是 UTF-8，中文会成乱码。
# 编译器读源码恒为 UTF-8，所以这只是显示问题；统一指定编码后报错里的中文才能直接读。
export JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8"

CP_COMPILE_WIN=""
for p in "${CP_COMPILE[@]}"; do
  if [ -z "$CP_COMPILE_WIN" ]; then
    CP_COMPILE_WIN="$(win "$p")"
  else
    CP_COMPILE_WIN="$CP_COMPILE_WIN$SEP$(win "$p")"
  fi
done

SOURCES_WIN=()
for s in "${SOURCES[@]}"; do
  SOURCES_WIN+=("$(win "$s")")
done

"$KOTLINC" -nowarn -classpath "$CP_COMPILE_WIN" \
  -d "$(win "$OUT/classes")" \
  "${SOURCES_WIN[@]}"

CP_RUN="$(win "$OUT/classes")$SEP$(win "$OPENCV_JAR")$SEP$(win "$KOTLIN_STDLIB")"

# Windows 控制台默认不是 UTF-8，不显式指定编码时中文输出会变乱码
# -D 参数交给 Windows 侧也要整体加引号，否则 MSYS 会把 "-Dfile.encoding=..." 里的 / 改写掉
java "-Dfile.encoding=UTF-8" "-Dstdout.encoding=UTF-8" -cp "$CP_RUN" \
  com.tapscanner.verify.QuadDetectVerifyKt
