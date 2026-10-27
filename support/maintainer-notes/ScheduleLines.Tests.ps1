<#
.SYNOPSIS
    Pester suite registering the Task Scheduler lines the web app's
    recurring hand-offs show, each pasted into the shell the panel names, and
    running each task it registers. Maintainer-facing.

.DESCRIPTION
    The lines are read from schedule-lines.txt, each with the shell it is
    pasted into, the trigger it means to register, and the arguments it means
    docker to receive. The web unit test
    apps/web/test/unit/recurring/scheduledRunCommand.test.ts writes that file
    from the line generator and compares it on every run; rewrite it with
    `npx vitest run -u` on that test.

    Each line is used as an operator uses it: the folder placeholder replaced
    with a folder whose name holds a space and a single quote, then run by a
    new cmd or Windows PowerShell process as typed at its prompt. Each line
    runs once under the en-US culture and once under en-GB, set with
    Set-Culture before that process starts, so schtasks and PowerShell read
    dates the way a British machine does.

    The task each line registers is read back with Get-ScheduledTask and
    Get-ScheduledTaskInfo and started. docker is a stand-in compiled into the
    folder, which cmd finds in the task's working folder before the runner's
    own docker; it writes the arguments it received to a file there. A task
    that does not write it within 60 s fails with the task's stored action,
    the processes it left running, and the folder's files.

    Last, it checks the two schtasks behaviors that are why the generator
    writes no schtasks line: schtasks reads a /SD date in the culture's
    format, and turns a single quote in /TR into a double quote.

    Every task the suite creates is stopped and deleted and the culture
    restored, test by test. The suite runs alone (the schedule job of
    .github/workflows/windows_resolution.yaml), because the culture it sets
    reaches every process started while it is set. Run it through
    ci-resolution-tests.ps1 -Suite ScheduleLines.

    Last, each line is run once more in a new PowerShell an application-control
    policy has put in ConstrainedLanguage (the machine-wide
    __PSLockdownPolicy=4, set in that block's BeforeAll and cleared in its
    AfterAll, as ConstrainedLanguage.Tests.ps1 does), under en-US. Whether
    the task registers, and with what trigger, is measured rather than
    asserted: each line is reported through $global:AlcoveMeasurements, which
    ci-resolution-tests.ps1 turns into ::notice annotations, and fails the job
    as a harness error when the session under test is not in
    ConstrainedLanguage.
#>

BeforeDiscovery {
    $entries = New-Object System.Collections.ArrayList
    $current = $null
    foreach ($text in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'schedule-lines.txt')) {
        if ($text.StartsWith('shell: ')) {
            $current = @{ Shell = $text.Substring(7); Trigger = $null; Line = $null; Arguments = New-Object System.Collections.ArrayList }
            [void] $entries.Add($current)
        } elseif ($null -eq $current) {
            if ($text.Trim().Length -ne 0) { throw "schedule-lines.txt starts with a line that is not a shell: $text" }
        } elseif ($text.StartsWith('trigger: ')) {
            $current.Trigger = $text.Substring(9)
        } elseif ($text -match '^  \[(.*)\]$') {
            [void] $current.Arguments.Add($Matches[1])
        } elseif ($text.Trim().Length -ne 0) {
            if ($null -ne $current.Line) { throw "schedule-lines.txt holds two lines for one entry: $text" }
            $current.Line = $text
        }
    }
    $constrainedCases = for ($index = 0; $index -lt $entries.Count; $index++) {
        @{ Number = $index + 1; Shell = $entries[$index].Shell; Trigger = $entries[$index].Trigger; Line = $entries[$index].Line }
    }
    $cases = foreach ($culture in @('en-US', 'en-GB')) {
        foreach ($entry in $entries) {
            @{
                Culture   = $culture
                Shell     = $entry.Shell
                Trigger   = $entry.Trigger
                Line      = $entry.Line
                Arguments = @($entry.Arguments)
            }
        }
    }
}

BeforeAll {
    $script:TaskName = 'alcove exchange'
    $script:Placeholder = 'C:\path\to\your\exchange-folder'
    $script:CultureBefore = (Get-Culture).Name

    $global:AlcoveRigPremises = [ordered]@{ schedule = [ordered]@{ state = 'not_reached'; culture_before = $script:CultureBefore } }
    $global:AlcoveMeasurements = [ordered]@{}

    # On the system drive rather than under the runner's profile, whose temp
    # path is an 8.3 short name.
    $script:Folder = Join-Path $env:SystemDrive ("alcove sched it's " + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $script:Folder | Out-Null
    $script:Recorded = Join-Path $script:Folder 'docker-argv.txt'
    # Written under another name and moved, so the file is whole once it
    # exists. Brackets keep an empty or space-edged argument visible.
    $recorderSource = @'
public static class AlcoveScheduledDockerRecorder {
    public static void Main(string[] args) {
        string[] lines = new string[args.Length];
        for (int i = 0; i < args.Length; i++) { lines[i] = "[" + args[i] + "]"; }
        string folder = System.Environment.CurrentDirectory;
        string partial = System.IO.Path.Combine(folder, "docker-argv.partial");
        System.IO.File.WriteAllLines(partial, lines);
        System.IO.File.Move(partial, System.IO.Path.Combine(folder, "docker-argv.txt"));
    }
}
'@
    Add-Type -TypeDefinition $recorderSource -OutputAssembly (Join-Path $script:Folder 'docker.exe') -OutputType ConsoleApplication
    $global:AlcoveRigPremises.schedule.state = 'built'
    $global:AlcoveRigPremises.schedule['folder'] = $script:Folder

    function Remove-TestTask {
        Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }

    function Invoke-PastedLine {
        <#  Run one line as typed at a prompt of $Shell, in a new process, so
            it reads the culture set before it started. Returns the exit code
            and both streams. #>
        param([Parameter(Mandatory = $true)][string] $Shell, [Parameter(Mandatory = $true)][string] $Line)

        $info = New-Object System.Diagnostics.ProcessStartInfo
        if ($Shell -eq 'Command Prompt') {
            $info.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
            # With /s, cmd drops the outer quotes and reads the rest as typed.
            $info.Arguments = '/d /s /c "' + $Line + '"'
        } elseif ($Shell -eq 'PowerShell') {
            $info.FileName = Join-Path $PSHOME 'powershell.exe'
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Line))
            $info.Arguments = "-NoProfile -NonInteractive -EncodedCommand $encoded"
        } else {
            throw "schedule-lines.txt names a shell this suite does not run: $Shell"
        }
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($info)
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEnd()
        if (-not $process.WaitForExit(120000)) {
            $process.Kill()
            throw "the $Shell line did not finish within 120 s"
        }
        return [ordered]@{ Exit = $process.ExitCode; Output = (($output.Result + ' ' + $errors) -replace '\s+', ' ').Trim() }
    }

    function Wait-ForRecorded {
        param([int] $TimeoutSeconds = 60)
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $script:Recorded)) {
            Start-Sleep -Milliseconds 500
        }
        return (Test-Path -LiteralPath $script:Recorded)
    }

    function Get-TaskRunDiagnostics {
        <#  One line stating what the task stored and what it left running:
            its actions, the cmd processes the Task Scheduler service started
            and their descendants, any docker or WerFault process, and the
            folder's files. #>
        $parts = New-Object System.Collections.ArrayList
        $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        foreach ($action in @($task.Actions)) {
            [void] $parts.Add("action Execute=[$($action.Execute)] Arguments=[$($action.Arguments)] WorkingDirectory=[$($action.WorkingDirectory)]")
        }
        $processes = @(Get-CimInstance Win32_Process)
        $schedulePid = (Get-CimInstance Win32_Service -Filter "Name='Schedule'").ProcessId
        $shown = @{}
        $pending = New-Object System.Collections.Queue
        foreach ($process in $processes) {
            if ($process.ParentProcessId -eq $schedulePid -and $process.Name -eq 'cmd.exe') { $pending.Enqueue($process) }
            if ($process.Name -eq 'docker.exe' -or $process.Name -eq 'WerFault.exe') { $pending.Enqueue($process) }
        }
        while ($pending.Count -gt 0) {
            $process = $pending.Dequeue()
            if ($shown.ContainsKey($process.ProcessId)) { continue }
            $shown[$process.ProcessId] = $true
            [void] $parts.Add("process $($process.ProcessId) parent $($process.ParentProcessId) $($process.ExecutablePath): $($process.CommandLine)")
            foreach ($child in $processes) {
                if ($child.ParentProcessId -eq $process.ProcessId) { $pending.Enqueue($child) }
            }
        }
        if ($shown.Count -eq 0) { [void] $parts.Add('process none from the Task Scheduler service') }
        [void] $parts.Add("folder holds [$((@(Get-ChildItem -LiteralPath $script:Folder -Name)) -join ', ')]")
        return ($parts -join ' || ')
    }
}

AfterAll {
    Remove-TestTask
    Set-Culture -CultureInfo $script:CultureBefore
    Remove-Item -LiteralPath $script:Folder -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'The Task Scheduler lines, pasted and run' {
    It 'reads PowerShell lines from the generated file' {
        $shells = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'schedule-lines.txt') |
                Where-Object { $_.StartsWith('shell: ') } | Sort-Object -Unique)
        $shells | Should -Be @('shell: PowerShell')
    }

    It 'under <Culture>, the <Shell> line registers <Trigger> and runs docker with its arguments' -ForEach $cases {
        $expected = @{}
        foreach ($pair in $Trigger -split ' ') {
            $name, $value = $pair -split '=', 2
            $expected[$name] = $value
        }
        $intended = @($Arguments | ForEach-Object { $_.Replace($script:Placeholder, $script:Folder) })

        Remove-TestTask
        Remove-Item -LiteralPath $script:Recorded -Force -ErrorAction SilentlyContinue
        Set-Culture -CultureInfo $Culture
        try {
            $run = Invoke-PastedLine -Shell $Shell -Line $Line.Replace($script:Placeholder, $script:Folder)
            $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
            $task | Should -Not -BeNullOrEmpty -Because "the line registered no task (exit $($run.Exit): $($run.Output))"

            $trigger = @($task.Triggers)[0]
            $start = [string] $trigger.StartBoundary
            $start | Should -Match ('T' + $expected.time + ':00') -Because 'the task starts at the line''s time'
            if ($expected.start -ne '-') {
                $start | Should -Match ('^' + $expected.start + 'T') -Because 'the start date is the first window''s'
            }
            $next = (Get-ScheduledTaskInfo -TaskName $script:TaskName).NextRunTime
            $next | Should -Not -BeNullOrEmpty -Because "the task has no next run (start $start)"
            $next.ToString('HH:mm', [Globalization.CultureInfo]::InvariantCulture) | Should -Be $expected.time
            if ($expected.weekday -ne '-') {
                $trigger.CimClass.CimClassName | Should -Be 'MSFT_TaskWeeklyTrigger'
                $trigger.WeeksInterval | Should -Be 1
                $next.DayOfWeek.ToString() | Should -Be $expected.weekday
            } else {
                $trigger.CimClass.CimClassName | Should -Be 'MSFT_TaskDailyTrigger'
                $trigger.DaysInterval | Should -Be ([int] $expected.interval)
            }
            if ($expected.start -ne '-') {
                $first = [datetime]::ParseExact($expected.start, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
                (($next.Date - $first).Days % [int] $expected.interval) | Should -Be 0 -Because "the next run, $next, is a whole number of intervals from the first window"
            }

            Start-ScheduledTask -TaskName $script:TaskName
            $ran = Wait-ForRecorded
            $diagnostics = if ($ran) { '' } else { Get-TaskRunDiagnostics }
            $ran | Should -BeTrue -Because "the task did not run docker in the folder within 60 s (last result $((Get-ScheduledTaskInfo -TaskName $script:TaskName).LastTaskResult)): $diagnostics"
            $received = @(Get-Content -LiteralPath $script:Recorded | ForEach-Object { $_.Substring(1, $_.Length - 2) })
            ($received -join ' | ') | Should -Be ($intended -join ' | ')
        } finally {
            # A task still running would otherwise outlive its deletion.
            Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
            Remove-TestTask
            Set-Culture -CultureInfo $script:CultureBefore
        }
    }
}

Describe 'What schtasks does to a start date and a single quote' {
    It 'reads /SD 03/04/2026 as 3 April under en-GB' {
        Remove-TestTask
        Set-Culture -CultureInfo 'en-GB'
        try {
            $run = Invoke-PastedLine -Shell 'Command Prompt' -Line ('schtasks /Create /TN "' + $script:TaskName + '" /SC DAILY /MO 3 /SD 03/04/2026 /ST 14:30 /TR "cmd /c exit 0"')
            $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
            $task | Should -Not -BeNullOrEmpty -Because "schtasks registered no task (exit $($run.Exit): $($run.Output))"
            [string] @($task.Triggers)[0].StartBoundary | Should -Match '^2026-04-03T14:30:00'
        } finally {
            Remove-TestTask
            Set-Culture -CultureInfo $script:CultureBefore
        }
    }

    It 'stores a single quote in /TR as a double quote' {
        Remove-TestTask
        try {
            $run = Invoke-PastedLine -Shell 'Command Prompt' -Line ('schtasks /Create /TN "' + $script:TaskName + '" /SC DAILY /ST 14:30 /TR "cmd /c echo it''s"')
            $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
            $task | Should -Not -BeNullOrEmpty -Because "schtasks registered no task (exit $($run.Exit): $($run.Output))"
            @($task.Actions)[0].Arguments | Should -Be '/c echo it"s'
        } finally {
            Remove-TestTask
        }
    }
}

Describe 'The Task Scheduler lines, pasted into a PowerShell in ConstrainedLanguage' {
    BeforeAll {
        # The ScheduledTasks module is loaded here, before the policy, so this
        # session never has to load it under the policy.
        Import-Module ScheduledTasks

        function Start-ConstrainedPastedLine {
            <#  Run one line in a new powershell.exe and return its exit code
                and both streams, with standard input from a file so that a
                run reaching a prompt ends rather than waits. #>
            param([Parameter(Mandatory = $true)][string] $Line, [int] $TimeoutSeconds = 120)

            $outFile = [IO.Path]::GetTempFileName()
            $errFile = [IO.Path]::GetTempFileName()
            $inFile = [IO.Path]::GetTempFileName()
            try {
                $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Line))
                $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
                    -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) `
                    -NoNewWindow -PassThru -RedirectStandardInput $inFile `
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
                $stdout = [string] (Get-Content -LiteralPath $outFile -Raw)
                $stderr = [string] (Get-Content -LiteralPath $errFile -Raw)
                return [ordered]@{
                    TimedOut = (-not $exited)
                    Exit     = $exitCode
                    Output   = (($stdout + ' ' + $stderr) -replace '\s+', ' ').Trim()
                }
            } finally {
                Remove-Item -LiteralPath $outFile, $errFile, $inFile -Force -ErrorAction SilentlyContinue
            }
        }

        $global:AlcoveRigPremises.clm = [ordered]@{ state = 'not_reached' }
        $script:LockdownName = '__PSLockdownPolicy'
        $script:LockdownBefore = [Environment]::GetEnvironmentVariable($script:LockdownName, 'Machine')
        $script:LockdownSet = $false
        $script:ChildMode = 'not_measured'
        # The policy last, once nothing this session still has to load is left.
        try {
            [Environment]::SetEnvironmentVariable($script:LockdownName, '4', 'Machine')
            $script:LockdownSet = $true
            $probe = Start-ConstrainedPastedLine -Line '$ExecutionContext.SessionState.LanguageMode' -TimeoutSeconds 60
            $script:ChildMode = $probe.Output
            $global:AlcoveRigPremises.clm = [ordered]@{
                state         = 'policy_set'
                route         = 'machine_PSLockdownPolicy_4'
                child_encoded = $script:ChildMode
                harness       = [string] $ExecutionContext.SessionState.LanguageMode
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
        Remove-TestTask
        Set-Culture -CultureInfo $script:CultureBefore
    }

    It 'is in effect in a new PowerShell, while this session keeps FullLanguage' {
        $shape = ($global:AlcoveRigPremises.clm.Keys | ForEach-Object {
                "$_=$($global:AlcoveRigPremises.clm[$_])" }) -join ' '
        $script:LockdownSet | Should -BeTrue -Because $shape
        $script:ChildMode | Should -Be 'ConstrainedLanguage' -Because $shape
        [string] $ExecutionContext.SessionState.LanguageMode | Should -Be 'FullLanguage' -Because $shape
    }

    It 'line <Number> is run and what it registers is recorded' -ForEach $constrainedCases {
        $expected = @{}
        foreach ($pair in $Trigger -split ' ') {
            $name, $value = $pair -split '=', 2
            $expected[$name] = $value
        }

        Remove-TestTask
        Set-Culture -CultureInfo 'en-US'
        try {
            $run = Start-ConstrainedPastedLine -Line $Line.Replace($script:Placeholder, $script:Folder)
            $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
            $measurement = [ordered]@{
                intended   = $Trigger
                registered = ($null -ne $task)
                exit       = $run.Exit
                timedout   = $run.TimedOut
            }
            if ($task) {
                $registered = @($task.Triggers)[0]
                $start = [string] $registered.StartBoundary
                $class = [string] $registered.CimClass.CimClassName
                $interval = if ($class -eq 'MSFT_TaskWeeklyTrigger') { $registered.WeeksInterval } else { $registered.DaysInterval }
                $asIntended = ($start -match ('T' + $expected.time + ':00')) -and
                    (($expected.start -eq '-') -or ($start -match ('^' + $expected.start + 'T'))) -and
                    ($interval -eq [int] $expected.interval) -and
                    ($class -eq $(if ($expected.weekday -ne '-') { 'MSFT_TaskWeeklyTrigger' } else { 'MSFT_TaskDailyTrigger' }))
                $measurement['as_intended'] = $asIntended
                $measurement['start'] = $start
                $measurement['trigger_class'] = $class
                $measurement['interval'] = $interval
                if ($class -eq 'MSFT_TaskWeeklyTrigger') { $measurement['days_of_week'] = [string] $registered.DaysOfWeek }
            }
            $measurement['output'] = $run.Output
            $global:AlcoveMeasurements["schedule_clm_line$Number"] = $measurement
        } finally {
            Remove-TestTask
            Set-Culture -CultureInfo $script:CultureBefore
        }
    }
}
