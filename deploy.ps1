<#
.SYNOPSIS
  Packages the module into sandbox-settlement-manager_<version>.zip for distribution.

.DESCRIPTION
  Reads the version from module.json and zips only the files/directories Foundry actually
  needs to run the module (lang, presets, scripts, styles, templates, module.json), with each
  of those sitting at the root of the archive. Always runs against the directory this script
  lives in, regardless of the caller's working directory.
#>

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$moduleJsonPath = Join-Path $root "module.json"

if (-not (Test-Path $moduleJsonPath)) {
    Write-Error "module.json not found at $moduleJsonPath"
    exit 1
}

$manifest = Get-Content $moduleJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    Write-Error "module.json has no 'version' field"
    exit 1
}

# Only what Foundry needs to load and run the module — nothing from reference/, .claude/, etc.
$includeNames = @("lang", "presets", "scripts", "styles", "templates", "module.json")

$missing = $includeNames | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing) {
    Write-Error "Missing expected path(s): $($missing -join ', ')"
    exit 1
}

$zipName = "sandbox-settlement-manager_$version.zip"
$zipPath = Join-Path $root $zipName

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Compress-Archive stores nested entries with backslash separators on Windows, which the zip spec
# forbids and which non-Windows unzip tools (and possibly Foundry's own installer) won't traverse
# correctly -- build the archive by hand instead so every entry name uses "/".
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($name in $includeNames) {
        $sourcePath = Join-Path $root $name
        if (Test-Path $sourcePath -PathType Leaf) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $sourcePath, $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        else {
            Get-ChildItem -Path $sourcePath -Recurse -File | ForEach-Object {
                $entryName = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        }
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Created $zipName"
