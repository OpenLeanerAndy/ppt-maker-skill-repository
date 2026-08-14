param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [int]$Width = 1600,
    [int]$Height = 900
)

$ErrorActionPreference = 'Stop'
$resolvedInput = [System.IO.Path]::GetFullPath($InputPath)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not [System.IO.File]::Exists($resolvedInput)) {
    throw "PPTX file does not exist: $resolvedInput"
}
if ([System.IO.Path]::GetExtension($resolvedInput).ToLowerInvariant() -ne '.pptx') {
    throw "Input file must use the .pptx extension: $resolvedInput"
}

[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
if ([System.IO.Directory]::EnumerateFileSystemEntries($resolvedOutput).GetEnumerator().MoveNext()) {
    throw "Output directory must be empty: $resolvedOutput"
}

$powerPoint = New-Object -ComObject PowerPoint.Application
try {
    $presentation = $powerPoint.Presentations.Open($resolvedInput, 0, 0, 0)
    try {
        $presentation.Export($resolvedOutput, 'PNG', $Width, $Height)
    }
    finally {
        $presentation.Close()
    }
}
finally {
    $powerPoint.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) | Out-Null
}

$rendered = @(Get-ChildItem -LiteralPath $resolvedOutput -File -Filter '*.PNG')
if ($rendered.Count -eq 0) {
    throw "PowerPoint did not export any PNG slides."
}
Write-Output $rendered.Count
