<#
.SYNOPSIS
    Pester suite that runs the accept sheet's Windows PowerShell commands and
    checks the arguments each one hands to docker. Maintainer-facing: an
    operator following the setup page never receives it.

.DESCRIPTION
    The commands are read from accept-sheet-powershell-lines.txt, which the web
    unit test apps/web/test/unit/exchange/acceptKit.test.ts compares with the
    sheet generator's output on every run, so this suite runs what a partner
    copies off the sheet. Rewrite the file from the generator with
    `npx vitest run -u` on that test.

    A recorder compiled to docker.exe and put first on PATH stands in for
    docker: it prints each argument it receives on its own line, so a test sees
    what Windows PowerShell 5.1 passed to a native command. Nothing here starts
    a container.

    Run it through ci-resolution-tests.ps1 rather than Invoke-Pester directly:
    that script is what reports results as annotations, which is all the CI
    reader can see.
#>

BeforeDiscovery {
    $sheetCommands = @(
        Get-Content -LiteralPath (Join-Path $PSScriptRoot 'accept-sheet-powershell-lines.txt') |
            Where-Object { $_.Trim().Length -gt 0 } |
            ForEach-Object { @{ Command = $_ } }
    )
}

BeforeAll {
    $script:sheetCommandCount = @(
        Get-Content -LiteralPath (Join-Path $PSScriptRoot 'accept-sheet-powershell-lines.txt') |
            Where-Object { $_.Trim().Length -gt 0 }
    ).Count

    $script:recorderFolder = Join-Path ([IO.Path]::GetTempPath()) ('alcove-docker-recorder-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:recorderFolder | Out-Null
    $script:recorderPath = Join-Path $script:recorderFolder 'docker.exe'
    # Brackets around each argument keep an empty or space-edged one visible.
    $recorderSource = @'
public static class AlcoveDockerRecorder {
    public static void Main(string[] args) {
        foreach (string argument in args) {
            System.Console.WriteLine("[" + argument + "]");
        }
    }
}
'@
    Add-Type -TypeDefinition $recorderSource -OutputAssembly $script:recorderPath -OutputType ConsoleApplication

    $script:savedPath = $env:PATH
    $env:PATH = "$script:recorderFolder;$env:PATH"

    function Get-DockerArgument {
        <#  Run one command line as typed at a prompt and return the arguments
            the docker stand-in received. #>
        param([Parameter(Mandatory = $true)] [string] $CommandLine)

        @(Invoke-Expression $CommandLine) | ForEach-Object {
            $text = [string] $_
            if ($text.Length -lt 2 -or $text[0] -ne '[' -or $text[$text.Length - 1] -ne ']') {
                throw "the docker stand-in printed an unexpected line: $text"
            }
            $text.Substring(1, $text.Length - 2)
        }
    }

    function Get-IntendedArgument {
        <#  The words of a sheet command after docker, each with one pair of
            surrounding quotes removed: what the partner means docker to
            receive. A quoted value holding a space would split here and fail
            the comparison, rather than pass it. #>
        param([Parameter(Mandatory = $true)] [string] $CommandLine)

        $words = @($CommandLine -split ' ')
        if ($words[0] -ne 'docker') { throw "a sheet command does not start with docker: $CommandLine" }
        $words | Select-Object -Skip 1 | ForEach-Object {
            if ($_ -match '^"(.*)"$' -or $_ -match "^'(.*)'$") { $Matches[1] } else { $_ }
        }
    }
}

AfterAll {
    $env:PATH = $script:savedPath
    Remove-Item -LiteralPath $script:recorderFolder -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'The accept sheet''s Windows PowerShell commands' {
    It 'runs under Windows PowerShell 5.1' {
        $PSVersionTable.PSEdition | Should -Be 'Desktop'
        "$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)" | Should -Be '5.1'
    }

    It 'reads at least one command from the generated file' {
        $script:sheetCommandCount | Should -BeGreaterThan 0
    }

    It 'resolves docker to the stand-in' {
        # Checked by what it prints rather than by path: the temporary folder
        # can be named in its short 8.3 form on one side and not the other.
        (@(Get-DockerArgument -CommandLine 'docker stand-in-probe') -join ' | ') |
            Should -Be 'stand-in-probe'
    }

    It 'hands docker each word as one argument: <Command>' -ForEach $sheetCommands {
        $received = @(Get-DockerArgument -CommandLine $Command)
        $intended = @(Get-IntendedArgument -CommandLine $Command)
        ($received -join ' | ') | Should -Be ($intended -join ' | ')
    }
}

Describe 'The forms the sheet gave before' {
    It 'an unquoted @invitation.txt does not parse' {
        $tokens = $null
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseInput(
            'docker run image accept @invitation.txt', [ref] $tokens, [ref] $parseErrors) | Out-Null
        @($parseErrors | ForEach-Object { $_.ErrorId }) | Should -Contain 'SplattingNotPermitted'
    }

    It 'a mount quoted only around the folder reaches docker as two arguments' {
        $received = @(Get-DockerArgument -CommandLine 'docker run -v "C:\Users\you\exchange":/work image')
        ($received -join ' | ') | Should -Be ('run | -v | C:\Users\you\exchange | :/work | image')
    }
}
