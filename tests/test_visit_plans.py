import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from tests.isolated_app import app, MOSCOW


class VisitPlansTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_db = app.config['REPORT_DB']
        app.config['REPORT_DB'] = str(Path(self.temp.name) / 'reports.sqlite3')
        self.catalog = patch('app.get_places', return_value=({'places': [
            {'id': 'node/1', 'name': 'Cafe'}, {'id': 'node/2', 'name': 'Market'}
        ], 'source': 'test', 'fetched_at': 0}, False))
        self.catalog.start()
        self.clock = patch('app.datetime')
        self.mock_clock = self.clock.start()
        self.mock_clock.now.return_value = datetime(2026, 11, 25, 12, 0, tzinfo=MOSCOW)
        self.a, self.b = app.test_client(), app.test_client()

    def tearDown(self):
        self.clock.stop()
        self.catalog.stop()
        app.config['REPORT_DB'] = self.previous_db
        self.temp.cleanup()

    def plan(self, client, slot='12:30', place='node/1'):
        return client.post('/api/plans', json={'time': slot, 'place_id': place})

    def counts(self, slot='12:30', client=None):
        response = (client or self.a).get('/api/places', query_string={'time': slot})
        self.assertEqual(response.status_code, 200)
        return [p['planned_count'] for p in response.json['places']]

    def test_default_now_is_separate_from_plans(self):
        self.assertEqual(self.plan(self.a).status_code, 201)
        self.a.post('/api/check-ins', json={'place_id': 'node/1', 'people_range': '5-10'})
        response = self.a.get('/api/places')
        self.assertEqual(response.json['mode'], 'now')
        self.assertEqual(response.json['places'][0]['people'], 7.5)
        self.assertEqual(self.counts(), [1, 0])
        self.assertIsNone(self.a.get('/api/places?time=12:30').json['places'][0]['current_report'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_window_includes_five_minutes_but_not_ten(self):
        self.plan(self.a, '12:25')
        self.plan(self.b, '12:35')
        self.assertEqual(self.counts(), [2, 0])
        self.assertEqual(self.counts('12:20'), [1, 0])
        self.assertEqual(self.counts('12:45'), [0, 0])

    def test_catalogue_reads_committed_plans_while_another_writer_is_active(self):
        self.assertEqual(self.plan(self.a).status_code, 201)
        with closing(sqlite3.connect(app.config['REPORT_DB'])) as writer:
            writer.execute('BEGIN IMMEDIATE')
            writer.execute('DELETE FROM visit_plans')
            self.assertEqual(self.counts(), [1, 0])

    def test_repeat_replaces_and_cancel_affects_only_owner(self):
        self.plan(self.a)
        self.plan(self.a)
        self.plan(self.b)
        self.assertEqual(self.counts(), [2, 0])
        self.plan(self.a, place='node/2')
        self.assertEqual(self.counts(), [1, 1])
        self.assertEqual(self.b.get('/api/places').json['my_plan']['place_id'], 'node/1')
        self.a.delete('/api/plans')
        self.assertEqual(self.counts(), [1, 0])
        self.assertIsNone(self.a.get('/api/places').json['my_plan'])

    def test_other_days_are_excluded(self):
        self.plan(self.a)
        self.mock_clock.now.return_value = datetime(2026, 11, 26, 12, 0, tzinfo=MOSCOW)
        self.assertEqual(self.counts(), [0, 0])
        self.assertIsNone(self.a.get('/api/places').json['my_plan'])

    def test_invalid_and_past_plans_do_not_change_counts(self):
        for value in (None, {}, {'time': 'bad'}, {'time': []}, {'time': 'now'}, {'time': '10:30'}):
            self.assertEqual(self.a.post('/api/plans', json=value).status_code, 400)
        self.assertEqual(self.plan(self.a, place='missing').status_code, 404)
        self.assertEqual(self.a.get('/api/places?time=invalid').status_code, 400)
        self.assertEqual(self.counts(), [0, 0])

    def test_plans_persist_for_same_browser(self):
        self.plan(self.a)
        cookie = self.a.get_cookie('mp-visitor')
        reopened = app.test_client()
        reopened.set_cookie('mp-visitor', cookie.value)
        self.assertEqual(reopened.get('/api/places').json['my_plan'],
                         {'place_id': 'node/1', 'slot': '12:30'})

    def test_university_schedules_are_validated_separately(self):
        self.mock_clock.now.return_value = datetime(2026, 11, 25, 9, 0, tzinfo=MOSCOW)
        for slot in ('09:50', '09:55', '10:00', '11:20', '11:25', '11:30', '12:50', '12:55', '13:00'):
            self.assertEqual(self.a.get(f'/api/places?university=mgsu&time={slot}').status_code, 200)
            self.assertEqual(self.a.post('/api/plans?university=mgsu', json={
                'place_id': 'node/1', 'time': slot}).status_code, 201)
        self.assertEqual(self.a.get('/api/places?university=mgsu&time=12:30').status_code, 400)
        self.assertEqual(self.a.get('/api/places?university=mai&time=09:50').status_code, 400)
        self.assertEqual(self.a.get('/api/places?university=unknown').status_code, 400)

    def test_university_plans_do_not_mix(self):
        self.plan(self.a, '12:50')
        self.b.post('/api/plans?university=mgsu', json={'place_id': 'node/1', 'time': '12:50'})
        self.assertEqual(self.counts('12:50'), [1, 0])
        response = self.a.get('/api/places?university=mgsu&time=12:50')
        self.assertEqual(response.json['places'][0]['planned_count'], 1)
        self.assertIsNone(response.json['my_plan'])
        self.assertNotEqual(response.json['campus'], self.a.get('/api/places').json['campus'])
        self.a.delete('/api/plans?university=mgsu')
        self.assertEqual(self.counts('12:50'), [1, 0])

    def test_catalog_uses_selected_university_and_home_lists_both(self):
        with patch('app.get_places', return_value=(
                {'places': [], 'source': 'test', 'fetched_at': 0}, False)) as lookup:
            self.a.get('/api/places?university=mgsu')
            lookup.assert_called_once_with('mgsu')
        page = self.a.get('/').get_data(as_text=True)
        self.assertIn('value="mai"', page)
        self.assertIn('value="mgsu"', page)

    def test_tomorrow_plan_can_be_saved_after_all_breaks_end(self):
        self.mock_clock.now.return_value = datetime(2026, 11, 25, 19, 30, tzinfo=MOSCOW)
        url = '/api/plans?university=mgsu&date=2026-11-26'
        payload = {'time': '09:55', 'place_id': 'node/1'}
        today = self.a.get('/api/places?university=mgsu&time=09:55')
        self.assertFalse(today.json['can_plan'])
        self.assertEqual(self.a.post('/api/plans?university=mgsu', json=payload).status_code, 400)
        self.assertEqual(self.a.post(url, json=payload).status_code, 201)
        tomorrow = self.a.get('/api/places?university=mgsu&time=09:55&date=2026-11-26')
        self.assertTrue(tomorrow.json['can_plan'])
        self.assertEqual(tomorrow.json['places'][0]['planned_count'], 1)
        self.assertEqual(tomorrow.json['visit_date'], '2026-11-26')
        self.assertEqual(tomorrow.json['my_plan']['slot'], '09:55')
        self.assertEqual(self.a.get('/api/places?university=mgsu&time=09:55').json['places'][0]['planned_count'], 0)
        self.a.delete('/api/plans?university=mgsu')
        self.assertIsNotNone(self.a.get('/api/places?university=mgsu&time=09:55&date=2026-11-26').json['my_plan'])
        self.a.delete(url)
        self.assertIsNone(self.a.get('/api/places?university=mgsu&time=09:55&date=2026-11-26').json['my_plan'])

    def test_only_today_and_tomorrow_are_allowed_and_now_stays_today(self):
        for day in ('2026-11-24', '2026-11-27', 'invalid'):
            self.assertEqual(self.a.get('/api/places?date='+day).status_code, 400)
            self.assertEqual(self.a.post('/api/plans?date='+day, json={'time':'12:30','place_id':'node/1'}).status_code, 400)
        response = self.a.get('/api/places?time=now&date=2026-11-26')
        self.assertEqual(response.json['visit_date'], '2026-11-25')
        self.assertEqual(response.json['mode'], 'now')


if __name__ == '__main__':
    unittest.main()
