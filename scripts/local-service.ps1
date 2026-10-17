[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser,
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverFile = Join-Path $workspace 'server\index.ts'
$recordDirectory = Join-Path $workspace 'data'
$recordFile = Join-Path $recordDirectory 'service.json'
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$stdoutFile = Join-Path $recordDirectory 'service.stdout.log'
$stderrFile = Join-Path $recordDirectory 'service.stderr.log'

function Read-ServiceRecord {
    if (-not (Test-Path -LiteralPath $recordFile)) { return $null }
    try {
        $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$record.pid -le 0 -or [int]$record.port -lt 1 -or [int]$record.port -gt 65535) { throw 'invalid' }
        if (-not $record.executablePath -or -not $record.processCreationUtc) { throw 'invalid' }
        return $record
    }
    catch { throw '后台记录无效，请检查 data/service.json；未对任何进程执行操作。' }
}

function Get-OwnedProcess($Record) {
    if ($null -eq $Record) { return $null }
    $serviceProcess = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f [int]$Record.pid)
    if ($null -eq $serviceProcess) { return $null }
    $executableMatches = [string]::Equals([string]$serviceProcess.ExecutablePath, [string]$Record.executablePath, [StringComparison]::OrdinalIgnoreCase)
    $creationMatches = $serviceProcess.CreationDate.ToUniversalTime().ToString('o') -eq [string]$Record.processCreationUtc
    $commandLine = [string]$serviceProcess.CommandLine
    $entrypointPattern = '(?i)(?:^|\s)"?' + [Regex]::Escape($serverFile) + '"?(?:\s|$)'
    if (-not $executableMatches -or -not $creationMatches -or [IO.Path]::GetFileName($serviceProcess.ExecutablePath) -ne 'node.exe' -or $commandLine -notmatch $entrypointPattern) {
        throw '后台记录与实际进程不一致，可能是 PID 已复用；未对该进程执行操作。'
    }
    return $serviceProcess
}

function Get-ServiceHealth([int]$ServicePort) {
    try {
        $response = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/health' -f $ServicePort) -TimeoutSec 2
        if ($response.ok -eq $true -and $response.data.service -eq 'coyote-link') { return $response.data }
    }
    catch { }
    return $null
}

function Test-PortOccupied([int]$ServicePort) {
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {
        $_.Port -eq $ServicePort -and ($_.Address.Equals([Net.IPAddress]::Loopback) -or $_.Address.Equals([Net.IPAddress]::Any) -or $_.Address.Equals([Net.IPAddress]::IPv6Any))
    }).Count -gt 0
}

function Find-Node {
    $candidates = @()
    $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($systemNode) { $candidates += $systemNode.Source }
    $candidates += Join-Path $runtimeRoot 'node\bin\node.exe'
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $version = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { return $candidate }
    }
    throw '未找到 Node.js 24 或更新版本。请安装 Node.js 24，或保留 Codex 自带运行时后重试。'
}

function Find-Pnpm {
    foreach ($name in @('pnpm.cmd', 'pnpm.exe')) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    $bundled = Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    throw '依赖或构建产物缺失，且未找到 pnpm。请先安装 pnpm 11.5 或更新版本。'
}

function Prepare-Project {
    $node = Find-Node
    $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
    $fallbackDirectory = Join-Path $runtimeRoot 'bin\fallback'
    if (Test-Path -LiteralPath $fallbackDirectory) { $env:PATH = $fallbackDirectory + ';' + $env:PATH }
    $dependenciesMissing = -not (Test-Path -LiteralPath (Join-Path $workspace 'node_modules\tsx\package.json'))
    $buildMissing = -not (Test-Path -LiteralPath (Join-Path $workspace 'dist\index.html')) -or -not (Test-Path -LiteralPath (Join-Path $workspace '.output\server\index.mjs'))
    if ($dependenciesMissing -or $buildMissing) {
        $pnpm = Find-Pnpm
        Push-Location -LiteralPath $workspace
        try {
            if ($dependenciesMissing) {
                Write-Host '正在安装锁定版本的项目依赖…'
                & $pnpm install --frozen-lockfile | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
            }
            Write-Host '正在构建前端和 AI 运行时…'
            & $pnpm build | Out-Host
            if ($LASTEXITCODE -ne 0) { throw '项目构建失败，请查看上方诊断。' }
        }
        finally { Pop-Location }
    }
    return $node
}

function Wait-ServiceReady($Record) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $health = $null
    do {
        if ($null -eq (Get-OwnedProcess $Record)) { throw '后台进程已退出。请查看 data/service.stderr.log 和 data/service.stdout.log。' }
        $health = Get-ServiceHealth ([int]$Record.port)
        if ($null -ne $health -and $health.ai.ready -eq $true) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $health) { throw '45 秒内未收到控制台健康响应。后台仍保留，请查看 data/service.stderr.log。' }
    if ($health.ai.ready -ne $true) { throw '控制台已启动，但 AI 运行时在 45 秒内未就绪。后台仍保留，请查看网页状态和 data/service.stderr.log。' }
    Write-Host ('控制台与 AI 运行时已就绪： http://127.0.0.1:{0}' -f $Record.port)
    Write-Host ('后台 PID：{0}。关闭此窗口不会停止服务；停止请运行 Stop-Coyote.cmd。' -f $Record.pid)
    if (-not $NoBrowser) { Start-Process ('http://127.0.0.1:{0}' -f $Record.port) }
}

try {
    if (-not $PSBoundParameters.ContainsKey('Port') -and $env:COYOTE_PORT) {
        $requestedPort = 0
        if (-not [int]::TryParse($env:COYOTE_PORT, [ref]$requestedPort) -or $requestedPort -lt 1 -or $requestedPort -gt 65535) { throw 'COYOTE_PORT 必须为 1 到 65535。' }
        $Port = $requestedPort
    }
    $record = Read-ServiceRecord
    $ownedProcess = Get-OwnedProcess $record

    if ($Action -eq 'status') {
        if ($null -eq $ownedProcess) { Write-Host '当前没有由本项目启动器管理的后台进程。'; exit 0 }
        $health = Get-ServiceHealth ([int]$record.port)
        if ($null -eq $health) { throw '后台进程存在，但控制台未响应。请检查 data/service.stderr.log。' }
        Write-Host ('控制台运行中： http://127.0.0.1:{0}，PID：{1}，AI 就绪：{2}' -f $record.port, $record.pid, [bool]$health.ai.ready)
        exit 0
    }

    if ($Action -eq 'stop') {
        if ($null -eq $ownedProcess) {
            Write-Host '后台进程已经停止。'
            if (Test-Path -LiteralPath $recordFile) { Remove-Item -LiteralPath $recordFile }
            exit 0
        }
        $url = 'http://127.0.0.1:{0}' -f $record.port
        if ($null -eq (Get-ServiceHealth ([int]$record.port))) { throw '后台未响应，无法确认设备停止；已保留进程，请先在官方 APP 或设备上停止输出。' }
        $current = Invoke-RestMethod -Uri "$url/api/state" -SessionVariable serviceSession -TimeoutSec 5
        if ($current.ok -ne $true -or $null -eq $current.data) { throw '无法读取当前运行状态，后台进程已保留。' }
        $state = $current.data
        $runActive = $null -ne $state.run -and @('running', 'paused') -contains $state.run.status
        $idleWithoutDevice = -not $runActive -and $state.stopUnconfirmed -eq $false -and $state.stopping -eq $false -and $state.device.connected -eq $false -and -not $state.device.clientId -and $state.device.intensities.A -eq 0 -and $state.device.intensities.B -eq 0
        if (-not $idleWithoutDevice) {
            Write-Host '正在结束当前运行、清理波形队列并确认归零…'
            $stopped = Invoke-RestMethod -Method Post -Uri "$url/api/emergency-stop" -WebSession $serviceSession -Headers @{ 'X-Coyote-Request' = '1'; Origin = $url } -ContentType 'application/json' -Body '{}' -TimeoutSec 20
            if ($stopped.ok -ne $true -or $null -eq $stopped.data -or $stopped.data.stopUnconfirmed -eq $true -or $stopped.data.stopping -eq $true) { throw '设备停止尚未确认，后台进程已保留。请在网页和官方 APP 检查停止状态后重试。' }
        }
        $ownedProcess = Get-OwnedProcess $record
        if ($null -ne $ownedProcess) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$record.pid) /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and $null -ne (Get-OwnedProcess $record)) { throw '设备已停止，但后台进程退出失败，请检查后台状态。' }
        }
        if (Test-Path -LiteralPath $recordFile) { Remove-Item -LiteralPath $recordFile }
        if ($idleWithoutDevice) { Write-Host '当前没有活动设备连接或运行；控制台与 AI 后台已退出。' }
        else { Write-Host '已确认停止输出，控制台与 AI 后台已退出。' }
        exit 0
    }

    if ($null -ne $ownedProcess) {
        if ([int]$record.port -ne $Port) { throw ('后台已在端口 {0} 运行。请先停止，或使用相同端口启动。' -f $record.port) }
        Wait-ServiceReady $record
        exit 0
    }
    if (Test-PortOccupied $Port) { throw ('端口 {0} 已被其他进程占用，未启动或终止任何进程。请释放端口，或显式指定 -Port。' -f $Port) }

    $node = Prepare-Project
    $null = New-Item -ItemType Directory -Path $recordDirectory -Force
    $env:COYOTE_PORT = [string]$Port
    $serviceProcess = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', ('"{0}"' -f $serverFile)) -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru
    $processInfo = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $serviceProcess.Id)
    if ($null -eq $processInfo) { throw '后台进程启动后立即退出，请检查 data/service.stderr.log。' }
    $record = [pscustomobject]@{
        pid = $serviceProcess.Id
        executablePath = $node
        port = $Port
        startedUtc = [DateTime]::UtcNow.ToString('o')
        processCreationUtc = $processInfo.CreationDate.ToUniversalTime().ToString('o')
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
    Write-Host '后台服务正在启动…'
    Wait-ServiceReady $record
    exit 0
}
catch {
    Write-Host ('启动器：{0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
