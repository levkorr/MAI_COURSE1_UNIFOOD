import json
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))
import app

def load_fixture(university):
    name = 'places-cache.json' if university == 'mai' else f'places-cache-{university}.json'
    return json.loads((root / name).read_text(encoding='utf-8')), False

app.get_places = load_fixture
with tempfile.TemporaryDirectory() as scratch:
    app.app.config['REPORT_DB'] = str(Path(scratch, 'mobile.sqlite3'))
    app.app.run(host='127.0.0.1', port=5059)
