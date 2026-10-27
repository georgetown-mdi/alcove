<#
.SYNOPSIS
    CI measurement harness: what a windows-latest runner can host beyond the
    rig ci-resolution-rig.ps1 measures. Maintainer-facing: the probe job of
    .github/workflows/windows_resolution.yaml runs it, and an operator
    following the setup page never touches it.

.DESCRIPTION
    Each question is a capability a planned suite depends on and nothing in
    this repository or its CI record had measured:

      P1  Whether the machine __PSLockdownPolicy=4 puts a new powershell.exe
          in ConstrainedLanguage with no restart, whether a process already
          running keeps FullLanguage, and whether the process-level variable
          alone does the same.
      P2  Whether AppLocker's service (AppIDSvc) is present and starts. No
          policy is applied.
      P3  Whether schtasks /Run starts a task created without /RU, and as
          whom; then the same with /RU SYSTEM.
      P3b How schtasks reads /SD under en-US, and under en-GB set with
          Set-Culture.
      P4  Whether a Docker engine answers on the runner, in which mode, and
          whether WSL is present.
      P4b The exit code and first line docker run gives with the engine's
          service stopped.
      P6  Whether a created standard local user can run a child process
          (Start-Process -Credential), and what Get-SmbConnection answers
          there.
      P7  Whether the job's token is elevated, by the scripts' own test and by
          its integrity level.
      P8  Whether input injected into a new console (AttachConsole and
          WriteConsoleInput) reaches cmd's set /p and Read-Host
          -AsSecureString.

    It measures; it does not assert. Every question emits one ::notice on
    both its success and its failure path, at most nine per step, and the
    script always exits 0. ::error titled Harness means this script broke
    outside any question, and the run answered nothing.

    Every change it makes to the machine is reverted before it exits: the
    policy variable, the culture, the scheduled tasks, the engine service,
    the local user, and its working folder.

    The formatting functions are the same contract as ci-resolution-rig.ps1's,
    restated so that neither script acquires a load order.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\ci-capability-probe.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:MaxFieldLength = 320
$script:MaxLineLength = 800

function Format-FieldValue {
    param($Value)

    if ($null -eq $Value) { return 'empty' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }

    $text = (([string] $Value) -replace '\s+', ' ').Trim()
    if ($text.Length -eq 0) { return 'empty' }
    if ($text.Length -gt $script:MaxFieldLength) {
        $text = $text.Substring(0, $script:MaxFieldLength) + '[cut]'
    }
    ($text -replace ' ', '_') -replace '%', '%25'
}

function Format-Line {
    param($Text)

    $line = (([string] $Text) -replace '\s+', ' ').Trim()
    if ($line.Length -eq 0) { return 'empty' }
    if ($line.Length -gt $script:MaxLineLength) {
        $line = $line.Substring(0, $script:MaxLineLength) + '[cut]'
    }
    $line -replace '%', '%25'
}

function Write-Measurement {
    param(
        [Parameter(Mandatory = $true)] [string] $Title,
        [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $Fields
    )

    $parts = @()
    foreach ($key in $Fields.Keys) {
        $parts += "$key=$(Format-FieldValue $Fields[$key])"
    }
    Write-Output "::notice title=${Title}::$($parts -join ' ')"
}

function Write-HarnessError {
    param($Text)

    Write-Output "::error title=Harness::$(Format-Line $Text)"
}

function Invoke-Native {
    <#  Run a native program and return its exit code and merged output, with
        the preference relaxed for the call: under 'Stop', Windows PowerShell
        turns a native program's redirected stderr into a terminating record. #>
    param(
        [Parameter(Mandatory = $true)] [string] $FilePath,
        [string[]] $Arguments = @()
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1
        $exit = $LASTEXITCODE
        # wsl.exe writes UTF-16, which arrives here with a NUL between characters.
        $lines = @($output | ForEach-Object { ([string] $_) -replace "`0", '' })
        return [ordered]@{ Exit = $exit; Output = ($lines -join ' ').Trim(); Lines = $lines }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Wait-ForFile {
    <# Whether a file appears within the bound. #>
    param([string] $Path, [int] $TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $Path) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (Test-Path -LiteralPath $Path)
}

function Read-FileText {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return ([string] (Get-Content -LiteralPath $Path -Raw)).Trim()
}

$powershellExe = Join-Path $PSHOME 'powershell.exe'
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
# On the system drive rather than under the runner's profile: P3's SYSTEM task
# and P6's created user both have to write here.
$probeRoot = Join-Path $env:SystemDrive "alcove-probe-$suffix"

try {
    New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null

    # --- P7: is the job's token elevated? -----------------------------------
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        $groups = Invoke-Native -FilePath 'whoami.exe' -Arguments @('/groups')
        $integrity = 'unknown'
        if ($groups.Output -match 'S-1-16-16384') { $integrity = 'system' }
        elseif ($groups.Output -match 'S-1-16-12288') { $integrity = 'high' }
        elseif ($groups.Output -match 'S-1-16-8192') { $integrity = 'medium' }
        Write-Measurement -Title 'P7_elevation' -Fields ([ordered]@{
                user          = $identity.Name
                is_admin_role = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
                integrity     = $integrity
                whoami_exit   = $groups.Exit
            })
    } catch {
        Write-Measurement -Title 'P7_elevation' -Fields ([ordered]@{ error = $_.Exception.Message })
    }

    # --- P1: does __PSLockdownPolicy impose ConstrainedLanguage? -------------
    $lockdownName = '__PSLockdownPolicy'
    $p1 = [ordered]@{
        machine_before = $null
        machine_cmd    = $null
        machine_file   = $null
        parent_file    = $null
        harness        = $null
        restored_cmd   = $null
        process_cmd    = $null
        error          = $null
    }
    try {
        $modeScript = Join-Path $probeRoot 'language-mode.ps1'
        Set-Content -LiteralPath $modeScript -Value '$ExecutionContext.SessionState.LanguageMode' -Encoding Ascii
        $commandArgs = @('-NoProfile', '-NonInteractive', '-Command', '$ExecutionContext.SessionState.LanguageMode')
        $fileArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $modeScript)

        $p1.machine_before = [Environment]::GetEnvironmentVariable($lockdownName, 'Machine')
        try {
            [Environment]::SetEnvironmentVariable($lockdownName, '4', 'Machine')
            $p1.machine_cmd = (Invoke-Native -FilePath $powershellExe -Arguments $commandArgs).Output
            $p1.machine_file = (Invoke-Native -FilePath $powershellExe -Arguments $fileArgs).Output
            # A script file this running session loads after the policy is set.
            try { $p1.parent_file = [string] (& $modeScript) } catch { $p1.parent_file = "failed: $($_.Exception.Message)" }
            $p1.harness = [string] $ExecutionContext.SessionState.LanguageMode
        } finally {
            [Environment]::SetEnvironmentVariable($lockdownName, $p1.machine_before, 'Machine')
        }
        $p1.restored_cmd = (Invoke-Native -FilePath $powershellExe -Arguments $commandArgs).Output

        try {
            Set-Item -Path "env:$lockdownName" -Value '4'
            $p1.process_cmd = (Invoke-Native -FilePath $powershellExe -Arguments $commandArgs).Output
        } finally {
            Remove-Item -Path "env:$lockdownName" -ErrorAction SilentlyContinue
        }
    } catch {
        $p1.error = $_.Exception.Message
    }
    Write-Measurement -Title 'P1_lockdown_policy' -Fields $p1

    # --- P2: is AppLocker's service there? -----------------------------------
    try {
        $appId = Get-Service -Name AppIDSvc -ErrorAction SilentlyContinue
        $p2 = [ordered]@{
            present         = [bool] $appId
            status_before   = $null
            start_type      = $null
            status_started  = $null
            applocker_cmds  = [bool] (Get-Command Get-AppLockerPolicy -ErrorAction SilentlyContinue)
            error           = $null
        }
        if ($appId) {
            $p2.status_before = [string] $appId.Status
            $p2.start_type = [string] $appId.StartType
            try {
                Start-Service -Name AppIDSvc
                $p2.status_started = [string] (Get-Service -Name AppIDSvc).Status
            } catch {
                $p2.error = $_.Exception.Message
            }
            if ($p2.status_before -ne 'Running') {
                Stop-Service -Name AppIDSvc -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Measurement -Title 'P2_applocker' -Fields $p2
    } catch {
        Write-Measurement -Title 'P2_applocker' -Fields ([ordered]@{ error = $_.Exception.Message })
    }

    # --- P3: does schtasks /Run start a task in this account? ----------------
    $p3 = [ordered]@{}
    try {
        $variants = @(
            @{ Key = 'default'; Extra = @() },
            @{ Key = 'system'; Extra = @('/RU', 'SYSTEM') })
        foreach ($variant in $variants) {
            $key = $variant.Key
            $taskName = "alcove-probe-$key-$suffix"
            $marker = Join-Path $probeRoot "p3-$key.txt"
            $taskScript = Join-Path $probeRoot "p3-$key.cmd"
            Set-Content -LiteralPath $taskScript -Encoding Ascii -Value @(
                '@echo off',
                "echo %USERNAME% %CD%> `"$marker`"")

            $create = Invoke-Native -FilePath 'schtasks.exe' -Arguments (@(
                    '/Create', '/TN', $taskName, '/TR', $taskScript, '/SC', 'ONCE', '/ST', '23:59', '/F') + $variant.Extra)
            $p3["${key}_create"] = $create.Exit
            if ($create.Exit -ne 0) {
                $p3["${key}_error"] = $create.Output
                continue
            }
            try {
                $runIt = Invoke-Native -FilePath 'schtasks.exe' -Arguments @('/Run', '/TN', $taskName)
                $p3["${key}_run"] = $runIt.Exit
                $ran = Wait-ForFile -Path $marker -TimeoutSeconds 60
                $p3["${key}_ran"] = $ran
                $p3["${key}_wrote"] = Read-FileText -Path $marker

                $query = Invoke-Native -FilePath 'schtasks.exe' -Arguments @('/Query', '/TN', $taskName, '/V', '/FO', 'LIST')
                foreach ($line in $query.Lines) {
                    if ($line -match '^\s*Last Result:\s*(.+)$') { $p3["${key}_last_result"] = $Matches[1] }
                    if ($line -match '^\s*Logon Mode:\s*(.+)$') { $p3["${key}_logon_mode"] = $Matches[1] }
                    if ($line -match '^\s*Run As User:\s*(.+)$') { $p3["${key}_run_as"] = $Matches[1] }
                }
            } finally {
                Invoke-Native -FilePath 'schtasks.exe' -Arguments @('/Delete', '/TN', $taskName, '/F') | Out-Null
            }
            # The SYSTEM form is asked only when the default form did not run.
            if ($key -eq 'default' -and $p3['default_ran']) { break }
        }
    } catch {
        $p3['error'] = $_.Exception.Message
    }
    Write-Measurement -Title 'P3_schtasks_run' -Fields $p3

    # --- P3b: how does schtasks read /SD under each culture? -----------------
    $p3b = [ordered]@{ culture_before = $null; child_culture = $null }
    $cultureBefore = $null
    try {
        $cultureBefore = (Get-Culture).Name
        $p3b.culture_before = $cultureBefore

        $readStartDate = {
            param([string] $Label, [string] $StartDate)

            $taskName = "alcove-probe-sd-$Label-$suffix"
            $create = Invoke-Native -FilePath 'schtasks.exe' -Arguments @(
                '/Create', '/TN', $taskName, '/TR', 'cmd.exe /c exit 0',
                '/SC', 'DAILY', '/SD', $StartDate, '/ST', '03:00', '/F')
            if ($create.Exit -ne 0) { return "refused_exit_$($create.Exit):$($create.Output)" }
            try {
                $xml = Invoke-Native -FilePath 'schtasks.exe' -Arguments @('/Query', '/TN', $taskName, '/XML')
                if ($xml.Output -match '<StartBoundary>([^<]+)</StartBoundary>') { return "start=$($Matches[1])" }
                return "no_start_boundary:$($xml.Output)"
            } finally {
                Invoke-Native -FilePath 'schtasks.exe' -Arguments @('/Delete', '/TN', $taskName, '/F') | Out-Null
            }
        }

        $p3b['us_03_04'] = & $readStartDate 'us0304' '03/04/2026'
        try {
            Set-Culture -CultureInfo 'en-GB'
            $p3b.child_culture = (Invoke-Native -FilePath $powershellExe -Arguments @(
                    '-NoProfile', '-NonInteractive', '-Command', '(Get-Culture).Name')).Output
            $p3b['gb_10_27'] = & $readStartDate 'gb1027' '10/27/2026'
            $p3b['gb_03_04'] = & $readStartDate 'gb0304' '03/04/2026'
        } finally {
            if ($cultureBefore) { Set-Culture -CultureInfo $cultureBefore }
        }
    } catch {
        $p3b['error'] = $_.Exception.Message
    }
    Write-Measurement -Title 'P3b_schtasks_dates' -Fields $p3b

    # --- P4: is there a container engine, and WSL? ---------------------------
    $dockerService = $null
    try {
        $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
        $dockerService = Get-Service -Name docker -ErrorAction SilentlyContinue
        $wslCommand = Get-Command wsl.exe -ErrorAction SilentlyContinue
        $p4 = [ordered]@{
            docker_path    = $null
            docker_service = $null
            server_exit    = $null
            server         = $null
            wsl_path       = $null
            wsl_exit       = $null
            wsl_status     = $null
        }
        if ($dockerService) { $p4.docker_service = [string] $dockerService.Status }
        if ($dockerCommand) {
            $p4.docker_path = $dockerCommand.Source
            $server = Invoke-Native -FilePath 'docker' -Arguments @('version', '--format', '{{.Server.Os}} {{.Server.Version}}')
            $p4.server_exit = $server.Exit
            $p4.server = $server.Output
        }
        if ($wslCommand) {
            $p4.wsl_path = $wslCommand.Source
            $wsl = Invoke-Native -FilePath 'wsl.exe' -Arguments @('--status')
            $p4.wsl_exit = $wsl.Exit
            $p4.wsl_status = $wsl.Output
        }
        Write-Measurement -Title 'P4_engine' -Fields $p4
    } catch {
        Write-Measurement -Title 'P4_engine' -Fields ([ordered]@{ error = $_.Exception.Message })
    }

    # --- P4b: what does docker run say with the engine stopped? -------------
    $p4b = [ordered]@{ state = 'skipped' }
    try {
        if ($dockerService -and [string] $dockerService.Status -eq 'Running' -and (Get-Command docker -ErrorAction SilentlyContinue)) {
            $p4b.state = 'measured'
            try {
                Stop-Service -Name docker -Force
                $p4b['service_stopped'] = [string] (Get-Service -Name docker).Status
                $stoppedRun = Invoke-Native -FilePath 'docker' -Arguments @('run', '--rm', 'hello-world')
                $p4b['run_exit'] = $stoppedRun.Exit
                $p4b['run_first_line'] = @($stoppedRun.Output -split '\r?\n')[0]
            } finally {
                Start-Service -Name docker -ErrorAction SilentlyContinue
                $p4b['service_after'] = [string] (Get-Service -Name docker).Status
            }
        }
    } catch {
        $p4b['error'] = $_.Exception.Message
    }
    Write-Measurement -Title 'P4b_engine_stopped' -Fields $p4b

    # --- P6: can a created standard user run a child process? ---------------
    $p6 = [ordered]@{ created = $false; started = $null; exit = $null; output = $null; error = $null }
    $probeUser = "alcprobe$suffix"
    try {
        $password = ConvertTo-SecureString -String ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
        New-LocalUser -Name $probeUser -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
        $p6.created = $true
        Invoke-Native -FilePath 'icacls.exe' -Arguments @($probeRoot, '/grant', "${probeUser}:(OI)(CI)M") | Out-Null

        $p6Output = Join-Path $probeRoot 'p6.txt'
        $childCommand = @(
            "`$lines = @('WHOAMI:' + (whoami))",
            "try { `$rows = @(Get-SmbConnection -ErrorAction Stop); `$lines += 'SMB_ROWS:' + `$rows.Count }",
            "catch { `$lines += 'SMB_ERROR:' + `$_.Exception.Message }",
            "Set-Content -LiteralPath '$p6Output' -Value `$lines") -join [Environment]::NewLine
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))

        $credential = New-Object System.Management.Automation.PSCredential($probeUser, $password)
        $child = Start-Process -FilePath $powershellExe -Credential $credential -PassThru `
            -WorkingDirectory $probeRoot -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
        $p6.started = $true
        try { $null = $child.Handle } catch { }
        if ($child.WaitForExit(60000)) {
            $p6.exit = $child.ExitCode
        } else {
            $p6.exit = 'timed_out'
            $child.Kill()
        }
        $p6.output = Read-FileText -Path $p6Output
    } catch {
        $p6.error = $_.Exception.Message
    } finally {
        if ($p6.created) { Remove-LocalUser -Name $probeUser -ErrorAction SilentlyContinue }
    }
    Write-Measurement -Title 'P6_standard_user' -Fields $p6

    # --- P8: does injected console input reach a prompt? --------------------
    $p8 = [ordered]@{}
    try {
        # The injection runs in a child of its own: detaching from a console
        # and attaching to another would otherwise take this script's away.
        $injector = Join-Path $probeRoot 'inject.ps1'
        Set-Content -LiteralPath $injector -Encoding Ascii -Value @(
            'param([int] $TargetPid, [string] $Text)',
            '$source = @''',
            'using System;',
            'using System.Runtime.InteropServices;',
            'public static class AlcoveProbeConsoleInput {',
            '    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]',
            '    public struct KeyEventRecord {',
            '        [FieldOffset(0)] public int KeyDown;',
            '        [FieldOffset(4)] public ushort RepeatCount;',
            '        [FieldOffset(6)] public ushort VirtualKeyCode;',
            '        [FieldOffset(8)] public ushort VirtualScanCode;',
            '        [FieldOffset(10)] public char UnicodeChar;',
            '        [FieldOffset(12)] public uint ControlKeyState;',
            '    }',
            '    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]',
            '    public struct InputRecord {',
            '        [FieldOffset(0)] public ushort EventType;',
            '        [FieldOffset(4)] public KeyEventRecord KeyEvent;',
            '    }',
            '    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();',
            '    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);',
            '    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
            '    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);',
            '    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
            '    public static extern bool WriteConsoleInputW(IntPtr handle, InputRecord[] records, uint length, out uint written);',
            '    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);',
            '    public static string Send(uint pid, string text) {',
            '        FreeConsole();',
            '        if (!AttachConsole(pid)) { return "attach_failed_" + Marshal.GetLastWin32Error(); }',
            '        IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
            '        if (input == new IntPtr(-1)) { int openError = Marshal.GetLastWin32Error(); FreeConsole(); return "conin_failed_" + openError; }',
            '        string keys = text + "\r";',
            '        InputRecord[] records = new InputRecord[keys.Length * 2];',
            '        for (int i = 0; i < keys.Length; i++) {',
            '            char c = keys[i];',
            '            ushort key = c == (char)13 ? (ushort)0x0D : (ushort)char.ToUpperInvariant(c);',
            '            for (int down = 0; down < 2; down++) {',
            '                InputRecord record = new InputRecord();',
            '                record.EventType = 1;',
            '                record.KeyEvent.KeyDown = down == 0 ? 1 : 0;',
            '                record.KeyEvent.RepeatCount = 1;',
            '                record.KeyEvent.VirtualKeyCode = key;',
            '                record.KeyEvent.UnicodeChar = c;',
            '                records[i * 2 + down] = record;',
            '            }',
            '        }',
            '        uint written;',
            '        bool ok = WriteConsoleInputW(input, records, (uint)records.Length, out written);',
            '        int writeError = Marshal.GetLastWin32Error();',
            '        CloseHandle(input);',
            '        FreeConsole();',
            '        return ok ? "written_" + written : "write_failed_" + writeError;',
            '    }',
            '}',
            '''@',
            'Add-Type -TypeDefinition $source',
            '[AlcoveProbeConsoleInput]::Send([uint32] $TargetPid, $Text)')

        $cmdOut = Join-Path $probeRoot 'p8-cmd.txt'
        $cmdTarget = Join-Path $probeRoot 'p8-cmd.cmd'
        Set-Content -LiteralPath $cmdTarget -Encoding Ascii -Value @(
            '@echo off',
            'set /p ANSWER=Answer: ',
            "> `"$cmdOut`" echo READ:%ANSWER%")

        $psOut = Join-Path $probeRoot 'p8-ps.txt'
        $psTarget = Join-Path $probeRoot 'p8-ps.ps1'
        Set-Content -LiteralPath $psTarget -Encoding Ascii -Value @(
            '$secure = Read-Host ''Password'' -AsSecureString',
            '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
            'try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }',
            'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
            "Set-Content -LiteralPath '$psOut' -Value ('READ:' + `$plain) -Encoding Ascii")

        $targets = @(
            @{ Key = 'cmd'; File = 'cmd.exe'; Args = @('/c', "`"$cmdTarget`""); Out = $cmdOut },
            @{ Key = 'ps'; File = $powershellExe; Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$psTarget`""); Out = $psOut })
        foreach ($target in $targets) {
            $key = $target.Key
            # No -NoNewWindow: the target gets a console of its own, as an
            # operator's window would.
            $process = Start-Process -FilePath $target.File -ArgumentList $target.Args -PassThru
            try {
                Start-Sleep -Seconds 3
                $sent = Invoke-Native -FilePath $powershellExe -Arguments @(
                    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $injector,
                    '-TargetPid', [string] $process.Id, '-Text', 'abc')
                $p8["${key}_inject"] = $sent.Output
                $p8["${key}_read"] = $null
                if (Wait-ForFile -Path $target.Out -TimeoutSeconds 20) { $p8["${key}_read"] = Read-FileText -Path $target.Out }
                $p8["${key}_exited"] = $process.HasExited
            } finally {
                if (-not $process.HasExited) { $process.Kill() }
            }
        }
    } catch {
        $p8['error'] = $_.Exception.Message
    }
    Write-Measurement -Title 'P8_console_input' -Fields $p8
} catch {
    Write-HarnessError $_.Exception.Message
} finally {
    Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Always green: the annotations above are the deliverable.
exit 0
