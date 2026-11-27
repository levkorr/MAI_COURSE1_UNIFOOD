"""Real OpenStreetMap POIs; no invented fallback locations."""
import json
import logging
import math
import sqlite3
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import closing, contextmanager
from http.client import HTTPException
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock, Thread
from universities import UNIVERSITIES

CAMPUS = (55.8104364, 37.4983111)
CACHE = Path(__file__).with_name('places-cache.json')
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
CACHE_TTL = 86400
RETRY_DELAY = 300
XML_SOURCE = 'OpenStreetMap API'
refresh_lock = Lock()
refresh_after = {}
logger = logging.getLogger(__name__)


def bounds_center(points):
    """Match the center returned by Overpass for ways and relations."""
    if not points:
        raise ValueError('Missing OSM geometry')
    return tuple((min(axis) + max(axis)) / 2 for axis in zip(*points))


def relation_center(relation, nodes, ways, relations):
    pending = [('relation', relation.attrib['id'])]
    seen = set()
    points = []
    while pending:
        kind, ref = pending.pop()
        if (kind, ref) in seen:
            continue
        seen.add((kind, ref))
        if kind == 'node':
            points.append(nodes[ref])
        elif kind == 'way':
            pending.extend(('node', nd.attrib['ref']) for nd in ways[ref].findall('nd'))
        elif kind == 'relation':
            pending.extend((m.attrib['type'], m.attrib['ref']) for m in relations[ref].findall('member'))
        else:
            raise ValueError('Unknown OSM member type')
    return bounds_center(points)


def parse_osm_xml(raw, campus=CAMPUS):
    root = ET.fromstring(raw)
    nodes = {n.attrib['id']: (float(n.attrib['lat']), float(n.attrib['lon'])) for n in root.findall('node')}
    ways = {w.attrib['id']: w for w in root.findall('way')}
    relations = {r.attrib['id']: r for r in root.findall('relation')}
    elements = []
    for item in root:
        tags = {t.attrib['k']: t.attrib['v'] for t in item.findall('tag')}
        if tags.get('amenity') not in ('cafe', 'fast_food', 'restaurant') and tags.get('shop') not in ('supermarket', 'convenience', 'bakery'):
            continue
        if not (tags.get('name:ru') or tags.get('name') or tags.get('brand')):
            continue
        if item.tag == 'node':
            lat, lon = nodes[item.attrib['id']]
        elif item.tag == 'way':
            points = [nodes[n.attrib['ref']] for n in item.findall('nd')]
            lat, lon = bounds_center(points)
        elif item.tag == 'relation':
            lat, lon = relation_center(item, nodes, ways, relations)
        else:
            continue
        elements.append(dict(type=item.tag, id=int(item.attrib['id']), lat=lat, lon=lon, tags=tags))
    return parse(elements, campus)


def distance(lat, lon, campus=CAMPUS):
    a, b = map(math.radians, campus)
    c, d = map(math.radians, (lat, lon))
    return 6371000 * 2 * math.asin(min(1, math.sqrt(math.sin((c-a)/2)**2 + math.cos(a)*math.cos(c)*math.sin((d-b)/2)**2)))


def parse(elements, campus=CAMPUS):
    result = []
    for item in elements:
        tags = item.get('tags', {})
        name = tags.get('name:ru') or tags.get('name') or tags.get('brand')
        if not name:
            continue
        point = item.get('center', item)
        lat, lon = point['lat'], point['lon']
        meters = round(distance(lat, lon, campus))
        # Estimate only: straight-line distance with a detour factor, not routing.
        walk = max(1, math.ceil(meters * 1.3 / 80))
        if walk > 10:
            continue
        shop, amenity, cuisine = tags.get('shop'), tags.get('amenity'), tags.get('cuisine', '')
        if shop in ('supermarket', 'convenience'):
            category, label, icon = 'market', 'Супермаркет' if shop == 'supermarket' else 'Продукты', '🛒'
        elif any(word in cuisine for word in ('kebab', 'shawarma')):
            category, label, icon = 'shawarma', 'Шаурма', '🥙'
        elif amenity == 'cafe' or shop == 'bakery' or 'coffee_shop' in cuisine.split(';'):
            category, label, icon = 'coffee', 'Пекарня' if shop == 'bakery' else 'Кафе / кофе', '☕'
        else:
            category, label, icon = 'food', 'Быстрое питание' if amenity == 'fast_food' else 'Ресторан', '🍜'
        address = ', '.join(filter(None, [tags.get('addr:street'), tags.get('addr:housenumber')]))
        result.append(dict(id=f"{item['type']}/{item['id']}", name=name, category=category,
                           label=label, icon=icon, lat=lat, lon=lon, walk=walk, distance=meters,
                           price='Цены не указаны', address=address or 'Адрес не указан в OSM',
                           hours=tags.get('opening_hours', 'Часы работы не указаны'),
                           source_url=f"https://www.openstreetmap.org/{item['type']}/{item['id']}",
                           base=20 + item['id'] % 55))
    return sorted(result, key=lambda p: p['distance'])


def fetch_places(campus):
    query = f'''[out:json][timeout:20];(nwr(around:650,{campus[0]},{campus[1]})[amenity~"^(cafe|fast_food|restaurant)$"];nwr(around:650,{campus[0]},{campus[1]})[shop~"^(supermarket|convenience|bakery)$"];);out center tags;'''
    for endpoint in ENDPOINTS:
        try:
            req = urllib.request.Request(endpoint, data=urllib.parse.urlencode({'data': query}).encode(), headers={'User-Agent': 'MezhduParamiPrototype/1.0'})
            with urllib.request.urlopen(req, timeout=27) as response:
                payload = json.load(response)
            if not isinstance(payload, dict) or payload.get('remark') or not isinstance(payload.get('elements'), list):
                continue
            places = parse(payload['elements'], campus)
            if places:
                return dict(places=places, fetched_at=time.time(), source='OpenStreetMap / Overpass')
        except (OSError, HTTPException, ValueError, KeyError, TypeError):
            continue
    try:
        lat, lon = campus
        bbox = f'{lon-.012},{lat-.007},{lon+.012},{lat+.007}'
        req = urllib.request.Request('https://api.openstreetmap.org/api/0.6/map?bbox='+bbox, headers={'User-Agent': 'MezhduParamiPrototype/1.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
            real_places = parse_osm_xml(response.read(), campus)
        if real_places:
            return dict(places=real_places, fetched_at=time.time(), source=XML_SOURCE)
    except (OSError, HTTPException, ValueError, KeyError, ET.ParseError):
        pass
    raise RuntimeError('Не удалось загрузить заведения. Повторите запрос позже.')


class CatalogueChanged(RuntimeError):
    """Another writer published a different catalogue during this refresh."""


def _read_optional(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _replace_bytes(path, content):
    temporary_path = None
    try:
        with NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
        temporary_path.replace(path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError as error:
                logger.warning('Не удалось удалить временный файл %s: %s', temporary_path, error)


def _restore_audit(journal):
    pending = _read_optional(journal)
    if pending is None:
        return
    for name, previous in json.loads(pending).items():
        if Path(name).name != name or not name.endswith('.json'):
            raise ValueError('Недопустимое имя файла в журнале сверки')
        path = journal.with_name(name)
        old_bytes = bytes.fromhex(previous) if previous is not None else None
        if _read_optional(path) != old_bytes:
            if old_bytes is None:
                path.unlink()
            else:
                _replace_bytes(path, old_bytes)
    journal.unlink()


@contextmanager
def _catalogue_lock(cache):
    # SQLite releases the writer lock even if the auditing process exits.
    with closing(sqlite3.connect(cache.with_suffix('.lock.sqlite3'), timeout=10)) as lock:
        lock.execute('BEGIN IMMEDIATE')
        journal = cache.with_suffix('.lock.sqlite3-audit')
        _restore_audit(journal)
        yield journal


def read_snapshot(cache):
    try:
        if cache.with_suffix('.lock.sqlite3-audit').exists():
            with _catalogue_lock(cache):
                return _read_optional(cache)
        return _read_optional(cache)
    except (OSError, sqlite3.Error, ValueError) as error:
        raise RuntimeError(f'Не удалось прочитать каталог {cache.name}: {error}') from error


def replace_catalogue(cache, expected, data, *, audit_files=()):
    """Compare and replace under the same cross-process lock for every writer."""
    content = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
    try:
        with _catalogue_lock(cache) as journal:
            if _read_optional(cache) != expected:
                raise CatalogueChanged(f'Каталог {cache.name} изменился во время сверки.')
            if not audit_files:
                _replace_bytes(cache, content)
                return
            files = [*audit_files, (cache, content)]
            previous = {}
            for path, _ in files:
                if path.parent != cache.parent or path.suffix != '.json' or path.name in previous:
                    raise ValueError('Ожидались отдельные JSON-файлы рядом с каталогом')
                original = _read_optional(path)
                previous[path.name] = original.hex() if original is not None else None
            # The undo journal must exist before changing the first public file.
            # Removing it commits the group. The next reader/writer recovers after a crash.
            _replace_bytes(journal, json.dumps(previous).encode())
            try:
                for path, artifact in files:
                    _replace_bytes(path, artifact)
                journal.unlink()
            except OSError:
                _restore_audit(journal)
                raise
    except (OSError, sqlite3.Error, ValueError) as error:
        raise RuntimeError(f'Не удалось сохранить каталог {cache.name}: {error}') from error


def decode_catalogue(original):
    try:
        cached = json.loads(original)
        if (cached['places'] and isinstance(cached['places'], list)
                and all(_valid_place(p) for p in cached['places'])
                and type(cached['fetched_at']) in (int, float) and math.isfinite(cached['fetched_at'])
                and isinstance(cached['source'], str) and cached['source'].strip()):
            return cached
    except (ValueError, KeyError, TypeError, OverflowError):
        pass
    return None


def _valid_place(place):
    text_fields = ('id', 'name', 'category', 'label', 'icon', 'address', 'hours')
    if not isinstance(place, dict) or not all(
            isinstance(place.get(key), str) and place[key].strip() for key in text_fields):
        return False
    return (type(place.get('lat')) in (int, float) and -90 <= place['lat'] <= 90
            and type(place.get('lon')) in (int, float) and -180 <= place['lon'] <= 180
            and type(place.get('walk')) is int and 1 <= place['walk'] <= 10
            and type(place.get('distance')) is int and place['distance'] >= 0)


def refresh_places(cache, campus, original, cached):
    data = fetch_places(campus)
    if cached is not None:
        if data['source'] == XML_SOURCE:
            received = {p['id'] for p in data['places']}
            if any(p['id'].startswith('relation/') and p['id'] not in received for p in cached['places']):
                raise RuntimeError('Резервный ответ OSM не подтвердил ранее сохранённые отношения.')
        data = {**cached, **data}
    replace_catalogue(cache, original, data)
    return data


def refresh_in_background(cache, campus, original, cached):
    try:
        refresh_places(cache, campus, original, cached)
    except CatalogueChanged:
        pass
    except RuntimeError as error:
        logger.warning('Фоновое обновление %s: %s', cache.name, error)
    finally:
        with refresh_lock:
            refresh_after[cache] = time.monotonic() + RETRY_DELAY


def get_places(university='mai', *, background=True):
    campus = UNIVERSITIES[university]['campus']
    cache = CACHE if university == 'mai' else CACHE.with_name(f'places-cache-{university}.json')
    original = read_snapshot(cache)
    cached = decode_catalogue(original)
    if cached is not None and time.time() - cached['fetched_at'] < CACHE_TTL:
        return cached, False
    if cached is not None and background:
        with refresh_lock:
            if time.monotonic() >= refresh_after.get(cache, 0):
                try:
                    Thread(target=refresh_in_background, args=(cache, campus, original, cached), daemon=True).start()
                except RuntimeError as error:
                    refresh_after[cache] = time.monotonic() + RETRY_DELAY
                    logger.warning('Не удалось запустить обновление %s: %s', cache.name, error)
                else:
                    refresh_after[cache] = float('inf')
        return cached, True
    try:
        return refresh_places(cache, campus, original, cached), False
    except CatalogueChanged:
        current = decode_catalogue(read_snapshot(cache))
        if current is None:
            raise
        return current, time.time() - current['fetched_at'] >= CACHE_TTL
    except RuntimeError as error:
        if cached is None:
            raise
        logger.warning('Обновление %s: %s', cache.name, error)
        return cached, True


if __name__ == '__main__':
    data, stale = get_places(background=False)
    print(json.dumps(dict(count=len(data['places']), names=[p['name'] for p in data['places']], stale=stale), ensure_ascii=False))
