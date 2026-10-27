<#
.SYNOPSIS
    Pester suite running Setup-AlcoveFileDrop.ps1 and Start-Alcove.ps1 in
    sessions an application-control policy has put in ConstrainedLanguage.
    Maintainer-facing: an operator following the setup page never receives it.

.DESCRIPTION
    The policy is the machine-wide __PSLockdownPolicy=4, set after everything
    this session needs is built and cleared in AfterAll. A powershell.exe
    started while it is set runs in ConstrainedLanguage; this session, started
    before it, keeps FullLanguage, which is what lets it drive the runs and
    read them back.

    The policy reaches every PowerShell started on the machine while it is
    set, so this suite runs in a job of its own (the clm job of
    .github/workflows/windows_resolution.yaml) and never beside the others.

    The first test is that the mode is in effect: a run in FullLanguage would
    take the scripts' other branches and prove nothing about this one.
    ci-resolution-tests.ps1 also reports the mode the children ran in as a
    rig assumption, and fails the job as a harness error when it is not
    ConstrainedLanguage.

    What a network folder typed into the launcher here does is measured
    rather than asserted: each such run is reported through
    $global:AlcoveMeasurements, which ci-resolution-tests.ps1 turns into
    ::notice annotations.

    Run it through ci-resolution-tests.ps1 -Suite ConstrainedLanguage rather
    than Invoke-Pester directly.
#>

BeforeAll {
    $scriptsDir = (Resolve-Path (Join-Path $PSScriptRoot '..\windows-network-filedrop')).Path
    $script:SetupScript = Join-Path $scriptsDir 'Setup-AlcoveFileDrop.ps1'
    $launcherScript = Join-Path $scriptsDir 'Start-Alcove.ps1'

    $global:AlcoveRigPremises = [ordered]@{
        clm   = [ordered]@{ state = 'not_reached' }
        share = [ordered]@{ state = 'not_reached' }
    }
    $global:AlcoveMeasurements = [ordered]@{}

    # Its own name rather than the other suites' helpers: this file runs
    # alone, but a shared name would give the files a load order.
    function Start-ConstrainedChild {
        <#  Run powershell.exe and return its exit code and both streams, with
            standard input from a file so that a run reaching a prompt it was
            not given an answer for ends rather than waits. #>
        param([string[]] $Arguments, [string[]] $InputLines = @(), [int] $TimeoutSeconds = 150)

        $outFile = [IO.Path]::GetTempFileName()
        $errFile = [IO.Path]::GetTempFileName()
        $inFile = [IO.Path]::GetTempFileName()
        try {
            if (@($InputLines).Count -gt 0) {
                Set-Content -LiteralPath $inFile -Value $InputLines -Encoding Ascii
            }
            $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
                -ArgumentList $Arguments -NoNewWindow -PassThru `
                -RedirectStandardInput $inFile `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            # Touch the handle before the wait: without it the Start-Process
            # wrapper can report ExitCode as null after a timed WaitForExit.
            try { $null = $process.Handle } catch { }
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
            $exitCode = $null
            if ($exited) { $exitCode = $process.ExitCode }
            $stdout = Get-Content -LiteralPath $outFile -Raw
            if ($null -eq $stdout) { $stdout = '' }
            $stderr = Get-Content -LiteralPath $errFile -Raw
            if ($null -eq $stderr) { $stderr = '' }
            return [ordered]@{
                TimedOut = (-not $exited)
                Exit     = $exitCode
                Output   = [string] $stdout
                Errors   = [string] $stderr
            }
        } finally {
            Remove-Item -LiteralPath $outFile, $errFile, $inFile -Force -ErrorAction SilentlyContinue
        }
    }

    function Invoke-ConstrainedRun {
        <#  One script run against the stub engine: the stub first on PATH and
            nothing else that could answer behind it. Returns the run with the
            stub's call log read back on it. #>
        param(
            [Parameter(Mandatory = $true)][string] $Script,
            [Parameter(Mandatory = $true)][string] $StubDir,
            [string[]] $Arguments = @(),
            [string[]] $InputLines = @(),
            [int] $TimeoutSeconds = 150
        )

        New-Item -ItemType Directory -Path $StubDir -Force | Out-Null
        $originalPath = $env:PATH
        $originalStubDir = $env:ALCOVE_STUB_DIR
        try {
            $env:PATH = @($script:ClmBin,
                (Join-Path $env:SystemRoot 'System32'),
                $env:SystemRoot,
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')) -join ';'
            $env:ALCOVE_STUB_DIR = $StubDir
            $run = Start-ConstrainedChild -Arguments (@(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Script`"") + $Arguments) `
                -InputLines $InputLines -TimeoutSeconds $TimeoutSeconds
        } finally {
            $env:PATH = $originalPath
            if ($null -eq $originalStubDir) {
                Remove-Item 'env:ALCOVE_STUB_DIR' -ErrorAction SilentlyContinue
            } else {
                $env:ALCOVE_STUB_DIR = $originalStubDir
            }
        }

        $calls = ''
        $log = Join-Path $StubDir 'calls.log'
        if (Test-Path -LiteralPath $log) { $calls = [string] (Get-Content -LiteralPath $log -Raw) }
        $run['Calls'] = $calls
        return $run
    }

    function Get-RunShape {
        <#  The run's shape and its tail, for a -Because: the failure
            annotation is the only diagnostic that leaves the runner. #>
        param($Run)

        $output = [string] $Run.Output
        return "timedout=$($Run.TimedOut) exit=$($Run.Exit) " +
            "calls=$(@(([string] $Run.Calls) -split '\r?\n' | Where-Object { $_.Trim() }).Count) " +
            "err=$((([string] $Run.Errors).Trim()) -replace '\s+', ' ') tail=" +
            (($output.Substring([Math]::Max(0, $output.Length - 300))) -replace '\s+', ' ')
    }

    function Get-ConsoleCalls {
        <#  The recorded calls that started the console: 'serve' as the last
            argument, which Start-Alcove.Tests.ps1 asserts of the argument
            vector. #>
        param([string] $Calls)

        return @($Calls -split '\r?\n' | ForEach-Object { $_.Trim() } |
                Where-Object { $_ -and (($_ -split '\s+')[-1] -eq 'serve') })
    }

    function Get-LanguageModeOfChild {
        <#  The language mode a new powershell.exe reports, by -Command and by
            -File: a policy can treat the two differently. #>
        param([string] $ModeScript)

        $commandRun = Start-ConstrainedChild -TimeoutSeconds 60 -Arguments @(
            '-NoProfile', '-NonInteractive', '-Command', '$ExecutionContext.SessionState.LanguageMode')
        $fileRun = Start-ConstrainedChild -TimeoutSeconds 60 -Arguments @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$ModeScript`"")
        return [ordered]@{
            Command = ([string] $commandRun.Output).Trim()
            File    = ([string] $fileRun.Output).Trim()
        }
    }

    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $script:ClmRoot = Join-Path $env:TEMP "alcove-clm-$suffix"
    $script:ClmBin = Join-Path $script:ClmRoot 'bin'
    $script:ClmData = Join-Path $script:ClmRoot 'agency-a-agency-b'
    $script:ClmInput = Join-Path $script:ClmRoot 'input'
    $script:ClmLauncherDir = Join-Path $script:ClmRoot 'launcher'
    foreach ($directory in @($script:ClmRoot, $script:ClmBin, $script:ClmData, $script:ClmInput,
            $script:ClmLauncherDir)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    # An engine that records the argument vector it is handed and answers
    # every run of the doctor checks with a verdict that blocks nothing: the
    # flow stub of Start-Alcove.Tests.ps1.
    Set-Content -LiteralPath (Join-Path $script:ClmBin 'docker.cmd') -Encoding Ascii -Value @(
        '@echo off',
        'echo %* >> "%ALCOVE_STUB_DIR%\calls.log"',
        'echo %* | findstr /c:"doctor" >nul',
        'if not errorlevel 1 echo {"version":1,"mode":"mount","overall":"ok","checks":[]}',
        'exit /b 0')

    # The launcher refuses to run unstamped, so the copy under test has a
    # digest, and the setup script sits beside it as a release ships them.
    $source = Get-Content -Raw -LiteralPath $launcherScript
    $placeholderLine = "`$AlcoveImageDigest = '@@ALCOVE_IMAGE_DIGEST@@'"
    $stamped = $source.Replace($placeholderLine, "`$AlcoveImageDigest = 'sha256:$('a1b2c3d4' * 8)'")
    if ($stamped -eq $source) { throw 'the launcher no longer carries the digest line this suite stamps' }
    $script:ClmLauncher = Join-Path $script:ClmLauncherDir 'Start-Alcove.ps1'
    [IO.File]::WriteAllText($script:ClmLauncher, $stamped)
    Copy-Item -LiteralPath $script:SetupScript -Destination (Join-Path $script:ClmLauncherDir 'Setup-AlcoveFileDrop.ps1')

    # Something has to answer on the console's port for the flow to reach its
    # end: the stub engine exits rather than holding one open.
    $script:ClmListener = New-Object -TypeName Net.Sockets.TcpListener `
        -ArgumentList ([Net.IPAddress]::Loopback, 0)
    $script:ClmListener.Start()
    $script:ClmPort = ([Net.IPEndPoint] $script:ClmListener.LocalEndpoint).Port

    # A share over loopback and a letter mapped to it: the network folders an
    # operator would type into the launcher's prompt.
    $script:ShareName = "alcoveclm$suffix"
    $script:ShareRoot = Join-Path $env:TEMP "alcove-clm-share-$suffix"
    $script:MappedLetter = $null
    $script:ShareUnc = $null
    try {
        New-Item -ItemType Directory -Path (Join-Path $script:ShareRoot 'drop') -Force | Out-Null
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        New-SmbShare -Name $script:ShareName -Path $script:ShareRoot -FullAccess $identity.Name | Out-Null
        $script:ShareUnc = "\\localhost\$script:ShareName"
        foreach ($letter in @('Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R')) {
            if (Test-Path -LiteralPath "${letter}:\" -ErrorAction SilentlyContinue) { continue }
            if (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue) { continue }
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                $null = & net use "${letter}:" $script:ShareUnc '/persistent:no' 2>&1
                if ($LASTEXITCODE -eq 0) { $script:MappedLetter = $letter }
            } finally { $ErrorActionPreference = $previous }
            break
        }
        $global:AlcoveRigPremises.share = [ordered]@{
            state  = 'built'
            unc    = $script:ShareUnc
            letter = $script:MappedLetter
        }
    } catch {
        $global:AlcoveRigPremises.share = [ordered]@{ state = 'failed'; error = $_.Exception.Message }
    }

    $script:ModeScript = Join-Path $script:ClmRoot 'language-mode.ps1'
    Set-Content -LiteralPath $script:ModeScript -Value '$ExecutionContext.SessionState.LanguageMode' -Encoding Ascii
    $before = Get-LanguageModeOfChild -ModeScript $script:ModeScript

    # The policy last, once nothing this session still has to load is left.
    $script:LockdownName = '__PSLockdownPolicy'
    $script:LockdownBefore = [Environment]::GetEnvironmentVariable($script:LockdownName, 'Machine')
    $script:LockdownSet = $false
    $script:ChildModes = [ordered]@{ Command = 'not_measured'; File = 'not_measured' }
    try {
        [Environment]::SetEnvironmentVariable($script:LockdownName, '4', 'Machine')
        $script:LockdownSet = $true
        $script:ChildModes = Get-LanguageModeOfChild -ModeScript $script:ModeScript
        $global:AlcoveRigPremises.clm = [ordered]@{
            state      = 'policy_set'
            route      = 'machine_PSLockdownPolicy_4'
            before_cmd = $before.Command
            child_cmd  = $script:ChildModes.Command
            child_file = $script:ChildModes.File
            harness    = [string] $ExecutionContext.SessionState.LanguageMode
        }
    } catch {
        $global:AlcoveRigPremises.clm = [ordered]@{
            state = 'failed'
            route = 'machine_PSLockdownPolicy_4'
            error = $_.Exception.Message
        }
    }
}

AfterAll {
    if ($script:LockdownSet) {
        [Environment]::SetEnvironmentVariable($script:LockdownName, $script:LockdownBefore, 'Machine')
    }
    if ($script:ClmListener) { $script:ClmListener.Stop() }
    if ($script:MappedLetter) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $null = & net use "$($script:MappedLetter):" /delete /y 2>&1 } finally { $ErrorActionPreference = $previous }
    }
    Remove-SmbShare -Name $script:ShareName -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:ShareRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:ClmRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Constrained language mode, imposed by policy' {
    It 'is in effect in a new PowerShell, while this session keeps FullLanguage' {
        $shape = ($global:AlcoveRigPremises.clm.Keys | ForEach-Object {
                "$_=$($global:AlcoveRigPremises.clm[$_])" }) -join ' '
        $script:LockdownSet | Should -BeTrue -Because $shape
        $script:ChildModes.Command | Should -Be 'ConstrainedLanguage' -Because $shape
        $script:ChildModes.File | Should -Be 'ConstrainedLanguage' -Because $shape
        [string] $ExecutionContext.SessionState.LanguageMode | Should -Be 'FullLanguage' -Because $shape
    }
}

Describe 'The setup script in constrained language mode' {
    It 'refuses before it reaches the engine, and points at the Command Prompt script' {
        $run = Invoke-ConstrainedRun -Script $script:SetupScript `
            -StubDir (Join-Path $script:ClmRoot 'setup-stub') -TimeoutSeconds 60
        $shape = Get-RunShape -Run $run
        $output = [string] $run.Output

        $run.TimedOut | Should -BeFalse -Because $shape
        $output | Should -BeLike '*PowerShell is running in ConstrainedLanguage mode.*' -Because $shape
        $output | Should -BeLike '*Use the Command Prompt version instead*' -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        ([string] $run.Calls).Trim() | Should -BeNullOrEmpty -Because $shape
    }
}

Describe 'The launcher in constrained language mode' {
    It 'warns, asks for a typed folder in place of the picker, and reaches the console' {
        # One folder for everything, typed at the prompt, then Enter to stop.
        $run = Invoke-ConstrainedRun -Script $script:ClmLauncher `
            -StubDir (Join-Path $script:ClmRoot 'local-stub') `
            -Arguments @('-Port', $script:ClmPort, '-NoBrowser') `
            -InputLines @('', $script:ClmData, '')
        $shape = Get-RunShape -Run $run
        $output = [string] $run.Output
        $calls = [string] $run.Calls

        $run.TimedOut | Should -BeFalse -Because $shape
        $output | Should -BeLike '*WARN  PowerShell is in ConstrainedLanguage mode.*' -Because $shape
        $output | Should -BeLike '*Click once in the File Explorer address bar*' -Because $shape
        $output | Should -Match 'The console is at' -Because $shape

        $served = @(Get-ConsoleCalls -Calls $calls) -join ' :: '
        $served | Should -BeLike "*$($script:ClmData):/data*" -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_NAME=agency-a-agency-b*' -Because $shape
        $calls | Should -Not -BeLike '*volume create*' -Because $shape
    }

    It 'takes a typed network folder on the route <Label>, and the run is recorded' -ForEach @(
        @{ Label = 'mapped_letter'; Kind = 'letter' },
        @{ Label = 'unc'; Kind = 'unc' }
    ) {
        $folder = $null
        if ($Kind -eq 'letter' -and $script:MappedLetter) { $folder = "$($script:MappedLetter):\drop" }
        if ($Kind -eq 'unc' -and $script:ShareUnc) { $folder = "$script:ShareUnc\drop" }
        if (-not $folder) {
            $global:AlcoveMeasurements["clm_$Label"] = [ordered]@{ state = 'no_rig' }
            Set-ItResult -Skipped -Because "the rig has no $Label to type"
            return
        }

        # Separate folders; the partner named one; that folder typed as the
        # network path; then Enter to stop the console.
        $run = Invoke-ConstrainedRun -Script $script:ClmLauncher `
            -StubDir (Join-Path $script:ClmRoot "$Label-stub") `
            -Arguments @('-Port', $script:ClmPort, '-NoBrowser') `
            -InputLines @('n', $script:ClmData, $script:ClmInput, '', $folder, '')
        $shape = Get-RunShape -Run $run
        $output = [string] $run.Output
        $calls = [string] $run.Calls

        $global:AlcoveMeasurements["clm_$Label"] = [ordered]@{
            typed            = $folder
            timedout         = $run.TimedOut
            exit             = $run.Exit
            console_started  = ($output -match 'The console is at')
            volume_create    = ($calls -like '*volume create*')
            rendezvous_mount = (@(Get-ConsoleCalls -Calls $calls) -join ' ') -replace '^.*(--volume \S+:/rendezvous).*$', '$1'
            tail             = (($output.Substring([Math]::Max(0, $output.Length - 300))) -replace '\s+', ' ')
        }

        # What the run does with the folder is recorded above for the next
        # change to assert. Here: the branch it took is the constrained one.
        $run.TimedOut | Should -BeFalse -Because $shape
        $output | Should -BeLike '*WARN  PowerShell is in ConstrainedLanguage mode.*' -Because $shape
    }
}
