[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command = 'help',

  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$HostName = $env:VK_VM_HOST
if (-not $HostName) { $HostName = '146.185.210.83' }

$UserName = $env:VK_VM_USER
if (-not $UserName) { $UserName = 'root' }

$KeyPath = $env:VK_VM_KEY_PATH
if (-not $KeyPath) { $KeyPath = Join-Path $HOME '.ssh\flexcraft_site_deploy_ed25519_nopass' }

$RemoteWebsitePath = $env:VK_VM_WEBSITE_PATH
if (-not $RemoteWebsitePath) { $RemoteWebsitePath = '/var/www/flexcraft' }

$RemoteDownloadsPath = $env:VK_VM_DOWNLOADS_PATH
if (-not $RemoteDownloadsPath) { $RemoteDownloadsPath = '/var/www/flexcraft/downloads' }

$RemoteApiPath = $env:VK_VM_API_PATH
if (-not $RemoteApiPath) { $RemoteApiPath = '/opt/flexcraft-auth' }

$WorkDir = Join-Path $RootDir 'work\deploy'

function Write-Usage {
  Write-Host @"
VK VM deploy helper

Usage:
  .\deploy-vk-vm.cmd site       Build and deploy the static website from dist
  .\deploy-vk-vm.cmd downloads  Package Windows launcher and deploy dist/downloads
  .\deploy-vk-vm.cmd api        Deploy the FlexCraft auth API service
  .\deploy-vk-vm.cmd all        Package launcher, deploy website and downloads
  .\deploy-vk-vm.cmd existing   Deploy the current dist folder without rebuilding
  .\deploy-vk-vm.cmd check      Test SSH access and remote deploy directories
  .\deploy-vk-vm.cmd help       Show this help

Options:
  -SkipBuild                    Reuse existing local build outputs

Environment:
  VK_VM_HOST                    Default: $HostName
  VK_VM_USER                    Default: $UserName
  VK_VM_KEY_PATH                Default: $KeyPath
  VK_VM_WEBSITE_PATH            Default: $RemoteWebsitePath
  VK_VM_DOWNLOADS_PATH          Default: $RemoteDownloadsPath
  VK_VM_API_PATH                Default: $RemoteApiPath

Before deploy:
  SSH must work with .\connect-vk-vm.cmd or .\vk-cloud.cmd ssh-test.
"@
}

function Deploy-Api {
  Assert-Tools

  $sourceDir = Join-Path $RootDir 'server'
  if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "API source directory was not found: $sourceDir"
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $archivePath = New-Archive -SourceDir $sourceDir -Name "flexcraft-api-$stamp"
  $remoteArchive = "/tmp/$(Split-Path -Leaf $archivePath)"

  Invoke-Remote -Command "find /tmp -maxdepth 1 -type f -name 'flexcraft-*.tgz' -delete 2>/dev/null || true"
  Write-Host 'Uploading api archive...'
  Copy-ToRemote -LocalPath $archivePath -RemotePath $remoteArchive

  $remoteApiPathQuoted = Quote-Sh -Value $RemoteApiPath
  $remoteArchiveQuoted = Quote-Sh -Value $remoteArchive
  $secretBytes = New-Object byte[] 48
  $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $randomGenerator.GetBytes($secretBytes)
  } finally {
    $randomGenerator.Dispose()
  }
  $authCookieSecret = [Convert]::ToBase64String($secretBytes)
  $remoteCommand = @"
set -e
mkdir -p $remoteApiPathQuoted
find $remoteApiPathQuoted -mindepth 1 -maxdepth 1 -not -name data -exec rm -rf -- {} + 2>/dev/null || true
tar -xzf $remoteArchiveQuoted -C $remoteApiPathQuoted
rm -f $remoteArchiveQuoted
cd $remoteApiPathQuoted
if command -v npm >/dev/null 2>&1; then npm install --omit=dev; else echo 'npm is required for FlexCraft auth API' >&2; exit 1; fi
mkdir -p /var/lib/flexcraft-auth
chmod 700 /var/lib/flexcraft-auth
if [ ! -f /etc/flexcraft-auth.env ]; then
  cat >/etc/flexcraft-auth.env <<EOF
NODE_ENV=production
PORT=3088
HOST=127.0.0.1
PUBLIC_ORIGIN=https://flex-craft.ru
AUTH_DATA_DIR=/var/lib/flexcraft-auth
AUTH_COOKIE_SECRET=$authCookieSecret
AUTH_SESSION_COOKIE=flexcraft_session
VK_CLIENT_ID=
VK_CLIENT_SECRET=
VK_REDIRECT_URI=https://flex-craft.ru/api/auth/vk/callback
VK_OAUTH_BASE_URL=https://id.vk.ru
VK_SCOPE=vkid.personal_info
TELEGRAM_CLIENT_ID=
TELEGRAM_CLIENT_SECRET=
TELEGRAM_REDIRECT_URI=https://flex-craft.ru/api/auth/telegram/callback
TELEGRAM_OIDC_ISSUER=https://oauth.telegram.org
TELEGRAM_SCOPE=openid profile
GAME_API_TOKEN=
EOF
  chmod 600 /etc/flexcraft-auth.env
fi
grep -q '^VK_CLIENT_ID=' /etc/flexcraft-auth.env || echo 'VK_CLIENT_ID=' >>/etc/flexcraft-auth.env
grep -q '^VK_CLIENT_SECRET=' /etc/flexcraft-auth.env || echo 'VK_CLIENT_SECRET=' >>/etc/flexcraft-auth.env
grep -q '^VK_REDIRECT_URI=' /etc/flexcraft-auth.env || echo 'VK_REDIRECT_URI=https://flex-craft.ru/api/auth/vk/callback' >>/etc/flexcraft-auth.env
grep -q '^VK_OAUTH_BASE_URL=' /etc/flexcraft-auth.env || echo 'VK_OAUTH_BASE_URL=https://id.vk.ru' >>/etc/flexcraft-auth.env
grep -q '^VK_SCOPE=' /etc/flexcraft-auth.env || echo 'VK_SCOPE=vkid.personal_info' >>/etc/flexcraft-auth.env
grep -q '^TELEGRAM_CLIENT_ID=' /etc/flexcraft-auth.env || echo 'TELEGRAM_CLIENT_ID=' >>/etc/flexcraft-auth.env
grep -q '^TELEGRAM_CLIENT_SECRET=' /etc/flexcraft-auth.env || echo 'TELEGRAM_CLIENT_SECRET=' >>/etc/flexcraft-auth.env
grep -q '^TELEGRAM_REDIRECT_URI=' /etc/flexcraft-auth.env || echo 'TELEGRAM_REDIRECT_URI=https://flex-craft.ru/api/auth/telegram/callback' >>/etc/flexcraft-auth.env
grep -q '^TELEGRAM_OIDC_ISSUER=' /etc/flexcraft-auth.env || echo 'TELEGRAM_OIDC_ISSUER=https://oauth.telegram.org' >>/etc/flexcraft-auth.env
grep -q '^TELEGRAM_SCOPE=' /etc/flexcraft-auth.env || echo 'TELEGRAM_SCOPE=openid profile' >>/etc/flexcraft-auth.env
grep -q '^GAME_API_TOKEN=' /etc/flexcraft-auth.env || echo 'GAME_API_TOKEN=' >>/etc/flexcraft-auth.env
cat >/etc/systemd/system/flexcraft-auth.service <<'EOF'
[Unit]
Description=FlexCraft Auth API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/flexcraft-auth
EnvironmentFile=/etc/flexcraft-auth.env
ExecStart=/usr/bin/node $RemoteApiPath/src/server.js
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
python3 - <<'PY'
from pathlib import Path
path = Path('/etc/nginx/sites-enabled/flexcraft')
text = path.read_text()
api_block = '''location /api/ {
    proxy_pass http://127.0.0.1:3088/api/;
    proxy_http_version 1.1;
    proxy_set_header Host `$host;
    proxy_set_header X-Real-IP `$remote_addr;
    proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto `$scheme;
  }'''
if 'proxy_pass http://127.0.0.1:3088/api/' not in text:
    text = text.replace('location /api/ {\n    return 501;\n  }', api_block)
path.write_text(text)
PY
systemctl daemon-reload
systemctl enable flexcraft-auth >/dev/null
systemctl restart flexcraft-auth
if command -v nginx >/dev/null 2>&1; then nginx -t && systemctl reload nginx; fi
systemctl --no-pager --full status flexcraft-auth | sed -n '1,18p'
"@

  Write-Host 'Installing api on VM...'
  Invoke-Remote -Command $remoteCommand
  Write-Host "Deployed api to $RemoteApiPath"
}

function Resolve-LocalPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if ($expanded.StartsWith('~')) {
    $expanded = Join-Path $HOME $expanded.Substring(1).TrimStart('\', '/')
  }

  return $expanded
}

function Test-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Tools {
  foreach ($tool in @('ssh', 'scp', 'tar')) {
    if (-not (Test-CommandExists $tool)) {
      throw "$tool was not found. Install Windows OpenSSH Client and make sure tar.exe is available."
    }
  }
}

function Get-SshArgs {
  $resolvedKeyPath = Resolve-LocalPath -Path $KeyPath
  if (-not (Test-Path -LiteralPath $resolvedKeyPath -PathType Leaf)) {
    throw "Private key was not found: $resolvedKeyPath"
  }

  return @(
    '-i', $resolvedKeyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new'
  )
}

function Invoke-Remote {
  param([Parameter(Mandatory = $true)][string]$Command)

  $sshArgs = Get-SshArgs
  & ssh @sshArgs "$UserName@$HostName" $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Remote command failed with exit code $LASTEXITCODE"
  }
}

function Copy-ToRemote {
  param(
    [Parameter(Mandatory = $true)][string]$LocalPath,
    [Parameter(Mandatory = $true)][string]$RemotePath
  )

  $sshArgs = Get-SshArgs
  & scp @sshArgs $LocalPath "$UserName@$HostName`:$RemotePath"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed with exit code $LASTEXITCODE"
  }
}

function New-LocalWorkSubdir {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
    New-Item -ItemType Directory -Path $WorkDir | Out-Null
  }

  $workFull = [System.IO.Path]::GetFullPath($WorkDir)
  $target = Join-Path $WorkDir $Name
  $targetFull = [System.IO.Path]::GetFullPath($target)
  if (-not $targetFull.StartsWith($workFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use work path outside deploy workdir: $targetFull"
  }

  if (Test-Path -LiteralPath $targetFull) {
    Remove-Item -LiteralPath $targetFull -Recurse -Force
  }
  New-Item -ItemType Directory -Path $targetFull | Out-Null
  return $targetFull
}

function Split-FileToChunks {
  param(
    [Parameter(Mandatory = $true)][string]$LocalPath,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [int]$ChunkSizeMb = 12
  )

  $chunkSize = $ChunkSizeMb * 1024 * 1024
  $buffer = New-Object byte[] (1024 * 1024)
  $inputStream = [System.IO.File]::OpenRead($LocalPath)
  $chunks = New-Object System.Collections.Generic.List[string]
  try {
    $index = 0
    while ($inputStream.Position -lt $inputStream.Length) {
      $chunkPath = Join-Path $OutputDir ('part-{0:D5}' -f $index)
      $outputStream = [System.IO.File]::Create($chunkPath)
      try {
        $remaining = $chunkSize
        while ($remaining -gt 0 -and $inputStream.Position -lt $inputStream.Length) {
          $readSize = [Math]::Min($buffer.Length, $remaining)
          $read = $inputStream.Read($buffer, 0, $readSize)
          if ($read -le 0) { break }
          $outputStream.Write($buffer, 0, $read)
          $remaining -= $read
        }
      } finally {
        $outputStream.Dispose()
      }
      $chunks.Add($chunkPath)
      $index += 1
    }
  } finally {
    $inputStream.Dispose()
  }

  return $chunks.ToArray()
}

function Copy-ToRemoteChunked {
  param(
    [Parameter(Mandatory = $true)][string]$LocalPath,
    [Parameter(Mandatory = $true)][string]$RemoteFinalPath
  )

  Assert-Tools

  $localFull = [System.IO.Path]::GetFullPath($LocalPath)
  if (-not (Test-Path -LiteralPath $localFull -PathType Leaf)) {
    throw "Local file was not found: $localFull"
  }

  $fileName = Split-Path -Leaf $localFull
  $safeName = $fileName -replace '[^A-Za-z0-9_.-]', '-'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $chunkDir = New-LocalWorkSubdir -Name "chunks-$stamp-$safeName"
  $remoteChunkDir = "/tmp/flexcraft-download-chunks-$stamp-$safeName"
  $remoteTempPath = "$RemoteFinalPath.upload-$stamp"
  $expectedSha1 = (Get-FileHash -Algorithm SHA1 -LiteralPath $localFull).Hash.ToLowerInvariant()

  try {
    $chunks = Split-FileToChunks -LocalPath $localFull -OutputDir $chunkDir
    $remoteChunkDirQuoted = Quote-Sh -Value $remoteChunkDir
    Invoke-Remote -Command "set -e; rm -rf $remoteChunkDirQuoted; mkdir -p $remoteChunkDirQuoted"

    foreach ($chunk in $chunks) {
      $chunkName = Split-Path -Leaf $chunk
      Copy-ToRemote -LocalPath $chunk -RemotePath "$remoteChunkDir/$chunkName"
    }

    $remoteTempQuoted = Quote-Sh -Value $remoteTempPath
    $remoteFinalQuoted = Quote-Sh -Value $RemoteFinalPath
    Invoke-Remote -Command "set -e; cat $remoteChunkDirQuoted/part-* > $remoteTempQuoted; actual=`$(sha1sum $remoteTempQuoted | awk '{print `$1}'); test `"`$actual`" = `"$expectedSha1`"; mv -f $remoteTempQuoted $remoteFinalQuoted; chown www-data:www-data $remoteFinalQuoted 2>/dev/null || true; chmod 644 $remoteFinalQuoted; rm -rf $remoteChunkDirQuoted"
  } finally {
    if (Test-Path -LiteralPath $chunkDir) {
      Remove-Item -LiteralPath $chunkDir -Recurse -Force
    }
  }
}

function Invoke-Npm {
  param([Parameter(Mandatory = $true)][string[]]$NpmArgs)

  Push-Location $RootDir
  try {
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) {
      throw "npm $($NpmArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function New-Archive {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$Name,
    [string[]]$Exclude = @()
  )

  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    throw "Source directory was not found: $SourceDir"
  }

  if (-not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
    New-Item -ItemType Directory -Path $WorkDir | Out-Null
  }

  $archivePath = Join-Path $WorkDir "$Name.tgz"
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }

  $tarArgs = @('-czf', $archivePath)
  foreach ($entry in $Exclude) {
    $tarArgs += @('--exclude', $entry)
  }
  $tarArgs += @('-C', $SourceDir, '.')

  & tar @tarArgs
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
  }

  return $archivePath
}

function Quote-Sh {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Deploy-Directory {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$RemoteDir,
    [Parameter(Mandatory = $true)][string]$Label,
    [string[]]$Exclude = @()
  )

  Assert-Tools

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $archivePath = New-Archive -SourceDir $SourceDir -Name "flexcraft-$Label-$stamp" -Exclude $Exclude
  $remoteArchive = "/tmp/$(Split-Path -Leaf $archivePath)"

  Invoke-Remote -Command "find /tmp -maxdepth 1 -type f -name 'flexcraft-*.tgz' -delete 2>/dev/null || true"

  Write-Host "Uploading $Label archive..."
  Copy-ToRemote -LocalPath $archivePath -RemotePath $remoteArchive

  $remoteDirQuoted = Quote-Sh -Value $RemoteDir
  $remoteArchiveQuoted = Quote-Sh -Value $remoteArchive
  $cleanCommand = 'true'
  if ($Label -eq 'site') {
    $cleanCommand = "rm -rf $remoteDirQuoted/assets $remoteDirQuoted/client-mods $remoteDirQuoted/index.html"
  } elseif ($Label -eq 'downloads') {
    $cleanCommand = "find $remoteDirQuoted -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true"
  }
  $remoteCommand = "set -e; mkdir -p $remoteDirQuoted; $cleanCommand; tar -xzf $remoteArchiveQuoted -C $remoteDirQuoted; rm -f $remoteArchiveQuoted; chown -R www-data:www-data $remoteDirQuoted 2>/dev/null || true; find $remoteDirQuoted -type d -exec chmod 755 {} +; find $remoteDirQuoted -type f -exec chmod 644 {} +; if command -v nginx >/dev/null 2>&1; then nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; fi"

  Write-Host "Extracting $Label on VM..."
  Invoke-Remote -Command $remoteCommand
  Write-Host "Deployed $Label to $RemoteDir"
}

function Deploy-Downloads {
  Assert-Tools

  if (-not (Test-Path -LiteralPath $downloadsDir -PathType Container)) {
    throw "Downloads directory was not found: $downloadsDir"
  }

  $files = @(
    'FlexCraft-Launcher-latest-win-x64.exe',
    'FlexCraft-Launcher-latest-win-x64.zip',
    'FlexCraft-Launcher-latest-portable-win-x64.exe',
    'latest.json'
  )

  foreach ($file in $files) {
    $localPath = Join-Path $downloadsDir $file
    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
      throw "Download artifact was not found: $localPath"
    }
  }

  $remoteDownloadsPathQuoted = Quote-Sh -Value $RemoteDownloadsPath
  Invoke-Remote -Command "set -e; mkdir -p $remoteDownloadsPathQuoted; chown www-data:www-data $remoteDownloadsPathQuoted 2>/dev/null || true; chmod 755 $remoteDownloadsPathQuoted"

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($file in $files) {
    $localPath = Join-Path $downloadsDir $file
    $remoteTemp = "$RemoteDownloadsPath/.upload-$stamp-$file"
    $remoteFinal = "$RemoteDownloadsPath/$file"

    Write-Host "Uploading $file..."
    if ((Get-Item -LiteralPath $localPath).Length -gt 32MB) {
      Copy-ToRemoteChunked -LocalPath $localPath -RemoteFinalPath $remoteFinal
    } else {
      Copy-ToRemote -LocalPath $localPath -RemotePath $remoteTemp

      $remoteTempQuoted = Quote-Sh -Value $remoteTemp
      $remoteFinalQuoted = Quote-Sh -Value $remoteFinal
      Invoke-Remote -Command "set -e; mv -f $remoteTempQuoted $remoteFinalQuoted; chown www-data:www-data $remoteFinalQuoted 2>/dev/null || true; chmod 644 $remoteFinalQuoted"
    }
  }

  Invoke-Remote -Command "if command -v nginx >/dev/null 2>&1; then nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; fi"
  Write-Host "Deployed downloads to $RemoteDownloadsPath"
}

function Test-DeployAccess {
  Assert-Tools
  Invoke-Remote -Command "set -e; whoami; mkdir -p $(Quote-Sh -Value $RemoteWebsitePath) $(Quote-Sh -Value $RemoteDownloadsPath); test -w $(Quote-Sh -Value $RemoteWebsitePath); test -w $(Quote-Sh -Value $RemoteDownloadsPath)"
}

$commandName = $Command.ToLowerInvariant()
$distDir = Join-Path $RootDir 'dist'
$downloadsDir = Join-Path $distDir 'downloads'

switch ($commandName) {
  'help' { Write-Usage }
  '-h' { Write-Usage }
  '--help' { Write-Usage }
  'check' {
    Test-DeployAccess
    Write-Host 'Deploy SSH access is ready.'
  }
  'site' {
    if (-not $SkipBuild) { Invoke-Npm -NpmArgs @('run', 'build') }
    Deploy-Directory -SourceDir $distDir -RemoteDir $RemoteWebsitePath -Label 'site' -Exclude @('./downloads', './downloads/*')
  }
  'downloads' {
    if (-not $SkipBuild) { Invoke-Npm -NpmArgs @('run', 'package:win') }
    Deploy-Downloads
  }
  'api' {
    Deploy-Api
  }
  'all' {
    if (-not $SkipBuild) { Invoke-Npm -NpmArgs @('run', 'package:win') }
    Deploy-Api
    Deploy-Directory -SourceDir $distDir -RemoteDir $RemoteWebsitePath -Label 'site' -Exclude @('./downloads', './downloads/*')
    Deploy-Downloads
  }
  'existing' {
    Deploy-Directory -SourceDir $distDir -RemoteDir $RemoteWebsitePath -Label 'site' -Exclude @('./downloads', './downloads/*')
  }
  default {
    Write-Error "Unknown command: $Command. Run .\deploy-vk-vm.cmd help"
  }
}
