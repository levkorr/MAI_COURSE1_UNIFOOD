param(
    [string]$Source = (Join-Path $PSScriptRoot '../.tools/osmmcp/source/NERVsystems-osmmcp-0916a0b'),
    [string]$Go = (Join-Path $PSScriptRoot '../.tools/osmmcp/toolchain124/go/bin/go.exe')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$patch = Join-Path $PSScriptRoot 'osmmcp-overpass.patch'
$env:GOTOOLCHAIN = 'local'
$env:GOCACHE = Join-Path $projectRoot '.tools/osmmcp/build-cache'
Push-Location $Source
try {
    # Accept either the original source or an already patched source tree.
    $ErrorActionPreference = 'Continue'
    & git apply --reverse --check $patch 2>$null
    $alreadyPatched = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $alreadyPatched) {
        & git apply --check $patch
        if ($LASTEXITCODE -ne 0) { throw 'Source does not match the saved patch.' }
        & git apply $patch
        if ($LASTEXITCODE -ne 0) { throw 'Could not apply the Overpass patch.' }
    }
    & $Go test -mod=vendor ./pkg/core ./pkg/osm ./pkg/server
    if ($LASTEXITCODE -ne 0) { throw 'OSM tests failed.' }
    & $Go test -mod=vendor ./pkg/tools -run '^TestNearbyCafeAlternativesAndBuildingCenter$'
    if ($LASTEXITCODE -ne 0) { throw 'Nearby places regression test failed.' }
    & $Go build -mod=vendor -ldflags '-X github.com/NERVsystems/osmmcp/pkg/version.BuildVersion=0.1.2-overpass-fix' -o (Join-Path $projectRoot '.tools/osmmcp/osmmcp-fixed.exe') ./cmd/osmmcp
    if ($LASTEXITCODE -ne 0) { throw 'MCP build failed.' }
} finally {
    Pop-Location
}
