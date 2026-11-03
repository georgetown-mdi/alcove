<#
.SYNOPSIS
    Pester suite running cmd_Setup-AlcoveFileDrop.cmd against docker and
    podman stand-ins, for the engine it chooses. Maintainer-facing.

.DESCRIPTION
    Each run is a new cmd process whose PATH holds one folder of stand-ins
    and a folder of copied where.exe and findstr.exe, and no system folder,
    where the runner's own docker is; a case whose PATH still reaches an
    engine it means to be absent throws, naming the file. The
    stand-ins are one compiled recorder copied to docker.exe, podman.exe, or
    both. It appends the name it runs as and its arguments to
    ALCOVE_STUB_LOG; exits 1 to every call when ALCOVE_STANDIN_STOPPED_<NAME>
    is 1; and otherwise answers as an engine that has the image and whose
    checks all pass. It is a program rather than a .cmd because the script
    calls its engine without "call", and cmd does not return from a batch
    file reached that way.

    A run with an engine that answers goes through to the closing screen.
    It asserts the version checks asked, the engine every later call reached,
    and the engine the printed command lines name; a failure names the
    expected engine and the ones received. A run where none answers asserts
    the screen it ends on.

    Runs in the Resolution suite of ci-resolution-tests.ps1, the test job of
    .github/workflows/windows_resolution.yaml.
#>

BeforeAll {
    $script:CmdScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\windows-network-filedrop\cmd_Setup-AlcoveFileDrop.cmd')).Path
    $script:Root = Join-Path $env:TEMP ('alcove-cmd-engine-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $script:Root | Out-Null

    $recorderSource = @'
public static class AlcoveCmdEngineStandIn {
    public static int Main(string[] args) {
        string name = System.IO.Path.GetFileNameWithoutExtension(
            System.Reflection.Assembly.GetEntryAssembly().Location).ToLowerInvariant();
        string log = System.Environment.GetEnvironmentVariable("ALCOVE_STUB_LOG");
        if (!string.IsNullOrEmpty(log)) {
            System.IO.File.AppendAllText(log, name + " " + string.Join(" ", args) + System.Environment.NewLine);
        }
        if (System.Environment.GetEnvironmentVariable("ALCOVE_STANDIN_STOPPED_" + name.ToUpperInvariant()) == "1") {
            System.Console.Error.WriteLine(name + " stand-in: not answering");
            return 1;
        }
        if (args.Length > 0 && args[0] == "version") {
            System.Console.WriteLine("linux 27.1.1");
            return 0;
        }
        if (System.Array.IndexOf(args, "--entrypoint") >= 0) {
            System.Console.WriteLine("VERDICT=OK");
            System.Console.WriteLine("TOKEN=standin");
        }
        return 0;
    }
}
'@
    $script:Recorder = Join-Path $script:Root 'recorder.exe'
    Add-Type -TypeDefinition $recorderSource -OutputAssembly $script:Recorder -OutputType ConsoleApplication

    # The runner's own docker is in a system folder, so no system folder goes
    # on a run's PATH: these copies are the system programs the runs reach.
    $script:Tools = Join-Path $script:Root 'tools'
    New-Item -ItemType Directory -Path $script:Tools | Out-Null
    foreach ($tool in @('where.exe', 'findstr.exe')) {
        Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\$tool") -Destination $script:Tools
    }

    function Assert-EngineAbsent {
        <#  Throw when an engine a case means to be absent is on its PATH. #>
        param([string[]] $Folders, [string[]] $Absent)
        $extensions = @($env:PATHEXT -split ';' | Where-Object { $_ })
        foreach ($engine in $Absent) {
            foreach ($folder in $Folders) {
                foreach ($extension in $extensions) {
                    $candidate = Join-Path $folder "$engine$extension"
                    if (Test-Path -LiteralPath $candidate) {
                        throw "the case means $engine to be absent, and its PATH reaches $candidate"
                    }
                }
            }
        }
    }

    function Set-ProcessVariable {
        param([Parameter(Mandatory = $true)][string] $Name, $Value)
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }

    function Invoke-CmdSetup {
        <#  Run the script with the named stand-ins installed and the named
            ones stopped, and return its exit code, its output, and the calls
            the stand-ins recorded. Standard input is a file holding the
            password, the one prompt the arguments leave; at its end a prompt
            reads nothing, so a run that reaches another one ends. #>
        param(
            [string[]] $Installed = @(),
            [string[]] $Stopped = @(),
            [int] $TimeoutSeconds = 120
        )

        $folder = Join-Path $script:Root ([guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $folder | Out-Null
        foreach ($engine in $Installed) {
            Copy-Item -LiteralPath $script:Recorder -Destination (Join-Path $folder "$engine.exe")
        }
        $log = Join-Path $folder 'calls.log'
        $inFile = Join-Path $folder 'input.txt'
        $outFile = Join-Path $folder 'stdout.txt'
        $errFile = Join-Path $folder 'stderr.txt'
        Set-Content -LiteralPath $inFile -Value @('hunter2') -Encoding Ascii
        $pathFolders = @($folder, $script:Tools)
        Assert-EngineAbsent -Folders $pathFolders -Absent @(@('docker', 'podman') | Where-Object { $Installed -notcontains $_ })

        $names = @('PATH', 'ALCOVE_STUB_LOG', 'ALCOVE_STANDIN_STOPPED_DOCKER', 'ALCOVE_STANDIN_STOPPED_PODMAN')
        $saved = @{}
        foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        try {
            Set-ProcessVariable -Name 'PATH' -Value ($pathFolders -join ';')
            Set-ProcessVariable -Name 'ALCOVE_STUB_LOG' -Value $log
            foreach ($engine in @('docker', 'podman')) {
                $value = $null
                if ($Stopped -contains $engine) { $value = '1' }
                Set-ProcessVariable -Name ('ALCOVE_STANDIN_STOPPED_' + $engine.ToUpperInvariant()) -Value $value
            }
            $arguments = '-Server fs-04.agency.gov -Share exchange -SubPath dropbox -Username alcoveci -Domain AGENCY'
            $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
                -ArgumentList "/d /s /c `"`"$script:CmdScript`" $arguments`"" `
                -WorkingDirectory $folder -NoNewWindow -PassThru `
                -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            # As Setup-AlcoveFileDrop.Tests.ps1's Start-PowerShellChild: the
            # handle is touched so that ExitCode is not null after the wait.
            try { $null = $process.Handle } catch { }
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            else {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
        } finally {
            foreach ($name in $names) { Set-ProcessVariable -Name $name -Value $saved[$name] }
        }

        $exitCode = $null
        if ($exited) { $exitCode = $process.ExitCode }
        $output = Get-Content -LiteralPath $outFile -Raw
        if ($null -eq $output) { $output = '' }
        $calls = @()
        if (Test-Path -LiteralPath $log) { $calls = @(Get-Content -LiteralPath $log) }
        return [ordered]@{
            TimedOut = (-not $exited)
            Exit     = $exitCode
            Output   = [string] $output
            Lines    = (@(([string] $output).TrimEnd() -split '\r?\n' | ForEach-Object { $_.TrimEnd() }) -join "`n")
            Calls    = $calls
        }
    }

    function Get-CallEngine {
        <#  The engines a set of recorded calls reached, comma-joined in the
            order first reached. #>
        param([string[]] $Calls = @())
        $seen = New-Object System.Collections.ArrayList
        foreach ($call in $Calls) {
            $engine = ($call -split ' ', 2)[0]
            if (-not $seen.Contains($engine)) { [void] $seen.Add($engine) }
        }
        return ($seen -join ',')
    }

    function Test-VersionCall {
        param([string] $Call)
        return (($Call -split ' ', 3)[1] -eq 'version')
    }
}

AfterAll {
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'The Command Prompt setup script choosing its engine' {
    It 'runs every call through <Expected> when <Case>' -ForEach @(
        @{ Case = 'docker and podman both answer'; Installed = @('docker', 'podman'); Stopped = @(); Expected = 'docker'; Asked = 'docker'; Running = 'Docker engine 27.1.1 is running.' }
        @{ Case = 'docker answers and podman is not installed'; Installed = @('docker'); Stopped = @(); Expected = 'docker'; Asked = 'docker'; Running = 'Docker engine 27.1.1 is running.' }
        @{ Case = 'docker does not answer and podman does'; Installed = @('docker', 'podman'); Stopped = @('docker'); Expected = 'podman'; Asked = 'docker,podman'; Running = 'Podman is running.' }
        @{ Case = 'docker is not installed and podman answers'; Installed = @('podman'); Stopped = @(); Expected = 'podman'; Asked = 'podman'; Running = 'Podman is running.' }
    ) {
        $run = Invoke-CmdSetup -Installed $Installed -Stopped $Stopped
        $shape = "exit=$($run.Exit) timedout=$($run.TimedOut) calls=$($run.Calls -join ' | ')"
        $versionCalls = @($run.Calls | Where-Object { Test-VersionCall -Call $_ })
        $laterCalls = @($run.Calls | Where-Object { -not (Test-VersionCall -Call $_) })
        $printed = @([regex]::Matches($run.Output, '\b(docker|podman) (run|volume|pull|ps)\b') |
                ForEach-Object { $_.Groups[1].Value })

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $run.Output | Should -Match ([regex]::Escape("  OK    $Running")) -Because $shape
        $run.Output | Should -Match 'Ready to run an exchange' -Because $shape
        Get-CallEngine -Calls $versionCalls | Should -Be $Asked -Because "the version checks ask docker first and stop at the first that answers ($shape)"
        $laterCalls.Count | Should -BeGreaterThan 0 -Because $shape
        Get-CallEngine -Calls $laterCalls | Should -Be $Expected -Because "every call after the version checks should reach the engine chosen ($shape)"
        $printed.Count | Should -BeGreaterThan 0 -Because 'the closing screen prints command lines'
        Get-CallEngine -Calls $printed | Should -Be $Expected -Because 'the printed command lines should name the engine chosen'
    }

    It 'says neither is installed when neither is' {
        $run = Invoke-CmdSetup

        $run.Exit | Should -Be 1 -Because $run.Lines
        $run.Lines | Should -Match ([regex]::Escape(@(
                    '  FAIL  Neither docker nor podman is installed on this PC.',
                    '        Install Docker Desktop, start it, and run this again.') -join "`n"))
        $run.Calls.Count | Should -Be 0
    }

    It 'says how to start each when both are installed and neither answers, then shows what docker said' {
        $run = Invoke-CmdSetup -Installed @('docker', 'podman') -Stopped @('docker', 'podman')

        $run.Exit | Should -Be 1 -Because $run.Lines
        $run.Lines | Should -Match ([regex]::Escape(@(
                    '  FAIL  Docker is installed but is not answering.',
                    '        Start Docker Desktop, wait for the whale icon to stop animating,',
                    '        and run this script again.',
                    '        "Access is denied" below means your account is not in the local',
                    '        docker-users group, which an administrator has to add you to.',
                    '  FAIL  Podman is installed but is not answering.',
                    '        Start the Podman machine with "podman machine start", and run',
                    '        this script again.',
                    '',
                    'docker stand-in: not answering') -join "`n"))
        @($run.Calls | Where-Object { -not (Test-VersionCall -Call $_) }).Count | Should -Be 0 -Because ($run.Calls -join ' | ')
    }

    It 'shows what podman said when it is the only one installed and does not answer' {
        $run = Invoke-CmdSetup -Installed @('podman') -Stopped @('podman')

        $run.Exit | Should -Be 1 -Because $run.Lines
        $run.Lines | Should -Match ([regex]::Escape(@(
                    '  FAIL  Podman is installed but is not answering.',
                    '        Start the Podman machine with "podman machine start", and run',
                    '        this script again.',
                    '',
                    'podman stand-in: not answering') -join "`n"))
        $run.Lines | Should -Not -Match 'Docker is installed'
    }
}
