"""Point the existing Codex OSM MCP entry at the verified local build."""
import argparse
import tomlkit
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
original = config_path.read_bytes().decode('utf-8')
config = tomlkit.parse(original)
if 'osmmcp' not in config.get('mcp_servers', {}):
    raise SystemExit('Expected existing mcp_servers.osmmcp entry')
server = config['mcp_servers']['osmmcp']
server['command'] = executable.as_posix()
server['args'] = ['--enable-monitoring=false', '--overpass-endpoint', 'https://ovp.dresel.systems/api/interpreter']
updated = tomlkit.dumps(config)
if updated == original:
    print('OSM MCP configuration already applied')
else:
    backup = config_path.with_name(config_path.name + '.osmmcp-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.bak')
    backup.write_bytes(original.encode('utf-8'))
    config_path.write_bytes(updated.encode('utf-8'))
    print(f'Updated OSM MCP command and args; backup: {backup}')
