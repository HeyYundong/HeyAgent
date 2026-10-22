#Requires -Version 5.1
<#
.SYNOPSIS
  安装 / 更新 HeyAgent 桌面：Windows-MCP 0.8.8 + 桌面服务（docs/dev/desktop.md 第 6 节）。

.DESCRIPTION
  在要给 agent 用的 Windows 电脑上，用「管理员 PowerShell」运行（前提：已装 Python 3.14）：

    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Key <密钥>

  做的事：
    1. pip 安装 windows-mcp==0.8.8 和本目录的桌面服务；
    2. 密钥写到 C:\HeyAgent\key（只有这个用户、管理员、SYSTEM 能读）；
    3. 关掉 Windows-MCP 的遥测（ANONYMIZED_TELEMETRY=false）；
    4. 建两个「登录时启动」的计划任务（\HeyAgent\WindowsMCP、\HeyAgent\DesktopAgent），
       用 pythonw 跑在登录用户的桌面会话里，不出黑窗口，日志在 C:\HeyAgent\logs；
       删掉 `windows-mcp install` 建的旧任务 windows-mcp-server（它的 start-server.cmd 里明文写着密钥，一起删）；
    5. 防火墙放行两个端口（可以用 -AllowFrom 只放行 HeyAgent 服务器的地址）；
    6. 关掉锁屏、屏保、睡眠、关显示器（锁屏后截不到画面，也点不了），关掉任务栏搜索框的动画（省得远程画面一直传新帧）；
    7. 启动两个任务，等两个端口都在监听、桌面服务的 /health 通过。
  重复运行 = 更新（代码、密钥、端口都按这次的参数来），不填 -Key 时沿用 C:\HeyAgent\key 里已有的密钥。

.PARAMETER Key
  两个服务共用的密钥（至少 16 位，不能有空白），和控制台「桌面」页填的一样。
.PARAMETER KeyFile
  从文件读密钥（代替 -Key，免得密钥出现在命令行历史里）。
.PARAMETER McpPort
  Windows-MCP 的端口，默认 8000。
.PARAMETER AgentPort
  桌面服务的端口，默认 8001。
.PARAMETER AllowFrom
  防火墙只放行这些来源地址（例如 10.0.0.5 或 10.0.0.0/24），默认 Any。
.PARAMETER Python
  python.exe 的路径；不填就找 py -3.14 或 PATH 里的 Python 3.14。
.PARAMETER User
  服务跑在哪个用户的桌面会话里，默认当前用户。这个用户要能自动登录（或者一直登录着）。
#>
[CmdletBinding()]
param(
  [string]$Key,
  [string]$KeyFile,
  [ValidateRange(1, 65535)][int]$McpPort = 8000,
  [ValidateRange(1, 65535)][int]$AgentPort = 8001,
  [string[]]$AllowFrom = @('Any'),
  [string]$Python,
  [string]$User = $env:USERNAME
)

$ErrorActionPreference = 'Stop'
$Root = 'C:\HeyAgent'
$KeyPath = Join-Path $Root 'key'
$LogDir = Join-Path $Root 'logs'
$FilesDir = Join-Path $Root 'files'
$TaskPath = '\HeyAgent\'
$McpTask = 'WindowsMCP'
$AgentTask = 'DesktopAgent'
$WindowsMcpVersion = '0.8.8'

function Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host "失败：$Text" -ForegroundColor Red; exit 1 }

# 跑外部命令，失败就停（Windows PowerShell 5.1 不会因为外部命令返回非 0 而停）
function Run([string]$Exe, [string[]]$Arguments, [int]$Tries = 1) {
  for ($i = 1; $i -le $Tries; $i++) {
    & $Exe @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($i -lt $Tries) { Write-Host "返回 $LASTEXITCODE，30 秒后重试（$i/$Tries）"; Start-Sleep -Seconds 30 }
  }
  Fail "$Exe $($Arguments -join ' ') 返回 $LASTEXITCODE"
}

# ---------- 0. 检查 ----------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail '要用「以管理员身份运行」的 PowerShell 执行'
}

$Account = if ($User -match '\\') { $User } else { "$env:USERDOMAIN\$User" }
try {
  $UserSid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
} catch {
  Fail "找不到用户 $Account"
}

if ($KeyFile) { $Key = (Get-Content -Raw -LiteralPath $KeyFile).Trim() }
if (-not $Key -and (Test-Path -LiteralPath $KeyPath)) {
  $Key = (Get-Content -Raw -LiteralPath $KeyPath).Trim()
  Write-Host "沿用 $KeyPath 里的密钥"
}
if (-not $Key) { Fail '要给密钥：-Key <密钥> 或 -KeyFile <文件>' }
if ($Key.Length -lt 16 -or $Key -match '\s') { Fail '密钥至少 16 位，不能有空格或换行' }
if ($McpPort -eq $AgentPort) { Fail '两个端口不能一样' }

function Find-Python {
  # 试探的命令往 stderr 写东西不算失败（外层是 Stop）
  $ErrorActionPreference = 'Continue'
  if ($Python) { return (Resolve-Path -LiteralPath $Python).Path }
  $candidates = @()
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($py) {
    $found = & $py.Source -3.14 -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $found) { $candidates += $found.Trim() }
  }
  $candidates += @(Get-Command python.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $candidates += "$env:ProgramFiles\Python314\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe"
  foreach ($candidate in $candidates) {
    # 跳过应用商店的占位 python.exe
    if (-not $candidate -or $candidate -like '*\WindowsApps\*' -or -not (Test-Path -LiteralPath $candidate)) { continue }
    # 参数里不能有双引号：Windows PowerShell 5.1 传给外部程序时会把它们吃掉
    $version = & $candidate -c 'import sys; print(sys.version.split()[0].rsplit(chr(46), 1)[0])' 2>$null
    if ($LASTEXITCODE -eq 0 -and $version -and $version.Trim() -eq '3.14') { return $candidate }
  }
  return $null
}

$PythonExe = Find-Python
if (-not $PythonExe) { Fail '没找到 Python 3.14：先从 python.org 装 Python 3.14（勾选 Add to PATH，为所有用户安装），或用 -Python 指定 python.exe' }
$PythonW = Join-Path (Split-Path -Parent $PythonExe) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $PythonW)) { Fail "没找到 $PythonW" }
Write-Host "Python：$PythonExe"
Write-Host "用户：$Account"

# ---------- 1. 装包 ----------

Step "安装 windows-mcp==$WindowsMcpVersion 和桌面服务"
$pipCommon = @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location')
# constraints.txt 锁住 Windows-MCP 的全部间接依赖（它自己只写了 >=），每台装出来都一样
$constraints = Join-Path $PSScriptRoot 'constraints.txt'
Run $PythonExe ($pipCommon + @('-c', $constraints, "windows-mcp==$WindowsMcpVersion", $PSScriptRoot)) 3
# 版本号没变时 pip 不会重装本目录的代码：单独强制重装一次（不动依赖）
Run $PythonExe ($pipCommon + @('--no-deps', '--force-reinstall', $PSScriptRoot)) 3

# ---------- 2. 目录和密钥 ----------

Step "写密钥到 $KeyPath"
foreach ($dir in @($Root, $LogDir, $FilesDir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[IO.File]::WriteAllText($KeyPath, $Key, (New-Object Text.ASCIIEncoding))
# 只给这个用户（读）、Administrators（S-1-5-32-544）、SYSTEM（S-1-5-18）。用 SID：中文系统上组名可能是本地化的
Run 'icacls.exe' @($KeyPath, '/inheritance:r', '/grant:r', "*${UserSid}:(R)", '*S-1-5-32-544:(F)', '*S-1-5-18:(F)', '/Q')
Run 'icacls.exe' @($LogDir, '/grant', "*${UserSid}:(OI)(CI)(M)", '/Q')
Run 'icacls.exe' @($FilesDir, '/grant', "*${UserSid}:(OI)(CI)(M)", '/Q')

Step '关掉 Windows-MCP 的遥测'
[Environment]::SetEnvironmentVariable('ANONYMIZED_TELEMETRY', 'false', 'Machine')

# ---------- 3. 停掉旧的 ----------

Step '停掉旧的服务'
$old = Get-ScheduledTask -TaskName 'windows-mcp-server' -ErrorAction SilentlyContinue
if ($old) {
  Stop-ScheduledTask -InputObject $old -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -InputObject $old -Confirm:$false
  Write-Host '删掉了旧的计划任务 windows-mcp-server'
}
$profileDir = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $UserSid }).LocalPath
if ($profileDir) {
  $oldScript = Join-Path $profileDir '.windows-mcp\start-server.cmd'
  if (Test-Path -LiteralPath $oldScript) {
    Remove-Item -LiteralPath $oldScript -Force
    Write-Host "删掉了 $oldScript（里面有明文密钥）"
  }
}
foreach ($name in @($McpTask, $AgentTask)) {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue }
}

# 端口上还有 Python 在听（旧任务留下的子进程、手动起的）就结束掉；别的程序占着就报错
function Stop-PortOwner([int]$Port) {
  for ($i = 0; $i -lt 20; $i++) {
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if (-not $owners) { return }
    foreach ($id in $owners) {
      $process = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $process) { continue }
      if ($process.ProcessName -notin @('python', 'pythonw')) {
        Fail "端口 $Port 被 $($process.ProcessName)（PID $id）占着，换一个端口（-McpPort / -AgentPort）"
      }
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
  }
  Fail "端口 $Port 上的进程结束不掉"
}
Stop-PortOwner $McpPort
Stop-PortOwner $AgentPort

# ---------- 4. 计划任务 ----------

Step '建登录时启动的计划任务'
$keyArg = "`"$KeyPath`""
$mcpArgs = "-m heyagent_desktop_agent.launch --log-file `"$LogDir\windows-mcp.log`" --auth-key-file $keyArg --env ANONYMIZED_TELEMETRY=false -- -m windows_mcp serve --transport streamable-http --host 0.0.0.0 --port $McpPort"
$agentArgs = "-m heyagent_desktop_agent --host 0.0.0.0 --port $AgentPort --key-file $keyArg --files-dir `"$FilesDir`" --log-file `"$LogDir\desktop-agent.log`""

function Register-HeyAgentTask([string]$Name, [string]$Arguments, [string]$Description) {
  $action = New-ScheduledTaskAction -Execute $PythonW -Argument $Arguments -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
  # Interactive：只在这个用户登录后的桌面会话里跑（看得到桌面）；Highest：能操作以管理员身份运行的窗口
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Highest
  # 不限运行时长（默认 72 小时会被停掉）；退出了 1 分钟后重启；优先级 5 = 普通（默认 7 是低于普通）
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -Priority 5
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $Name -Description $Description -Action $action -Trigger $trigger `
    -Principal $taskPrincipal -Settings $settings -Force | Out-Null
}
Register-HeyAgentTask $McpTask $mcpArgs "HeyAgent：Windows-MCP $WindowsMcpVersion（端口 $McpPort）"
Register-HeyAgentTask $AgentTask $agentArgs "HeyAgent：桌面服务（端口 $AgentPort）"

# ---------- 5. 防火墙 ----------

Step '防火墙放行端口'
# 规则绑定到 pythonw.exe + 端口：有了这个程序的规则，第一次监听时不会弹「是否允许访问网络」的框
# （那个框点了取消会生成阻止规则，比放行规则优先）
Get-NetFirewallRule -Group 'HeyAgent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
foreach ($rule in @(@{ Name = 'Windows-MCP'; Port = $McpPort }, @{ Name = '桌面服务'; Port = $AgentPort })) {
  New-NetFirewallRule -Group 'HeyAgent' -DisplayName "HeyAgent $($rule.Name)" -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $rule.Port -Program $PythonW -RemoteAddress $AllowFrom -Profile Any | Out-Null
}
# 以前弹框时点了取消留下的、阻止 python 的入站规则
$blocked = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -and ((Split-Path -Leaf $_.Program) -in @('python.exe', 'pythonw.exe')) } |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
if ($blocked) {
  $blocked | Remove-NetFirewallRule
  Write-Host "删掉了 $(@($blocked).Count) 条阻止 python 入站的规则"
}

# ---------- 6. 锁屏、屏保、睡眠 ----------

Step '关掉锁屏、屏保、睡眠和关显示器'
foreach ($setting in @('monitor-timeout-ac', 'monitor-timeout-dc', 'standby-timeout-ac', 'standby-timeout-dc', 'hibernate-timeout-ac', 'hibernate-timeout-dc')) {
  Run 'powercfg.exe' @('/change', $setting, '0')
}
# 「离开后何时要求重新登录」= 从不
Run 'powercfg.exe' @('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_NONE', 'CONSOLELOCK', '0')
Run 'powercfg.exe' @('/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_NONE', 'CONSOLELOCK', '0')
Run 'powercfg.exe' @('/setactive', 'SCHEME_CURRENT')

function Set-Dword([string]$Path, [string]$Name, [int]$Value) {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
}
function Set-String([string]$Path, [string]$Name, [string]$Value) {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType String -Force | Out-Null
}
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' 'NoLockScreen' 1
# 「计算机不活动限制」：不因为没人动就锁
Set-Dword 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'InactivityTimeoutSecs' 0
# 任务栏搜索框里的动画插图（「搜索要点」）：一直在动，远程画面就一直有新帧要传。下次登录起生效
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search' 'EnableDynamicContentInWSB' 0
# 屏保写在这个用户自己的注册表里（HKEY_USERS\<SID>，它登录着时一定已经加载）
$userHive = "Registry::HKEY_USERS\$UserSid"
if (Test-Path $userHive) {
  Set-String "$userHive\Control Panel\Desktop" 'ScreenSaveActive' '0'
  Set-String "$userHive\Control Panel\Desktop" 'ScreenSaverIsSecure' '0'
  Set-String "$userHive\Control Panel\Desktop" 'ScreenSaveTimeOut' '0'
} else {
  Write-Host "用户 $Account 现在没登录，屏保没改：登录后再跑一次本脚本" -ForegroundColor Yellow
}

# ---------- 7. 启动并检查 ----------

# 这个用户登录着桌面：有它的 explorer；或者本脚本就是它在桌面会话里跑的（第一次登录时的安装脚本，explorer 可能还没起来）
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$loggedOn = (@(Get-Process -Name explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -eq $Account }).Count -gt 0) -or
  ($me -eq $UserSid -and (Get-Process -Id $PID).SessionId -ne 0)
if (-not $loggedOn) {
  Write-Host "用户 $Account 现在没登录桌面：两个服务会在它下次登录时启动。" -ForegroundColor Yellow
  exit 0
}

Step '启动两个服务'
Start-ScheduledTask -TaskPath $TaskPath -TaskName $McpTask
Start-ScheduledTask -TaskPath $TaskPath -TaskName $AgentTask

function Wait-Port([int]$Port, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
# Windows-MCP 第一次启动要加载很多模块，机械盘上可能要一两分钟
if (-not (Wait-Port $AgentPort 180)) { Fail "桌面服务没在端口 $AgentPort 上起来，看 $LogDir\desktop-agent.log" }
if (-not (Wait-Port $McpPort 300)) { Fail "Windows-MCP 没在端口 $McpPort 上起来，看 $LogDir\windows-mcp.log" }

$headers = @{ Authorization = "Bearer $Key" }
try {
  $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$AgentPort/health" -Headers $headers -TimeoutSec 30
} catch {
  Fail "桌面服务 /health 不通：$($_.Exception.Message)"
}
Write-Host ("桌面服务 {0}：屏幕 {1}x{2}" -f $health.version, $health.screen.width, $health.screen.height)

$ip = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress)[0]
if (-not $ip) { $ip = '<这台电脑的 IP>' }
Write-Host ''
Write-Host '装好了。在控制台「桌面」页登记：' -ForegroundColor Green
Write-Host "  MCP 地址：      http://${ip}:$McpPort/mcp"
Write-Host "  桌面服务地址：  http://${ip}:$AgentPort"
Write-Host '  密钥：          和这次用的一样'
Write-Host "（虚拟机的话，地址填宿主机上映射出来的地址和端口）"
