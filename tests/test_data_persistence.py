import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing


ROOT = Path(__file__).resolve().parent.parent
VISITOR = '4079cb4c-d5b7-4e6e-aad8-449603bed808'
SERVER = '''
import json
import sys
from datetime import datetime
from unittest.mock import patch
from app import MOSCOW, app

visitor, action = sys.argv[1:]
client = app.test_client()
client.set_cookie('mp-visitor', visitor)
catalog = {'places': [{'id': 'node/1'}, {'id': 'node/2'}], 'source': 'test', 'fetched_at': 0}
with patch('app.get_places', return_value=(catalog, False)), patch('app.datetime') as clock:
    clock.now.return_value = datetime(2026, 11, 25, 12, 0, tzinfo=MOSCOW)
    with patch('app.time.time', return_value=2800 if action == 'expired' else 1000):
        if action == 'write':
            report = client.post('/api/check-ins', json={'place_id': 'node/1', 'people_range': '5-10'})
            plan = client.post('/api/plans', json={'place_id': 'node/1', 'time': '12:30'})
            print(json.dumps([report.status_code, plan.status_code]))
        elif action == 'update':
            plan = client.post('/api/plans', json={'place_id': 'node/2', 'time': '12:30'})
            counts = client.get('/api/places?time=12:30').json['places']
            cancel = client.delete('/api/plans')
            print(json.dumps([plan.status_code, [p['planned_count'] for p in counts],
                              cancel.status_code, client.get('/api/places').json['my_plan']]))
        else:
            now = client.get('/api/places').json['places'][0]
            plans = client.get('/api/places?time=12:35').json
            other = app.test_client()
            other_plan = other.get('/api/places').json['my_plan']
            print(json.dumps([now['people'], now['report_count'], plans['my_plan'],
                              plans['places'][0]['planned_count'], other_plan,
                              other.get_cookie('mp-visitor').value != visitor]))
'''


class DataPersistenceTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.db = Path(scratch.name) / 'reports #test.sqlite3'
        self.env = {**os.environ, 'REPORT_DB': str(self.db)}

    def python(self, *args, succeeds=True):
        result = subprocess.run([sys.executable, *args], cwd=ROOT, env=self.env,
                                capture_output=True, text=True, timeout=20)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def init_db(self, *, succeeds=True):
        return self.python('-m', 'database', 'init', str(self.db), succeeds=succeeds)

    def api(self, action):
        return json.loads(self.python('-c', SERVER, VISITOR, action).stdout)

    def test_startup_and_explicit_initialization(self):
        result = self.python('-c', 'import app', succeeds=False)
        self.assertIn('Cannot open SQLite database', result.stderr)
        self.assertFalse(self.db.exists())
        self.init_db()
        with closing(sqlite3.connect(self.db)) as db:
            for table in ('reports', 'visitor_observations', 'visit_plans'):
                self.assertEqual(db.execute(f'SELECT COUNT(*) FROM {table}').fetchone(), (0,))
        original = self.db.read_bytes()
        self.init_db(succeeds=False)
        self.assertEqual(self.db.read_bytes(), original)
        self.python('-c', 'import app')

    def test_api_records_survive_process_restart(self):
        self.init_db()
        self.assertEqual(self.api('write'), [201, 201])
        plan = {'place_id': 'node/1', 'slot': '12:30'}
        self.assertEqual(self.api('read'), [7.5, 1, plan, 1, None, True])
        self.assertEqual(self.api('expired'), [None, 0, plan, 1, None, True])
        self.assertEqual(self.api('update'), [201, [0, 1], 200, None])

    def test_explicit_path_rejects_read_only_connection_after_migration(self):
        self.init_db()
        result = self.python('-c', '''
import sqlite3
from unittest.mock import patch
connect = sqlite3.connect
def open_readonly(path, **options):
    return connect(path.replace('?mode=rw', '?mode=ro'), **options)
with patch.object(sqlite3, 'connect', open_readonly):
    import app
''', succeeds=False)
        self.assertIn('readonly', result.stderr.lower())

    def test_legacy_database_copy_preserves_records(self):
        old_path = self.db.with_name('old.sqlite3')
        with closing(sqlite3.connect(old_path)) as old, closing(sqlite3.connect(self.db)) as copied:
            old.executescript('''
                CREATE TABLE reports (place_id TEXT PRIMARY KEY, people_range TEXT NOT NULL, observed_at REAL NOT NULL);
                INSERT INTO reports VALUES ('node/1', '5-10', 1000);
                CREATE TABLE visit_plans (visitor_id TEXT NOT NULL, visit_date TEXT NOT NULL,
                    place_id TEXT NOT NULL, slot TEXT NOT NULL, PRIMARY KEY (visitor_id, visit_date));
            ''')
            old.execute('INSERT INTO visit_plans VALUES (?, ?, ?, ?)',
                        (VISITOR, '2026-11-25', 'node/1', '12:30'))
            old.commit()
            old.backup(copied)
        expected = [7.5, 1, {'place_id': 'node/1', 'slot': '12:30'}, 1, None, True]
        self.assertEqual(self.api('read'), expected)
        self.assertEqual(self.api('read'), expected)
