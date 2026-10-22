# =====================================================
# TapScanner APP 一键发布脚本（默认完整发布流程）
# 用法（任意目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1                 # 自动 patch +1
#   powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1 -Version 0.2.0  # 指定版本
#   powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1 -LocalOnly      # 只出包不推远端
#   可选 -CommitMsg "feat: xxx" 自定义提交信息（默认 feat: 发布 vX.Y.Z）
#   可选 -EmulatorAbi  产物额外带 x86_64（给模拟器装；OpenCV 的 .so 会让包大 ~83MB）
# 前置：
#   - Node / Android SDK（gradlew + aapt + apksigner + zipalign）
#   - keystore.properties + keystore/ 存在（缺了会回 debug 签名，脚本直接拒绝发布）
#   - CHANGELOG.md 已包含目标版本条目（## [X.Y.Z]）
# 流程（断言全部打在**产物**上，不在配置上打日志）：
#   版本号同步 → CHANGELOG/原生源入库检查 → vitest+tsc+eslint+prettier → prebuild --clean
#   → gradlew assembleRelease → aapt 版本+显示名 → apksigner 拒 debug 签名
#   → OpenCV .so 与 ABI 断言 → zipalign 16KB 校验 → 复制 APK 到根目录 → git（有远端才推）→ Release
# =====================================================

param(
  [string]$Version = '',
  [string]$CommitMsg = '',
  [switch]$LocalOnly,
  [switch]$EmulatorAbi
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$AppName = '扫描一下'

function Fail([string]$msg) { Write-Host "[错误] $msg" -ForegroundColor Red; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # ---------- 0. 解析目标版本 ----------
  $appJson = Get-Content 'app.json' -Raw -Encoding UTF8 | ConvertFrom-Json
  $current = $appJson.expo.version
  if (-not $Version) {
    $parts = $current.Split('.')
    $parts[2] = [string]([int]$parts[2] + 1)
    $Version = $parts -join '.'
  }
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "版本号格式错误：$Version（应为 X.Y.Z）" }
  $vp = $Version.Split('.')
  $versionCode = [int]$vp[0] * 10000 + [int]$vp[1] * 100 + [int]$vp[2]
  if ([int]$vp[1] -ge 100 -or [int]$vp[2] -ge 100) { Fail "minor/patch 必须 < 100" }
  Write-Host "==> 发布 v$Version（当前 $current，versionCode $versionCode）" -ForegroundColor Cyan

  # ---------- 1. CHANGELOG 校验（说明来源，缺失则中止） ----------
  $changelogPath = Join-Path $root 'CHANGELOG.md'
  $changelogRaw = [System.IO.File]::ReadAllText($changelogPath, $utf8)
  if ($changelogRaw -notmatch ('## \[' + [regex]::Escape($Version) + '\]')) {
    Fail "CHANGELOG.md 缺少 [$Version] 条目，请先补充（## [版本] - 日期）再发布。"
  }

  # ---------- 1.5 原生源码必须入库（.gitignore 写错就是静默丢功能） ----------
  # 教训：`android/` 未锚定会把 native/android/ 一起忽略，prebuild --clean 后
  # 智能高清整体消失，而 git status 看起来干净得像没事发生。
  $nativeFiles = & git ls-files -- native/android
  if ($LASTEXITCODE -ne 0) { Fail "git ls-files 失败（仓库还没 init？先 git init 再发布）。" }
  $nativeCount = @($nativeFiles | Where-Object { $_ }).Count
  if ($nativeCount -lt 7) {
    Fail "native/android 只有 $nativeCount 个文件入库（应 ≥7）。检查 .gitignore 是否写成了未锚定的 android/。"
  }
  Write-Host "==> 原生源码入库：$nativeCount 个文件" -ForegroundColor Gray

  # ---------- 2. 版本号同步 ----------
  Write-Host "==> 同步版本号：app.json / package.json / package-lock.json" -ForegroundColor Cyan
  & node (Join-Path $PSScriptRoot 'sync-version.js') $Version
  if ($LASTEXITCODE -ne 0) { Fail "版本号同步失败。" }

  Write-Host "==> 同步 README 版本行" -ForegroundColor Cyan
  $readmePath = Join-Path $root 'README.md'
  $readmeRaw = [System.IO.File]::ReadAllText($readmePath, $utf8)
  $readmeRaw = $readmeRaw -replace '当前版本：[\d.]+', "当前版本：$Version"
  [System.IO.File]::WriteAllText($readmePath, $readmeRaw, $utf8)

  # ---------- 3. 单测 + 类型检查 + Lint ----------
  Write-Host "==> vitest + tsc + eslint + prettier" -ForegroundColor Cyan
  & npx vitest run
  if ($LASTEXITCODE -ne 0) { Fail "单测未通过。" }
  & npx tsc --noEmit
  if ($LASTEXITCODE -ne 0) { Fail "类型检查未通过。" }
  & npx eslint .
  if ($LASTEXITCODE -ne 0) { Fail "ESLint 未通过。" }
  & npx prettier --check "src/**/*.{ts,tsx}" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Prettier 格式检查未通过（先跑 npm run format）。" }

  # ---------- 4. prebuild（一律 --clean，杜绝 android/ 与 app.json 漂移） ----------
  if (-not (Test-Path (Join-Path $root 'keystore.properties'))) { Fail "缺少 keystore.properties，禁止发布。" }
  $env:TAPSCANNER_REQUIRE_RELEASE_SIGNING = '1'
  if ($EmulatorAbi) { $env:TAPSCANNER_EMULATOR_ABI = '1' } else { Remove-Item Env:\TAPSCANNER_EMULATOR_ABI -ErrorAction SilentlyContinue }
  Write-Host "==> npx expo prebuild --platform android --no-install --clean" -ForegroundColor Cyan
  # ---- 为什么这段这么长（v0.1.3 连撞三次 EBUSY 换来的）----
  # prebuild --clean 要 unlink 整个 android/，而 Gradle 守护进程一直握着
  # app/build/intermediates/dex/.../classes.dex 的句柄：文件能以写方式打开（所以「看起来没锁」），
  # 但只要有句柄存在就删不掉 → Expo 抛 EBUSY。而且失败时 android/ 已被删了一半，
  # 连 gradlew.bat 都没了 —— 所以「先跑 gradlew --stop」这条最直觉的路本身就不可靠。
  # 结论：按进程特征停 daemon（只认 GradleDaemon，不碰 Kotlin 编译守护进程和 IDE），
  #      自己带重试地删 android/，删不掉时**报出第一个被占用的文件**而不是静默失败。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  if (Test-Path (Join-Path $root 'android\gradlew.bat')) {
    Push-Location (Join-Path $root 'android')
    try { & .\gradlew.bat --stop *> $null } finally { Pop-Location }
  }
  Start-Sleep -Seconds 2
  $daemons = Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
             Where-Object { $_.CommandLine -match 'GradleDaemon' }
  foreach ($d in $daemons) {
    Write-Host "==> 停掉 Gradle 守护进程 PID $($d.ProcessId)" -ForegroundColor Gray
    Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($daemons) { Start-Sleep -Seconds 2 }
  $ErrorActionPreference = $prevEap

  $androidDir = Join-Path $root 'android'
  if (Test-Path $androidDir) {
    $removed = $false
    $lastError = ''
    for ($i = 1; $i -le 8; $i++) {
      $ErrorActionPreference = 'Continue'
      Remove-Item $androidDir -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable rmErr
      $ErrorActionPreference = $prevEap
      if (-not (Test-Path $androidDir)) { $removed = $true; break }
      $lastError = if ($rmErr) { "$($rmErr[0].Exception.Message)" } else { $lastError }
      Write-Host "==> android/ 仍被占用，5 秒后重试（$i/8）" -ForegroundColor Yellow
      Start-Sleep -Seconds 5
    }
    if (-not $removed) {
      # 报出真正被占用的文件，别让下一次排查再从「EBUSY」三个字猜起
      Write-Host "[诊断] 最后一次错误：$lastError" -ForegroundColor Yellow
      $blocked = @()
      $ErrorActionPreference = 'Continue'
      Get-ChildItem $androidDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          $fs = [System.IO.File]::Open($_.FullName, 'Open', 'ReadWrite', 'None')
          $fs.Close()
        } catch { $blocked += $_.FullName }
      }
      $ErrorActionPreference = $prevEap
      if ($blocked.Count -gt 0) {
        Write-Host "[诊断] 被占用文件（前 5 个）：" -ForegroundColor Yellow
        $blocked | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
      }
      Fail "android/ 删不掉。上面列出了被占用的文件；若仍有 Gradle 进程残留，任务管理器结束 java.exe 后重试。"
    }
    Write-Host "==> 已删除 android/（prebuild 将全新重建）" -ForegroundColor Gray
  }
  & npx expo prebuild --platform android --no-install --clean
  if ($LASTEXITCODE -ne 0) { Fail "prebuild 失败。" }

  # 注入自检：三段签名片段 + OpenCV 依赖 + ABI，缺一就在构建前停住
  $gradlePath = Join-Path $root 'android\app\build.gradle'
  if (-not (Test-Path $gradlePath)) { Fail "prebuild 后仍没有 android\app\build.gradle。" }
  $g = [System.IO.File]::ReadAllText($gradlePath, $utf8)
  foreach ($needle in @(
      'tapscannerKeystorePropsFile = rootProject',
      'storeFile file(tapscannerKeystoreProps',
      'signingConfig tapscannerKeystorePropsFile.exists() ? signingConfigs.release : signingConfigs.debug',
      'org.opencv:opencv')) {
    if ($g -notlike "*$needle*") { Fail "android/app/build.gradle 缺少注入片段：$needle" }
  }
  $gp = [System.IO.File]::ReadAllText((Join-Path $root 'android\gradle.properties'), $utf8)
  $wantAbis = if ($EmulatorAbi) { 'arm64-v8a,x86_64' } else { 'arm64-v8a' }
  if ($gp -notmatch "reactNativeArchitectures=$([regex]::Escape($wantAbis))") {
    Fail "gradle.properties 的 reactNativeArchitectures 不是 $wantAbis（ABI 没限制住 = 包白变大几十 MB）"
  }

  # ---------- 5. 本地构建 release APK ----------
  Write-Host "==> gradlew assembleRelease" -ForegroundColor Cyan
  Push-Location (Join-Path $root 'android')
  try { & .\gradlew.bat assembleRelease --console=plain }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail "APK 构建失败。" }

  $apkPath = Join-Path $root 'android\app\build\outputs\apk\release\app-release.apk'
  if (-not (Test-Path $apkPath)) { Fail "未找到构建产物：$apkPath" }

  # ---------- 6. aapt 校验 versionName / versionCode / 显示名 ----------
  # 注意编码：aapt 把资源里的中文按 UTF-8 原样写到 stdout，而 PowerShell 5.1 默认用
  # 控制台代码页(GBK)解码，中文会被切坏 —— 直接比较会得到「显示名不对」的**假失败**
  # （v0.1.1 就断在这里）。所以让 aapt 输出落盘，再按 UTF-8 读回来比。
  $buildTools = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools" -Directory |
                Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $buildTools) { Fail "未找到 Android SDK build-tools。" }
  $aapt = Join-Path $buildTools 'aapt.exe'
  $aaptOut = Join-Path $env:TEMP "tapscanner-aapt-$Version.txt"
  & cmd.exe /c "`"$aapt`" dump badging `"$apkPath`" > `"$aaptOut`"" 2>&1 | Out-Null
  if (-not (Test-Path $aaptOut)) { Fail "aapt 没有输出，无法校验产物。" }
  $badgingText = [System.IO.File]::ReadAllText($aaptOut, $utf8)
  Remove-Item $aaptOut -ErrorAction SilentlyContinue
  $pkgLine = ($badgingText -split "`r?`n" | Where-Object { $_ -match '^package:' } | Select-Object -First 1)
  Write-Host "aapt: $pkgLine" -ForegroundColor Gray
  if ($pkgLine -notlike "*versionName='$Version'*") { Fail "versionName 校验失败（期望 $Version）" }
  if ($pkgLine -notlike "*versionCode='$versionCode'*") { Fail "versionCode 校验失败（期望 $versionCode）" }
  # Expo 56 的模板资源在所有 Config Plugin 之后写，桌面名字只能信产物不能信配置
  $labelLine = ($badgingText -split "`r?`n" | Where-Object { $_ -match "^application-label:'" } | Select-Object -First 1)
  if ($null -eq $labelLine -or -not $labelLine.Contains("'$AppName'")) {
    Fail "桌面显示名不是「$AppName」（实际：$labelLine）。检查 app.json 的 android.applicationName。"
  }

  # ---------- 7. OpenCV 与 ABI 断言（在产物里数文件，不看构建日志） ----------
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
  try {
    $libNames = @($zip.Entries | Where-Object { $_.FullName -like 'lib/*' } | ForEach-Object { $_.FullName })
    $opencvArm64 = @($libNames | Where-Object { $_ -eq 'lib/arm64-v8a/libopencv_java4.so' }).Count
    if ($opencvArm64 -ne 1) { Fail "APK 里没有 lib/arm64-v8a/libopencv_java4.so —— OpenCV 没进包，智能高清必然失败" }
    $extraAbis = @($libNames | ForEach-Object { ($_ -split '/')[1] } | Sort-Object -Unique |
                   Where-Object { $wantAbis -notlike "*$_*" })
    if ($extraAbis.Count -gt 0) { Fail "APK 混进了多余 ABI：$($extraAbis -join ', ')（包会白大几十 MB）" }
    $barcode = @($libNames | Where-Object { $_ -like '*barcode*' -or $_ -like '*mlkit*' })
    if ($barcode.Count -gt 0) { Fail "APK 里出现了不需要的扫码原生库：$($barcode -join ', ')" }
  } finally { $zip.Dispose() }

  # ---------- 8. apksigner 校验签名者（禁止 debug 签名的 release 包） ----------
  $apksigner = Join-Path $buildTools 'apksigner.bat'
  $certOut = & $apksigner verify --print-certs $apkPath 2>&1 | Out-String
  Write-Host "签名: $(($certOut -split "`n" | Where-Object { $_ -match 'certificate DN' }) -join ' ')" -ForegroundColor Gray
  if ($certOut -match 'CN=Android Debug') {
    Fail "APK 使用 debug keystore 签名，禁止发布！请确认 keystore.properties 与 keystore/ 后重新 prebuild。"
  }

  # ---------- 9. zipalign 16KB 页对齐（Android 15+ 16KB 设备装不上未对齐的包） ----------
  $zipalign = Join-Path $buildTools 'zipalign.exe'
  if (Test-Path $zipalign) {
    & $zipalign -c -P 16 -v 4 $apkPath | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "zipalign 16KB 页对齐校验未通过（OpenCV 的 .so 对齐是新变量，必须实测）。" }
    Write-Host "==> zipalign 16KB 对齐通过" -ForegroundColor Gray
  } else {
    Write-Host "!! 未找到 zipalign.exe，跳过 16KB 对齐校验" -ForegroundColor Yellow
  }

  # ---------- 10. 复制 APK 到根目录（交付约定：<项目名>-v<版本>.apk） ----------
  $apkDest = Join-Path $root "TapScanner-v$Version.apk"
  Copy-Item $apkPath $apkDest -Force
  $mb = [math]::Round((Get-Item $apkDest).Length / 1MB, 1)
  Write-Host "==> APK 就绪：TapScanner-v$Version.apk（$mb MB）" -ForegroundColor Green

  # ---------- 11. git 提交（有远端才推；没远端就本地留着） ----------
  Write-Host "==> git 提交" -ForegroundColor Cyan
  $stagePaths = @('app.json', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md',
                  'AGENTS.md', 'src', 'App.tsx', 'index.ts', 'plugins', 'scripts', 'native', 'tools', 'assets')
  & git add -- $stagePaths
  if ($LASTEXITCODE -ne 0) { Fail "git add 失败（注意 android/ 必须在 .gitignore 里且根锚定）。" }
  & git status --short
  if (-not $CommitMsg) { $CommitMsg = "feat: 发布 v$Version" }
  & git commit -m $CommitMsg
  if ($LASTEXITCODE -ne 0) { Fail "git commit 失败（可能无可提交改动）。" }

  $remotes = & git remote 2>$null
  if ($LocalOnly -or -not $remotes) {
    Write-Host ""
    Write-Host "本地发布完成：v$Version（没有配远端或指定了 -LocalOnly，未推送、未建 Release）" -ForegroundColor Green
    Write-Host "  APK：TapScanner-v$Version.apk（项目根目录）" -ForegroundColor Cyan
    Write-Host "  要推 GitHub：git remote add origin https://github.com/sctale/TapScanner.git 后重跑本脚本" -ForegroundColor Cyan
    exit 0
  }
  & git push
  if ($LASTEXITCODE -ne 0) { Fail "git push 失败。" }

  # ---------- 12. GitHub Release + 上传 APK ----------
  Write-Host "==> gh release create v$Version" -ForegroundColor Cyan
  $pattern = '(?s)## \[' + [regex]::Escape($Version) + '\] - [^\r\n]*\r?\n(.*?)(?=\r?\n## \[|$)'
  $m = [regex]::Match($changelogRaw, $pattern)
  $notes = if ($m.Success) { $m.Groups[1].Value.Trim() } else { "详见 CHANGELOG.md" }
  $notesFile = Join-Path ([System.IO.Path]::GetTempPath()) "tapscanner-release-notes-$Version.md"
  [System.IO.File]::WriteAllText($notesFile, $notes, $utf8)
  try {
    & gh release create "v$Version" --repo sctale/TapScanner --title "v$Version" --target main --notes-file $notesFile $apkDest
    if ($LASTEXITCODE -ne 0) { Fail "GitHub Release 创建失败。" }
  } finally {
    Remove-Item $notesFile -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "发布完成：v$Version" -ForegroundColor Green
  Write-Host "  Release: https://github.com/sctale/TapScanner/releases/tag/v$Version" -ForegroundColor Cyan
}
finally {
  Pop-Location
}
