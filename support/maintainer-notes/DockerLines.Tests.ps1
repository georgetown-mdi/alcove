<#
.SYNOPSIS
    Pester suite that runs the docker lines README.md prints, and the line the
    console's shared-folder notice gives, under Windows PowerShell and checks the
    arguments each one hands to docker. Maintainer-facing.

.DESCRIPTION
    The commands are read from docker-lines.txt, each followed by the arguments
    it means docker to receive. The repository test
    scripts/docker-lines.test.mjs writes that file from README.md and the
    console's flags, compares it on every run, and splits the same lines under
    bash and sh; rewrite it with `npx vitest run -u` on that test. Only the
    lines printed on one line are here: a line continued with a trailing
    backslash is for a Mac or Linux shell, and the README says so above it.

    Every command runs from a local folder whose name contains a space, which
    is what <working folder> in the file stands for. docker is the stand-in
    DockerStandIn.ps1 compiles; nothing here starts a container.

    Run it through ci-resolution-tests.ps1 rather than Invoke-Pester directly:
    that script is what reports results as annotations.
#>

BeforeDiscovery {
    function Read-DockerLine {
        param([Parameter(Mandatory = $true)] [string] $Path)
        $entries = New-Object System.Collections.ArrayList
        $current = $null
        foreach ($line in Get-Content -LiteralPath $Path) {
            if ($line.StartsWith('docker ')) {
                $current = @{ Command = $line; Arguments = New-Object System.Collections.ArrayList }
                [void] $entries.Add($current)
            } elseif ($line -match '^  \[(.*)\]$' -and $null -ne $current) {
                [void] $current.Arguments.Add($Matches[1])
            } elseif ($line.Trim().Length -ne 0) {
                throw "docker-lines.txt holds a line that is neither a command nor an argument: $line"
            }
        }
        $entries
    }
    $dockerLines = @(Read-DockerLine -Path (Join-Path $PSScriptRoot 'docker-lines.txt'))
}

BeforeAll {
    . (Join-Path $PSScriptRoot 'DockerStandIn.ps1')
    $script:standIn = Enable-DockerStandIn

    $script:createdFolder = Join-Path ([IO.Path]::GetTempPath()) ('alcove docker lines ' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:createdFolder | Out-Null
    Push-Location -LiteralPath $script:createdFolder
    # Taken from the location rather than the created path, which can differ
    # from it in an 8.3 short name or in letter case.
    $script:workingFolder = (Get-Location).Path
}

AfterAll {
    Pop-Location
    Disable-DockerStandIn -StandIn $script:standIn
    Remove-Item -LiteralPath $script:createdFolder -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'The README and console docker lines in Windows PowerShell' {
    It 'runs under Windows PowerShell 5.1' {
        $PSVersionTable.PSEdition | Should -Be 'Desktop'
        "$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)" | Should -Be '5.1'
    }

    It 'reads at least one command from the generated file' {
        @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'docker-lines.txt') |
            Where-Object { $_.StartsWith('docker ') }).Count | Should -BeGreaterThan 0
    }

    It 'runs from a local folder whose name contains a space' {
        (Get-Location).Provider.Name | Should -Be 'FileSystem'
        $script:workingFolder | Should -Match '^[A-Za-z]:\\'
        Split-Path -Leaf $script:workingFolder | Should -Match ' '
    }

    It 'hands docker each word as one argument: <Command>' -ForEach $dockerLines {
        $received = @(Get-DockerArgument -CommandLine $Command)
        $intended = @($Arguments | ForEach-Object { $_.Replace('<working folder>', $script:workingFolder) })
        ($received -join ' | ') | Should -Be ($intended -join ' | ')
    }
}

Describe 'Forms that fail in Windows PowerShell 5.1' {
    It 'a mount quoted only around the host path reaches docker as two arguments' {
        $received = @(Get-DockerArgument -CommandLine 'docker run -v "/path/to/shared-folder":/shared image')
        ($received -join ' | ') | Should -Be 'run | -v | /path/to/shared-folder | :/shared | image'
    }

    It 'a command continued with a trailing backslash does not parse' {
        $tokens = $null
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseInput(
            "docker run --rm \`n  --env JOB_RENDEZVOUS_DIR=/shared \`n  image serve",
            [ref] $tokens, [ref] $parseErrors) | Out-Null
        @($parseErrors | ForEach-Object { $_.ErrorId }) | Should -Contain 'MissingExpressionAfterOperator'
    }

    It 'a backslash before ! reaches docker, unlike in bash' {
        $received = @(Get-DockerArgument -CommandLine 'docker run image sftp://user:passw\!rd@example.org/psi')
        $received | Should -Contain 'sftp://user:passw\!rd@example.org/psi'
    }

    It '${PWD} from a network location is provider-qualified, not a path docker can mount' {
        $local = (Get-Location).Path
        $unc = '\\localhost\' + $local.Substring(0, 1) + '$' + $local.Substring(2)
        Set-Location -LiteralPath $unc
        try {
            $received = @(Get-DockerArgument -CommandLine 'docker run -v "${PWD}:/work" image')
            $received[2] | Should -Be "Microsoft.PowerShell.Core\FileSystem::$($unc):/work"
        } finally {
            Set-Location -LiteralPath $local
        }
    }

    It '${PWD} from the same location through a mapped drive letter is a drive path' {
        $local = (Get-Location).Path
        $unc = '\\localhost\' + $local.Substring(0, 1) + '$' + $local.Substring(2)
        $letter = [string] (@('Z', 'Y', 'X', 'W', 'V') |
                Where-Object { -not (Test-Path -LiteralPath "$($_):\") } |
                Select-Object -First 1)
        $letter | Should -Not -BeNullOrEmpty
        New-PSDrive -Name $letter -PSProvider FileSystem -Root $unc -Persist -Scope Global | Out-Null
        try {
            Set-Location -LiteralPath "$($letter):\"
            $received = @(Get-DockerArgument -CommandLine 'docker run -v "${PWD}:/work" image')
            $received[2] | Should -Be "$($letter):\:/work"
        } finally {
            Set-Location -LiteralPath $local
            Remove-PSDrive -Name $letter -Force -ErrorAction SilentlyContinue
        }
    }
}
