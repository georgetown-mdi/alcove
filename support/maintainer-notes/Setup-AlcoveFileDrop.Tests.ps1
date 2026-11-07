<#
.SYNOPSIS
    Pester suite over the path-resolution functions in
    Setup-AlcoveFileDrop.ps1, the console command it closes on, and the
    screens it prints under each exit code of the image's checks.
    Maintainer-facing: it lives outside the guide folder, and an operator
    following the setup page never receives it.

.DESCRIPTION
    The script under test is dot-sourced with -LoadFunctionsOnly, which defines
    its functions and stops before the setup flow. Two tests hold that switch to
    its contract from both sides -- a dot-source prints nothing, and an ordinary
    run still reaches the banner -- because a guard that silently swallowed the
    flow would leave every operator with a script that does nothing.

    Four kinds of test:

      - Pure: UNC and device-prefix parsing, drive-kind classification, the
        dialect map, password masking, the rule that names the shared folder
        and the console command the closing screen prints from it, and that the
        switch defines the sequences the launcher reaches through it. These
        need no rig and no rights.
      - Stub-engine: a docker.cmd standing in for the container engine, put
        ahead of the PATH for one function call or for a whole run of the flow.
        The engine records each call, which lets a test read back which calls
        the flow made and which it did not go on to make. The same engine
        replays what the image's checks print for each exit code, so every
        screen the flow puts under them is compared line for line.
      - Real-engine: the flow run against the PC's own docker, which on the
        hosted runner serves Windows containers, to the refusal of that mode.
      - Rig-backed: a share the runner serves itself over loopback, a drive
        letter mapped to it, and a standalone DFS namespace with a link into
        that share. Built the way support/maintainer-notes/ci-resolution-rig.ps1
        measured to work on a windows-latest runner. Each half of the rig is
        built inside its own try/catch and reported through
        $global:AlcoveRigPremises, which ci-resolution-tests.ps1 turns into
        ::notice annotations -- so a runner that cannot build the rig is
        distinguishable from a script that resolves a path wrongly.

    Run it through ci-resolution-tests.ps1 rather than Invoke-Pester directly:
    that script is what reports results as annotations, which is all the CI
    reader can see.
#>

BeforeAll {
    # -LoadFunctionsOnly is what keeps the prompts, the Docker calls and the
    # volume creation out of this session.
    $setupScript = (Resolve-Path (Join-Path $PSScriptRoot '..\windows-network-filedrop\Setup-AlcoveFileDrop.ps1')).Path
    . $setupScript -LoadFunctionsOnly

    # The dot-source above also sets $ErrorActionPreference to 'Stop', which is
    # how the functions run for an operator and so is left in place. It is also
    # why the helpers below relax it around native commands: under 'Stop',
    # Windows PowerShell turns a native program's stderr into a terminating
    # ErrorRecord, and the rig would abort where it means to report.
    function Invoke-Net {
        param([string[]] $Arguments)

        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & net @Arguments 2>&1
            $exit = $LASTEXITCODE
            $text = ($output | ForEach-Object { [string] $_ }) -join ' '
            return [ordered]@{ Exit = $exit; Output = $text }
        } finally {
            $ErrorActionPreference = $previous
        }
    }

    function Find-FreeDriveLetter {
        param([string[]] $Exclude = @())

        foreach ($letter in @('Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R')) {
            if ($Exclude -contains $letter) { continue }
            if (Test-Path -LiteralPath "${letter}:\" -ErrorAction SilentlyContinue) { continue }
            if (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue) { continue }
            return $letter
        }
        return $null
    }

    function Start-PowerShellChild {
        <#  Run powershell.exe and return its exit code and both streams.

            $PSHOME rather than the bare name, because callers strip the PATH
            down; a temporary file rather than the console for standard input,
            so that a guard which failed and let the flow reach a prompt ends
            the run rather than blocking it. The timeout is the backstop for
            anything else that waits. -InputLines fills that file for a run
            that is meant to reach the prompts; a run given none still ends at
            the first one it reaches. #>
        param([string[]] $Arguments, [string[]] $InputLines = @(), [int] $TimeoutSeconds = 120)

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
            # Touch the handle before the wait: without it, the Start-Process
            # wrapper can report ExitCode as null after a timed WaitForExit --
            # the failure CI measured in this helper's first run. Best-effort:
            # a child that exited already can refuse the handle, and the Exit
            # assertion downstream is what reports that case. The parameterless
            # WaitForExit afterwards settles the redirects.
            try { $null = $process.Handle } catch { }
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
            $exitCode = $null
            if ($exited) { $exitCode = $process.ExitCode }
            # Plain statements and an explicit null check: CI measured Errors
            # arriving at the assertions as null despite a [string] cast here,
            # so the coercion is spelled out where a debugger cannot reach.
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
}

Describe 'The -LoadFunctionsOnly guard' {
    It 'defines the resolution functions and runs nothing else' {
        $command = ". '$setupScript' -LoadFunctionsOnly; " +
            "if (Get-Command Resolve-DropPath -ErrorAction SilentlyContinue) { 'LOADED' }"
        $run = Start-PowerShellChild -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) -TimeoutSeconds 60

        # Null-safe reads and a -Because carrying the run's shape: the failure
        # annotation is the only diagnostic that leaves the runner, so an
        # assertion here must describe the run it judged, never throw.
        $stdout = ([string] $run.Output).Trim()
        $stderr = ([string] $run.Errors).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) " +
            "out_null=$($null -eq $run.Output) err_null=$($null -eq $run.Errors)"
        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $stderr | Should -BeNullOrEmpty -Because $shape
        # Exactly the one word: the setup flow announces itself with a banner
        # before it does anything, so any of it running shows up here.
        $stdout | Should -Be 'LOADED' -Because $shape
    }

    It 'defines the sequences Start-Alcove.ps1 dot-sources it for' {
        # The launcher carries no copy of these: it calls them through the
        # dot-source, so each has to sit above the guard rather than in the flow
        # below it. A move past the guard leaves the launcher's network branch
        # calling functions that are not there, on a path no test here reaches.
        foreach ($name in 'Resolve-DropPath', 'Read-ShareCredential',
                          'New-ShareVolume', 'Invoke-Docker', 'Hide-Secret',
                          'Get-RendezvousFolderName') {
            Get-Command $name -ErrorAction SilentlyContinue |
                Should -Not -BeNullOrEmpty -Because $name
        }
    }

    It 'leaves an ordinary run running the setup flow' {
        # Docker is taken off the PATH for this call. The flow asks the engine
        # for its version immediately after the banner, and a runner whose
        # engine answered would carry it on into an image pull.
        $originalPath = $env:PATH
        try {
            $env:PATH = @(
                (Join-Path $env:SystemRoot 'System32'),
                $env:SystemRoot,
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
            ) -join ';'
            $run = Start-PowerShellChild -Arguments @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setupScript`"") -TimeoutSeconds 120
        } finally {
            $env:PATH = $originalPath
        }

        $run.TimedOut | Should -BeFalse
        $run.Output | Should -Match 'Alcove file-drop setup'
        # A null exit must not satisfy "not zero": the guard would then pass
        # vacuously on the same helper fault the dot-source test caught.
        $run.Exit | Should -Not -BeNullOrEmpty
        $run.Exit | Should -Not -Be 0
    }
}

Describe 'Resolve-DropPath on paths that need no rig' {
    It 'reads a bare UNC share as server and share with no subdirectory' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\exchange'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'fileserver'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -BeNullOrEmpty
        $resolved.Unc | Should -Be '\\fileserver\exchange'
        $resolved.Full | Should -Be '\\fileserver\exchange'
    }

    It 'reports the subdirectory with forward slashes for the mount option' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\exchange\alcove\drop'

        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'alcove/drop'
        $resolved.Unc | Should -Be '\\fileserver\exchange'
        $resolved.Full | Should -Be '\\fileserver\exchange\alcove\drop'
    }

    It 'folds forward slashes before splitting the share off' {
        $resolved = Resolve-DropPath -Raw '//fileserver/exchange/alcove'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'fileserver'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'alcove'
    }

    It 'strips surrounding quotes and whitespace' {
        $resolved = Resolve-DropPath -Raw '  "\\fileserver\exchange\alcove"  '

        $resolved.Kind | Should -Be 'Network'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'alcove'
    }

    It 'ignores a trailing separator' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\exchange\'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -BeNullOrEmpty
    }

    It 'keeps a dollar sign and dots in a hidden share on a fully qualified server' {
        $resolved = Resolve-DropPath -Raw '\\fs-04.agency.gov\exchange$\dropbox'

        $resolved.Server | Should -Be 'fs-04.agency.gov'
        $resolved.Share | Should -Be 'exchange$'
        $resolved.SubPath | Should -Be 'dropbox'
    }

    It 'keeps spaces inside a share and a folder name' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\my share\sub folder'

        $resolved.Share | Should -Be 'my share'
        $resolved.SubPath | Should -Be 'sub folder'
    }

    It 'unwraps the \\?\UNC\ device prefix' {
        $resolved = Resolve-DropPath -Raw '\\?\UNC\fileserver\exchange\alcove'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'fileserver'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'alcove'
    }

    It 'unwraps the \\.\ device prefix' {
        $resolved = Resolve-DropPath -Raw '\\.\C:\Exchange'

        $resolved.Kind | Should -Be 'Local'
        $resolved.LocalPath | Should -Be 'C:\Exchange'
    }

    It 'refuses a UNC that names a server and no share' {
        $resolved = Resolve-DropPath -Raw '\\fileserver'

        $resolved.Kind | Should -Be 'Unknown'
        $resolved.Reason | Should -Match 'names the server'
        $resolved.Reason | Should -Match 'fileserver'
    }

    It 'refuses an empty path' {
        (Resolve-DropPath -Raw '').Kind | Should -Be 'Unknown'
        (Resolve-DropPath -Raw '').Reason | Should -Be 'empty path'
        (Resolve-DropPath -Raw '   ').Reason | Should -Be 'empty path'
    }

    It 'refuses text that is not a path at all' {
        $resolved = Resolve-DropPath -Raw 'the exchange folder'

        $resolved.Kind | Should -Be 'Unknown'
        $resolved.Reason | Should -Match 'could not interpret'
    }

    It 'refuses a relative path' {
        (Resolve-DropPath -Raw 'exchange\alcove').Kind | Should -Be 'Unknown'
    }
}

Describe 'Drive-kind classification' {
    It 'reads the system drive as fixed and its paths as local' {
        Get-DriveKind -Letter 'C' | Should -Be 'Fixed'

        $resolved = Resolve-DropPath -Raw 'C:\Exchange\alcove'
        $resolved.Kind | Should -Be 'Local'
        $resolved.LocalPath | Should -Be 'C:\Exchange\alcove'
    }

    It 'reads a letter no drive holds as absent' {
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty -Because 'the classification needs a letter nothing holds'

        Get-DriveKind -Letter $letter | Should -Be 'Absent'
    }

    It 'refuses a letter that resolves to nothing, and says which case it is' {
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty

        $resolved = Resolve-DropPath -Raw "${letter}:\Exchange"
        $resolved.Kind | Should -Be 'Unknown'
        # The two arms differ by what the session can see, so the run's own
        # elevation decides which message is the right one.
        if (Test-Elevated) {
            $resolved.Reason | Should -Match 'running as Administrator'
        } else {
            $resolved.Reason | Should -Match "there is no ${letter}: drive"
        }
    }
}

Describe 'The reason a path could not be used' {
    It 'says retyping will not help in an elevated window' {
        # Test-Elevated answers for the window the run is in, and this suite
        # cannot put its own run in an elevated one: it stands in for that one
        # question, and the reason the answer selects is what is read back.
        function Test-Elevated { return $true }
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty -Because 'the reason needs a letter nothing holds'

        $resolved = Resolve-DropPath -Raw "${letter}:\Exchange"

        $resolved.Kind | Should -Be 'Unknown'
        $resolved.RetypingWillNotHelp | Should -BeTrue
        # Every reason is printed as a sentence of its own, so every reason
        # starts as one. Matched with the case held, which -Match would not.
        $resolved.Reason | Should -MatchExactly '^This window is running as Administrator'
    }

    It 'leaves the flag off a reason that a different path would answer' {
        function Test-Elevated { return $false }
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty

        $absent = Resolve-DropPath -Raw "${letter}:\Exchange"

        $absent.RetypingWillNotHelp | Should -BeNullOrEmpty
        $absent.Reason | Should -MatchExactly "^There is no ${letter}: drive"
        (Resolve-DropPath -Raw 'the exchange folder').Reason | Should -MatchExactly '^Could not interpret'
        (Resolve-DropPath -Raw '').Reason | Should -MatchExactly '^Empty path'
    }
}

Describe 'The shared folder name the console is told' {
    It 'names a folder on this PC by its own last segment' {
        Get-RendezvousFolderName -Path 'C:\Users\dana\Egnyte\agency-a-agency-b' |
            Should -Be 'agency-a-agency-b'
    }

    It 'ignores a trailing separator, and reads either one' {
        Get-RendezvousFolderName -Path 'C:\drops\studyA\' | Should -Be 'studyA'
        Get-RendezvousFolderName -Path 'C:/drops/studyA' | Should -Be 'studyA'
    }

    It 'names a share subfolder rather than the mount the volume is bound at' {
        # The network shape mounts a named volume, so no host path reaches the
        # container at all: the share is where the name has to come from.
        Get-RendezvousFolderName -Share 'exchange' -SubPath 'agency-a/agency-b' |
            Should -Be 'agency-b'
    }

    It 'names the share itself when the folder is the share root' {
        Get-RendezvousFolderName -Share 'exchange' | Should -Be 'exchange'
    }

    It 'reads a subfolder the command line supplied with backslashes' {
        # -SubPath is normalised to forward slashes before the flow reaches the
        # console command, but the rule is not allowed to depend on that.
        Get-RendezvousFolderName -Share 'exchange' -SubPath 'agency-a\agency-b' |
            Should -Be 'agency-b'
    }

    It 'gives no name for a drive root, which has none' {
        # Naming it 'D:' would ask the partner to match a drive letter that means
        # nothing on their machine; the console degrades to no name instead.
        Get-RendezvousFolderName -Path 'D:\' | Should -BeNullOrEmpty
        Get-RendezvousFolderName -Path 'D:' | Should -BeNullOrEmpty
    }

    It 'gives no name for a path it could read no segment out of' {
        Get-RendezvousFolderName -Path '' | Should -BeNullOrEmpty
        Get-RendezvousFolderName -Path '\' | Should -BeNullOrEmpty
    }
}

Describe 'The console command the closing screen prints' {
    It 'mounts the volume the run created, and the work folder beside it' {
        $lines = @(Get-ConsoleCommandLines -VolumeName 'alcove-sync' -RendezvousName 'agency-b')

        ($lines -join "`n") | Should -Match "-v 'alcove-sync:/sync'"
        ($lines -join "`n") | Should -Match "-v 'C:\\path\\to\\your\\work:/data'"
        ($lines -join "`n") | Should -Match 'JOB_RENDEZVOUS_DIR=/sync'
    }

    It 'carries the folder name the naming rule reads off the share' {
        # The whole path the closing screen takes, driven end to end: the share
        # and subfolder the run resolved reduce to one name, and that is what the
        # operator is told to pass.
        $lines = @(Get-ConsoleCommandLines -VolumeName 'alcove-sync' `
            -RendezvousName (Get-RendezvousFolderName -Share 'exchange' -SubPath 'agency-a/agency-b'))

        ($lines -join "`n") | Should -Match "JOB_RENDEZVOUS_NAME=agency-b'"
    }

    It 'carries the share itself when the drop folder is the share root' {
        $lines = @(Get-ConsoleCommandLines -VolumeName 'alcove-sync' `
            -RendezvousName (Get-RendezvousFolderName -Share 'exchange' -SubPath ''))

        ($lines -join "`n") | Should -Match "JOB_RENDEZVOUS_NAME=exchange'"
    }

    It 'passes an empty name rather than leaving the variable out' {
        # An omitted variable has the console name the folder after the mount
        # point THIS script picked -- sync -- and mint that as the name the
        # partner is told to look for.
        $lines = @(Get-ConsoleCommandLines -VolumeName 'alcove-sync')

        ($lines -join "`n") | Should -Match "JOB_RENDEZVOUS_NAME='"
        # The quote closes immediately: anything else between the = and it is a
        # name, and the mount point is what an omitted variable would leave.
        ($lines -join "`n") | Should -Not -Match "JOB_RENDEZVOUS_NAME=[^']"
    }

    It 'ends every line but the last with the continuation that joins them' {
        # The command is pasted as printed: a line that lost its continuation
        # runs as a command of its own, and the rest as arguments to nothing.
        $lines = @(Get-ConsoleCommandLines -VolumeName 'alcove-sync' -RendezvousName 'agency-b')

        $lines.Count | Should -BeGreaterThan 1
        foreach ($line in $lines[0..($lines.Count - 2)]) {
            $line | Should -Match '`$'
        }
        $lines[-1] | Should -Not -Match '`$'
    }
}

Describe 'The dialect map' {
    It 'gives SMB3 the 3.1.1 the checks negotiate' {
        Get-DialectMountVersion -Dialect 'SMB3' | Should -Be '3.1.1'
    }

    It 'gives SMB2 and NT1 their mount versions' {
        Get-DialectMountVersion -Dialect 'SMB2' | Should -Be '2.1'
        Get-DialectMountVersion -Dialect 'NT1' | Should -Be '1.0'
    }

    It 'answers nothing for a name it does not carry' {
        # The map is closed; -Dialect's ValidateSet is what keeps the flow off
        # this branch, and an empty dialect never reaches the map at all.
        Get-DialectMountVersion -Dialect 'SMB3.02' | Should -BeNullOrEmpty
        Get-DialectMountVersion -Dialect '' | Should -BeNullOrEmpty
    }
}

Describe 'Split-TextToWidth' {
    It 'wraps at the width and splits no word' {
        $text = 'There is no Z: drive on this PC. If it is a network drive that is ' +
            'not connected right now, open it in File Explorer first, then run the script again.'

        $lines = Split-TextToWidth -Text $text -Width 40

        (@($lines).Count -gt 1) | Should -BeTrue
        foreach ($line in $lines) { ($line.Length -le 40) | Should -BeTrue -Because $line }
        # Nothing added and nothing lost: the wrap is where the spaces already were.
        ($lines -join ' ') | Should -Be $text
    }

    It 'gives a word longer than the width a line of its own rather than breaking it' {
        # A share path is one word and can be longer than the block it is
        # printed in. Broken across two lines it is no longer a path the
        # operator can copy.
        $path = '\\fs-04.agency.gov\exchange$\clinic-study\from-clinic'

        $lines = Split-TextToWidth -Text "$path is gone" -Width 20

        $lines[0] | Should -Be $path
    }

    It 'gives its caller no line to print for text that holds no word' {
        # Read as the callers read it: each of them prints what it is given a
        # line at a time, and a reason that came to nothing prints nothing
        # rather than an empty line.
        $printed = @()
        foreach ($line in (Split-TextToWidth -Text '')) { $printed += $line }
        foreach ($line in (Split-TextToWidth -Text '   ')) { $printed += $line }

        $printed.Count | Should -Be 0
    }
}

Describe 'Hide-Secret' {
    It 'removes every occurrence of the password' {
        $masked = Hide-Secret -Text 'o=username=bob,password=hunter2,domain=x hunter2' -Secret 'hunter2'

        $masked | Should -Not -Match 'hunter2'
        $masked | Should -Be 'o=username=bob,password=<password removed>,domain=x <password removed>'
    }

    It 'returns the text unchanged when there is no secret to remove' {
        Hide-Secret -Text 'nothing to hide' -Secret '' | Should -Be 'nothing to hide'
        Hide-Secret -Text 'nothing to hide' -Secret $null | Should -Be 'nothing to hide'
    }

    It 'carries empty text through' {
        Hide-Secret -Text '' -Secret 'hunter2' | Should -BeNullOrEmpty
        Hide-Secret -Text $null -Secret 'hunter2' | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-Docker' {
    BeforeAll {
        $script:EngineStubRoot = Join-Path $env:TEMP ('alcove-engine-stub-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

        # Each stub is a docker.cmd in a folder of its own, put ahead of the PATH
        # for the one call, because the wrapper calls docker by name.
        #
        # A native command that answers on both streams and exits non-zero,
        # which is the engine's own routine behaviour: docker writes "no such
        # volume" to standard error on every first run.
        $script:NoisyEngine = Join-Path $script:EngineStubRoot 'noisy'
        New-Item -ItemType Directory -Path $script:NoisyEngine -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:NoisyEngine 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            'echo answered on stdout',
            'echo grumbled on stderr 1>&2',
            'exit /b 3')

        # The same, with a blank line ahead of the message: a container's own
        # output has them, and each redirected line reaches the wrapper as an
        # error record whose ToString() answers with a type name when the line
        # it holds is empty.
        $script:BlankLineEngine = Join-Path $script:EngineStubRoot 'blankline'
        New-Item -ItemType Directory -Path $script:BlankLineEngine -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:BlankLineEngine 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            '>&2 echo(',
            '>&2 echo could not mount the share',
            'exit /b 1')

        $script:NoEngine = Join-Path $script:EngineStubRoot 'none'
        New-Item -ItemType Directory -Path $script:NoEngine -Force | Out-Null

        function Invoke-DockerFrom {
            <#  -EngineOnly leaves the Windows folders off the PATH: a hosted
                runner keeps a real docker in one of them. #>
            param([Parameter(Mandatory = $true)][string] $EngineRoot, [switch] $EngineOnly)

            $originalPath = $env:PATH
            try {
                $env:PATH = if ($EngineOnly) { $EngineRoot }
                else { @($EngineRoot, (Join-Path $env:SystemRoot 'System32'), $env:SystemRoot) -join ';' }
                return (Invoke-Docker -DockerArgs @('version'))
            } finally {
                $env:PATH = $originalPath
            }
        }
    }

    AfterAll {
        Remove-Item -LiteralPath $script:EngineStubRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'answers a PC with no docker without borrowing an earlier code' {
        # A native command run first, leaving a 0 in $LASTEXITCODE, so that the
        # answer below cannot have been taken from there -- a 0 would read as an
        # engine that ran and was happy. What the call itself does without the
        # guard is the last case below.
        & cmd /c exit 0

        $result = Invoke-DockerFrom -EngineRoot $script:NoEngine -EngineOnly

        $result.Ran | Should -Be $false
        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match 'docker is not a command'
    }

    It 'carries a stderr-writing command''s output and code back rather than throwing' {
        # The preference the script runs under, restated here because it is the
        # whole reason the redirect inside Invoke-Docker relaxes it.
        $ErrorActionPreference = 'Stop'

        $result = Invoke-DockerFrom -EngineRoot $script:NoisyEngine

        $result.Ran | Should -Be $true
        $result.ExitCode | Should -Be 3
        $result.Output | Should -Match 'answered on stdout'
        $result.Output | Should -Match 'grumbled on stderr'
    }

    It 'reads a blank stderr line as a blank line and a message as itself' {
        $ErrorActionPreference = 'Stop'

        $result = Invoke-DockerFrom -EngineRoot $script:BlankLineEngine

        $result.Ran | Should -Be $true
        $result.Output | Should -Match 'could not mount the share'
        # What the operator is shown in place of the blank line without the
        # message being read off the record.
        $result.Output | Should -Not -Match 'RemoteException'
    }

    It 'would end the run on a redirected stderr line without the relaxed preference' {
        # The premise the relaxed preference inside Invoke-Docker exists for,
        # held as a check rather than asserted in a comment: at 'Stop', Windows
        # PowerShell turns a native program's redirected standard error into a
        # terminating record, whatever its exit code says.
        $ErrorActionPreference = 'Stop'
        $threw = $false

        try { $null = & (Join-Path $script:NoisyEngine 'docker.cmd') 2>&1 } catch { $threw = $true }

        $threw | Should -BeTrue
    }

    It 'would end the run on a name that is not a command without the guard' {
        # The premise the guard stands in for: the call raises rather than
        # answering, and the relaxed preference the wrapper runs under does not
        # soften it -- so a wrapper without the guard never returns anything a
        # caller could report.
        $ErrorActionPreference = 'Continue'
        $threw = $false
        $raised = ''

        try { & 'alcove-no-such-engine' 'version' } catch {
            $threw = $true
            $raised = $_.Exception.GetType().Name
        }

        $threw | Should -BeTrue
        $raised | Should -Be 'CommandNotFoundException'
    }
}

Describe 'The engine the setup script chooses' {
    BeforeEach {
        $script:EnginesAsked = @()
    }

    It 'chooses podman when docker is not installed' {
        function Invoke-Docker {
            param([string[]] $DockerArgs, [string] $Engine)
            $script:EnginesAsked += "$Engine $($DockerArgs -join ' ')"
            if ($Engine -eq 'podman') { return @{ Ran = $true; Output = 'podman version 5.1.0'; ExitCode = 0 } }
            return @{ Ran = $false; Output = "$Engine is not a command on this PC."; ExitCode = 127 }
        }

        $found = Find-SetupEngine

        $found.Engine | Should -Be 'podman'
        ($script:EnginesAsked -join '|') |
            Should -Be 'docker version --format {{.Server.Os}} {{.Server.Version}}|podman version'
    }

    It 'keeps docker when it answers, without asking podman' {
        function Invoke-Docker {
            param([string[]] $DockerArgs, [string] $Engine)
            $script:EnginesAsked += $Engine
            return @{ Ran = $true; Output = 'linux 27.1.1'; ExitCode = 0 }
        }

        $found = Find-SetupEngine

        $found.Engine | Should -Be 'docker'
        $found.Output | Should -Be 'linux 27.1.1'
        ($script:EnginesAsked -join ',') | Should -Be 'docker'
    }

    It 'chooses nothing when neither answers, keeping what the installed one said' {
        function Invoke-Docker {
            param([string[]] $DockerArgs, [string] $Engine)
            if ($Engine -eq 'docker') { return @{ Ran = $true; Output = 'access is denied'; ExitCode = 1 } }
            return @{ Ran = $false; Output = "$Engine is not a command on this PC."; ExitCode = 127 }
        }

        $found = Find-SetupEngine

        $found.Engine | Should -BeNullOrEmpty
        $found.Output | Should -Be 'access is denied'
    }
}

Describe 'The setup flow, driven against a stub engine' {
    BeforeAll {
        # Whole engines, each named docker.cmd so the flow's own `docker` calls
        # reach it through the PATH, each appending every call it was given to
        # ALCOVE_STUB_LOG, which is what lets a test assert what the flow did
        # NOT go on to run.
        #
        # Labels rather than parenthesised blocks: a `)` anywhere in what a stub
        # prints would close a block early.
        $script:PresentImageEngineRoot = Join-Path $env:TEMP ('alcove-flow-present-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $script:NoImageEngineRoot = Join-Path $env:TEMP ('alcove-flow-noimage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $script:PresentImageEngineRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $script:NoImageEngineRoot -Force | Out-Null

        # Answers the version question and has the image, and refuses every
        # other call loudly: any `docker run` at all reaches the unexpected-call
        # arm, which exits 99 and names the call it was given. That is what
        # makes "the local answer runs no container" an assertion rather than a
        # reading of the flow.
        Set-Content -LiteralPath (Join-Path $script:PresentImageEngineRoot 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            '>>"%ALCOVE_STUB_LOG%" echo %*',
            'echo %*| findstr /C:"version --format" >nul',
            'if not errorlevel 1 goto engineversion',
            'echo %*| findstr /C:"image inspect" >nul',
            'if not errorlevel 1 goto imagepresent',
            'echo unexpected engine call: %*',
            'exit /b 99',
            ':engineversion',
            'echo linux 27.1.1',
            'exit /b 0',
            ':imagepresent',
            'exit /b 0')

        # Has no copy of the image and cannot reach the registry for one.
        Set-Content -LiteralPath (Join-Path $script:NoImageEngineRoot 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            '>>"%ALCOVE_STUB_LOG%" echo %*',
            'echo %*| findstr /C:"version --format" >nul',
            'if not errorlevel 1 goto engineversion',
            'echo %*| findstr /C:"image inspect" >nul',
            'if not errorlevel 1 goto imageabsent',
            'echo %*| findstr /C:"pull" >nul',
            'if not errorlevel 1 goto pullrefused',
            'echo unexpected engine call: %*',
            'exit /b 99',
            ':engineversion',
            'echo linux 27.1.1',
            'exit /b 0',
            ':imageabsent',
            'exit /b 1',
            ':pullrefused',
            'echo error response from daemon: the proxy refused the connection 1>&2',
            'exit /b 1')

        # The setup script with the elevation question answered, for the one
        # reason an elevated window gets: this suite cannot put a run in such a
        # window, and the answer decides which reason the flow prints. Injected
        # above the guard line so that it replaces the script's own definition,
        # which is where the launcher's flow suite puts its credential answer.
        $script:ElevatedSetupScript = Join-Path $script:PresentImageEngineRoot 'Setup-AlcoveFileDrop.ps1'
        $setupSource = Get-Content -Raw -LiteralPath $setupScript
        $guardLine = "if (`$LoadFunctionsOnly) { return }"
        $answeredElevation = @(
            'function Test-Elevated { return $true }',
            '') -join [Environment]::NewLine
        $patchedSetup = $setupSource.Replace($guardLine, $answeredElevation + $guardLine)
        if ($patchedSetup -eq $setupSource) { throw 'the setup script no longer carries the guard line this suite patches' }
        [IO.File]::WriteAllText($script:ElevatedSetupScript, $patchedSetup)

        function Invoke-SetupWithEngine {
            <#  Run the setup flow with one of the stub engines ahead of a
                minimal PATH, and return the run beside the calls the engine
                recorded. The PATH is cut down to the system directories for the
                same reason the -LoadFunctionsOnly guard's own flow test cuts
                it: a runner with a real Docker would otherwise answer first.

                -TimeoutSeconds is a backstop for a run that ends on its own.
                -InputLines answers the prompts a run reaches. #>
            param(
                [Parameter(Mandatory = $true)][string] $EngineRoot,
                [Parameter(Mandatory = $true)][string] $SetupScript,
                [string[]] $ScriptArguments = @(),
                [string[]] $InputLines = @(),
                [int] $TimeoutSeconds = 120
            )

            $log = Join-Path $EngineRoot ('calls-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.log')
            $originalPath = $env:PATH
            $originalLog = $env:ALCOVE_STUB_LOG
            try {
                $env:ALCOVE_STUB_LOG = $log
                $env:PATH = @(
                    $EngineRoot,
                    (Join-Path $env:SystemRoot 'System32'),
                    $env:SystemRoot,
                    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
                ) -join ';'
                $run = Start-PowerShellChild -Arguments (@(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$SetupScript`"") +
                    $ScriptArguments) -InputLines $InputLines -TimeoutSeconds $TimeoutSeconds
            } finally {
                $env:PATH = $originalPath
                if ($null -eq $originalLog) { Remove-Item env:ALCOVE_STUB_LOG -ErrorAction SilentlyContinue }
                else { $env:ALCOVE_STUB_LOG = $originalLog }
            }

            $calls = ''
            if (Test-Path -LiteralPath $log) {
                $calls = [string] (Get-Content -LiteralPath $log -Raw)
            }
            return [ordered]@{
                TimedOut = $run.TimedOut
                Exit     = $run.Exit
                Output   = [string] $run.Output
                Errors   = [string] $run.Errors
                Calls    = $calls
            }
        }

        function Get-RunShape {
            param($Run)
            $output = [string] $Run.Output
            return "timedout=$($Run.TimedOut) exit=$($Run.Exit) calls=$($Run.Calls) tail=" +
                (($output.Substring([Math]::Max(0, $output.Length - 200))) -replace '\s+', ' ')
        }

        function Get-RunLines {
            param($Run)
            return (@(([string] $Run.Output).TrimEnd() -split '\r?\n' | ForEach-Object { $_.TrimEnd() }) -join "`n")
        }

        function Assert-SetupEndsWith {
            <#  That a run ended where it should, on exactly the lines given: the
                last lines of the window, each compared whole, so a change to a
                word of the screen fails here. Trailing spaces are dropped on
                both sides, because an empty Write-Info leaves its indent behind
                and nobody reading the window sees it. #>
            param($Run, [int] $Exit, [string[]] $Screen)

            $shape = Get-RunShape -Run $Run
            $Run.TimedOut | Should -BeFalse -Because $shape
            $Run.Exit | Should -Be $Exit -Because $shape

            $lines = @((Get-RunLines -Run $Run) -split "`n")
            $expected = @($Screen | ForEach-Object { $_.TrimEnd() })
            (@($lines | Select-Object -Last $expected.Count) -join "`n") |
                Should -BeExactly ($expected -join "`n") -Because $shape
        }

        function Assert-SetupShows {
            <#  That a run printed the lines given, one after another and each
                compared whole, somewhere in the window: for a screen followed
                by a prompt, whose own line a redirected run renders as it
                likes. #>
            param($Run, [int] $Exit, [string[]] $Screen)

            $shape = Get-RunShape -Run $Run
            $Run.TimedOut | Should -BeFalse -Because $shape
            $Run.Exit | Should -Be $Exit -Because $shape

            $expected = (@($Screen | ForEach-Object { $_.TrimEnd() }) -join "`n")
            (Get-RunLines -Run $Run).Contains($expected) | Should -BeTrue -Because "$shape expected=$expected"
        }
    }

    AfterAll {
        Remove-Item -LiteralPath $script:PresentImageEngineRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $script:NoImageEngineRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'runs no container at all for a folder that turns out to be local' {
        # The local answer prints a direct -v mount and leaves, so it must not
        # be made to survive a container first.
        $run = Invoke-SetupWithEngine -EngineRoot $script:PresentImageEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-DropPath', 'C:\alcove-local-drop')
        $shape = Get-RunShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $run.Output | Should -Match 'already local' -Because $shape
        $run.Output | Should -Match 'do not need a volume at all' -Because $shape
        $run.Output | Should -Not -Match 'unexpected engine call' -Because $shape
        $run.Calls | Should -Match 'image inspect' -Because $run.Calls
        # The image is present, so nothing has any reason to fetch one.
        $run.Calls | Should -Not -Match 'pull' -Because $run.Calls
    }

    It 'fetches an image the PC does not have, and stops on what Docker said when it cannot' {
        $run = Invoke-SetupWithEngine -EngineRoot $script:NoImageEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-Server', 'fs-04.agency.gov', '-Share', 'exchange', '-SkipConfirm')
        $shape = Get-RunShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        # `pull --quiet` prints nothing until it is done, so a fetch that said
        # nothing first would read as a hang.
        $run.Output | Should -Match 'few hundred megabytes' -Because $shape
        $run.Output | Should -Match 'Could not fetch the Alcove image' -Because $shape
        $run.Output | Should -Match 'proxy refused the connection' -Because $shape
        $run.Output | Should -Match 'Start-Alcove\.ps1 can get\s+the image from Docker Hub instead' -Because $shape
        $run.Output | Should -Not -Match 'credentials for the file server' -Because $shape
        @([regex]::Matches($run.Calls, 'pull --quiet')).Count | Should -Be 1 -Because $run.Calls
    }

    It 'puts the confirmation again for an answer that is neither yes nor no' {
        # Everything below this prompt depends on the three values it
        # confirms, and an answer that is neither yes nor no settles nothing
        # about them. A reserved TLD (RFC 6761) for the server, because the flow
        # asks Windows whether it can reach the path on the way down, and no
        # machine can ever answer to this one.
        $run = Invoke-SetupWithEngine -EngineRoot $script:PresentImageEngineRoot -SetupScript $setupScript `
            -ScriptArguments @('-DropPath', '\\fs-04.invalid\exchange\alcove') `
            -InputLines @('B', 'n') -TimeoutSeconds 60
        $shape = Get-RunShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $run.Output | Should -Match 'Answer y or n' -Because $shape
        # Where the answer after it took the run: the no it was, rather than the
        # yes that reading only the first answer would have made of it.
        $run.Output | Should -Match 'Run the script again with the real values' -Because $shape
    }

    It 'leaves the retype advice off a reason that retyping would not answer' {
        # An elevated window cannot see the drive letters the operator mapped as
        # themselves, and no path they could type instead would be found either:
        # the remedy is to close the window, which the advice would talk over.
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty -Because 'the reason needs a letter nothing holds'

        $run = Invoke-SetupWithEngine -EngineRoot $script:PresentImageEngineRoot `
            -SetupScript $script:ElevatedSetupScript `
            -ScriptArguments @('-DropPath', "${letter}:\Exchange") -TimeoutSeconds 60

        Assert-SetupEndsWith -Run $run -Exit 1 -Screen @(
            ('=' * 72),
            'Part 1: locating the file drop',
            ('=' * 72),
            '  FAIL  Could not use that path.',
            '',
            '        This window is running as Administrator, and an elevated session',
            "        cannot see the drive letters you mapped as yourself -- ${letter}: is",
            '        invisible here even if File Explorer shows it. Close this window,',
            '        open PowerShell normally, and run the script again.')
    }

    It 'keeps the retype advice for a reason that a different path would answer' {
        $run = Invoke-SetupWithEngine -EngineRoot $script:PresentImageEngineRoot -SetupScript $setupScript `
            -ScriptArguments @('-DropPath', 'the exchange folder') -TimeoutSeconds 60
        $shape = Get-RunShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $run.Output | Should -Match 'Could not interpret' -Because $shape
        $run.Output | Should -Match 'Enter it as a drive letter path' -Because $shape
    }

    Context 'what the checks printed, replayed through each screen' {
        BeforeAll {
            # What `alcove doctor` prints for each outcome below, recorded from
            # the checks themselves: apps/cli/src/doctor/probe.ts and mount.ts
            # run against a server and a folder that answer that way, rendered
            # by verdict.ts. The 64 lines are the CLI's own refusal of an
            # input, from smbEnvironment.ts, timestamp and all.
            $script:ProbePortClosed = @(
                'OK: resolved to 10.20.30.40.',
                'FAIL: cannot reach fs-04.agency.gov:445.',
                'MEANING: this container reaches the network through its runtime''s address',
                '         translation, so to the file server it looks like a different',
                '         machine than Windows does. A VPN that routes only the Windows side,',
                '         a host firewall rule, or a server-side address restriction blocks',
                '         it while File Explorer keeps working.',
                'ACTION:  if you are on a VPN, that is the likely cause. See the',
                '         troubleshooting page, ''The container cannot reach the server''.',
                'SKIP: finding smbclient in this image - not run.',
                'SKIP: signing in to the server - not run.',
                'SKIP: opening the share - not run.',
                'SKIP: opening the folder inside the share - not run.',
                'SKIP: reading the free space on the share - not run.',
                'SKIP: creating a file - not run.',
                'SKIP: renaming a file - not run.',
                'SKIP: deleting a file - not run.',
                'SKIP: leaving the cross-check file for `alcove doctor mount` - not run.',
                'MEANING: an earlier check failed and stopped the run, so nothing was',
                '         established either way about what did not run.',
                '',
                'NOT READY YET - follow the ACTION lines above and run this again.')
            $script:ProbeNoSmbclient = @(
                'OK: resolved to 10.20.30.40.',
                'OK: port 445 is open.',
                'FAIL: smbclient is not in the image these checks are running in.',
                'MEANING: this copy of the Alcove image predates the checks. Nothing has been',
                '         established about the credentials, the share, the folder, or write',
                '         access; the name and reachability checks above stand.',
                'ACTION:  use a current Alcove release and run this again.',
                'SKIP: signing in to the server - not run.',
                'SKIP: opening the share - not run.',
                'SKIP: opening the folder inside the share - not run.',
                'SKIP: reading the free space on the share - not run.',
                'SKIP: creating a file - not run.',
                'SKIP: renaming a file - not run.',
                'SKIP: deleting a file - not run.',
                'SKIP: leaving the cross-check file for `alcove doctor mount` - not run.',
                'MEANING: an earlier check failed and stopped the run, so nothing was',
                '         established either way about what did not run.',
                '',
                'COULD NOT RUN THE CHECKS - nothing was established either way.')
            $script:ProbeRefusedServer = @(
                '[2026-10-28T17:21:06.949Z] [ERROR] [doctor-probe] alcove doctor cannot run with the environment it was given: SMB_SERVER must not contain a path separator')
            $script:MountWriteDenied = @(
                'OK: /rz is readable.',
                'OK: the mount and the network checks agree on this folder.',
                'FAIL: could not write and rename in this folder (EACCES).',
                'MEANING: the mount reached a folder but Alcove cannot write in it. Either',
                '         the account this container runs as does not own the folder, or it',
                '         can open the folder but not create files in it, or the share is out',
                '         of space.',
                'ACTION:  see the troubleshooting page, ''The folder cannot be written to''.',
                'SKIP: refusing to create a file twice - not run.',
                'SKIP: renaming onto an existing file - not run.',
                'MEANING: an earlier check failed and stopped the run, so nothing was',
                '         established either way about what did not run.',
                '',
                'NOT READY YET - follow the ACTION lines above and run this again.')
            $script:MountUnreadable = @(
                'FAIL: /rz could not be read (ENOENT).',
                'MEANING: the folder the exchange runs in is not there, or is not a directory',
                '         this process can list. Nothing about the share itself has been',
                '         established.',
                'ACTION:  check that the volume is mounted at this path and that the',
                '         container was started with it attached.',
                'SKIP: matching the file the network checks left behind - not run.',
                'SKIP: writing a file and renaming it into place - not run.',
                'SKIP: refusing to create a file twice - not run.',
                'SKIP: renaming onto an existing file - not run.',
                'MEANING: an earlier check failed and stopped the run, so nothing was',
                '         established either way about what did not run.',
                '',
                'COULD NOT RUN THE CHECKS - nothing was established either way.')
            $script:MountRefusedToken = @(
                '[2026-10-28T17:21:15.721Z] [ERROR] [doctor-mount] alcove doctor cannot run with the environment it was given: SMB_TOKEN must be letters, digits, dash, or underscore')

            $script:ReplayRoot = Join-Path $env:TEMP ('alcove-flow-replay-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $script:ReplayRoot -Force | Out-Null

            # The credential prompt answered: the password is read with
            # Read-Host -AsSecureString, which reads the console rather than the
            # redirected standard input, so nothing past it could be reached
            # otherwise. A prompt's text goes to the console too, and never
            # reaches the output captured here, so each is also written where
            # the run's other lines go before the prompt itself is put.
            $script:AnsweredSetupScript = Join-Path $script:ReplayRoot 'Setup-AlcoveFileDrop.ps1'
            $replaySource = Get-Content -Raw -LiteralPath $setupScript
            $replayGuard = "if (`$LoadFunctionsOnly) { return }"
            $answeredCredential = @(
                'function Read-ShareCredential {',
                '    param([string] $Username, [string] $Domain, [switch] $DomainSupplied)',
                "    return @{ Username = 'alcoveci'; Domain = ''; Password = 'hunter2' }",
                '}',
                'function Read-Host {',
                '    param([string] $Prompt)',
                '    Write-Host $Prompt',
                '    return (Microsoft.PowerShell.Utility\Read-Host -Prompt $Prompt)',
                '}',
                '') -join [Environment]::NewLine
            $patchedReplay = $replaySource.Replace($replayGuard, $answeredCredential + $replayGuard)
            if ($patchedReplay -eq $replaySource) { throw 'the setup script no longer carries the guard line this suite patches' }
            [IO.File]::WriteAllText($script:AnsweredSetupScript, $patchedReplay)

            function New-ReplayEngine {
                <#  An engine that answers preflight as a PC with the image does,
                    makes every volume asked of it, and answers each battery
                    with the lines and exit code given, written to standard
                    error, where the image writes them. The lines go through a
                    file and `type` rather than `echo`, which would read the
                    parentheses and backticks in them.

                    -RetriedProbeExit, when given, is what every probe after the
                    first answers, with no lines.

                    -EngineStopsAfterStart makes every version query after the
                    first exit 1, as an engine that stopped mid-run does.

                    -EngineName is the command the engine answers as. Any
                    version query is answered, since podman is asked a bare
                    one. #>
                param(
                    [Parameter(Mandatory = $true)][string] $Name,
                    [string[]] $ProbeLines = @(),
                    [int] $ProbeExit = 0,
                    [int] $RetriedProbeExit = -1,
                    [string[]] $MountLines = @(),
                    [int] $MountExit = 0,
                    [switch] $EngineStopsAfterStart,
                    [string] $EngineName = 'docker'
                )

                $root = Join-Path $script:ReplayRoot $Name
                New-Item -ItemType Directory -Path $root -Force | Out-Null
                $probeFile = Join-Path $root 'probe.txt'
                $mountFile = Join-Path $root 'mount.txt'
                $probedFile = Join-Path $root 'probed'
                $versionedFile = Join-Path $root 'versioned'
                $stopArm = @()
                if ($EngineStopsAfterStart) {
                    $stopArm = @(
                        "if exist `"$versionedFile`" exit /b 1",
                        "type nul >`"$versionedFile`"")
                }
                [IO.File]::WriteAllText($probeFile, (@($ProbeLines | ForEach-Object { "$_`r`n" }) -join ''))
                [IO.File]::WriteAllText($mountFile, (@($MountLines | ForEach-Object { "$_`r`n" }) -join ''))
                $retryArm = @()
                if ($RetriedProbeExit -ge 0) {
                    $retryArm = @(
                        "if exist `"$probedFile`" exit /b $RetriedProbeExit",
                        "type nul >`"$probedFile`"")
                }
                Set-Content -LiteralPath (Join-Path $root "$EngineName.cmd") -Encoding Ascii -Value (@(
                    '@echo off',
                    '>>"%ALCOVE_STUB_LOG%" echo %*',
                    'echo %*| findstr /B /C:"version" >nul',
                    'if not errorlevel 1 goto engineversion',
                    'echo %*| findstr /C:"image inspect" >nul',
                    'if not errorlevel 1 goto succeed',
                    'echo %*| findstr /C:"doctor probe" >nul',
                    'if not errorlevel 1 goto doctorprobe',
                    'echo %*| findstr /C:"doctor mount" >nul',
                    'if not errorlevel 1 goto doctormount',
                    'echo %*| findstr /C:"volume " >nul',
                    'if not errorlevel 1 goto succeed',
                    'echo unexpected engine call: %*',
                    'exit /b 99',
                    ':engineversion') + $stopArm + @(
                    'echo linux 27.1.1',
                    'exit /b 0',
                    ':succeed',
                    'exit /b 0',
                    ':doctorprobe') + $retryArm + @(
                    "type `"$probeFile`" 1>&2",
                    "exit /b $ProbeExit",
                    ':doctormount',
                    "type `"$mountFile`" 1>&2",
                    "exit /b $MountExit"))
                return $root
            }

            function Invoke-ReplayRun {
                param(
                    [Parameter(Mandatory = $true)][string] $EngineRoot,
                    [string] $Server = 'fs-04.agency.gov',
                    [string[]] $InputLines = @()
                )

                return (Invoke-SetupWithEngine -EngineRoot $EngineRoot -SetupScript $script:AnsweredSetupScript `
                        -ScriptArguments @('-Server', $Server, '-Share', 'exchange', '-SubPath', 'dropbox') `
                        -InputLines $InputLines)
            }

            function Add-StoppedDocker {
                <#  A docker that is installed and does not answer, beside a
                    podman engine and so ahead of any docker the runner has.
                    Its calls are logged under a prefix of their own. #>
                param([Parameter(Mandatory = $true)][string] $EngineRoot)

                Set-Content -LiteralPath (Join-Path $EngineRoot 'docker.cmd') -Encoding Ascii -Value @(
                    '@echo off',
                    '>>"%ALCOVE_STUB_LOG%" echo docker-stub %*',
                    'exit /b 1')
                return $EngineRoot
            }

            # Where part 3 leaves off and the checks' own lines begin, and where
            # part 4 does.
            $script:ProbeLead = @(
                'Running the checks against the server. They take a moment, and',
                'everything they found is printed together when they finish.',
                '')
            $script:MountLead = @('Mounting it and running the checks over it...', '')
            $script:NotReadyTail = @(
                '',
                '        The troubleshooting page explains each of these in more detail:',
                '        https://github.com/georgetown-mdi/alcove/blob/main/support/windows-network-filedrop/troubleshooting.md')
            $script:SignInAgain = 'Enter the username and password again and run the checks again? [y/N]'
        }

        AfterAll {
            Remove-Item -LiteralPath $script:ReplayRoot -Recurse -Force -ErrorAction SilentlyContinue
        }

        It 'carries a run whose checks pass through to the closing screen' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'all-0')
            $shape = Get-RunShape -Run $run

            $run.TimedOut | Should -BeFalse -Because $shape
            $run.Exit | Should -Be 0 -Because $shape
            $run.Output | Should -Match 'Ready to run an exchange' -Because $shape
            $run.Output | Should -Not -Match ([regex]::Escape($script:SignInAgain)) -Because $shape
            # The image is present, so nothing has any reason to fetch one.
            $run.Calls | Should -Not -Match 'pull' -Because $run.Calls
            $run.Calls | Should -Not -Match '--json' -Because $run.Calls
        }

        It 'runs every engine call through podman when docker does not answer' {
            $run = Invoke-ReplayRun -EngineRoot (Add-StoppedDocker -EngineRoot (
                    New-ReplayEngine -Name 'podman-all-0' -EngineName 'podman'))
            $shape = Get-RunShape -Run $run
            $dockerCalls = @(([string] $run.Calls) -split '\r?\n' | Where-Object { $_ -like 'docker-stub *' })

            $run.TimedOut | Should -BeFalse -Because $shape
            $run.Exit | Should -Be 0 -Because $shape
            $run.Output | Should -Match 'Podman is running\.' -Because $shape
            $run.Output | Should -Match 'Ready to run an exchange' -Because $shape
            $run.Output | Should -Match 'podman volume rm alcove-sync' -Because $shape
            # The one question docker was asked is whether it answers.
            $dockerCalls.Count | Should -Be 1 -Because $run.Calls
            $dockerCalls[0] | Should -BeLike 'docker-stub version*' -Because $run.Calls
            $run.Calls | Should -Match 'doctor probe' -Because $run.Calls
            $run.Calls | Should -Match 'doctor mount' -Because $run.Calls
        }

        It 'names Podman when the checks ended with 1 and podman no longer answers' {
            $run = Invoke-ReplayRun -EngineRoot (Add-StoppedDocker -EngineRoot (
                    New-ReplayEngine -Name 'podman-probe-1-stopped' -EngineName 'podman' -ProbeExit 1 -EngineStopsAfterStart))

            Assert-SetupEndsWith -Run $run -Exit 1 -Screen @(
                '',
                '  FAIL  Podman stopped during the checks.',
                '        Start the Podman machine with "podman machine start", and run',
                '        this script again.')
        }

        It 'shows a battery that is not ready whole, then offers the sign-in again with no as the default' {
            $run = Invoke-ReplayRun -InputLines @('') -EngineRoot (New-ReplayEngine -Name 'probe-78' `
                    -ProbeLines $script:ProbePortClosed -ProbeExit 78)

            Assert-SetupShows -Run $run -Exit 78 -Screen ($script:ProbeLead + $script:ProbePortClosed + $script:NotReadyTail)
            $run.Output | Should -Match ([regex]::Escape($script:SignInAgain)) -Because (Get-RunShape -Run $run)
            @([regex]::Matches($run.Calls, 'doctor probe')).Count | Should -Be 1 -Because $run.Calls
            $run.Calls | Should -Not -Match 'volume create' -Because $run.Calls
        }

        It 'runs the checks again with the credentials entered again, and stops when declined' {
            $run = Invoke-ReplayRun -InputLines @('y', 'n') -EngineRoot (New-ReplayEngine -Name 'probe-78-again' `
                    -ProbeLines $script:ProbePortClosed -ProbeExit 78)
            $shape = Get-RunShape -Run $run

            $run.TimedOut | Should -BeFalse -Because $shape
            $run.Exit | Should -Be 78 -Because $shape
            @([regex]::Matches($run.Calls, 'doctor probe')).Count | Should -Be 2 -Because $run.Calls
            @([regex]::Matches($run.Output, 'Part 2: credentials for the file server')).Count | Should -Be 2 -Because $shape
        }

        It 'carries on to the volume once the checks run again pass' {
            $run = Invoke-ReplayRun -InputLines @('y') -EngineRoot (New-ReplayEngine -Name 'probe-78-then-0' `
                    -ProbeLines $script:ProbePortClosed -ProbeExit 78 -RetriedProbeExit 0)
            $shape = Get-RunShape -Run $run

            $run.TimedOut | Should -BeFalse -Because $shape
            $run.Exit | Should -Be 0 -Because $shape
            @([regex]::Matches($run.Calls, 'doctor probe')).Count | Should -Be 2 -Because $run.Calls
            $run.Calls | Should -Match 'doctor mount' -Because $run.Calls
            $run.Output | Should -Match 'Ready to run an exchange' -Because $shape
        }

        It 'stops on checks that could not run, with no sign-in offered' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'probe-69' `
                    -ProbeLines $script:ProbeNoSmbclient -ProbeExit 69)

            Assert-SetupEndsWith -Run $run -Exit 69 -Screen ($script:ProbeLead + $script:ProbeNoSmbclient + @(
                    '',
                    '        Follow the ACTION line above, then run this again.'))
        }

        It 'names the refused value without blaming the script' {
            # -Server is forwarded as typed, which is how a path separator in it
            # reaches the checks and is refused there.
            $run = Invoke-ReplayRun -Server 'fs-04.agency.gov/exchange' -EngineRoot (New-ReplayEngine -Name 'probe-64' `
                    -ProbeLines $script:ProbeRefusedServer -ProbeExit 64)

            Assert-SetupEndsWith -Run $run -Exit 64 -Screen ($script:ProbeLead + $script:ProbeRefusedServer + @(
                    '',
                    '  FAIL  The checks refused a value they were given, so nothing was tested.',
                    '        The line above names the value. SMB_SERVER is the server,',
                    '        SMB_SHARE the share, SMB_PATH the folder within it, and SMB_USER',
                    '        the username; correct the one it names and run this again.',
                    '        Any other name is a value this script set, not one you typed:',
                    '        report it as a problem with this script. An image older than',
                    '        these checks also ends this way, and downloading it again',
                    '        fixes that:',
                    '            docker pull ghcr.io/georgetown-mdi/alcove:latest'))
            $run.Output | Should -Not -Match 'defect' -Because (Get-RunShape -Run $run)
        }

        It 'tells a container that never started apart from the checks' {
            # Docker's own message, not the checks', is what precedes this
            # screen, so the engine here prints none.
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'probe-125' -ProbeExit 125)

            Assert-SetupEndsWith -Run $run -Exit 125 -Screen ($script:ProbeLead + @(
                    '',
                    '',
                    '  FAIL  Docker could not start the container (exit 125).',
                    '        Nothing was tested; the message above says why.',
                    '        If it says Docker is not running:',
                    '        Start Docker Desktop, wait for the whale icon to stop animating,',
                    '        and run this script again.'))
        }

        It 'names Podman and its machine when podman could not start the container' {
            $run = Invoke-ReplayRun -EngineRoot (Add-StoppedDocker -EngineRoot (
                    New-ReplayEngine -Name 'podman-probe-125' -EngineName 'podman' -ProbeExit 125))

            Assert-SetupEndsWith -Run $run -Exit 125 -Screen ($script:ProbeLead + @(
                    '',
                    '',
                    '  FAIL  Podman could not start the container (exit 125).',
                    '        Nothing was tested; the message above says why.',
                    '        If it says Podman is not running:',
                    '        Start the Podman machine with "podman machine start", and run',
                    '        this script again.'))
            $run.Output | Should -Not -Match 'Docker Desktop' -Because (Get-RunShape -Run $run)
        }

        It 'reads an exit code the checks never give as a newer image' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'probe-3' -ProbeExit 3)

            Assert-SetupEndsWith -Run $run -Exit 3 -Screen @(
                '',
                '  FAIL  The checks ended with exit 3, which this script does not know.',
                '        Nothing was established about your file drop. Look for a newer',
                '        copy of this script wherever you downloaded it.')
        }

        It 'says Docker stopped when the checks ended with 1 and the engine no longer answers' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'probe-1-stopped' -ProbeExit 1 -EngineStopsAfterStart)

            Assert-SetupEndsWith -Run $run -Exit 1 -Screen @(
                '',
                '  FAIL  Docker stopped during the checks.',
                '        Start Docker Desktop, wait for the whale icon to stop animating,',
                '        and run this script again.')
        }

        It 'keeps the unknown-code text for a code of 1 while the engine answers' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'probe-1-up' -ProbeExit 1)

            Assert-SetupEndsWith -Run $run -Exit 1 -Screen @(
                '',
                '  FAIL  The checks ended with exit 1, which this script does not know.',
                '        Nothing was established about your file drop. Look for a newer',
                '        copy of this script wherever you downloaded it.')
        }

        It 'shows a battery over the volume that is not ready whole, and removes the volume' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'mount-78' `
                    -MountLines $script:MountWriteDenied -MountExit 78)

            Assert-SetupEndsWith -Run $run -Exit 9 -Screen ($script:MountLead + $script:MountWriteDenied + $script:NotReadyTail)
            $run.Calls | Should -Match 'volume rm' -Because $run.Calls
        }

        It 'shows checks over the volume that could not run' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'mount-69' `
                    -MountLines $script:MountUnreadable -MountExit 69)

            Assert-SetupEndsWith -Run $run -Exit 9 -Screen ($script:MountLead + $script:MountUnreadable + @(
                    '',
                    '        Follow the ACTION line above, then run this again.'))
        }

        It 'names a value the checks over the volume refused without blaming the script' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'mount-64' `
                    -MountLines $script:MountRefusedToken -MountExit 64)

            Assert-SetupEndsWith -Run $run -Exit 9 -Screen ($script:MountLead + $script:MountRefusedToken + @(
                    '',
                    '  FAIL  The checks refused a value they were given, so nothing was tested.',
                    '        The line above names the value. SMB_SERVER is the server,',
                    '        SMB_SHARE the share, SMB_PATH the folder within it, and SMB_USER',
                    '        the username; correct the one it names and run this again.',
                    '        Any other name is a value this script set, not one you typed:',
                    '        report it as a problem with this script. An image older than',
                    '        these checks also ends this way, and downloading it again',
                    '        fixes that:',
                    '            docker pull ghcr.io/georgetown-mdi/alcove:latest'))
        }

        It 'reads a volume Docker could not mount as Docker''s failure, not the checks''' {
            $run = Invoke-ReplayRun -EngineRoot (New-ReplayEngine -Name 'mount-125' -MountExit 125)

            Assert-SetupEndsWith -Run $run -Exit 9 -Screen ($script:MountLead + @(
                    '',
                    '',
                    '  FAIL  The volume could not be mounted.',
                    '        The message above says why.'))
            $run.Calls | Should -Match 'volume rm' -Because $run.Calls
        }
    }
}

Describe 'The Windows-containers refusal, against this PC''s own engine' {
    BeforeAll {
        # Whatever docker the session's PATH reaches, with no stub ahead of it.
        # The hosted Windows runner's engine serves Windows containers.
        $engineOs = Invoke-Docker -DockerArgs @('version', '--format', '{{.Server.Os}}')
        $script:NoWindowsEngine = ''
        if (-not $engineOs.Ran) { $script:NoWindowsEngine = 'docker is not installed on this PC' }
        elseif ($engineOs.ExitCode -ne 0) { $script:NoWindowsEngine = "docker did not answer: $($engineOs.Output)" }
        elseif ($engineOs.Output.Trim() -ne 'windows') {
            $script:NoWindowsEngine = "the engine serves $($engineOs.Output.Trim()) containers, not windows"
        }
    }

    It 'refuses at its preflight and leaves the volumes as they were' {
        if ($script:NoWindowsEngine) {
            if ($env:GITHUB_ACTIONS -eq 'true') { throw $script:NoWindowsEngine }
            Set-ItResult -Skipped -Because $script:NoWindowsEngine
            return
        }

        $before = Invoke-Docker -DockerArgs @('volume', 'ls', '--quiet')
        $run = Start-PowerShellChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setupScript`"") -TimeoutSeconds 120
        $after = Invoke-Docker -DockerArgs @('volume', 'ls', '--quiet')

        $output = [string] $run.Output
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) tail=" +
            (($output.Substring([Math]::Max(0, $output.Length - 300))) -replace '\s+', ' ')
        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $lines = @($output -split '\r?\n' | ForEach-Object { $_.TrimEnd() })
        ($lines -contains '  FAIL  Docker Desktop is in Windows containers mode.') | Should -BeTrue -Because $shape
        $before.ExitCode | Should -Be 0 -Because "volume ls said: $($before.Output)"
        $after.Output | Should -BeExactly $before.Output
    }
}

Describe 'Resolution over a live SMB rig' {
    BeforeAll {
        $global:AlcoveRigPremises = [ordered]@{
            share  = [ordered]@{ state = 'not_reached' }
            mapped = [ordered]@{ state = 'not_reached' }
            dfs    = [ordered]@{ state = 'not_reached' }
        }

        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $dataShareName = "alcoveci$suffix"
        $dfsShareName = "alcovedfs$suffix"
        $dataShareRoot = Join-Path $env:TEMP "alcove-ci-data-$suffix"
        $dfsShareRoot = Join-Path $env:TEMP "alcove-ci-dfs-$suffix"
        $dataUnc = "\\localhost\$dataShareName"
        # DFS names its targets by server, so the namespace link cannot be
        # pointed at the loopback form above.
        $dataUncByServer = "\\$env:COMPUTERNAME\$dataShareName"
        $subFolder = 'drop'
        $mappedLetter = $null
        $dfsLetter = $null
        $namespacePath = $null
        $namespaceLink = $null

        # --- the share, and a mapped letter over it -------------------------
        try {
            # A hosted runner has no reason to be serving SMB, so the Server
            # service may be stopped.
            $serverService = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
            if ($serverService -and $serverService.Status -ne 'Running') {
                Start-Service -Name LanmanServer -ErrorAction SilentlyContinue
                $serverService = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
            }

            New-Item -ItemType Directory -Path (Join-Path $dataShareRoot $subFolder) -Force | Out-Null
            # Full access for the runner's own account rather than Everyone: the
            # rig only ever reaches this share as itself, over loopback.
            New-SmbShare -Name $dataShareName -Path $dataShareRoot -FullAccess $identity.Name | Out-Null

            # Writing through the UNC and finding the bytes in the directory is
            # what makes this a real share rather than a name that accepts a
            # write.
            $token = [guid]::NewGuid().ToString('N')
            Set-Content -LiteralPath (Join-Path $dataUnc 'premise.txt') -Value $token -Encoding Ascii
            $landed = (Get-Content -LiteralPath (Join-Path $dataShareRoot 'premise.txt') -Raw).Trim() -eq $token

            $serverServiceStatus = 'absent'
            if ($serverService) { $serverServiceStatus = [string] $serverService.Status }

            $global:AlcoveRigPremises.share = [ordered]@{
                state          = 'built'
                server_service = $serverServiceStatus
                share          = $dataShareName
                unc            = $dataUnc
                write_through  = $landed
            }
        } catch {
            $global:AlcoveRigPremises.share = [ordered]@{
                state = 'FAILED'
                share = $dataShareName
                error = $_.Exception.Message
            }
        }

        try {
            $candidate = Find-FreeDriveLetter
            if (-not $candidate) { throw 'no free drive letter on this runner' }
            $mapping = Invoke-Net -Arguments @('use', "${candidate}:", $dataUnc, '/persistent:no')
            if ($mapping.Exit -eq 0) { $mappedLetter = $candidate }

            $global:AlcoveRigPremises.mapped = [ordered]@{
                state       = $(if ($mappedLetter) { 'built' } else { 'FAILED' })
                letter      = $mappedLetter
                target      = $dataUnc
                netuse_exit = $mapping.Exit
                error       = $(if ($mappedLetter) { $null } else { $mapping.Output })
            }
        } catch {
            $global:AlcoveRigPremises.mapped = [ordered]@{
                state  = 'FAILED'
                target = $dataUnc
                error  = $_.Exception.Message
            }
        }

        # --- the standalone namespace, and a letter over a link in it -------
        try {
            Import-Module ServerManager -ErrorAction Stop
            $install = Install-WindowsFeature -Name FS-DFS-Namespace -IncludeManagementTools
            if (-not $install.Success) { throw "Install-WindowsFeature exit $($install.ExitCode)" }

            $dfsService = Get-Service -Name Dfs -ErrorAction SilentlyContinue
            if ($dfsService -and $dfsService.Status -ne 'Running') {
                Start-Service -Name Dfs -ErrorAction SilentlyContinue
                $dfsService = Get-Service -Name Dfs -ErrorAction SilentlyContinue
            }
            $dfsServiceStatus = 'absent'
            if ($dfsService) { $dfsServiceStatus = [string] $dfsService.Status }

            New-Item -ItemType Directory -Path $dfsShareRoot -Force | Out-Null
            New-SmbShare -Name $dfsShareName -Path $dfsShareRoot -FullAccess $identity.Name | Out-Null

            # A standalone root is named by the share that hosts it, on the
            # server's own name: localhost is not accepted as a namespace server.
            $namespacePath = "\\$env:COMPUTERNAME\$dfsShareName"
            New-DfsnRoot -TargetPath $namespacePath -Type Standalone | Out-Null
            $namespaceLink = "$namespacePath\$subFolder"
            New-DfsnFolder -Path $namespaceLink -TargetPath $dataUncByServer | Out-Null

            $candidate = Find-FreeDriveLetter -Exclude @($mappedLetter)
            if (-not $candidate) { throw 'no second free drive letter on this runner' }
            $dfsMapping = Invoke-Net -Arguments @('use', "${candidate}:", $namespaceLink, '/persistent:no')
            if ($dfsMapping.Exit -eq 0) { $dfsLetter = $candidate }

            $global:AlcoveRigPremises.dfs = [ordered]@{
                state       = $(if ($dfsLetter) { 'built' } else { 'FAILED' })
                dfs_service = $dfsServiceStatus
                namespace   = $namespacePath
                link        = $namespaceLink
                target      = $dataUncByServer
                letter      = $dfsLetter
                netuse_exit = $dfsMapping.Exit
                error       = $(if ($dfsLetter) { $null } else { $dfsMapping.Output })
            }
        } catch {
            $global:AlcoveRigPremises.dfs = [ordered]@{
                state     = 'FAILED'
                namespace = $namespacePath
                link      = $namespaceLink
                error     = $_.Exception.Message
            }
        }
    }

    It 'resolves a mapped letter to the UNC behind it' {
        $mappedLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter before this can be asked'

        $unc = Resolve-MappedDrive -Letter $mappedLetter
        $unc | Should -Not -BeNullOrEmpty
        $unc.TrimEnd('\') | Should -Be $dataUnc
    }

    It 'calls a mapped letter a network drive' {
        $mappedLetter | Should -Not -BeNullOrEmpty

        Get-DriveKind -Letter $mappedLetter | Should -Be 'Network'
    }

    It 'turns a path on a mapped letter into the server, share and subdirectory behind it' {
        $mappedLetter | Should -Not -BeNullOrEmpty

        $resolved = Resolve-DropPath -Raw "${mappedLetter}:\$subFolder"
        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'localhost'
        $resolved.Share | Should -Be $dataShareName
        $resolved.SubPath | Should -Be $subFolder
        $resolved.Unc | Should -Be $dataUnc
        $resolved.Full | Should -Be "$dataUnc\$subFolder"
    }

    It 'resolves a letter mapped through a DFS namespace to the namespace, not to the server holding the data' {
        $dfsLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter to a namespace link before this can be asked'

        $unc = Resolve-MappedDrive -Letter $dfsLetter
        $unc | Should -Not -BeNullOrEmpty
        $unc.TrimEnd('\') | Should -Be $namespaceLink

        $resolved = Resolve-DropPath -Raw "${dfsLetter}:\"
        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be $env:COMPUTERNAME
        $resolved.Share | Should -Be $dfsShareName
        $resolved.SubPath | Should -Be $subFolder
        # The share the data actually lives on. That the resolution does not
        # reach it is why the script asks the operator to confirm what it worked
        # out, and why a DFS path is the case it names when it asks.
        $resolved.Share | Should -Not -Be $dataShareName
    }

    It 'says where a mapped letter goes once, however many paths resolve on it' {
        # The launcher resolves a path per folder, and a pair of folders on one
        # mapped drive would otherwise be told the same mapping twice. The
        # letters already announced are what the run remembers by, so the count
        # starts from the state a run starts in.
        $mappedLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter before this can be asked'
        $script:AnnouncedDriveLetters = @()

        $first = Resolve-DropPath -Raw "${mappedLetter}:\$subFolder" 6>&1
        $second = Resolve-DropPath -Raw "${mappedLetter}:\" 6>&1
        $said = @(@($first) + @($second) | ForEach-Object { [string] $_ }) -join ' '

        @([regex]::Matches($said, 'is mapped to')).Count | Should -Be 1 -Because $said
    }

    It 'reads the UNC root back out of net use for a mapped letter' {
        # Resolve-MappedDrive's third method, driven on its own: the two before
        # it answer first on this runner, so nothing else executes it.
        $mappedLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter before this can be asked'
        # The preference the script itself runs under. A native command whose
        # standard error is redirected is where 'Stop' would end the run.
        $ErrorActionPreference = 'Stop'

        $root = Get-NetUseRemoteName -Letter $mappedLetter

        $root | Should -Not -BeNullOrEmpty
        $root.TrimEnd('\') | Should -Be $dataUnc
    }

    It 'answers nothing for a letter nothing is mapped to' {
        $letter = Find-FreeDriveLetter -Exclude @($mappedLetter, $dfsLetter)
        $letter | Should -Not -BeNullOrEmpty
        $ErrorActionPreference = 'Stop'

        Get-NetUseRemoteName -Letter $letter | Should -BeNullOrEmpty
    }

    It 'reaches an unmapped letter as a throw rather than as an exit code' {
        # Why the catch inside Get-NetUseRemoteName is load-bearing: net use
        # writes to standard error for a letter it does not hold, and at 'Stop'
        # the redirect turns that into a terminating record before the exit
        # code above it is ever read.
        $letter = Find-FreeDriveLetter -Exclude @($mappedLetter, $dfsLetter)
        $letter | Should -Not -BeNullOrEmpty
        $ErrorActionPreference = 'Stop'
        $threw = $false

        try { $null = & net use "${letter}:" 2>$null } catch { $threw = $true }

        $threw | Should -BeTrue
    }

    AfterAll {
        # Hygiene rather than necessity -- the runner is thrown away -- but it
        # keeps a re-run on any other host from meeting its own leftovers. Each
        # step is guarded: a rig half that failed to build leaves commands that
        # are not there to call, and a teardown that threw would report as a
        # test failure.
        if ($mappedLetter) { Invoke-Net -Arguments @('use', "${mappedLetter}:", '/delete', '/y') | Out-Null }
        if ($dfsLetter) { Invoke-Net -Arguments @('use', "${dfsLetter}:", '/delete', '/y') | Out-Null }
        try {
            if ($namespaceLink) { Remove-DfsnFolder -Path $namespaceLink -Force -ErrorAction SilentlyContinue }
            if ($namespacePath) { Remove-DfsnRoot -Path $namespacePath -Force -ErrorAction SilentlyContinue }
        } catch { }
        try {
            Remove-SmbShare -Name $dataShareName -Force -ErrorAction SilentlyContinue
            Remove-SmbShare -Name $dfsShareName -Force -ErrorAction SilentlyContinue
        } catch { }
        Remove-Item -LiteralPath $dataShareRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $dfsShareRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
