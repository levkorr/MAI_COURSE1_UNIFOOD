"""Real OpenStreetMap POIs; no invented fallback locations."""
import json
import math
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from universities import UNIVERSITIES

CAMPUS = (55.8104364, 37.4983111)
CACHE = Path(__file__).with_name('places-cache.json')
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']


def parse_osm_xml(raw, campus=CAMPUS):
    root = ET.fromstring(raw)
    nodes = {n.attrib['id']: (float(n.attrib['lat']), float(n.attrib['lon'])) for n in root.findall('node')}
    elements = []
    for item in root:
        tags = {t.attrib['k']: t.attrib['v'] for t in item.findall('tag')}
        if tags.get('amenity') not in ('cafe', 'fast_food', 'restaurant') and tags.get('shop') not in ('supermarket', 'convenience', 'bakery'):
            continue
        if item.tag == 'node':
            lat, lon = nodes[item.attrib['id']]
        elif item.tag == 'way':
            points = [nodes[n.attrib['ref']] for n in item.findall('nd') if n.attrib['ref'] in nodes]
            if not points:
                continue
            lat, lon = (sum(p[i] for p in points)/len(points) for i in (0, 1))
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


def get_places(university='mai'):
    campus = UNIVERSITIES[university]['campus']
    cache = CACHE if university == 'mai' else CACHE.with_name(f'places-cache-{university}.json')
    cached = None
    if cache.exists():
        try:
            cached = json.loads(cache.read_text(encoding='utf-8'))
            if time.time() - cached['fetched_at'] < 86400:
                return cached, False
        except (ValueError, KeyError):
            cached = None
    query = f'''[out:json][timeout:20];(nwr(around:650,{campus[0]},{campus[1]})[amenity~"^(cafe|fast_food|restaurant)$"];nwr(around:650,{campus[0]},{campus[1]})[shop~"^(supermarket|convenience|bakery)$"];);out center tags;'''
    for endpoint in ENDPOINTS:
        try:
            req = urllib.request.Request(endpoint, data=urllib.parse.urlencode({'data': query}).encode(), headers={'User-Agent': 'MezhduParamiPrototype/1.0'})
            with urllib.request.urlopen(req, timeout=27) as response:
                payload = json.load(response)
            cached = dict(places=parse(payload['elements'], campus), fetched_at=time.time(), source='OpenStreetMap / Overpass')
            cache.write_text(json.dumps(cached, ensure_ascii=False, indent=2), encoding='utf-8')
            return cached, False
        except (OSError, ValueError, KeyError):
            continue
    if cached:
        return cached, True
    try:
        lat, lon = campus
        bbox = f'{lon-.012},{lat-.007},{lon+.012},{lat+.007}'
        req = urllib.request.Request('https://api.openstreetmap.org/api/0.6/map?bbox='+bbox, headers={'User-Agent': 'MezhduParamiPrototype/1.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
            real_places = parse_osm_xml(response.read(), campus)
        cached = dict(places=real_places, fetched_at=time.time(), source='OpenStreetMap API')
        cache.write_text(json.dumps(cached, ensure_ascii=False, indent=2), encoding='utf-8')
        return cached, False
    except (OSError, ValueError, ET.ParseError):
        pass
    raise RuntimeError('Не удалось загрузить заведения. Повторите запрос позже.')


if __name__ == '__main__':
    data, stale = get_places()
    print(json.dumps(dict(count=len(data['places']), names=[p['name'] for p in data['places']], stale=stale), ensure_ascii=False))
