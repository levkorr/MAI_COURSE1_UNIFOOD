import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


class OsmConfigTest(unittest.TestCase):
    def test_update_preserves_server_settings_and_creates_one_backup(self):
        project = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            script = root / 'scripts/configure_osmmcp.py'
            script.parent.mkdir()
            shutil.copyfile(project / 'scripts/configure_osmmcp.py', script)
            binary = root / '.tools/osmmcp/osmmcp-fixed.exe'
            binary.parent.mkdir(parents=True)
            binary.touch()
            config = root / 'config.toml'
            config.write_text('''[mcp_servers.osmmcp]
command = "old"
args = [
    "--old",
]
enabled = false # keep this setting
[mcp_servers.osmmcp.env]
REGION = "eu"
[mcp_servers.other]
command = "other"
''', encoding='utf-8')
            original = config.read_bytes()
            for _ in range(2):
                subprocess.run([sys.executable, script, '--config', config], check=True, capture_output=True)
            new = config.read_text(encoding='utf-8')
            servers = tomllib.loads(new)['mcp_servers']
            self.assertTrue(Path(servers['osmmcp']['command']).samefile(binary))
            self.assertEqual(servers['osmmcp']['args'], ['--enable-monitoring=false', '--overpass-endpoint',
                                                        'https://ovp.dresel.systems/api/interpreter'])
            self.assertIs(servers['osmmcp']['enabled'], False)
            self.assertEqual(servers['osmmcp']['env'], {'REGION': 'eu'})
            self.assertEqual(servers['other']['command'], 'other')
            self.assertIn('# keep this setting', new)
            self.assertEqual([p.read_bytes() for p in root.glob('*.bak')], [original])
