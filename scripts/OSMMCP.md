# osmmcp

Built from NERVsystems/osmmcp commit `0916a0b` with Go 1.24.5.
Binary: `.tools/osmmcp/osmmcp.exe`. Registered globally in Codex as `osmmcp`
using STDIO and `--enable-monitoring=false`.

Restart Codex to load the newly configured tools into a new session.
For venues use `find_nearby_places` or `osm_query_bbox`.
MAI map center: latitude `55.8104364`, longitude `37.4983111`.

Verification: MCP initialization and listing 25 tools succeeded. The initial
nearby cafes request failed with an Overpass `SERVICE_UNAVAILABLE` response.
No new venue data was imported into the map.

Run `scripts/check_osmmcp.py` with a working Python installation to repeat the
STDIO handshake and cafe request. The response is saved to
`.tools/osmmcp/nearby-mai.json`. No API key is needed.
