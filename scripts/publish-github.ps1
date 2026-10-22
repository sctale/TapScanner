# =====================================================
# TapScanner 开源发布：建远端仓库 + 推送 + 发 Release
#
# 与 release-app.ps1 的分工：那个脚本负责「构建 + 产物断言 + 提交」，
# 这个脚本只负责「把已经断言过的东西推到 GitHub」。两者都能单独跑，
# 因为网络/登录态出问题的时候，需要能只重跑远端这一步而不是重新构建 7 分钟。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\publish-github.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\publish-github.ps1 -Version 0.1.2
#   powershell -ExecutionPolicy Bypass -File scripts\publish-github.ps1 -DryRun
# 前置：
#   - gh auth login 已完成（token 失效会明确提示，不会静默失败）
#   - 本机到 github.com 的 HTTPS 可用
#   - 根目录已有 TapScanner-v<版本>.apk（由 release-app.ps1 产出）
# =====================================================

param(
  [string]$Version = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$Repo = 'sctale/TapScanner'
$Description = '极简文档扫描 · 智能高清（自动切边 + 光照摊平 + 无损 PDF 导出）。React Native + Expo + Kotlin/OpenCV。'

function Fail([string]$msg) { Write-Host "[错误] $msg" -ForegroundColor Red; exit 1 }
function Note([string]$msg) { Write-Host $msg -ForegroundColor Cyan }

# PowerShell 5.1 的坑：$ErrorActionPreference='Stop' 时，原生命令只要往 stderr 写一行
# 就会被当成终止错误抛出（NativeCommandError）。而「探测某物是否存在」的命令
# （gh repo view / gh release view / gh api）恰恰是靠 stderr 报「不存在」的。
# 所以探测一律走这个包装：临时降到 Continue，只看退出码。
function Test-GhExit([scriptblock]$block) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $block *> $null
    return ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $prev
  }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # ---------- 0. gh 在哪、登录没有 ----------
  $gh = (Get-Command gh.exe -ErrorAction SilentlyContinue)
  if (-not $gh) {
    $candidate = 'C:\Program Files\GitHub CLI\gh.exe'
    if (Test-Path $candidate) { $gh = $candidate } else { Fail "未找到 GitHub CLI（gh.exe）。" }
  } else { $gh = $gh.Source }

  $who = ''
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $whoRaw = & $gh api user --jq .login 2>$null
  $whoOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prevEap
  if (-not $whoOk -or -not "$whoRaw") {
    Fail @"
gh 没有有效登录（常见原因：keyring 里的 token 已失效，或本机到 github.com 的 HTTPS 不通）。
先执行：  & "$gh" auth login --hostname github.com --git-protocol https --web
网络排查：curl -sS https://api.github.com/zen  （TLS 被掐断时会报 SSL_ERROR_SYSCALL）
"@
  }
  $who = "$whoRaw".Trim()
  Note "==> 已登录 GitHub：$who"

  # ---------- 1. 目标版本与产物 ----------
  if (-not $Version) {
    $appJson = Get-Content 'app.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = $appJson.expo.version
  }
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "版本号格式错误：$Version" }
  $apk = Join-Path $root "TapScanner-v$Version.apk"
  if (-not (Test-Path $apk)) {
    Fail "缺少产物 $apk —— 先跑 scripts\release-app.ps1 -LocalOnly -Version $Version 出包。"
  }
  Note "==> 发布 v$Version（APK $([math]::Round((Get-Item $apk).Length / 1MB, 1)) MB）"

  # ---------- 2. 仓库（不存在就建，公开） ----------
  $repoExists = Test-GhExit { & $gh repo view $Repo }
  if ($repoExists) {
    Note "==> 仓库已存在：https://github.com/$Repo"
  } else {
    if ($DryRun) { Note "[DryRun] 将创建公开仓库 $Repo"; }
    else {
      & $gh repo create $Repo --public --description $Description
      if ($LASTEXITCODE -ne 0) { Fail "创建仓库失败。" }
      Note "==> 已创建公开仓库 https://github.com/$Repo"
    }
  }

  # ---------- 3. remote + 推送 ----------
  $remoteUrl = "https://github.com/$Repo.git"
  $prevEap2 = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $current = & git remote get-url origin 2>$null
  $hasRemote = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prevEap2
  if (-not $hasRemote -or -not "$current") {
    if ($DryRun) { Note "[DryRun] 将 git remote add origin $remoteUrl" }
    else {
      & git remote add origin $remoteUrl
      if ($LASTEXITCODE -ne 0) { Fail "git remote add 失败。" }
      Note "==> 已添加 origin"
    }
  } elseif ($current -ne $remoteUrl) {
    Fail "origin 指向 $current，和期望的 $remoteUrl 不一致 —— 先人工确认再推，别自动改。"
  }

  $branch = (git rev-parse --abbrev-ref HEAD)
  if ($branch -ne 'main') { Fail "当前分支是 $branch，发布要求 main。" }

  if ($DryRun) {
    Note "[DryRun] 将执行 git push -u origin main 与 gh release create v$Version"
  } else {
    Note "==> git push -u origin main"
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) { Fail "git push 失败（凭据或网络；gh 已登录时通常重试即可）。" }

    # ---------- 4. Release（说明取自 CHANGELOG 对应小节） ----------
    $releaseExists = Test-GhExit { & $gh release view "v$Version" --repo $Repo }
    if ($releaseExists) {
      Note "==> Release v$Version 已存在，只覆盖上传 APK"
      & $gh release upload "v$Version" $apk --repo $Repo --clobber
      if ($LASTEXITCODE -ne 0) { Fail "上传 APK 失败。" }
    } else {
      $changelogRaw = [System.IO.File]::ReadAllText((Join-Path $root 'CHANGELOG.md'), $utf8)
      $pattern = '(?s)## \[' + [regex]::Escape($Version) + '\] - [^\r\n]*\r?\n(.*?)(?=\r?\n## \[|$)'
      $m = [regex]::Match($changelogRaw, $pattern)
      if (-not $m.Success) { Fail "CHANGELOG.md 里没有 [$Version] 小节，Release 说明会是空的。" }
      $notesFile = Join-Path $env:TEMP "tapscanner-release-notes-$Version.md"
      [System.IO.File]::WriteAllText($notesFile, $m.Groups[1].Value.Trim(), $utf8)
      try {
        # 必须 --notes-file：--notes 传含 emoji/方括号的内容会被 PowerShell 当通配符
        & $gh release create "v$Version" --repo $Repo --title "v$Version" --target main --notes-file $notesFile $apk
        if ($LASTEXITCODE -ne 0) { Fail "创建 Release 失败。" }
      } finally {
        Remove-Item $notesFile -ErrorAction SilentlyContinue
      }
    }
  }

  Note ""
  Note "发布完成：https://github.com/$Repo/releases/tag/v$Version"
} finally {
  Pop-Location
}
