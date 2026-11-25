from flask import Flask, jsonify, render_template, request, g
from places_source import get_places
from pathlib import Path
from contextlib import contextmanager
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from universities import UNIVERSITIES
from database import database, absolute_path

app = Flask(__name__)
configured_db = os.environ.get('REPORT_DB')
app.config['REPORT_DB'] = str(Path(__file__).with_name('reports.sqlite3'))
if configured_db is not None:
    path = absolute_path(configured_db)
    with database(path, existing=True):
        pass
    app.config['REPORT_DB'] = str(path)
PEOPLE_RANGES = ('0-5', '5-10', '10-15', '15-20')
REPORT_LIFETIME = 30 * 60
PLAN_WINDOW = 5
MOSCOW = timezone(timedelta(hours=3))


@app.before_request
def identify_visitor():
    try:
        g.visitor_id = str(uuid.UUID(request.cookies.get('mp-visitor', '')))
    except ValueError:
        g.visitor_id = str(uuid.uuid4())
    payload = request.get_json(silent=True)
    g.university = request.args.get('university', payload.get('university', 'mai') if isinstance(payload, dict) else 'mai')
    if not isinstance(g.university, str) or g.university not in UNIVERSITIES:
        return jsonify(error='Университет не найден'), 400
    today = datetime.now(MOSCOW).date()
    g.visit_date = request.args.get('date', payload.get('date', today.isoformat()) if isinstance(payload, dict) else today.isoformat())
    if g.visit_date not in (today.isoformat(), (today + timedelta(days=1)).isoformat()):
        return jsonify(error='Выберите сегодня или завтра'), 400


@app.after_request
def remember_visitor(response):
    if request.cookies.get('mp-visitor') != g.visitor_id:
        response.set_cookie('mp-visitor', g.visitor_id, max_age=365*86400,
                            httponly=True, samesite='Lax', secure=request.is_secure)
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@contextmanager
def report_database():
    with database(app.config['REPORT_DB'], existing=configured_db is not None) as db:
        yield db


def report_json(row):
    return dict(people_range=row['people_range'], observed_at=row['observed_at'],
                expires_at=row['observed_at'] + REPORT_LIFETIME)
BREAKS = UNIVERSITIES['mai']['breaks']
SLOTS = UNIVERSITIES['mai']['slots']



def occupancy(place, observations):
    count = len(observations)
    people = round(sum((int(row['people_range'].split('-')[0]) + int(row['people_range'].split('-')[1])) / 2
                       for row in observations) / count, 1) if count else None
    load = min(100, round(people / 20 * 100)) if count else 0
    latest = observations[-1] if count else None
    result = {key: value for key, value in place.items() if key not in ('price', 'base')}
    return dict(result, load=load, people=people, report_count=count,
                status='Нет оценок' if not count else 'Свободно' if load < 45 else 'Умеренно' if load < 70 else 'Много людей',
                tone='neutral' if not count else 'green' if load < 45 else 'amber' if load < 70 else 'red',
                current_report=report_json(latest) if latest else None)


def active_observations(db):
    result = {}
    for row in db.execute('SELECT * FROM visitor_observations WHERE observed_at > ? ORDER BY observed_at, id',
                          (time.time() - REPORT_LIFETIME,)):
        result.setdefault(row['place_id'], []).append(row)
    return result


@app.get('/')
def index():
    today = datetime.now(MOSCOW).date()
    return render_template('index.html', breaks=BREAKS, universities=UNIVERSITIES,
                           today=today.isoformat(), tomorrow=(today + timedelta(days=1)).isoformat())


@app.get('/ui-kit')
def ui_kit():
    return render_template('ui-kit.html')


@app.get('/ui-kit/layout-example')
def ui_kit_layout_example():
    return render_template('ui-kit-layout.html')


@app.get('/ui-kit/place-card-example')
def ui_kit_place_card_example():
    return render_template('ui-kit-place-card-example.html')


@app.get('/ui-kit/check-in-example')
def ui_kit_check_in_example():
    return render_template('ui-kit-check-in-example.html')


@app.get('/api/places')
def places():
    slot = request.args.get('time', 'now')
    if slot != 'now' and slot not in UNIVERSITIES[g.university]['slots']:
        return jsonify(error='Выберите время из списка'), 400
    try:
        data, stale = get_places(g.university)
    except RuntimeError as error:
        return jsonify(error=str(error)), 503
    with report_database() as db:
        now = datetime.now(MOSCOW)
        today = now.date().isoformat() if slot == 'now' else g.visit_date
        own = db.execute('SELECT place_id, slot FROM visit_plans WHERE visitor_id=? AND visit_date=? AND university=?',
                         (g.visitor_id, today, g.university)).fetchone()
        if slot == 'now':
            reports = active_observations(db)
            result = [occupancy(p, reports.get(p['id'], [])) for p in data['places']]
        else:
            minute = slot_minutes(slot)
            counts = {}
            for row in db.execute('SELECT place_id, slot FROM visit_plans WHERE visit_date=? AND university=?', (today, g.university)):
                if abs(slot_minutes(row['slot']) - minute) <= PLAN_WINDOW:
                    counts[row['place_id']] = counts.get(row['place_id'], 0) + 1
            result = []
            for place in data['places']:
                count = counts.get(place['id'], 0)
                item = occupancy(place, [])
                item.update(planned_count=count, people=count, load=0,
                            status=f'Планируют: {count} чел.', tone='green' if count else 'neutral')
                result.append(item)
    return jsonify(places=result, time=slot, mode='now' if slot == 'now' else 'planned',
                   visit_date=today, window_minutes=PLAN_WINDOW, my_plan=dict(own) if own else None,
                   can_plan=slot != 'now' and (today > now.date().isoformat() or slot_minutes(slot) > now.hour*60 + now.minute),
                   demo=False, source=data['source'], fetched_at=data['fetched_at'],
                   stale=stale, university=g.university, campus=UNIVERSITIES[g.university]['campus'])


def slot_minutes(slot):
    return int(slot[:2])*60 + int(slot[3:])


@app.post('/api/plans')
def plan_visit():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or payload.get('time') not in UNIVERSITIES[g.university]['slots']:
        return jsonify(error='Выберите время из списка'), 400
    now = datetime.now(MOSCOW)
    if g.visit_date == now.date().isoformat() and slot_minutes(payload['time']) <= now.hour*60 + now.minute:
        return jsonify(error='Это время уже прошло. Выберите «Завтра» или более позднее время.'), 400
    try:
        data, _ = get_places(g.university)
    except RuntimeError as error:
        return jsonify(error=str(error)), 503
    place_id = payload.get('place_id')
    if not isinstance(place_id, str) or not any(p['id'] == place_id for p in data['places']):
        return jsonify(error='Заведение не найдено'), 404
    today = g.visit_date
    with report_database() as db:
        db.execute('INSERT INTO visit_plans (visitor_id, visit_date, place_id, slot, university) VALUES (?, ?, ?, ?, ?) '
                   'ON CONFLICT(visitor_id, visit_date) DO UPDATE SET place_id=excluded.place_id, slot=excluded.slot, university=excluded.university',
                   (g.visitor_id, today, place_id, payload['time'], g.university))
    return jsonify(my_plan=dict(place_id=place_id, slot=payload['time']), visit_date=today), 201


@app.delete('/api/plans')
def cancel_plan():
    with report_database() as db:
        db.execute('DELETE FROM visit_plans WHERE visitor_id=? AND visit_date=? AND university=?',
                   (g.visitor_id, g.visit_date, g.university))
    return jsonify(my_plan=None)


@app.post('/api/check-ins')
def check_in():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or payload.get('people_range') not in PEOPLE_RANGES:
        return jsonify(error='Выберите число посетителей: 0–5, 5–10, 10–15 или 15–20'), 400
    place_id = payload.get('place_id')
    try:
        data, _ = get_places(g.university)
    except RuntimeError as error:
        return jsonify(error=str(error)), 503
    if not isinstance(place_id, str) or not any(p['id'] == place_id for p in data['places']):
        return jsonify(error='Заведение не найдено'), 404
    observed_at = time.time()
    with report_database() as db:
        db.execute('INSERT INTO visitor_observations (place_id, people_range, observed_at) VALUES (?, ?, ?)',
                   (place_id, payload['people_range'], observed_at))
        observations = active_observations(db).get(place_id, [])
    place = next(p for p in data['places'] if p['id'] == place_id)
    result = occupancy(place, observations)
    return jsonify(place=result, current_report=result['current_report']), 201



if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5051, debug=False)
