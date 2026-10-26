<#
.SYNOPSIS
    A docker stand-in for the Pester suites that run copyable docker lines
    under Windows PowerShell: AcceptSheet.Tests.ps1 and DockerLines.Tests.ps1.
    Maintainer-facing; dot-source it from a suite's BeforeAll.

.DESCRIPTION
    Enable-DockerStandIn compiles a recorder to docker.exe in a temporary folder
    and puts that folder first on PATH. The recorder prints each argument it
    receives on its own line, in brackets, so a test sees what Windows
    PowerShell 5.1 passed to a native command. Nothing here starts a container.
#>

function Enable-DockerStandIn {
    <#  Compile the recorder and put it first on PATH. Returns what
        Disable-DockerStandIn needs to undo it. #>
    $folder = Join-Path ([IO.Path]::GetTempPath()) ('alcove-docker-recorder-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $folder | Out-Null
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
    Add-Type -TypeDefinition $recorderSource -OutputAssembly (Join-Path $folder 'docker.exe') -OutputType ConsoleApplication
    $savedPath = $env:PATH
    $env:PATH = "$folder;$env:PATH"
    @{ Folder = $folder; SavedPath = $savedPath }
}

function Disable-DockerStandIn {
    param([Parameter(Mandatory = $true)] [hashtable] $StandIn)
    $env:PATH = $StandIn.SavedPath
    Remove-Item -LiteralPath $StandIn.Folder -Recurse -Force -ErrorAction SilentlyContinue
}

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
