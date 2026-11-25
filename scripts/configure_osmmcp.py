"""Point the existing Codex OSM MCP entry at the verified local build."""
import argparse
import re
import tomllib
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', type=Path, required=True)
args = parser.parse_args()
config_path = args.config.resolve()
executable = ROOT / '.tools/osmmcp/osmmcp-fixed.exe'
if not executable.is_file():
    raise SystemExit('Build and verify osmmcp-fixed.exe first')
original = config_path.read_text(encoding='utf-8')
before = tomllib.loads(original)
if 'osmmcp' not in before.get('mcp_servers', {}):
    raise SystemExit('Expected existing mcp_servers.osmmcp entry')
section = ('[mcp_servers.osmmcp]\n'
           f'command = "{executable.as_posix()}"\n'
           'args = ["--enable-monitoring=false", "--overpass-endpoint", "https://ovp.dresel.systems/api/interpreter"]\n\n')
updated, count = re.subn(r'(?ms)^\[mcp_servers\.osmmcp\]\n.*?(?=^\[|\Z)', lambda _: section, original)
if count != 1:
    raise SystemExit('Expected exactly one OSM MCP section')
after = tomllib.loads(updated)
old_osm = before['mcp_servers'].pop('osmmcp')
new_osm = after['mcp_servers'].pop('osmmcp')
# Nested per-tool approval settings live in their own TOML sections; preserve them.
assert before == after
assert {k: v for k, v in old_osm.items() if k not in ('command', 'args')} == {k: v for k, v in new_osm.items() if k not in ('command', 'args')}
if updated == original:
    print('OSM MCP configuration already applied')
else:
    backup = config_path.with_name(config_path.name + '.osmmcp-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.bak')
    backup.write_text(original, encoding='utf-8')
    config_path.write_text(updated, encoding='utf-8')
    print(f'Updated OSM MCP command and args; backup: {backup}')
