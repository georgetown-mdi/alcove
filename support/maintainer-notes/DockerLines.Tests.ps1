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

Describe 'PROBE docker line forms (record only)' {
    It 'records the arguments each form hands to docker' {
        $probes = [ordered]@{
            'mount-src-quoted-pwd'      = 'docker run --mount type=bind,src="$PWD",dst=/work img'
            'mount-src-bare-pwd'        = 'docker run --mount type=bind,src=$PWD,dst=/work img'
            'mount-whole-quoted-braced' = 'docker run --mount "type=bind,src=${PWD},dst=/work" img'
            'mount-placeholder'         = 'docker run --mount type=bind,src=WORK_PATH,dst=/work img'
            'mount-windows-path-bare'   = 'docker run --mount type=bind,src=C:\Users\me\psi-exchange,dst=/work img'
            'mount-windows-path-single' = 'docker run --mount type=bind,src=''C:\Users\me\Documents\alcove'',dst=/work img'
            'v-quoted-then-colon'       = 'docker run -v "/path/to/shared-folder":/shared img'
            'v-whole-quoted'            = 'docker run -v "/path/to/shared-folder:/shared" img'
            'v-placeholder-whole'       = 'docker run -v "WORK_PATH:/work" img'
            'password-backslash-bang'   = 'docker run img sftp://user:passw\!rd@example.org/psi'
            'password-single-quoted'    = 'docker run img ''sftp://user:passw!rd@example.org/psi'''
            'at-file-mid-word'          = 'docker run img --server-password=@passwd x'
            'fingerprint'               = 'docker run img --server-host-key-fingerprint=SHA256:FINGERPRINT x'
            'continuation'              = "docker run --rm \`n  --env JOB_RENDEZVOUS_DIR=/shared \`n  img serve"
        }
        foreach ($case in $probes.Keys) {
            try {
                $received = @(Invoke-Expression $probes[$case] 2>&1 | ForEach-Object { [string] $_ })
                Write-Host ("PROBE ${case}: " + (ConvertTo-Json -Compress -InputObject $received))
            } catch {
                Write-Host ("PROBE ${case}: ERROR " + $_.Exception.Message)
            }
        }
        $startedIn = (Get-Location).Path
        try {
            $unc = '\\localhost\' + $startedIn.Substring(0, 1) + '$' + $startedIn.Substring(2)
            Set-Location -LiteralPath $unc -ErrorAction Stop
            Write-Host ('PROBE unc-pwd: ' + "${PWD}")
            Write-Host ('PROBE unc-provider-path: ' + (Get-Location).ProviderPath)
        } catch {
            Write-Host ('PROBE unc: ERROR ' + $_.Exception.Message)
        } finally {
            Set-Location -LiteralPath $startedIn
        }
    }
}
