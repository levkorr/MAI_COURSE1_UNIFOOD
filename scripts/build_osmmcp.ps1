param(
    [string]$Source = (Join-Path $PSScriptRoot '../.tools/osmmcp/source/NERVsystems-osmmcp-0916a0b'),
    [string]$Go = (Join-Path $PSScriptRoot '../.tools/osmmcp/toolchain124/go/bin/go.exe')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$env:GOTOOLCHAIN = 'local'
$env:GOCACHE = Join-Path $projectRoot '.tools/osmmcp/build-cache'
Push-Location $Source
try {
    # Apply each revision independently so an existing patched checkout can be upgraded.
    foreach ($name in 'osmmcp-overpass.patch', 'osmmcp-bbox.patch') {
        $patch = Join-Path $PSScriptRoot $name
        $ErrorActionPreference = 'Continue'
        & git apply --reverse --check $patch 2>$null
        $alreadyPatched = $LASTEXITCODE -eq 0
        $ErrorActionPreference = 'Stop'
        if ($alreadyPatched) { continue }
        & git apply --check $patch
        if ($LASTEXITCODE -ne 0) { throw "Source does not match $name." }
        & git apply $patch
        if ($LASTEXITCODE -ne 0) { throw "Could not apply $name." }
    }
    & $Go test -mod=vendor ./pkg/core ./pkg/osm ./pkg/server
    if ($LASTEXITCODE -ne 0) { throw 'OSM tests failed.' }
    & $Go test -mod=vendor ./pkg/tools -run '^(TestNearbyCafeAlternativesAndBuildingCenter|TestBBoxCompleteness)$'
    if ($LASTEXITCODE -ne 0) { throw 'OSM tools regression tests failed.' }
    & $Go build -mod=vendor -ldflags '-X github.com/NERVsystems/osmmcp/pkg/version.BuildVersion=0.1.2-bbox-complete -X github.com/NERVsystems/osmmcp/pkg/tools.Version=0.1.2-bbox-complete' -o (Join-Path $projectRoot '.tools/osmmcp/osmmcp-fixed.exe') ./cmd/osmmcp
    if ($LASTEXITCODE -ne 0) { throw 'MCP build failed.' }
} finally {
    Pop-Location
}
