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
$buildStateScript = Join-Path $PSScriptRoot 'build-state.mjs'

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

function Read-StopState([string]$Url, $Session) {
    $response = Invoke-RestMethod -Uri "$Url/api/state" -WebSession $Session -TimeoutSec 5
    if ($response.ok -isnot [bool] -or $response.ok -ne $true -or $null -eq $response.data) { throw '无法读取停止后的状态，后台进程已保留。' }
    return $response.data
}

function Test-ZeroIntensity($Value) {
    return ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and $Value -eq 0
}

function Assert-StopConfirmed($State) {
    # Require explicit booleans: an old/partial/error response must never permit exit.
    $validFlags = $State.stopUnconfirmed -is [bool] -and $State.stopping -is [bool]
    $inactive = $State.PSObject.Properties.Name -contains 'run' -and ($null -eq $State.run -or @('stopped', 'completed', 'faulted', 'interrupted') -contains $State.run.status)
    $zero = $null -ne $State.device -and $null -ne $State.device.intensities -and (Test-ZeroIntensity $State.device.intensities.A) -and (Test-ZeroIntensity $State.device.intensities.B)
    if ($validFlags -and $State.stopUnconfirmed -eq $false -and $State.stopping -eq $false -and $inactive -and $zero) { return }
    $reason = '服务未返回完整的停止确认状态'
    if ($State.stopping -eq $true) { $reason = '停止仍在进行，等待设备回传或 AI 取消完成超时' }
    elseif ($State.stopUnconfirmed -eq $true) {
        $reason = '未收到清队列及 A/B 双通道归零的完整确认'
        if ($State.stopReason) { $reason = [string]$State.stopReason }
        elseif ($State.device.error) { $reason = [string]$State.device.error }
    }
    elseif (-not $inactive) { $reason = '仍有活动运行' }
    elseif (-not $zero) { $reason = '未确认 A/B 双通道回传均为零' }
    throw ('设备停止尚未确认，后台进程已保留。原因：{0}。请先在官方 APP 或设备上停止输出，恢复 APP/设备连接后在网页重试急停，再运行 Stop-Coyote.cmd。' -f $reason)
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

function Get-ProjectBuildState([string]$NodePath) {
    $json = & $NodePath $buildStateScript inspect
    if ($LASTEXITCODE -ne 0) { throw '无法检查项目构建版本，请查看上方诊断。' }
    $state = $json | ConvertFrom-Json
    if ($state.sourceFingerprint -notmatch '^[a-f0-9]{64}$' -or $state.dependencyFingerprint -notmatch '^[a-f0-9]{64}$' -or $state.needsInstall -isnot [bool] -or $state.needsBuild -isnot [bool]) {
        throw '项目构建版本检查结果无效，未启动后台。'
    }
    return $state
}

function Prepare-Project {
    $node = Find-Node
    $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
    $fallbackDirectory = Join-Path $runtimeRoot 'bin\fallback'
    if (Test-Path -LiteralPath $fallbackDirectory) { $env:PATH = $fallbackDirectory + ';' + $env:PATH }
    $buildState = Get-ProjectBuildState $node
    if ($buildState.needsInstall -or $buildState.needsBuild) {
        $pnpm = Find-Pnpm
        Push-Location -LiteralPath $workspace
        try {
            if ($buildState.needsInstall) {
                & $node $buildStateScript invalidate-dependencies | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '无法更新依赖记录，未启动后台。' }
                Write-Host '正在安装锁定版本的项目依赖…'
                & $pnpm install --frozen-lockfile | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
                & $node $buildStateScript mark-dependencies $buildState.dependencyFingerprint | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '安装期间依赖配置发生变化，未启动旧版本。请重新运行 Start-Coyote.cmd。' }
                $buildState = Get-ProjectBuildState $node
            }
            if ($buildState.needsBuild) {
                & $node $buildStateScript invalidate-build | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '无法更新构建记录，未启动后台。' }
                Write-Host ('需要重新构建：{0}' -f $buildState.reason)
                Write-Host '正在构建最新版网页和 AI 运行时，请等待完成…'
                & $pnpm build | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '项目构建失败，未启动旧产物。请查看上方诊断后重试。' }
                & $node $buildStateScript mark-build $buildState.sourceFingerprint | Out-Host
                if ($LASTEXITCODE -ne 0) { throw '构建记录未确认（可能在构建时修改了代码），未启动后台。请重新运行 Start-Coyote.cmd。' }
                $buildState = Get-ProjectBuildState $node
            }
        }
        finally { Pop-Location }
    }
    if ($buildState.needsInstall -or $buildState.needsBuild) { throw '项目构建版本尚未就绪，未启动后台。' }
    return [pscustomobject]@{ nodePath = $node; sourceFingerprint = $buildState.sourceFingerprint }
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
        if ($current.ok -isnot [bool] -or $current.ok -ne $true -or $null -eq $current.data) { throw '无法读取当前运行状态，后台进程已保留。' }
        # The controller owns the idle/physical confirmation decision and must
        # invalidate pending starts/model results even when the initial state is idle.
        Write-Host '正在结束当前运行、清理波形队列并确认归零…'
        $stopped = Invoke-RestMethod -Method Post -Uri "$url/api/emergency-stop" -WebSession $serviceSession -Headers @{ 'X-Coyote-Request' = '1'; Origin = $url } -ContentType 'application/json' -Body '{}' -TimeoutSec 20
        if ($stopped.ok -isnot [bool] -or $stopped.ok -ne $true -or $null -eq $stopped.data) { throw '停止接口未返回有效确认，后台进程已保留。' }
        $state = $stopped.data
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(20)
        while ($state.stopping -eq $true -and [DateTime]::UtcNow -lt $stopDeadline) {
            Start-Sleep -Milliseconds 250
            $state = Read-StopState $url $serviceSession
        }
        Assert-StopConfirmed $state
        # Re-read after the awaited stop so a stale POST snapshot cannot authorize exit.
        $state = Read-StopState $url $serviceSession
        Assert-StopConfirmed $state
        $ownedProcess = Get-OwnedProcess $record
        if ($null -ne $ownedProcess) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$record.pid) /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and $null -ne (Get-OwnedProcess $record)) { throw '设备已停止，但后台进程退出失败，请检查后台状态。' }
        }
        if (Test-Path -LiteralPath $recordFile) { Remove-Item -LiteralPath $recordFile }
        Write-Host '已确认停止输出或从未连接的待机状态，控制台与 AI 后台已退出。'
        exit 0
    }

    if ($null -ne $ownedProcess) {
        if ([int]$record.port -ne $Port) { throw ('后台已在端口 {0} 运行。请先停止，或使用相同端口启动。' -f $record.port) }
        $currentBuild = Get-ProjectBuildState (Find-Node)
        if ($currentBuild.needsInstall -or $currentBuild.needsBuild -or $record.sourceFingerprint -ne $currentBuild.sourceFingerprint) {
            throw '代码已有更新，当前后台尚未加载最新版。请先运行 Stop-Coyote.cmd，再运行 Start-Coyote.cmd；启动器会自动完成重建。'
        }
        Wait-ServiceReady $record
        exit 0
    }
    if (Test-PortOccupied $Port) { throw ('端口 {0} 已被其他进程占用，未启动或终止任何进程。请释放端口，或显式指定 -Port。' -f $Port) }

    $prepared = Prepare-Project
    $node = $prepared.nodePath
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
        sourceFingerprint = $prepared.sourceFingerprint
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
