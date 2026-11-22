# Build OpenStudy-Setup.exe using the built-in .NET Framework 4.x C# compiler (zero external SDK required).
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$sourceFile = Join-Path $scriptDir 'windows\OpenStudyInstaller.cs'
$outputExe = Join-Path $scriptDir 'windows\OpenStudy-Setup.exe'

if (-not (Test-Path -LiteralPath $sourceFile)) {
    throw "Source file not found: $sourceFile"
}

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)

$cscPath = $null
foreach ($candidate in $cscCandidates) {
    if (Test-Path -LiteralPath $candidate) {
        $cscPath = $candidate
        break
    }
}

if (-not $cscPath) {
    throw "Could not locate .NET Framework 4.x csc.exe under $env:WINDIR\Microsoft.NET"
}

Write-Host "[OpenStudy Build] Compiler: $cscPath"
Write-Host "[OpenStudy Build] Source:   $sourceFile"
Write-Host "[OpenStudy Build] Output:   $outputExe"

$compilerArgs = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/utf8output',
    '/warn:4',
    "/out:$outputExe",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    $sourceFile
)

& $cscPath @compilerArgs
if ($LASTEXITCODE -ne 0) {
    throw "Compilation failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $outputExe)) {
    throw "Expected output executable was not created: $outputExe"
}

$fileInfo = Get-Item -LiteralPath $outputExe
$sizeKb = [math]::Round($fileInfo.Length / 1024, 1)
Write-Host "[OpenStudy Build] Success: OpenStudy-Setup.exe built cleanly ($sizeKb KB)"
exit 0
