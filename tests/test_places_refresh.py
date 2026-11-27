import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import BytesIO, StringIO
from pathlib import Path
from threading import Event
from unittest.mock import patch

import places_source as places
from app import app
from scripts import audit_places
from scripts.audit_places import MCP_FILTERS, parse_mcp_catalogue


class MCPSelectionTest(unittest.TestCase):
    def setUp(self):
        self.responses = {key: {'complete': True, 'elements': []} for key in MCP_FILTERS}
        self.cafe = dict(type='node', id='42', location=dict(latitude=55.8104, longitude=37.4983),
                         tags=dict(amenity='cafe', name='Cafe'))
        self.responses['amenity=cafe']['elements'].append(self.cafe)

    def test_converts_nodes_ways_relations_and_merges_duplicate_ids(self):
        center = dict(latitude=55.8105, longitude=37.4984)
        self.responses['shop=bakery']['elements'] = [
            self.cafe,
            dict(type='way', id='42', center=center, tags=dict(shop='bakery', name='Bakery')),
            dict(type='relation', id='9', center=center, tags=dict(amenity='restaurant', name='Hall'))]
        result = parse_mcp_catalogue(self.responses, places.CAMPUS)
        self.assertCountEqual([(p['id'], p['name'], p['lat'], p['lon']) for p in result], [
            ('node/42', 'Cafe', 55.8104, 37.4983), ('way/42', 'Bakery', 55.8105, 37.4984),
            ('relation/9', 'Hall', 55.8105, 37.4984)])

    def test_omitted_or_unconfirmed_category_rejects_whole_selection(self):
        for partial in (None, {'elements': []}, {'complete': False, 'elements': []},
                        {'complete': True, 'elements': None},
                        {'complete': True, 'elements': [self.cafe], 'remark': 'timeout'}):
            with self.subTest(partial=partial):
                responses = self.responses.copy()
                del responses['shop=bakery']
                if partial is not None:
                    responses['shop=bakery'] = partial
                with self.assertRaisesRegex(ValueError, 'shop=bakery'):
                    parse_mcp_catalogue(responses, places.CAMPUS)


class CatalogueRefreshTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.cache = Path(directory) / 'places-cache.json'
        self.enterContext(patch.object(places, 'CACHE', self.cache))
        self.enterContext(patch.dict(places.refresh_after, clear=True))
        self.enterContext(patch.dict(app.config, REPORT_DB=str(Path(directory) / 'reports.sqlite3')))
        self.place = dict(id='node/1', name='Cafe', category='coffee', label='Cafe', icon='☕',
                          address='Near campus', hours='24/7', lat=55.8104, lon=37.4983, walk=1, distance=5)
        self.old = dict(places=[self.place, dict(self.place, id='relation/2')], source='previous', fetched_at=0)
        self.original = json.dumps(self.old).encode()
        self.cache.write_bytes(self.original)
        self.fresh = dict(places=[dict(self.place, id='node/3')], source='OpenStreetMap / Overpass',
                          fetched_at=places.time.time())

    def test_closed_way_uses_bbox_center_independent_of_vertex_density(self):
        xml = b'''<osm>
          <node id="1" lat="55.8100" lon="37.4980"/><node id="2" lat="55.8100" lon="37.4990"/>
          <node id="3" lat="55.8110" lon="37.4990"/>
          <way id="7"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/>
            <tag k="amenity" v="cafe"/><tag k="name" v="Hall"/></way></osm>'''
        hall, = places.parse_osm_xml(xml)
        self.assertAlmostEqual(hall['lat'], 55.8105)
        self.assertAlmostEqual(hall['lon'], 37.4985)

    def test_fresh_but_unusable_cache_is_replaced_through_api(self):
        self.cache.write_text(json.dumps(dict(self.fresh, places=[{'id': 'node/1'}])))
        with patch.object(places, 'fetch_places', return_value=self.fresh) as fetch:
            response = app.test_client().get('/api/places')
        self.assertEqual(response.status_code, 200)
        fetch.assert_called_once()
        self.assertEqual(response.json['places'][0]['name'], 'Cafe')
        self.assertEqual(json.loads(self.cache.read_bytes()), self.fresh)

    def test_invalid_display_fields_are_rejected(self):
        for field, value in (('lat', 91), ('lon', True), ('lon', float('nan')), ('walk', 0), ('distance', -1),
                             ('name', ''), ('hours', None), ('label', []), ('address', 3)):
            with self.subTest(field=field, value=value):
                snapshot = dict(self.fresh, places=[dict(self.place, **{field: value})])
                self.assertIsNone(places.decode_catalogue(json.dumps(snapshot)))

    def test_xml_fallback_keeps_relation_and_uses_member_geometry(self):
        xml = b'''<osm>
          <node id="1" lat="55.8100" lon="37.4980"><tag k="amenity" v="cafe"/><tag k="name" v="Cafe"/></node>
          <node id="2" lat="55.8110" lon="37.4990"/>
          <way id="7"><nd ref="1"/><nd ref="2"/></way>
          <relation id="2"><member type="way" ref="7" role="outer"/>
            <tag k="amenity" v="restaurant"/><tag k="name" v="Hall"/></relation></osm>'''
        with patch('places_source.urllib.request.urlopen', side_effect=[OSError(), OSError(), BytesIO(xml)]):
            result, stale = places.get_places(background=False)
        self.assertFalse(stale)
        self.assertEqual(json.loads(self.cache.read_bytes()), result)
        self.assertCountEqual([p['id'] for p in result['places']], ['node/1', 'relation/2'])
        hall = next(p for p in result['places'] if p['id'] == 'relation/2')
        self.assertAlmostEqual(hall['lat'], 55.8105)
        self.assertAlmostEqual(hall['lon'], 37.4985)

    def test_xml_with_missing_relation_or_member_retains_original_bytes(self):
        node = b'<node id="1" lat="55.8104" lon="37.4983"><tag k="amenity" v="cafe"/><tag k="name" v="Cafe"/></node>'
        unresolved = b'<relation id="2"><member type="way" ref="7"/><tag k="amenity" v="restaurant"/><tag k="name" v="Hall"/></relation>'
        for relation in (b'', unresolved):
            xml = BytesIO(b'<osm>' + node + relation + b'</osm>')
            with self.subTest(relation=relation), self.assertLogs('places_source'), patch(
                    'places_source.urllib.request.urlopen', side_effect=[OSError(), OSError(), xml]):
                self.assertEqual(places.get_places(background=False), (self.old, True))
                self.assertEqual(self.cache.read_bytes(), self.original)

    def test_manual_update_in_other_process_wins_over_inflight_refresh(self):
        started, resume = Event(), Event()
        workers = []
        real_thread = places.Thread

        def start_worker(**kwargs):
            worker = real_thread(**kwargs)
            workers.append(worker)
            return worker

        def delayed_fetch(campus):
            started.set()
            if not resume.wait(15):
                raise RuntimeError('test timed out')
            return self.fresh

        manual = dict(self.old, places=[dict(self.place, id='node/4')])  # A partial update keeps fetched_at.
        writer = ('import json, sys; from pathlib import Path; from places_source import replace_catalogue; '
                  'path = Path(sys.argv[1]); replace_catalogue(path, path.read_bytes(), json.loads(sys.argv[2]))')
        with patch.object(places, 'fetch_places', side_effect=delayed_fetch), patch.object(places, 'Thread', start_worker):
            self.assertEqual(places.get_places(), (self.old, True))
            try:
                self.assertTrue(started.wait(5))
                subprocess.run([sys.executable, '-c', writer, str(self.cache), json.dumps(manual)],
                               cwd=Path(places.__file__).parent, check=True, timeout=10)
            finally:
                resume.set()
                workers[0].join(5)
        self.assertFalse(workers[0].is_alive())
        self.assertEqual(json.loads(self.cache.read_bytes()), manual)
        with self.assertRaises(places.CatalogueChanged):
            places.replace_catalogue(self.cache, self.original, self.fresh)

    def test_api_serves_stale_and_retries_after_thread_start_failure(self):
        client = app.test_client()
        with patch.object(places.time, 'monotonic', return_value=100), self.assertLogs('places_source'), patch.object(
                places.Thread, 'start', side_effect=RuntimeError("can't start new thread")):
            response = client.get('/api/places')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['stale'])
        with patch.object(places.Thread, 'start') as start:
            with patch.object(places.time, 'monotonic', return_value=101):
                client.get('/api/places')
                start.assert_not_called()
            with patch.object(places.time, 'monotonic', return_value=100 + places.RETRY_DELAY):
                client.get('/api/places')
                start.assert_called_once()

    def test_failed_replace_is_observable_and_preserves_disk(self):
        with patch.object(places, 'fetch_places', return_value=self.fresh), patch.object(
                Path, 'replace', side_effect=PermissionError('denied')):
            with self.assertLogs('places_source', level='WARNING') as foreground:
                self.assertEqual(places.get_places(background=False), (self.old, True))
            self.assertIn('denied', foreground.output[0])
            with self.assertLogs('places_source', level='WARNING') as background:
                places.refresh_in_background(self.cache, places.CAMPUS, self.original, self.old)
            self.assertIn('denied', background.output[0])
            self.assertEqual(self.cache.read_bytes(), self.original)
            self.cache.unlink()
            response = app.test_client().get('/api/places')
            self.assertEqual(response.status_code, 503)
            self.assertFalse(self.cache.exists())

    def test_historical_audit_preserves_original_until_report_and_backup_are_written(self):
        root = self.cache.parent
        element = dict(type='node', id=3, lat=55.8104, lon=37.4983, tags=dict(amenity='cafe', name='Cafe'))
        raw = dict(elements=[element], queried_at='2026-11-25T12:00:00Z', source='fixture', bbox={})
        (root / 'osm-places-audit-input.json').write_text(json.dumps(raw), encoding='utf-8')
        report = root / 'places-audit.json'
        report.mkdir()
        with patch.object(audit_places, 'ROOT', root), redirect_stdout(StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'сохранить каталог'):
                audit_places.main()
            self.assertEqual(self.cache.read_bytes(), self.original)
            report.rmdir()
            audit_places.main()
        self.assertEqual((root / 'places-cache.before-audit.json').read_bytes(), self.original)
        self.assertEqual(json.loads(report.read_bytes())['added'], ['node/3'])
        self.assertEqual(json.loads(self.cache.read_bytes())['places'][0]['id'], 'node/3')

    def test_failure_publishing_catalogue_restores_prior_audit_files(self):
        backup = self.cache.with_suffix('.before-audit.json')
        report = self.cache.with_name('places-audit.json')
        report.write_bytes(b'previous report')
        real_replace = places._replace_bytes

        def fail_publishing_catalogue(path, data):
            if path == self.cache:
                raise PermissionError('catalogue locked')
            real_replace(path, data)

        with patch.object(places, '_replace_bytes', side_effect=fail_publishing_catalogue):
            with self.assertRaisesRegex(RuntimeError, 'catalogue locked'):
                places.replace_catalogue(self.cache, self.original, self.fresh,
                                         audit_files=[(backup, self.original), (report, b'new report')])
        self.assertFalse(backup.exists())
        self.assertEqual(report.read_bytes(), b'previous report')
        self.assertEqual(self.cache.read_bytes(), self.original)

    def test_interrupted_audit_is_recovered_before_next_reader(self):
        backup = self.cache.with_suffix('.before-audit.json')
        report = self.cache.with_name('places-audit.json')
        backup.write_bytes(b'older catalogue')
        report.write_bytes(b'older report')
        writer = '''
import os, sys
from pathlib import Path
import places_source as p
cache, backup, report = map(Path, sys.argv[1:])
replace = p._replace_bytes
def stop_before_catalogue(path, data):
    if path == cache:
        os._exit(53)
    replace(path, data)
p._replace_bytes = stop_before_catalogue
p.replace_catalogue(cache, cache.read_bytes(), {}, audit_files=[(backup, b'new backup'), (report, b'new report')])
'''
        result = subprocess.run([sys.executable, '-c', writer, str(self.cache), str(backup), str(report)],
                                cwd=Path(places.__file__).parent, timeout=10)
        self.assertEqual(result.returncode, 53)
        self.assertEqual(places.read_snapshot(self.cache), self.original)
        self.assertEqual(backup.read_bytes(), b'older catalogue')
        self.assertEqual(report.read_bytes(), b'older report')


class SchematicTest(unittest.TestCase):
    def test_mgsu_selects_its_extract_and_preserves_map_on_empty_input(self):
        project = Path(places.__file__).parent
        scratch = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ('build_schematic.py', 'universities.py'):
            shutil.copyfile(project / name, scratch / name)
        (scratch / '.tools').mkdir()
        (scratch / 'static').mkdir()
        map_path = scratch / 'static/neighborhood-mgsu.svg'
        map_path.write_text('existing map')
        empty = scratch / 'osm-schematic.xml'
        empty.write_text('<osm/>')
        command = [sys.executable, 'build_schematic.py', '--university', 'mgsu']
        for args in ([], ['--input', str(empty)]):
            with self.subTest(args=args):
                result = subprocess.run(command + args, cwd=scratch, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(map_path.read_text(), 'existing map')
        (scratch / '.tools/mgsu-area.osm').write_text('''<osm>
          <node id="1" lat="55.8560" lon="37.6955"/><node id="2" lat="55.8565" lon="37.6955"/>
          <way id="3"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>''')
        result = subprocess.run(command, cwd=scratch, capture_output=True, check=True, timeout=10)
        self.assertIn(b'1 streets', result.stdout)
        self.assertIn('stroke-linejoin', map_path.read_text())
