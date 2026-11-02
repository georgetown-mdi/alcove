<#
.SYNOPSIS
    Runs one lap of the Windows VM pass over the file-drop scripts and prints
    one JSON line per lap: lap, exit, pass, reasons, notes. Maintainer-facing.

.DESCRIPTION
    Each lap's screen is saved to <WorkRoot>\artifacts\<lap>.txt with the share
    password removed. Laps: SelfTest, V1.1-V1.7, V2.1-V2.3, Podman, V3.1-V3.4,
    V4.1, V4.2, V5. Every name of the lab -- the share's drive, its account,
    the DFS path and its target -- is a parameter.

    The share password is read from a DPAPI file that -SaveSecret writes from a
    masked prompt. It reaches the scripts as a SecureString through
    ReadHostStandIn.ps1, and a console through ConsoleInput.ps1, and is never
    an argument.

    Run it from a clone, in the signed-in user's own desktop session: the
    mapped drive and the property sheets exist only there.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\Invoke-VmPass.ps1 -SaveSecret -SecretFile C:\pass\secret\share.dpapi

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\Invoke-VmPass.ps1 -Lap V1.1 -WorkRoot C:\pass -DriveRoot Z:\ -ShareAccount shareuser -SecretFile C:\pass\secret\share.dpapi -ImageDigest sha256:...
#>

[CmdletBinding()]
param(
    [string] $Lap,
    [string] $WorkRoot,
    [string] $DriveRoot,
    [string] $ShareAccount,
    [string] $SecretFile,
    [string] $ImageDigest,
    [string] $DfsPath,
    [string] $DfsTarget,
    [switch] $SaveSecret,
    [switch] $LoadFunctionsOnly
)

$ErrorActionPreference = 'Stop'

$script:HelperFolder = $PSScriptRoot
$script:GuideFolder = (Resolve-Path (Join-Path $script:HelperFolder '..\..\windows-network-filedrop')).Path
$script:SourceRoot = (Resolve-Path (Join-Path $script:HelperFolder '..\..\..')).Path
$script:PowerShellExe = Join-Path $PSHOME 'powershell.exe'
$script:Image = 'ghcr.io/georgetown-mdi/alcove:latest'

# The scripts' own Hide-Secret and engine wrapper, loaded into a module so that
# their parameters and variables stay out of this script's scope.
New-Module -Name AlcoveVmPassScripts -ScriptBlock {
    param([string] $Folder)
    . (Join-Path $Folder 'Start-Alcove.ps1') -LoadFunctionsOnly
    . (Join-Path $Folder 'Setup-AlcoveFileDrop.ps1') -LoadFunctionsOnly
    Export-ModuleMember -Function 'Hide-Secret', 'Invoke-EngineQuiet'
} -ArgumentList $script:GuideFolder | Import-Module -Force

function Initialize-Pass {
    param([string] $Root, [string] $Secret, [hashtable] $Lab = @{})

    $script:Pass = @{
        Work = Join-Path $Root 'work'; Artifacts = Join-Path $Root 'artifacts'
        Runs = Join-Path $Root 'run'; Launcher = Join-Path $Root 'launcher'
        StopFile = Join-Path $Root 'run\stop'; SecretFile = $Secret
    }
    foreach ($key in $Lab.Keys) { $script:Pass[$key] = $Lab[$key] }
    foreach ($folder in @($script:Pass.Work, $script:Pass.Artifacts, $script:Pass.Runs)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }
}

function Write-LapResult {
    param([string] $Name, $Exit, [string[]] $Reasons = @(), [string[]] $Notes = @())

    $line = [ordered]@{ 'lap' = $Name; 'exit' = $Exit; 'pass' = (@($Reasons).Count -eq 0)
        'reasons' = @($Reasons); 'notes' = @($Notes) }
    Write-Output ($line | ConvertTo-Json -Compress)
}

function Protect-Screen {
    <#  The text with the share password removed by the setup script's
        Hide-Secret. The password is text only for that call. #>
    param([string] $Text)

    $secretFile = $script:Pass.SecretFile
    if (-not $secretFile -or -not (Test-Path -LiteralPath $secretFile)) { return $Text }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-SharePassword))
    try { return (Hide-Secret -Text $Text -Secret ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Read-SharePassword {
    ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath $script:Pass.SecretFile).Trim()
}

function Save-Artifact {
    <#  Writes the text, password removed, and returns what it wrote. #>
    param([string] $Name, [string] $Text)
    $screen = Protect-Screen $Text
    [IO.File]::WriteAllText((Join-Path $script:Pass.Artifacts "$Name.txt"), $screen)
    return $screen
}

function Read-SharedText {
    <#  A file another process still has open for writing. #>
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try { return (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
}

function Get-ScreenReasons {
    param([string] $Screen, [string[]] $Has = @(), [string[]] $Lacks = @())

    foreach ($text in $Has) { if (-not $Screen.Contains($text)) { "screen lacks '$text'" } }
    foreach ($text in $Lacks) { if ($Screen.Contains($text)) { "screen has '$text'" } }
}

function Start-StandInRun {
    <#  One run of a PowerShell script through ReadHostStandIn.ps1, its
        output read into memory rather than a file. #>
    param(
        [Parameter(Mandatory = $true)][string] $Target,
        [hashtable] $Arguments = @{},
        [string[]] $Answers = @(),
        [hashtable] $Environment = @{}
    )

    $requestFile = Join-Path $script:Pass.Runs ('request-' + [guid]::NewGuid().ToString('N') + '.json')
    $request = [ordered]@{ target = $Target; arguments = $Arguments; answers = [string[]] $Answers
        secretFile = $script:Pass.SecretFile; stopFile = $script:Pass.StopFile }
    [IO.File]::WriteAllText($requestFile, ($request | ConvertTo-Json -Depth 4))

    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $script:PowerShellExe
    $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $script:HelperFolder 'ReadHostStandIn.ps1')`" -RequestFile `"$requestFile`""
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = $Environment[$key] }
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.Close()
    return @{ Process = $process; RequestFile = $requestFile
        Out = $process.StandardOutput.ReadToEndAsync(); Err = $process.StandardError.ReadToEndAsync() }
}

function Complete-StandInRun {
    param([Parameter(Mandatory = $true)] $Run, [Parameter(Mandatory = $true)][string] $Name, [int] $TimeoutSeconds = 900)

    $exited = $Run.Process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $exited) {
        $Run.Process.Kill()
        $Run.Process.WaitForExit(10000) | Out-Null
        # The launcher's console container is named for its process.
        Invoke-EngineQuiet -EngineArgs @('stop', "alcove-console-$($Run.Process.Id)") | Out-Null
    }
    $screen = ''
    foreach ($stream in @($Run.Out, $Run.Err)) {
        if ($stream.Wait(30000)) { $screen += $stream.Result } else { $screen += "`n(the output stayed open)`n" }
    }
    $screen = Save-Artifact -Name $Name -Text $screen
    Remove-Item -LiteralPath $Run.RequestFile -Force -ErrorAction SilentlyContinue
    $exit = $null
    if ($exited) { $exit = $Run.Process.ExitCode }
    return @{ Exit = $exit; Screen = $screen; TimedOut = (-not $exited) }
}

function Invoke-StandInRun {
    param([string] $Name, [string] $Target, [hashtable] $Arguments = @{}, [string[]] $Answers = @(),
        [hashtable] $Environment = @{})

    $run = Start-StandInRun -Target $Target -Arguments $Arguments -Answers $Answers -Environment $Environment
    return (Complete-StandInRun -Run $run -Name $Name)
}

function Start-ConsoleCommand {
    <#  A command line in a console window of its own, as an operator's would
        be, with its output in the lap's artifact file. #>
    param([Parameter(Mandatory = $true)][string] $Name, [Parameter(Mandatory = $true)][string] $CommandLine)

    $out = Join-Path $script:Pass.Artifacts "$Name.txt"
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /s /c `"$CommandLine > `"$out`" 2>&1`"" -PassThru
    # Touched before any wait, or ExitCode can read as null afterwards.
    $null = $process.Handle
    return @{ Process = $process; Out = $out; Name = $Name }
}

function Start-CmdScript {
    param([string] $Name, [string] $Arguments)
    Start-ConsoleCommand -Name $Name -CommandLine "`"$(Join-Path $script:GuideFolder 'cmd_Setup-AlcoveFileDrop.cmd')`" $Arguments"
}

function Complete-ConsoleCommand {
    param([Parameter(Mandatory = $true)] $Console, [int] $TimeoutSeconds = 600)

    $exited = $Console.Process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $exited) { $Console.Process.Kill() }
    $screen = Save-Artifact -Name $Console.Name -Text (Read-SharedText $Console.Out)
    $exit = $null
    if ($exited) { $exit = $Console.Process.ExitCode }
    return @{ Exit = $exit; Screen = $screen; TimedOut = (-not $exited) }
}

function Send-ConsoleInput {
    <#  ConsoleInput.ps1 against a console, returning the one word it prints. #>
    param([int] $ProcessId, [string[]] $HelperArgs = @())

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $said = & $script:PowerShellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File (Join-Path $script:HelperFolder 'ConsoleInput.ps1') -ProcessId $ProcessId @HelperArgs 2>&1
        return ((@($said) | ForEach-Object { [string] $_ }) -join ' ')
    } finally { $ErrorActionPreference = $previous }
}

function Send-AtPrompt {
    <#  Wait for a prompt to reach the console's output, then answer it.
        Returns a reason when it never came or the answer was not written. #>
    param($Console, [string] $Prompt, [string] $Text = '', [switch] $Secret, [int] $TimeoutSeconds = 300)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Read-SharedText $Console.Out).Contains($Prompt)) {
        if ($Console.Process.HasExited -or (Get-Date) -gt $deadline) { return "no prompt '$Prompt'" }
        Start-Sleep -Milliseconds 500
    }
    $helperArgs = @()
    if ($Secret) { $helperArgs = @('-SecretFile', $script:Pass.SecretFile) }
    elseif ($Text) { $helperArgs = @('-Text', $Text) }
    $said = Send-ConsoleInput -ProcessId $Console.Process.Id -HelperArgs $helperArgs
    if ($said -notlike 'written_*') { return "answering '$Prompt': $said" }
}

function Invoke-Engine {
    param([string[]] $EngineArgs)
    Invoke-EngineQuiet -EngineArgs $EngineArgs
}

function Invoke-Detached {
    param([string] $FilePath, [string[]] $ArgumentList, [int] $TimeoutSeconds = 300)
    # Waited on by itself: Start-Process -Wait also waits for what it leaves running.
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WindowStyle Hidden -PassThru
    $process.WaitForExit($TimeoutSeconds * 1000) | Out-Null
}

function Set-DockerDesktop {
    <#  Start or stop Docker Desktop, and wait until docker answers or not. #>
    param([ValidateSet('start', 'stop')][string] $State, [int] $TimeoutSeconds = 180)

    Invoke-Detached -FilePath 'docker' -ArgumentList @('desktop', $State)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (((Invoke-Engine @('version')).ExitCode -eq 0) -eq ($State -eq 'start')) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Set-PodmanMachine {
    <#  A running Podman machine answers on Docker's pipe once Docker Desktop
        stops, so the docker laps run with it stopped. #>
    param([ValidateSet('start', 'stop')][string] $State)
    if (Get-Command podman -ErrorAction SilentlyContinue) { Invoke-Detached -FilePath 'podman' -ArgumentList @('machine', $State) }
}

function Get-PathWithout {
    <#  PATH with every folder holding one of these commands left out. #>
    param([string[]] $Commands)

    $kept = foreach ($entry in ($env:PATH -split ';')) {
        if (-not $entry) { continue }
        $holds = @($Commands | Where-Object { Test-Path -LiteralPath (Join-Path $entry "$_.exe") })
        if ($holds.Count -eq 0) { $entry }
    }
    return (@($kept) -join ';')
}

function Get-VolumeNames {
    @(((Invoke-Engine @('volume', 'ls', '--format', '{{.Name}}')).Output -split '\r?\n') | Where-Object { $_ })
}

function Get-VolumeKind {
    <#  Driver and mount type only: the whole inspect shows the password. #>
    param([string] $Name)
    $inspect = Invoke-Engine @('volume', 'inspect', '--format', '{{.Driver}} {{.Options.type}}', $Name)
    if ($inspect.ExitCode -ne 0) { return '' }
    return $inspect.Output.Trim()
}

function Remove-Volumes {
    param([string[]] $Names)
    foreach ($name in $Names) { Invoke-Engine @('volume', 'rm', $name) | Out-Null }
}

function Get-ConsoleReport {
    param([string] $Route, [int] $Port = 3000)
    try { return (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/jobs/$Route" -TimeoutSec 5) } catch { return $null }
}

function Wait-ConsoleReport {
    <#  The console's report once it answers, or nothing when the run ends
        first or it never answers. #>
    param($Run, [string] $Route = 'rendezvous', [int] $TimeoutSeconds = 600)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $report = Get-ConsoleReport -Route $Route
        if ($report) { return $report }
        if ($Run -and $Run.Process.HasExited) { return $null }
        Start-Sleep -Seconds 3
    }
    return $null
}

function Get-Launcher {
    <#  A copy of the launcher stamped with the image digest, as a release
        stamps it, with the setup script beside it. #>
    if (-not $script:Pass.ImageDigest) { throw '-ImageDigest is needed for a launcher lap' }
    New-Item -ItemType Directory -Path $script:Pass.Launcher -Force | Out-Null
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:GuideFolder 'Start-Alcove.ps1')
    $placeholderLine = "`$AlcoveImageDigest = '@@ALCOVE_IMAGE_DIGEST@@'"
    $stamped = $source.Replace($placeholderLine, "`$AlcoveImageDigest = '$($script:Pass.ImageDigest)'")
    if ($stamped -eq $source) { throw 'the launcher has no digest placeholder to stamp' }
    $launcher = Join-Path $script:Pass.Launcher 'Start-Alcove.ps1'
    [IO.File]::WriteAllText($launcher, $stamped)
    Copy-Item -LiteralPath (Join-Path $script:GuideFolder 'Setup-AlcoveFileDrop.ps1') -Destination $script:Pass.Launcher -Force
    return $launcher
}

function Get-SetupScript { Join-Path $script:GuideFolder 'Setup-AlcoveFileDrop.ps1' }

function Get-DropFolder {
    <#  A folder on the share for a lap, made if it is not there. #>
    param([string] $Name)
    $folder = Join-Path $script:Pass.DriveRoot $Name
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    return $folder
}

function Get-WorkFolder {
    param([string] $Name)
    $folder = Join-Path $script:Pass.Work $Name
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    return $folder
}

function Get-CredentialAnswers { return @($script:Pass.ShareAccount, '', '@password') }

function Invoke-SetupLap {
    <#  V1.1 and V1.3: the setup script on one folder, answered in full. #>
    param([string] $Name, [string] $Volume)

    $drop = Get-DropFolder 'alcove-vm-1'
    $run = Invoke-StandInRun -Name $Name -Target (Get-SetupScript) `
        -Arguments @{ DropPath = $drop; VolumeName = $Volume } -Answers (@('Y') + (Get-CredentialAnswers))
    $reasons = @(Get-ScreenReasons -Screen $run.Screen -Has @('Ready to run an exchange'))
    if ($run.Exit -ne 0) { $reasons += "exit $($run.Exit)" }
    $kind = Get-VolumeKind $Volume
    if ($kind -ne 'local cifs') { $reasons += "volume $Volume is '$kind'" }
    if (@(Get-ChildItem -Force -LiteralPath $drop).Count -ne 0) { $reasons += "$drop is not empty" }
    Write-LapResult -Name $Name -Exit $run.Exit -Reasons $reasons
}

function Invoke-LapWrongPassword {
    $run = Invoke-StandInRun -Name 'V1.2' -Target (Get-SetupScript) `
        -Arguments @{ DropPath = (Get-DropFolder 'alcove-vm-1'); VolumeName = 'alcove-vm-wrong' } `
        -Answers @('Y', $script:Pass.ShareAccount, '', '@made-up-password', 'n')
    $reasons = @()
    if ($run.Exit -eq 0) { $reasons += 'exit 0' }
    if ($run.Screen -notmatch '(?m)^.*FAIL.*authentication') { $reasons += 'no FAIL line naming authentication' }
    if ((Get-VolumeNames) -contains 'alcove-vm-wrong') { $reasons += 'volume alcove-vm-wrong was made' }
    Write-LapResult -Name 'V1.2' -Exit $run.Exit -Reasons $reasons
}

function Invoke-LapExchange {
    <#  V1.4: a quick exchange per party over the two volumes V1.1 and V1.3
        made, both on one folder of the share. #>
    $parties = @(
        @{ Name = 'alcove-vm-party-a'; Volume = 'alcove-vm-1a'; Input = 'fake_data_1.csv' },
        @{ Name = 'alcove-vm-party-b'; Volume = 'alcove-vm-1b'; Input = 'fake_data_2.csv' })
    foreach ($party in $parties) {
        $party.Work = Get-WorkFolder $party.Name
        Copy-Item -LiteralPath (Join-Path $script:SourceRoot "test_data\$($party.Input)") -Destination $party.Work -Force
        Invoke-Engine @('run', '-d', '--name', $party.Name, '-v', "$($party.Work):/work", '-v', "$($party.Volume):/sync",
            $script:Image, 'file:///sync', $party.Input, 'matches.csv') | Out-Null
    }
    $deadline = (Get-Date).AddSeconds(1500)
    while ((Get-Date) -lt $deadline) {
        $running = @($parties | Where-Object { (Invoke-Engine @('inspect', '-f', '{{.State.Running}}', $_.Name)).Output.Trim() -eq 'true' })
        if ($running.Count -eq 0) { break }
        Start-Sleep -Seconds 10
    }

    $reasons = @(); $notes = @(); $log = ''; $matched = @(); $rows = @()
    foreach ($party in $parties) {
        $exit = (Invoke-Engine @('inspect', '-f', '{{.State.ExitCode}}', $party.Name)).Output.Trim()
        $output = (Invoke-Engine @('logs', $party.Name)).Output
        $log += "== $($party.Name) exit $exit`n$output`n"
        Invoke-Engine @('rm', '-f', $party.Name) | Out-Null
        if ($exit -ne '0') { $reasons += "$($party.Name) exit $exit" }
        if ($output -match 'exchange complete: (\d+) record') { $matched += [int] $Matches[1] } else { $matched += -1 }
        $result = Get-ChildItem -LiteralPath $party.Work -Recurse -Filter '*.csv' | Where-Object { $_.Name -ne $party.Input } |
            Sort-Object LastWriteTime | Select-Object -Last 1
        if ($result) { $rows += @(Import-Csv -LiteralPath $result.FullName).Count } else { $rows += 0 }
    }
    $null = Save-Artifact -Name 'V1.4' -Text $log
    $notes += "matched $($matched -join ' / '), result rows $($rows -join ' / ')"
    if ($matched[0] -lt 1 -or $matched[0] -ne $matched[1]) { $reasons += 'the parties did not report the same non-zero match count' }
    if ($rows[0] -lt 1 -or $rows[0] -ne $rows[1]) { $reasons += 'the result files do not hold equal, non-zero row counts' }
    Write-LapResult -Name 'V1.4' -Exit $null -Reasons $reasons -Notes $notes
}

function Invoke-LauncherLap {
    <#  A launcher run that reaches the console: its reports read while it
        runs, then stopped through the stop file. Returns the lap's reasons. #>
    param([string] $Name, [hashtable] $Arguments, [string[]] $Answers, [scriptblock] $WhileRunning = {})

    $launcherArguments = @{ DataRoot = (Get-WorkFolder 'op'); NoBrowser = $true }
    foreach ($key in $Arguments.Keys) { $launcherArguments[$key] = $Arguments[$key] }
    Remove-Item -LiteralPath $script:Pass.StopFile -Force -ErrorAction SilentlyContinue
    $run = Start-StandInRun -Target (Get-Launcher) -Arguments $launcherArguments -Answers ($Answers + '@wait-stop-file')
    $report = Wait-ConsoleReport -Run $run
    $reasons = @()
    if (-not $report) { $reasons += 'the console never answered' } else { $reasons += @(& $WhileRunning $report) }
    New-Item -ItemType File -Path $script:Pass.StopFile -Force | Out-Null
    $done = Complete-StandInRun -Run $run -Name $Name
    $reasons += @(Get-ScreenReasons -Screen $done.Screen -Has @('The console is at http://127.0.0.1:3000', 'The console has stopped.'))
    if ($done.Exit -ne 0) { $reasons += "exit $($done.Exit)" }
    return @{ Exit = $done.Exit; Screen = $done.Screen; Reasons = @($reasons | Where-Object { $_ }) }
}

function Invoke-LapLauncherOneFolder {
    $lap = Invoke-LauncherLap -Name 'V1.5' -Answers (@('Y') + (Get-CredentialAnswers)) `
        -Arguments @{ RendezvousDir = (Get-DropFolder 'alcove-vm-1'); VolumeName = 'alcove-vm-l1' } -WhileRunning {
        param($report)
        if ($report.configured -ne $true) { 'rendezvous not configured' }
        if ($report.folderName -ne 'alcove-vm-1') { "folderName '$($report.folderName)'" }
        $image = Get-ConsoleReport -Route 'image'
        if (-not $image -or $image.digest -ne $script:Pass.ImageDigest) { 'the image report lacks the stamped digest' }
        if (-not $image -or $image.registry -ne 'docker.io') { "registry '$($image.registry)'" }
    }
    Remove-Volumes @('alcove-vm-l1')
    Write-LapResult -Name 'V1.5' -Exit $lap.Exit -Reasons $lap.Reasons
}

function Invoke-LapLauncherPair {
    $inbound = Get-DropFolder 'alcove-vm-2\partner-writes'
    $outbound = Get-DropFolder 'alcove-vm-2\operator-writes'
    $script:VolumesBefore = Get-VolumeNames
    $lap = Invoke-LauncherLap -Name 'V1.6' -Answers (@('Y') + (Get-CredentialAnswers)) -Arguments @{
        RendezvousDir = $inbound; RendezvousOutboundDir = $outbound; VolumeName = 'alcove-vm-l2' } -WhileRunning {
        param($report)
        $made = @(Get-VolumeNames | Where-Object { $script:VolumesBefore -notcontains $_ })
        if ($made.Count -ne 1) { "$($made.Count) volumes made, not one" }
        if ($report.split -ne $true) { 'the report is not split' }
        if ($report.folderName -ne 'partner-writes') { "folderName '$($report.folderName)'" }
        if ($report.outboundFolderName -ne 'operator-writes') { "outboundFolderName '$($report.outboundFolderName)'" }
    }
    Remove-Volumes @('alcove-vm-l2', 'alcove-vm-l2-outbound')
    Write-LapResult -Name 'V1.6' -Exit $lap.Exit -Reasons $lap.Reasons
}

function Invoke-LapCommandPrompt {
    <#  V1.7: the Command Prompt script typed at its own console, then the
        console line it prints run with a work folder filled in. #>
    $drop = Get-DropFolder 'alcove-vm-3'
    $console = Start-CmdScript -Name 'V1.7' -Arguments "-DropPath `"$drop`" -VolumeName alcove-vm-cmd"
    $reasons = @(
        Send-AtPrompt -Console $console -Prompt 'Are those correct?' -Text 'Y'
        Send-AtPrompt -Console $console -Prompt 'Username: ' -Text $script:Pass.ShareAccount
        Send-AtPrompt -Console $console -Prompt 'Domain (press Enter' -Text ''
        Send-AtPrompt -Console $console -Prompt 'Password: ' -Secret)
    $done = Complete-ConsoleCommand -Console $console
    if ($done.Exit -ne 0) { $reasons += "exit $($done.Exit)" }
    $reasons += @(Get-ScreenReasons -Screen $done.Screen -Has @('Ready to run an exchange', 'JOB_RENDEZVOUS_NAME=alcove-vm-3'))

    $line = @($done.Screen -split '\r?\n' | Where-Object { $_ -match '^\s*docker run --rm -p 127\.0\.0\.1:3000:3000' }) | Select-Object -First 1
    if ($line) {
        $tokens = @([regex]::Matches($line.Trim(), '"[^"]*"|\S+') | ForEach-Object { $_.Value.Trim('"') })
        $tokens = @($tokens | ForEach-Object { $_.Replace('C:\path\to\your\work', (Get-WorkFolder 'op')) })
        Invoke-Engine (@('run', '-d', '--name', 'alcove-vm-cmd-console') + $tokens[2..($tokens.Count - 1)]) | Out-Null
        $report = Wait-ConsoleReport -TimeoutSeconds 120
        if (-not $report -or $report.folderName -ne 'alcove-vm-3') { $reasons += "the console line's report has folderName '$($report.folderName)'" }
        Invoke-Engine @('rm', '-f', 'alcove-vm-cmd-console') | Out-Null
    } else {
        $reasons += 'no console line'
    }
    Remove-Volumes @('alcove-vm-cmd')
    Write-LapResult -Name 'V1.7' -Exit $done.Exit -Reasons @($reasons | Where-Object { $_ })
}

function Invoke-EngineCheckLaps {
    <#  The three scripts against a missing or silent engine: each stops at
        its preflight with the message given, exit 1. #>
    param([string] $Prefix, [string] $Path, [string] $LauncherSays, [string] $SetupSays, [switch] $SkipCommandPrompt)

    $environment = @{ PATH = $Path }
    $drop = Get-DropFolder 'alcove-vm-1'
    $runs = @(
        @{ Name = "$Prefix-SA"; Says = $LauncherSays
            Run = { Invoke-StandInRun -Name "$Prefix-SA" -Target (Get-Launcher) -Environment $environment `
                    -Arguments @{ DataRoot = (Get-WorkFolder 'op'); RendezvousDir = $drop; VolumeName = 'alcove-vm-noengine' } } },
        @{ Name = "$Prefix-SF"; Says = $SetupSays
            Run = { Invoke-StandInRun -Name "$Prefix-SF" -Target (Get-SetupScript) -Environment $environment `
                    -Arguments @{ DropPath = $drop; VolumeName = 'alcove-vm-noengine' } } })
    if (-not $SkipCommandPrompt) {
        $runs += @{ Name = "$Prefix-CMD"; Says = 'Docker is not running, or is not installed, or you cannot use it.'
            Run = {
                $savedPath = $env:PATH
                $env:PATH = $Path
                try { $console = Start-CmdScript -Name "$Prefix-CMD" -Arguments "-DropPath `"$drop`" -VolumeName alcove-vm-noengine" }
                finally { $env:PATH = $savedPath }
                Complete-ConsoleCommand -Console $console -TimeoutSeconds 120
            } }
    }
    foreach ($entry in $runs) {
        $run = & $entry.Run
        $reasons = @(Get-ScreenReasons -Screen $run.Screen -Has @($entry.Says) -Lacks @('Part 1'))
        if ($run.Exit -ne 1) { $reasons += "exit $($run.Exit)" }
        Write-LapResult -Name $entry.Name -Exit $run.Exit -Reasons $reasons
    }
}

function Invoke-LapNoEngine {
    Set-PodmanMachine stop
    Invoke-EngineCheckLaps -Prefix 'V2.1a' -Path (Get-PathWithout @('docker', 'podman')) `
        -LauncherSays 'Neither docker nor podman is installed on this PC.' `
        -SetupSays 'Neither docker nor podman is installed on this PC.'
    $stopped = Set-DockerDesktop stop
    Invoke-EngineCheckLaps -Prefix 'V2.1b' -Path $env:PATH `
        -LauncherSays 'Docker is installed but is not answering.' -SetupSays 'Docker is installed but is not answering.'
    $started = Set-DockerDesktop start
    if (-not $stopped -or -not $started) { Write-LapResult -Name 'V2.1-engine' -Exit $null -Reasons @("Docker Desktop stopped=$stopped started=$started") }
}

function Invoke-LapEngineStopsMidRun {
    <#  V2.2: Docker Desktop stopped at the username prompt, so the checks
        that follow meet a stopped engine. #>
    Set-PodmanMachine stop
    $drop = Get-DropFolder 'alcove-vm-1'
    $answers = @('Y', "@stop-docker:$($script:Pass.ShareAccount)", '', '@password')
    $laps = @(
        @{ Name = 'V2.2-SA'; Target = (Get-Launcher); Wrong = 'published with the image it runs'
            Arguments = @{ DataRoot = (Get-WorkFolder 'op'); RendezvousDir = $drop; VolumeName = 'alcove-vm-stopped'; NoBrowser = $true } },
        @{ Name = 'V2.2-SF'; Target = (Get-SetupScript); Wrong = 'newer copy of this script'
            Arguments = @{ DropPath = $drop; VolumeName = 'alcove-vm-stopped' } })
    foreach ($lap in $laps) {
        Set-DockerDesktop start | Out-Null
        $run = Invoke-StandInRun -Name $lap.Name -Target $lap.Target -Arguments $lap.Arguments -Answers $answers
        $stoppedRun = Invoke-Engine @('run', '--rm', $script:Image, '--version')
        $reasons = @(Get-ScreenReasons -Screen $run.Screen -Has @('Docker stopped during the checks.') -Lacks @($lap.Wrong))
        Write-LapResult -Name $lap.Name -Exit $run.Exit -Reasons $reasons `
            -Notes @("docker run with the engine stopped exits $($stoppedRun.ExitCode)")
    }
    Set-DockerDesktop start | Out-Null
    Remove-Volumes @('alcove-vm-stopped')
}

function Get-DoctorContainers {
    $listing = Invoke-Engine @('ps', '-a', '--no-trunc', '--filter', "ancestor=$($script:Image)", '--format', '{{.ID}} {{.Status}}')
    @(($listing.Output -split '\r?\n') | Where-Object { $_ })
}

function Wait-DoctorRunning {
    <#  Until one container of the image has been running for three seconds:
        the doctor, not the Command Prompt script's brief password check. #>
    param([int] $TimeoutSeconds = 120)

    $firstSeen = @{}
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $ids = (Invoke-Engine @('ps', '-q', '--filter', "ancestor=$($script:Image)")).Output -split '\r?\n' | Where-Object { $_ }
        foreach ($id in $ids) {
            if (-not $firstSeen.ContainsKey($id)) { $firstSeen[$id] = Get-Date }
            if (((Get-Date) - $firstSeen[$id]).TotalSeconds -ge 3) { return $true }
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Invoke-LapInterrupt {
    <#  V2.3: the doctor held by a listener that never speaks SMB, then
        interrupted; whatever container of the image is left is read and
        removed. Passes when none is left 40 or 90 seconds on. #>
    Set-PodmanMachine stop
    Set-DockerDesktop start | Out-Null
    Invoke-Engine @('run', '-d', '--platform', 'linux/amd64', '--name', 'alcove-vm-stall-445', 'alpine/socat',
        'TCP-LISTEN:445,fork,reuseaddr', 'SYSTEM:sleep 600') | Out-Null
    $stallAddress = (Invoke-Engine @('inspect', '-f', '{{.NetworkSettings.IPAddress}}', 'alcove-vm-stall-445')).Output.Trim()
    $cmdArguments = "-Server $stallAddress -Share stall -VolumeName alcove-vm-stall"

    foreach ($case in @(
            @{ Name = 'V2.3i'; Send = @('-CtrlC', '1'); Confirm = $true },
            @{ Name = 'V2.3ii'; Send = @('-CtrlC', '2'); Confirm = $true },
            @{ Name = 'V2.3iii'; Send = @('-Close'); Confirm = $false },
            @{ Name = 'V2.3iv'; Send = @('-CtrlC', '1'); Confirm = $false; PowerShell = $true })) {
        $reasons = @(); $notes = @()
        if ($case.PowerShell) {
            # A console of its own, so its screen is not captured.
            $requestFile = Join-Path $script:Pass.Runs 'interrupt.json'
            [IO.File]::WriteAllText($requestFile, ([ordered]@{ target = (Get-SetupScript); answers = @('@made-up-password')
                        arguments = @{ Server = $stallAddress; Share = 'stall'; VolumeName = 'alcove-vm-stall'; Username = 'stalltest'; Domain = '' }
                        secretFile = ''; stopFile = $script:Pass.StopFile } | ConvertTo-Json -Depth 4))
            $process = Start-Process -FilePath $script:PowerShellExe -PassThru -ArgumentList (
                "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $script:HelperFolder 'ReadHostStandIn.ps1')`" -RequestFile `"$requestFile`"")
            $console = @{ Process = $process; Out = '' }
        } else {
            $console = Start-CmdScript -Name $case.Name -Arguments $cmdArguments
            # A made-up account: Command Prompt shows the password as typed.
            $reasons += @(
                Send-AtPrompt -Console $console -Prompt 'Username: ' -Text 'stalltest'
                Send-AtPrompt -Console $console -Prompt 'Domain (press Enter' -Text ''
                Send-AtPrompt -Console $console -Prompt 'Password: ' -Text 'stalltest')
        }
        if (Wait-DoctorRunning) {
            $notes += "interrupt: $(Send-ConsoleInput -ProcessId $console.Process.Id -HelperArgs $case.Send)"
            if ($case.Confirm) {
                Start-Sleep -Seconds 1
                $notes += "Y: $(Send-ConsoleInput -ProcessId $console.Process.Id -HelperArgs @('-Text', 'Y'))"
            }
        } else {
            $reasons += 'the doctor never ran for three seconds'
        }

        $readings = "at once:`n$((Get-DoctorContainers) -join "`n")`n"
        Start-Sleep -Seconds 40
        $left = Get-DoctorContainers
        $readings += "at 40 s:`n$($left -join "`n")`n"
        if ($left.Count -gt 0) {
            Start-Sleep -Seconds 50
            $left = Get-DoctorContainers
            $readings += "at 90 s:`n$($left -join "`n")`n"
        }
        foreach ($entry in $left) {
            $id = ($entry -split ' ')[0]
            $residue = ((Invoke-Engine @('diff', $id)).Output -split '\r?\n') | Where-Object { $_ -like '*/tmp/alcove-doctor-*' }
            $readings += "diff ${id}:`n$($residue -join "`n")`n"
            Invoke-Engine @('rm', '-f', $id) | Out-Null
        }
        if ($left.Count -gt 0) { $reasons += "$($left.Count) container(s) left at 90 s" }
        if (-not $console.Process.HasExited) { $console.Process.Kill() }
        $screen = ''
        if ($console.Out) { $screen = Read-SharedText $console.Out }
        $null = Save-Artifact -Name $case.Name -Text "$screen`n== readings`n$readings"
        Remove-Volumes @('alcove-vm-stall')
        Write-LapResult -Name $case.Name -Exit $null -Reasons @($reasons | Where-Object { $_ }) -Notes $notes
    }
    Invoke-Engine @('rm', '-f', 'alcove-vm-stall-445') | Out-Null
}

function Invoke-LapPodman {
    <#  Podman chosen when docker is not on PATH, and its message when its
        machine is stopped. #>
    $path = Get-PathWithout @('docker')
    $drop = Get-DropFolder 'alcove-vm-1'
    Set-PodmanMachine start
    $run = Invoke-StandInRun -Name 'Podman-choice-SA' -Target (Get-Launcher) -Environment @{ PATH = $path } -Answers @('n') `
        -Arguments @{ DataRoot = (Get-WorkFolder 'op'); RendezvousDir = $drop; VolumeName = 'alcove-vm-podman' }
    Write-LapResult -Name 'Podman-choice-SA' -Exit $run.Exit -Reasons @(Get-ScreenReasons -Screen $run.Screen -Has @('Using podman.'))
    $run = Invoke-StandInRun -Name 'Podman-choice-SF' -Target (Get-SetupScript) -Environment @{ PATH = $path } -Answers @('n') `
        -Arguments @{ DropPath = $drop; VolumeName = 'alcove-vm-podman' }
    Write-LapResult -Name 'Podman-choice-SF' -Exit $run.Exit -Reasons @(Get-ScreenReasons -Screen $run.Screen -Has @('Podman is running.'))
    Set-PodmanMachine stop
    Invoke-EngineCheckLaps -Prefix 'Podman-stopped' -Path $path -SkipCommandPrompt `
        -LauncherSays 'Podman is installed but is not answering.' -SetupSays 'Podman is installed but is not answering.'
}

function Invoke-LapDfsTab {
    $screenshot = Join-Path $script:Pass.Artifacts 'V3.1.png'
    $said = & $script:PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:HelperFolder 'Read-DfsTab.ps1') `
        -Path $script:Pass.DfsPath -ScreenshotFile $screenshot
    $null = Save-Artifact -Name 'V3.1' -Text ([string] $said)
    try { $tab = ([string] $said) | ConvertFrom-Json }
    catch { $tab = [pscustomobject]@{ tab = $false; referrals = @(); error = 'the reader printed no JSON' } }
    $reasons = @()
    if ($tab.error) { $reasons += "error: $($tab.error)" }
    if (-not $tab.tab) { $reasons += 'no DFS tab' }
    $referral = @($tab.referrals | Where-Object { $_ -like '\\*' }) | Select-Object -First 1
    if (@($tab.referrals) -notcontains $script:Pass.DfsTarget) { $reasons += 'the referral list lacks the target' }
    if ($referral) { [IO.File]::WriteAllText((Join-Path $script:Pass.Artifacts 'V3.1.referral.txt'), $referral) }
    Write-LapResult -Name 'V3.1' -Exit $null -Reasons $reasons -Notes @("referrals: $(@($tab.referrals) -join ', ')")
}

function Invoke-LapDfsSetup {
    <#  V3.2: the setup script given the namespace path. Passes on the
        doctor's DFS-link finding, or on a volume that writes to the target. #>
    $run = Invoke-StandInRun -Name 'V3.2' -Target (Get-SetupScript) `
        -Arguments @{ DropPath = $script:Pass.DfsPath; VolumeName = 'alcove-vm-dfs' } -Answers (@('Y') + (Get-CredentialAnswers))
    $reasons = @()
    if ($run.Exit -eq 78) {
        if ($run.Screen -notmatch 'DFS link') { $reasons += 'exit 78 without the DFS-link finding' }
        if ((Get-VolumeNames) -contains 'alcove-vm-dfs') { $reasons += 'volume alcove-vm-dfs was made' }
    } elseif ($run.Exit -eq 0) {
        Invoke-Engine @('run', '--rm', '-v', 'alcove-vm-dfs:/rz', '--entrypoint', 'sh', $script:Image, '-c', 'echo x > /rz/vm-dfs-check') | Out-Null
        $written = Join-Path $script:Pass.DfsTarget 'vm-dfs-check'
        if (Test-Path -LiteralPath $written) { Remove-Item -LiteralPath $written -Force }
        else { $reasons += 'a file written through the volume is not at the target' }
    } else {
        $reasons += "exit $($run.Exit), neither the DFS-link finding nor a volume"
    }
    Remove-Volumes @('alcove-vm-dfs')
    Write-LapResult -Name 'V3.2' -Exit $run.Exit -Reasons $reasons
}

function Invoke-LapDfsDeclined {
    $run = Invoke-StandInRun -Name 'V3.3' -Target (Get-Launcher) -Answers @('n') -Arguments @{
        DataRoot = (Get-WorkFolder 'op'); RendezvousDir = $script:Pass.DfsPath; VolumeName = 'alcove-vm-dfs-sa'; NoBrowser = $true }
    $reasons = @(Get-ScreenReasons -Screen $run.Screen -Has @('read the DFS tab', '-RendezvousDir'))
    if ($run.Exit -eq 0) { $reasons += 'exit 0' }
    if ((Get-VolumeNames) -contains 'alcove-vm-dfs-sa') { $reasons += 'volume alcove-vm-dfs-sa was made' }
    Write-LapResult -Name 'V3.3' -Exit $run.Exit -Reasons $reasons
}

function Invoke-LapDfsManual {
    <#  V3.4: the launcher given the path V3.1 read off the DFS tab, or the
        known target when it read none. #>
    $notes = @()
    $referralFile = Join-Path $script:Pass.Artifacts 'V3.1.referral.txt'
    $path = $script:Pass.DfsTarget
    if (Test-Path -LiteralPath $referralFile) { $path = (Get-Content -Raw -LiteralPath $referralFile).Trim() }
    else { $notes += 'V3.1 read no referral; the known target was used' }
    $parts = $script:Pass.DfsTarget.TrimStart('\').Split('\')
    $lap = Invoke-LauncherLap -Name 'V3.4' -Answers (@('Y') + (Get-CredentialAnswers)) `
        -Arguments @{ RendezvousDir = $path; VolumeName = 'alcove-vm-dfs-manual' } -WhileRunning {
        param($report)
        if ($report.configured -ne $true) { 'rendezvous not configured' }
    }
    $reasons = @($lap.Reasons)
    foreach ($expected in @("Server:       $($parts[0])", "Share:        $($parts[1])", "Subdirectory: $($parts[2..($parts.Count - 1)] -join '/')")) {
        if ($lap.Screen -notmatch [regex]::Escape($expected)) { $reasons += "screen lacks '$expected'" }
    }
    Remove-Volumes @('alcove-vm-dfs-manual')
    Write-LapResult -Name 'V3.4' -Exit $lap.Exit -Reasons $reasons -Notes $notes
}

function Invoke-LapBinds {
    <#  V4.1: a bind of a folder whose name has a space and a quote, in the
        forms the accept sheet and the console print. #>
    $folder = Get-WorkFolder "it's a dir"
    Set-Content -LiteralPath (Join-Path $folder 'alcove-vm-marker') -Value 'x'
    $bind = "type=bind,src=$folder,dst=/work"
    $listings = @(
        @{ Form = '--mount'; Args = @('--mount', $bind) },
        @{ Form = '--mount readonly'; Args = @('--mount', "$bind,readonly") },
        @{ Form = '-v'; Args = @('-v', "${folder}:/work") })
    $reasons = @(); $log = ''
    foreach ($listing in $listings) {
        $run = Invoke-Engine (@('run', '--rm') + $listing.Args + @('--entrypoint', 'ls', $script:Image, '/work'))
        $log += "== $($listing.Form) exit $($run.ExitCode)`n$($run.Output)`n"
        if ($run.ExitCode -ne 0 -or $run.Output -notmatch 'alcove-vm-marker') { $reasons += "$($listing.Form) did not list the marker" }
    }
    $write = Invoke-Engine @('run', '--rm', '--mount', "$bind,readonly", '--entrypoint', 'sh', $script:Image, '-c', 'touch /work/written')
    $log += "== readonly write exit $($write.ExitCode)`n$($write.Output)`n"
    if ($write.ExitCode -eq 0 -or (Test-Path -LiteralPath (Join-Path $folder 'written'))) { $reasons += 'a read-only bind took a write' }
    $null = Save-Artifact -Name 'V4.1' -Text $log
    Write-LapResult -Name 'V4.1' -Exit $null -Reasons $reasons
}

function Invoke-LapConstrainedVector {
    <#  V4.2: what the launcher passes under a constrained language mode, a
        network folder as a bind, against the real engine. Expected refused. #>
    $folder = Get-DropFolder 'alcove-vm-clm'
    Set-Content -LiteralPath (Join-Path $folder 'alcove-vm-marker') -Value 'x'
    $paths = @($folder.TrimEnd('\'))
    $shareRoot = (Get-PSDrive -Name $script:Pass.DriveRoot.Substring(0, 1)).DisplayRoot
    if ($shareRoot) { $paths += $shareRoot.TrimEnd('\') + '\alcove-vm-clm' }
    $reasons = @(); $notes = @(); $log = ''
    foreach ($path in $paths) {
        $run = Invoke-Engine @('run', '--rm', '-v', "${path}:/rendezvous", '--entrypoint', 'ls', $script:Image, '/rendezvous')
        $log += "== $path exit $($run.ExitCode)`n$($run.Output)`n"
        $notes += "$path exit $($run.ExitCode)"
        if ($run.Output -match 'alcove-vm-marker') { $reasons += "$path listed the marker" }
    }
    $null = Save-Artifact -Name 'V4.2' -Text $log
    Write-LapResult -Name 'V4.2' -Exit $null -Reasons $reasons -Notes $notes
}

function Invoke-LapCleanUp {
    $containers = @('alcove-vm-party-a', 'alcove-vm-party-b', 'alcove-vm-cmd-console', 'alcove-vm-stall-445')
    $volumes = @('alcove-vm-1a', 'alcove-vm-1b', 'alcove-vm-wrong', 'alcove-vm-l1', 'alcove-vm-l2', 'alcove-vm-l2-outbound',
        'alcove-vm-cmd', 'alcove-vm-noengine', 'alcove-vm-stopped', 'alcove-vm-stall', 'alcove-vm-podman',
        'alcove-vm-dfs', 'alcove-vm-dfs-sa', 'alcove-vm-dfs-manual')
    foreach ($name in $containers) { Invoke-Engine @('rm', '-f', $name) | Out-Null }
    Remove-Volumes $volumes
    Invoke-Engine @('image', 'rm', 'alpine/socat') | Out-Null
    $folders = @($script:Pass.Work, $script:Pass.Runs, $script:Pass.Launcher)
    if ($script:Pass.DriveRoot) {
        $folders += @('alcove-vm-1', 'alcove-vm-2', 'alcove-vm-3', 'alcove-vm-clm' | ForEach-Object { Join-Path $script:Pass.DriveRoot $_ })
    }
    foreach ($folder in $folders) { Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue }
    if ($script:Pass.DfsTarget) {
        Get-ChildItem -Force -LiteralPath $script:Pass.DfsTarget -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    }
    $reasons = @()
    $left = (Invoke-Engine @('ps', '-a', '--format', '{{.Names}}')).Output -split '\r?\n'
    $reasons += @($containers | Where-Object { $left -contains $_ } | ForEach-Object { "container $_ is left" })
    $reasons += @($volumes | Where-Object { (Get-VolumeNames) -contains $_ } | ForEach-Object { "volume $_ is left" })
    $reasons += @($folders | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { "$_ is left" })
    Write-LapResult -Name 'V5' -Exit $null -Reasons $reasons
}

function Invoke-SelfTest {
    <#  V0 item 10: console input reaches set /p, the UI Automation
        assemblies load, and the stand-in answers both kinds of prompt. #>
    $reasons = @()
    $target = Join-Path $script:Pass.Runs 'self-test.cmd'
    Set-Content -LiteralPath $target -Encoding Ascii -Value @('@echo off', 'set /p "ANSWER=Answer: "', 'if "%ANSWER%"=="abc" echo READ_OK')
    $console = Start-ConsoleCommand -Name 'SelfTest-console' -CommandLine "`"$target`""
    $reasons += @(Send-AtPrompt -Console $console -Prompt 'Answer: ' -Text 'abc' -TimeoutSeconds 30)
    $reasons += @(Get-ScreenReasons -Screen (Complete-ConsoleCommand -Console $console -TimeoutSeconds 30).Screen -Has @('READ_OK'))

    try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes } catch { $reasons += 'the UI Automation assemblies did not load' }

    $prompts = Join-Path $script:Pass.Runs 'self-test.ps1'
    Set-Content -LiteralPath $prompts -Encoding Ascii -Value @(
        '$plain = Read-Host ''Plain''',
        '$secure = Read-Host ''Secret'' -AsSecureString',
        'Write-Host (''PLAIN:'' + $plain + '' SECURE:'' + ($secure -is [Security.SecureString] -and $secure.Length -gt 0))')
    $password = '@made-up-password'
    if ($script:Pass.SecretFile -and (Test-Path -LiteralPath $script:Pass.SecretFile)) { $password = '@password' }
    $run = Invoke-StandInRun -Name 'SelfTest-stand-in' -Target $prompts -Answers @('abc', $password)
    $reasons += @(Get-ScreenReasons -Screen $run.Screen -Has @('PLAIN:abc SECURE:True'))
    Write-LapResult -Name 'SelfTest' -Exit $run.Exit -Reasons @($reasons | Where-Object { $_ })
}

if ($LoadFunctionsOnly) { return }

if ($SaveSecret) {
    if (-not $SecretFile) { throw '-SecretFile names where to keep the password' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $SecretFile) -Force | Out-Null
    Read-Host 'Share password' -AsSecureString | ConvertFrom-SecureString | Set-Content -LiteralPath $SecretFile
    exit 0
}

if (-not $WorkRoot) { throw '-WorkRoot is needed' }
Initialize-Pass -Root $WorkRoot -Secret $SecretFile -Lab @{
    DriveRoot = $DriveRoot; ShareAccount = $ShareAccount; ImageDigest = $ImageDigest; DfsPath = $DfsPath; DfsTarget = $DfsTarget }

$laps = [ordered]@{
    'SelfTest' = { Invoke-SelfTest }
    'V1.1' = { Invoke-SetupLap -Name 'V1.1' -Volume 'alcove-vm-1a' }
    'V1.2' = { Invoke-LapWrongPassword }
    'V1.3' = { Invoke-SetupLap -Name 'V1.3' -Volume 'alcove-vm-1b' }
    'V1.4' = { Invoke-LapExchange }
    'V1.5' = { Invoke-LapLauncherOneFolder }
    'V1.6' = { Invoke-LapLauncherPair }
    'V1.7' = { Invoke-LapCommandPrompt }
    'V2.1' = { Invoke-LapNoEngine }
    'V2.2' = { Invoke-LapEngineStopsMidRun }
    'V2.3' = { Invoke-LapInterrupt }
    'Podman' = { Invoke-LapPodman }
    'V3.1' = { Invoke-LapDfsTab }
    'V3.2' = { Invoke-LapDfsSetup }
    'V3.3' = { Invoke-LapDfsDeclined }
    'V3.4' = { Invoke-LapDfsManual }
    'V4.1' = { Invoke-LapBinds }
    'V4.2' = { Invoke-LapConstrainedVector }
    'V5' = { Invoke-LapCleanUp }
}
if (-not $laps.Contains($Lap)) { throw "-Lap is one of: $($laps.Keys -join ', ')" }
try { & $laps[$Lap] }
catch {
    Write-LapResult -Name $Lap -Exit $null -Reasons @("the driver stopped: $($_.Exception.Message)")
    exit 1
}
