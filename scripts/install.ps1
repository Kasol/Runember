param(
  [string]$Version = 'v2.2.0-beta.5',
  [string]$InstallDir,
  [switch]$Start,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:OS -ne 'Windows_NT') { throw '请在 macOS 上使用 install.sh。' }
if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw '无效的发布版本号' }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw '当前 Windows 发布包仅支持 x64。' }
$arch = 'x64'
$folder = 'runember-' + $Version.Substring(1) + '-windows-' + $arch
if (!$InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA ('Runember\runtime\' + $folder) }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$entry = Join-Path $InstallDir 'runember.cmd'
if (Test-Path -LiteralPath $InstallDir) {
  if (!(Test-Path -LiteralPath (Join-Path $InstallDir 'runtime.json'))) { throw '目标目录已存在且不是 Runember 运行时；请选择新目录。' }
  $installed = Get-Content -LiteralPath (Join-Path $InstallDir 'runtime.json') -Raw | ConvertFrom-Json
  if ($installed.product -ne 'Runember' -or $installed.version -ne $Version.Substring(1) -or $installed.arch -ne $arch -or $installed.platform -ne 'win32') { throw '目标目录已有其他版本，保留原目录并选择新的安装位置。' }
} else {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $work = Join-Path $tempRoot ('runember-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $asset = $folder + '.zip'
    $url = 'https://github.com/Kasol/Runember/releases/download/' + $Version + '/' + $asset
    $archive = Join-Path $work $asset
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    Invoke-WebRequest -Uri ($url + '.sha256') -OutFile ($archive + '.sha256') -UseBasicParsing
    $expected = ((Get-Content -LiteralPath ($archive + '.sha256') -Raw).Trim() -split '\s+')[0]
    if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) { throw 'SHA256_CHECK_FAILED: 安装包校验失败，未执行安装。' }
    $extract = Join-Path $work 'extract'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
      foreach ($item in $zip.Entries) {
        $candidate = [IO.Path]::GetFullPath((Join-Path $extract $item.FullName))
        if (!$candidate.StartsWith($extract + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装包包含无效路径。' }
      }
    } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    $source = [IO.Path]::GetFullPath((Join-Path $extract $folder))
    if (!$source.StartsWith($extract + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装包目录无效。' }
    $manifest = Get-Content -LiteralPath (Join-Path $source 'runtime.json') -Raw | ConvertFrom-Json
    if ($manifest.product -ne 'Runember' -or $manifest.version -ne $Version.Substring(1) -or $manifest.platform -ne 'win32' -or $manifest.arch -ne $arch) { throw '安装包版本或架构不匹配。' }
    $parent = Split-Path -Parent $InstallDir
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (Test-Path -LiteralPath $InstallDir) { throw '目标目录在安装期间发生变化，已停止。' }
    Move-Item -LiteralPath $source -Destination $InstallDir
  } finally {
    $resolvedWork = [IO.Path]::GetFullPath($work)
    if ($resolvedWork.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedWork) -match '^runember-install-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
if (!(Test-Path -LiteralPath $entry)) { throw '安装目录缺少启动命令。' }
$previousConsoleEncoding = [Console]::OutputEncoding
$previousAppDir = $env:AGENTDESK_APP_DIR
function Invoke-InstalledCli([string]$Arguments) {
  $outputFile = Join-Path ([IO.Path]::GetTempPath()) ('runember-cli-' + [guid]::NewGuid().ToString('N'))
  $errorFile = $outputFile + '.stderr'
  try {
    $cli = Start-Process -FilePath (Join-Path $InstallDir 'node.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'desk.mjs') + '" ' + $Arguments) -WorkingDirectory $InstallDir -WindowStyle Hidden -RedirectStandardOutput $outputFile -RedirectStandardError $errorFile -PassThru
    if (!$cli.WaitForExit(60000)) { $cli.Kill(); throw 'CLI_TIMEOUT: 命令执行超时。' }
    $text = [IO.File]::ReadAllText($outputFile, [Text.Encoding]::UTF8)
    $errors = [IO.File]::ReadAllText($errorFile, [Text.Encoding]::UTF8)
    if ($errors) { [Console]::Error.WriteLine($errors) }
    return [pscustomobject]@{ Text = $text; Code = $cli.ExitCode }
  } finally {
    Remove-Item -LiteralPath $outputFile, $errorFile -Force -ErrorAction SilentlyContinue
  }
}
try {
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:AGENTDESK_APP_DIR = $InstallDir
$diagnosis = Invoke-InstalledCli 'doctor --json'
$diagnosticCode = $diagnosis.Code
$report = $diagnosis.Text | ConvertFrom-Json
if ($Start) {
  # A separate hidden console keeps a detached daemon from inheriting the caller's output pipes.
  $started = Start-Process -FilePath (Join-Path $InstallDir 'node.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'desk.mjs') + '" start --no-browser') -WorkingDirectory $InstallDir -WindowStyle Hidden -Verb Open -PassThru
  if (!$started.WaitForExit(60000)) { $started.Kill(); throw 'CLI_TIMEOUT: 后台启动命令超时。' }
  if ($started.ExitCode -ne 0) { throw '安装已完成，但后台服务启动失败，请运行 doctor --json。' }
}
$result = [ordered]@{ status = $(if ($diagnosticCode -eq 0) { 'installed' } else { 'needs_setup' }); version = $Version; installDir = $InstallDir; command = $entry; started = $Start.IsPresent; diagnostics = $report }
if ($Json) { $result | ConvertTo-Json -Depth 14 }
else { 'Runember 已安装：' + $InstallDir; '使用命令：' + $entry; '依赖或登录未完成时，请按诊断建议处理。' }
if ($diagnosticCode -ne 0) { exit 2 }
} finally {
  [Console]::OutputEncoding = $previousConsoleEncoding
  $env:AGENTDESK_APP_DIR = $previousAppDir
}
