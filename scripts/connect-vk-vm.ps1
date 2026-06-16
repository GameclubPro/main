[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'

$HostName = '146.185.210.83'
$UserName = 'root'
$DefaultKeyPath = Join-Path $HOME '.ssh\flexcraft_site_deploy_ed25519_nopass'

function Write-Usage {
  Write-Host @"
VK VM connection helper

Usage:
  .\connect-vk-vm.cmd                 Open SSH shell
  .\connect-vk-vm.cmd shell           Open SSH shell
  .\connect-vk-vm.cmd minecraft       Open /opt/minecraft
  .\connect-vk-vm.cmd website         Open /var/www/flexcraft
  .\connect-vk-vm.cmd downloads       Open /var/www/flexcraft/downloads
  .\connect-vk-vm.cmd status          Show minecraft.service status
  .\connect-vk-vm.cmd logs            Follow minecraft.service logs
  .\connect-vk-vm.cmd cmd <command>   Run a custom remote command
  .\connect-vk-vm.cmd help            Show this help

Environment:
  VK_VM_KEY_PATH can override the default SSH key path.

Default:
  Host: $UserName@$HostName
  Key:  $DefaultKeyPath
"@
}

function Resolve-KeyPath {
  $candidate = if ($env:VK_VM_KEY_PATH) { $env:VK_VM_KEY_PATH } else { $DefaultKeyPath }
  $expanded = [Environment]::ExpandEnvironmentVariables($candidate)

  if ($expanded.StartsWith('~')) {
    $expanded = Join-Path $HOME $expanded.Substring(1).TrimStart('\', '/')
  }

  return $expanded
}

function Test-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Ssh {
  param(
    [Parameter(Mandatory = $true)][string]$KeyPath,
    [string]$RemoteCommand
  )

  $sshArgs = @(
    '-i', $KeyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    "$UserName@$HostName"
  )

  if ($RemoteCommand) {
    $sshArgs = @('-t') + $sshArgs + @($RemoteCommand)
  }

  & ssh @sshArgs
  exit $LASTEXITCODE
}

$Mode = if ($Args.Count -gt 0) { $Args[0].ToLowerInvariant() } else { 'shell' }
$Rest = if ($Args.Count -gt 1) { $Args[1..($Args.Count - 1)] } else { @() }

switch ($Mode) {
  'help' {
    Write-Usage
    exit 0
  }
  '-h' {
    Write-Usage
    exit 0
  }
  '--help' {
    Write-Usage
    exit 0
  }
}

if (-not (Test-CommandExists 'ssh')) {
  Write-Error 'OpenSSH client was not found. Install Windows OpenSSH Client or Git for Windows.'
}

$KeyPath = Resolve-KeyPath
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
  Write-Host 'SSH key was not found.'
  Write-Host "Expected key: $KeyPath"
  Write-Host ''
  Write-Host 'Put the private key there, or set VK_VM_KEY_PATH to another key file.'
  Write-Host 'Example:'
  Write-Host '  set VK_VM_KEY_PATH=C:\path\to\key'
  exit 2
}

switch ($Mode) {
  'shell' {
    Invoke-Ssh -KeyPath $KeyPath
  }
  'minecraft' {
    Invoke-Ssh -KeyPath $KeyPath -RemoteCommand 'cd /opt/minecraft && exec bash -l'
  }
  'website' {
    Invoke-Ssh -KeyPath $KeyPath -RemoteCommand 'cd /var/www/flexcraft && exec bash -l'
  }
  'downloads' {
    Invoke-Ssh -KeyPath $KeyPath -RemoteCommand 'cd /var/www/flexcraft/downloads && exec bash -l'
  }
  'status' {
    Invoke-Ssh -KeyPath $KeyPath -RemoteCommand 'systemctl status minecraft.service'
  }
  'logs' {
    Invoke-Ssh -KeyPath $KeyPath -RemoteCommand 'journalctl -u minecraft.service -f'
  }
  'cmd' {
    if ($Rest.Count -eq 0) {
      Write-Error 'Missing remote command after "cmd".'
    }

    Invoke-Ssh -KeyPath $KeyPath -RemoteCommand ($Rest -join ' ')
  }
  default {
    Write-Error "Unknown mode: $Mode. Run .\connect-vk-vm.cmd help"
  }
}
