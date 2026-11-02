<#
.SYNOPSIS
    Runs one of the guide's PowerShell scripts with its prompts answered from a
    list. Invoke-VmPass.ps1 starts it, one process per run.

.DESCRIPTION
    The Read-Host function below is found before the cmdlet by the script it
    runs, which has no password parameter. Each prompt takes the next answer,
    and is written to the screen with it. An answer may be a token:

      @password          the share password, read from the DPAPI file
      @made-up-password  a random password
      @wait-stop-file    wait for the stop file, delete it, answer Enter
      @stop-docker:TEXT  stop Docker Desktop, wait until it stops answering,
                         then answer TEXT

    The two password tokens answer only a -AsSecureString prompt, as a
    SecureString. A prompt with no answer left, or a password token at any
    other prompt, ends the run with exit 97.
#>

param([Parameter(Mandatory = $true)][string] $RequestFile)

$ErrorActionPreference = 'Stop'

$request = Get-Content -Raw -LiteralPath $RequestFile | ConvertFrom-Json
# Global and uniquely named: $script: in the function below would resolve to
# the script it is called from.
$global:AlcoveStandInAnswers = New-Object 'System.Collections.Generic.Queue[string]'
foreach ($answer in @($request.answers)) { $global:AlcoveStandInAnswers.Enqueue([string] $answer) }
$global:AlcoveStandInRequest = $request

function Stop-StandIn {
    param([string] $Message)
    throw (New-Object System.Management.Automation.RuntimeException "STAND-IN: $Message")
}

function Wait-DockerStopped {
    $process = Start-Process -FilePath 'docker' -ArgumentList @('desktop', 'stop') -WindowStyle Hidden -PassThru
    $process.WaitForExit(120000) | Out-Null
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $probe = Start-Process -FilePath 'docker' -ArgumentList 'version' -WindowStyle Hidden -PassThru
        # Touched before the wait, or ExitCode can read as null afterwards.
        $null = $probe.Handle
        $probe.WaitForExit(30000) | Out-Null
        if ($probe.HasExited -and $probe.ExitCode -ne 0) {
            Write-Host 'STAND-IN: Docker has stopped answering.'
            return
        }
        Start-Sleep -Seconds 3
    }
    Write-Host 'STAND-IN: Docker still answered after 120 seconds.'
}

function Read-Host {
    param([Parameter(Position = 0)] $Prompt, [switch] $AsSecureString)

    $request = $global:AlcoveStandInRequest
    if ($global:AlcoveStandInAnswers.Count -eq 0) { Stop-StandIn "no answer left for '$Prompt'" }
    $answer = $global:AlcoveStandInAnswers.Dequeue()

    if ($answer -eq '@password' -or $answer -eq '@made-up-password') {
        if (-not $AsSecureString) { Stop-StandIn "'$Prompt' is not a password prompt" }
        Write-Host "${Prompt}: (password)"
        if ($answer -eq '@made-up-password') {
            return (ConvertTo-SecureString -String ([guid]::NewGuid().ToString('N')) -AsPlainText -Force)
        }
        return (ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath $request.secretFile).Trim())
    }

    if ($answer -eq '@wait-stop-file') {
        Write-Host "${Prompt}: (waiting for the stop file)"
        $deadline = (Get-Date).AddSeconds(900)
        while (-not (Test-Path -LiteralPath $request.stopFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
        Remove-Item -LiteralPath $request.stopFile -Force -ErrorAction SilentlyContinue
        $answer = ''
    } else {
        if ($answer -like '@stop-docker:*') {
            Wait-DockerStopped
            $answer = $answer.Substring('@stop-docker:'.Length)
        }
        Write-Host "${Prompt}: $answer"
    }

    if (-not $AsSecureString) { return $answer }
    if (-not $answer) { return (New-Object System.Security.SecureString) }
    return (ConvertTo-SecureString -String $answer -AsPlainText -Force)
}

$arguments = @{}
foreach ($property in $request.arguments.PSObject.Properties) { $arguments[$property.Name] = $property.Value }

# A script that ends without exit leaves the last native command's code here.
$global:LASTEXITCODE = 0
try {
    & $request.target @arguments
    exit $LASTEXITCODE
} catch {
    if ($_.Exception.Message -notlike '*STAND-IN:*') { throw }
    Write-Host $_.Exception.Message
    exit 97
}
