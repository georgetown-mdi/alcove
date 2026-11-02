<#
.SYNOPSIS
    Smoke over the Windows VM pass driver beside it: console input into a
    Command Prompt set /p, and the Read-Host stand-in driving Start-Alcove.ps1
    against a stub engine, with the share password kept off every screen.
    Run it through ..\ci-resolution-tests.ps1.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot 'Invoke-VmPass.ps1') -LoadFunctionsOnly

    $script:SmokeRoot = Join-Path $env:TEMP ('alcove-vm-pass-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $script:SmokePassword = 'SmokeOnly' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $secretFile = Join-Path $script:SmokeRoot 'secret\share.dpapi'
    New-Item -ItemType Directory -Path (Split-Path -Parent $secretFile) -Force | Out-Null
    ConvertTo-SecureString -String $script:SmokePassword -AsPlainText -Force | ConvertFrom-SecureString |
        Set-Content -LiteralPath $secretFile
    Initialize-Pass -Root $script:SmokeRoot -Secret $secretFile -Lab @{ ImageDigest = 'sha256:' + ('a1b2c3d4' * 8) }

    function Get-RunShape {
        <#  The run's exit and its tail, for a -Because: the failure annotation
            is the only diagnostic that leaves the runner. #>
        param($Run)
        $screen = [string] $Run.Screen
        return "exit=$($Run.Exit) timedout=$($Run.TimedOut) tail=" +
            ($screen.Substring([Math]::Max(0, $screen.Length - 300)) -replace '\s+', ' ')
    }
}

AfterAll {
    Remove-Item -LiteralPath $script:SmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Console input' {
    It 'answers set /p with typed text and with the password, and its output holds neither' {
        $target = Join-Path $script:SmokeRoot 'prompts.cmd'
        Set-Content -LiteralPath $target -Encoding Ascii -Value @(
            '@echo off',
            'set /p "FIRST=First: "',
            'set /p "SECOND=Second: "',
            'if "%FIRST%"=="abc" if "%SECOND%"=="%ALCOVE_SMOKE_EXPECTED%" echo MATCHED')
        $env:ALCOVE_SMOKE_EXPECTED = $script:SmokePassword
        try { $console = Start-ConsoleCommand -Name 'smoke-console' -CommandLine "`"$target`"" }
        finally { Remove-Item 'env:ALCOVE_SMOKE_EXPECTED' }

        $reasons = @(
            Send-AtPrompt -Console $console -Prompt 'First: ' -Text 'abc' -TimeoutSeconds 60
            Send-AtPrompt -Console $console -Prompt 'Second: ' -Secret -TimeoutSeconds 60) | Where-Object { $_ }
        $console.Process.WaitForExit(60000) | Out-Null
        # Read before Complete-ConsoleCommand removes the password: what is
        # pinned here is that set /p never writes what it reads to the file.
        $raw = Read-SharedText $console.Out
        $done = Complete-ConsoleCommand -Console $console -TimeoutSeconds 10

        @($reasons) | Should -BeNullOrEmpty
        $raw | Should -Match 'First: '
        $raw | Should -Match 'MATCHED' -Because "the file held: $($raw -replace '\s+', ' ')"
        $raw | Should -Not -Match 'abc'
        $raw | Should -Not -Match $script:SmokePassword
        $done.Exit | Should -Be 0
    }
}

Describe 'The Read-Host stand-in' {
    BeforeAll {
        $script:StubBin = Join-Path $script:SmokeRoot 'stub-bin'
        New-Item -ItemType Directory -Path $script:StubBin -Force | Out-Null
        # Every call succeeds, and each run of the checks prints the password
        # it was handed, as Docker prints a volume's options when a mount fails.
        Set-Content -LiteralPath (Join-Path $script:StubBin 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            'echo %* | findstr /c:"doctor" >nul',
            'if errorlevel 1 exit /b 0',
            'echo password=%SMB_PASS% 1>&2',
            'echo READY 1>&2',
            'exit /b 0')

        # The stub engine starts nothing, so something else answers on the
        # console's port.
        $script:Listener = New-Object -TypeName Net.Sockets.TcpListener -ArgumentList ([Net.IPAddress]::Loopback, 0)
        $script:Listener.Start()
        $script:ListenerPort = ([Net.IPEndPoint] $script:Listener.LocalEndpoint).Port
    }

    AfterAll {
        if ($script:Listener) { $script:Listener.Stop() }
    }

    It 'removes the password from a screen' {
        Protect-Screen "before $($script:SmokePassword) after" | Should -Be 'before <password removed> after'
    }

    It 'drives the launcher to the console and back, the password off its screen' {
        New-Item -ItemType File -Path $script:Pass.StopFile -Force | Out-Null
        $path = @($script:StubBin,
            (Join-Path $env:SystemRoot 'System32'),
            $env:SystemRoot,
            (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')) -join ';'

        $run = Invoke-StandInRun -Name 'smoke-launcher' -Target (Get-Launcher) -Environment @{ PATH = $path } `
            -Arguments @{ DataRoot = (Get-WorkFolder 'op'); RendezvousDir = '\\alcove-ci-server\exchange\drop'
                VolumeName = 'alcove-smoke'; Port = $script:ListenerPort; NoBrowser = $true } `
            -Answers @('y', 'ciuser', '', '@password', '@wait-stop-file')
        $shape = Get-RunShape $run
        $artifact = Get-Content -Raw -LiteralPath (Join-Path $script:Pass.Artifacts 'smoke-launcher.txt')

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $run.Screen | Should -Match 'The console is at' -Because $shape
        $run.Screen | Should -Match 'The console has stopped\.' -Because $shape
        $run.Screen | Should -Match 'Password: \(password\)' -Because $shape
        $run.Screen | Should -Match 'password=<password removed>' -Because $shape
        $run.Screen | Should -Not -Match $script:SmokePassword
        $artifact | Should -Not -Match $script:SmokePassword
    }

    It 'ends the run rather than answer a prompt that is not a password prompt with the password' {
        $target = Join-Path $script:SmokeRoot 'plain-prompt.ps1'
        Set-Content -LiteralPath $target -Encoding Ascii -Value @(
            '$answer = Read-Host ''Username''',
            'Write-Host (''READ:'' + $answer)')

        $run = Invoke-StandInRun -Name 'smoke-plain' -Target $target -Answers @('@password')

        $run.Exit | Should -Be 97 -Because (Get-RunShape $run)
        $run.Screen | Should -Not -Match 'READ:'
        $run.Screen | Should -Not -Match $script:SmokePassword
    }
}
