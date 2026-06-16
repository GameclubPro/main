[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command = 'help',

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$AuthUrl = $env:OS_AUTH_URL
if (-not $AuthUrl) { $AuthUrl = 'https://infra.mail.ru:35357/v3/' }

$ProjectId = $env:OS_PROJECT_ID
if (-not $ProjectId) { $ProjectId = '00f80ce2c7e6403288920e0231986bb2' }

$RegionName = $env:OS_REGION_NAME
if (-not $RegionName) { $RegionName = 'RegionOne' }

$UserName = $env:OS_USERNAME
if (-not $UserName) { $UserName = 'svc-00f80ce2c7e6403288920e0231986bb2-codex' }

$UserDomainName = $env:OS_USER_DOMAIN_NAME
if (-not $UserDomainName) { $UserDomainName = 'service-users' }

$Interface = $env:OS_INTERFACE
if (-not $Interface) { $Interface = 'public' }

$ServerId = $env:VK_CLOUD_SERVER_ID
if (-not $ServerId) { $ServerId = 'dfe0ac23-78e8-47ec-91be-8906c46b1716' }

$ServerName = $env:VK_CLOUD_SERVER_NAME
if (-not $ServerName) { $ServerName = 'flexcraft-site-rsa-nopass-20260613-010950' }

$HostName = $env:VK_VM_HOST
if (-not $HostName) { $HostName = '146.185.210.83' }

$KeyPairName = $env:VK_CLOUD_KEYPAIR_NAME
if (-not $KeyPairName) { $KeyPairName = 'codex-flexcraft-site-20260615' }

$DefaultPublicKeyPath = Join-Path $HOME '.ssh\flexcraft_site_deploy_ed25519_nopass.pub'
$PublicKeyPath = $env:VK_VM_PUBLIC_KEY_PATH
if (-not $PublicKeyPath) { $PublicKeyPath = $DefaultPublicKeyPath }

$ConsoleUrlPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) 'work\vk-api\console-url.txt'

function Write-Usage {
  Write-Host @"
VK Cloud service-account helper

Usage:
  .\vk-cloud.cmd status             Show VM status and addresses
  .\vk-cloud.cmd start              Start the VM
  .\vk-cloud.cmd stop               Stop the VM
  .\vk-cloud.cmd reboot [soft|hard] Reboot the VM
  .\vk-cloud.cmd console            Create a fresh noVNC console URL
  .\vk-cloud.cmd import-key         Import local public SSH key as an OpenStack keypair
  .\vk-cloud.cmd keypairs           List OpenStack keypairs
  .\vk-cloud.cmd token              Verify credentials without printing the token
  .\vk-cloud.cmd ssh-test           Test SSH access with the deploy key
  .\vk-cloud.cmd help               Show this help

Credentials:
  Set OS_PASSWORD or VK_CLOUD_PASSWORD, or enter the password when prompted.
  This helper never prints passwords, tokens, private keys, or cookies.

Defaults:
  Project: $ProjectId
  Region:  $RegionName
  Server:  $ServerName ($ServerId)
  Host:    $HostName
  Keypair: $KeyPairName
"@
}

function Convert-SecureStringToPlainText {
  param([Parameter(Mandatory = $true)][securestring]$SecureString)

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Get-CloudPassword {
  if ($env:VK_CLOUD_PASSWORD) { return $env:VK_CLOUD_PASSWORD }
  if ($env:OS_PASSWORD) { return $env:OS_PASSWORD }

  $securePassword = Read-Host "OpenStack password for $UserName" -AsSecureString
  return Convert-SecureStringToPlainText -SecureString $securePassword
}

function Join-CloudUri {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUri,
    [Parameter(Mandatory = $true)][string]$Path
  )

  return $BaseUri.TrimEnd('/') + '/' + $Path.TrimStart('/')
}

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [hashtable]$Headers = @{},

    [object]$Body
  )

  $params = @{
    Method      = $Method
    Uri         = $Uri
    Headers     = $Headers
    ErrorAction = 'Stop'
  }

  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 20)
  }

  try {
    return Invoke-RestMethod @params
  } catch {
    $message = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $message = $_.ErrorDetails.Message
    }
    throw "VK Cloud API request failed: $Method $Uri`n$message"
  }
}

function Get-OpenStackSession {
  $password = Get-CloudPassword

  $authBody = @{
    auth = @{
      identity = @{
        methods = @('password')
        password = @{
          user = @{
            name = $UserName
            domain = @{ name = $UserDomainName }
            password = $password
          }
        }
      }
      scope = @{
        project = @{ id = $ProjectId }
      }
    }
  }

  $tokenUri = Join-CloudUri -BaseUri $AuthUrl -Path 'auth/tokens'
  $response = Invoke-WebRequest -Method POST -Uri $tokenUri -ContentType 'application/json' -Body ($authBody | ConvertTo-Json -Depth 20) -ErrorAction Stop
  $token = $response.Headers['X-Subject-Token']
  if ($token -is [array]) { $token = $token[0] }
  if (-not $token) { throw 'Keystone response did not include X-Subject-Token.' }

  $payload = $response.Content | ConvertFrom-Json

  return [pscustomobject]@{
    Token = $token
    Body = $payload.token
  }
}

function Get-ServiceEndpoint {
  param(
    [Parameter(Mandatory = $true)][object]$Session,
    [Parameter(Mandatory = $true)][string[]]$Types
  )

  foreach ($type in $Types) {
    $service = @($Session.Body.catalog | Where-Object { $_.type -eq $type }) | Select-Object -First 1
    if (-not $service) { continue }

    $endpoint = @($service.endpoints | Where-Object {
      $_.interface -eq $Interface -and ($_.region -eq $RegionName -or $_.region_id -eq $RegionName)
    }) | Select-Object -First 1

    if (-not $endpoint) {
      $endpoint = @($service.endpoints | Where-Object { $_.interface -eq $Interface }) | Select-Object -First 1
    }

    if ($endpoint) { return $endpoint.url }
  }

  throw "No $Interface endpoint found for service type(s): $($Types -join ', ')"
}

function Invoke-Cloud {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
    [string]$Method,

    [Parameter(Mandatory = $true)][string]$ServiceType,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body
  )

  $session = Get-OpenStackSession
  $types = switch ($ServiceType) {
    'compute' { @('compute') }
    'network' { @('network') }
    default { @($ServiceType) }
  }

  $endpoint = Get-ServiceEndpoint -Session $session -Types $types
  $headers = @{
    'X-Auth-Token' = $session.Token
    'Accept' = 'application/json'
  }

  return Invoke-JsonRequest -Method $Method -Uri (Join-CloudUri -BaseUri $endpoint -Path $Path) -Headers $headers -Body $Body
}

function Get-Server {
  return Invoke-Cloud -Method GET -ServiceType compute -Path "servers/$ServerId"
}

function Write-ServerStatus {
  $serverResponse = Get-Server
  $server = $serverResponse.server

  Write-Host "Name:      $($server.name)"
  Write-Host "ID:        $($server.id)"
  Write-Host "Status:    $($server.status)"
  Write-Host "Power:     $($server.'OS-EXT-STS:power_state')"
  Write-Host "Task:      $($server.'OS-EXT-STS:task_state')"
  Write-Host "Key name:  $($server.key_name)"
  Write-Host "Host:      $HostName"

  if ($server.addresses) {
    Write-Host 'Addresses:'
    foreach ($networkName in $server.addresses.PSObject.Properties.Name) {
      foreach ($address in $server.addresses.$networkName) {
        Write-Host "  $networkName $($address.'OS-EXT-IPS:type') $($address.addr)"
      }
    }
  }
}

function Invoke-ServerAction {
  param([Parameter(Mandatory = $true)][object]$Body)
  [void](Invoke-Cloud -Method POST -ServiceType compute -Path "servers/$ServerId/action" -Body $Body)
}

function Import-KeyPair {
  $expandedPath = [Environment]::ExpandEnvironmentVariables($PublicKeyPath)
  if ($expandedPath.StartsWith('~')) {
    $expandedPath = Join-Path $HOME $expandedPath.Substring(1).TrimStart('\', '/')
  }

  if (-not (Test-Path -LiteralPath $expandedPath -PathType Leaf)) {
    throw "Public key was not found: $expandedPath"
  }

  $publicKey = (Get-Content -LiteralPath $expandedPath -Raw).Trim()
  if (-not $publicKey.StartsWith('ssh-')) {
    throw "The file does not look like an OpenSSH public key: $expandedPath"
  }

  try {
    $result = Invoke-Cloud -Method POST -ServiceType compute -Path 'os-keypairs' -Body @{
      keypair = @{
        name = $KeyPairName
        public_key = $publicKey
        type = 'ssh'
      }
    }

    Write-Host "Imported keypair: $($result.keypair.name)"
  } catch {
    if ($_.ToString() -match '409|Conflict|already exists') {
      Write-Host "Keypair already exists: $KeyPairName"
      Write-Host 'OpenStack keypairs affect new instances only. Existing VM SSH still needs authorized_keys inside the guest OS.'
      return
    }

    throw
  }
}

function Get-ConsoleUrl {
  $result = Invoke-Cloud -Method POST -ServiceType compute -Path "servers/$ServerId/action" -Body @{
    'os-getVNCConsole' = @{ type = 'novnc' }
  }

  $url = $result.console.url
  if (-not $url) { throw 'VK Cloud did not return a console URL.' }

  $dir = Split-Path -Parent $ConsoleUrlPath
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }

  Set-Content -LiteralPath $ConsoleUrlPath -Value $url -Encoding UTF8
  Write-Host $url
  Write-Host "Saved to: $ConsoleUrlPath"
}

function Test-SshAccess {
  $keyPath = $env:VK_VM_KEY_PATH
  if (-not $keyPath) { $keyPath = Join-Path $HOME '.ssh\flexcraft_site_deploy_ed25519_nopass' }
  $keyPath = [Environment]::ExpandEnvironmentVariables($keyPath)
  if ($keyPath.StartsWith('~')) {
    $keyPath = Join-Path $HOME $keyPath.Substring(1).TrimStart('\', '/')
  }

  if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "Private key was not found: $keyPath"
  }

  & ssh -i $keyPath -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "root@$HostName" 'whoami'
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'SSH is not ready yet. The OpenStack keypair exists outside the VM, but the public key still must be added to /root/.ssh/authorized_keys inside the guest OS.'
    exit $LASTEXITCODE
  }
}

$commandName = $Command.ToLowerInvariant()

switch ($commandName) {
  'help' { Write-Usage }
  '-h' { Write-Usage }
  '--help' { Write-Usage }
  'token' {
    $session = Get-OpenStackSession
    Write-Host "Authenticated as $UserName"
    Write-Host "Token expires: $($session.Body.expires_at)"
  }
  'status' { Write-ServerStatus }
  'server' { Write-ServerStatus }
  'start' {
    Invoke-ServerAction -Body @{ 'os-start' = $null }
    Write-Host "Start requested for $ServerName"
  }
  'stop' {
    Invoke-ServerAction -Body @{ 'os-stop' = $null }
    Write-Host "Stop requested for $ServerName"
  }
  'reboot' {
    $type = if ($Rest.Count -gt 0) { $Rest[0].ToUpperInvariant() } else { 'SOFT' }
    if ($type -notin @('SOFT', 'HARD')) { throw 'Reboot type must be soft or hard.' }
    Invoke-ServerAction -Body @{ reboot = @{ type = $type } }
    Write-Host "$type reboot requested for $ServerName"
  }
  'console' { Get-ConsoleUrl }
  'import-key' { Import-KeyPair }
  'keypairs' {
    $result = Invoke-Cloud -Method GET -ServiceType compute -Path 'os-keypairs'
    foreach ($item in @($result.keypairs)) {
      $keypair = $item.keypair
      Write-Host "$($keypair.name) $($keypair.type) $($keypair.fingerprint)"
    }
  }
  'ssh-test' { Test-SshAccess }
  default {
    Write-Error "Unknown command: $Command. Run .\vk-cloud.cmd help"
  }
}
