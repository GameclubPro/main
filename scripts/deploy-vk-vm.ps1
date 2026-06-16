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

$WorkDir = Join-Path $RootDir 'work\deploy'

function Write-Usage {
  Write-Host @"
VK VM deploy helper

Usage:
  .\deploy-vk-vm.cmd site       Build and deploy the static website from dist
  .\deploy-vk-vm.cmd downloads  Package Windows launcher and deploy dist/downloads
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

Before deploy:
  SSH must work with .\connect-vk-vm.cmd or .\vk-cloud.cmd ssh-test.
"@
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
    [Parameter(Mandatory = $true)][string]$Name
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

  & tar -czf $archivePath -C $SourceDir .
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
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-Tools

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $archivePath = New-Archive -SourceDir $SourceDir -Name "flexcraft-$Label-$stamp"
  $remoteArchive = "/tmp/$(Split-Path -Leaf $archivePath)"

  Invoke-Remote -Command "find /tmp -maxdepth 1 -type f -name 'flexcraft-*.tgz' -delete 2>/dev/null || true"

  Write-Host "Uploading $Label archive..."
  Copy-ToRemote -LocalPath $archivePath -RemotePath $remoteArchive

  $remoteDirQuoted = Quote-Sh -Value $RemoteDir
  $remoteArchiveQuoted = Quote-Sh -Value $remoteArchive
  $cleanCommand = 'true'
  if ($Label -eq 'site') {
    $cleanCommand = "rm -rf $remoteDirQuoted/assets $remoteDirQuoted/client-mods $remoteDirQuoted/downloads $remoteDirQuoted/index.html"
  } elseif ($Label -eq 'downloads') {
    $cleanCommand = "find $remoteDirQuoted -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true"
  }
  $remoteCommand = "set -e; mkdir -p $remoteDirQuoted; $cleanCommand; tar -xzf $remoteArchiveQuoted -C $remoteDirQuoted; rm -f $remoteArchiveQuoted; chown -R www-data:www-data $remoteDirQuoted 2>/dev/null || true; find $remoteDirQuoted -type d -exec chmod 755 {} +; find $remoteDirQuoted -type f -exec chmod 644 {} +; if command -v nginx >/dev/null 2>&1; then nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; fi"

  Write-Host "Extracting $Label on VM..."
  Invoke-Remote -Command $remoteCommand
  Write-Host "Deployed $Label to $RemoteDir"
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
    Deploy-Directory -SourceDir $distDir -RemoteDir $RemoteWebsitePath -Label 'site'
  }
  'downloads' {
    if (-not $SkipBuild) { Invoke-Npm -NpmArgs @('run', 'package:win') }
    Deploy-Directory -SourceDir $downloadsDir -RemoteDir $RemoteDownloadsPath -Label 'downloads'
  }
  'all' {
    if (-not $SkipBuild) { Invoke-Npm -NpmArgs @('run', 'package:win') }
    Deploy-Directory -SourceDir $distDir -RemoteDir $RemoteWebsitePath -Label 'site'
  }
  'existing' {
    Deploy-Directory -SourceDir $distDir -RemoteDir $RemoteWebsitePath -Label 'site'
  }
  default {
    Write-Error "Unknown command: $Command. Run .\deploy-vk-vm.cmd help"
  }
}
