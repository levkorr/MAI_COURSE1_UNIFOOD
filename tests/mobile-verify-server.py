import json
import os
import sys
from datetime import datetime
from pathlib import Path
from werkzeug.serving import make_server

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))
scratch = Path(sys.argv[1])
db_path = scratch / 'mobile.sqlite3'
db_path.touch(exist_ok=False)
os.environ['REPORT_DB'] = str(db_path)
import app


class FixtureDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        instant = cls(2026, 11, 25, 10, 30, tzinfo=app.MOSCOW)
        return instant.astimezone(tz) if tz is not None else instant.replace(tzinfo=None)


def load_fixture(university):
    name = 'places-cache.json' if university == 'mai' else f'places-cache-{university}.json'
    return json.loads((root / name).read_text(encoding='utf-8')), False

app.get_places = load_fixture
app.datetime = FixtureDateTime
with make_server('127.0.0.1', 0, app.app, threaded=True) as server:
    port_file = scratch / 'flask-port.tmp'
    port_file.write_text(str(server.server_port), encoding='ascii')
    port_file.replace(scratch / 'flask-port')
    server.serve_forever()
