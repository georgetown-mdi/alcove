<#
.SYNOPSIS
    Opens a folder's Properties in File Explorer's shell, reads its DFS tab by
    UI Automation, and prints one JSON line: tab, referrals, error.
    Invoke-VmPass.ps1 runs it as a process of its own: the property sheet
    belongs to the process that opened it and closes with it.

.DESCRIPTION
    Needs an interactive desktop. -ScreenshotFile keeps a picture of the
    sheet as it was read.
#>

param(
    [Parameter(Mandatory = $true)][string] $Path,
    [string] $ScreenshotFile,
    [int] $TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{ tab = $false; referrals = @(); error = '' }

try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
    $automation = [System.Windows.Automation.AutomationElement]
    $leaf = Split-Path -Leaf $Path
    $item = (New-Object -ComObject Shell.Application).Namespace((Split-Path -Parent $Path)).ParseName($leaf)
    if (-not $item) { throw "the shell cannot see $Path" }
    $item.InvokeVerb('properties')

    $byName = New-Object System.Windows.Automation.PropertyCondition($automation::NameProperty, "$leaf Properties")
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $window = $null
    while (-not $window -and (Get-Date) -lt $deadline) {
        $window = $automation::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $byName)
        if (-not $window) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $window) { throw "no '$leaf Properties' window opened" }

    $tabConditions = [System.Windows.Automation.Condition[]] @(
        (New-Object System.Windows.Automation.PropertyCondition($automation::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)),
        (New-Object System.Windows.Automation.PropertyCondition($automation::NameProperty, 'DFS')))
    $tabCondition = New-Object System.Windows.Automation.AndCondition -ArgumentList (, $tabConditions)
    $tab = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
    if ($tab) {
        $result.tab = $true
        $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        Start-Sleep -Seconds 1
        $listItems = New-Object System.Windows.Automation.PropertyCondition($automation::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
        $result.referrals = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listItems) |
                ForEach-Object { $_.Current.Name })
    }

    if ($ScreenshotFile) {
        $bounds = $window.Current.BoundingRectangle
        $bitmap = New-Object System.Drawing.Bitmap ([int] $bounds.Width), ([int] $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen([int] $bounds.X, [int] $bounds.Y, 0, 0, $bitmap.Size)
        $bitmap.Save($ScreenshotFile, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
    }
    $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress
