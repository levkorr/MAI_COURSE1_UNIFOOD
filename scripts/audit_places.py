"""Compare a saved OpenStreetMap MCP response with the application catalogue."""
import json
from datetime import datetime
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from places_source import parse, distance, read_snapshot, replace_catalogue


MCP_FILTERS = ('amenity=cafe', 'amenity=fast_food', 'amenity=restaurant',
               'shop=supermarket', 'shop=convenience', 'shop=bakery')


def parse_mcp_catalogue(responses, campus):
    """Build a catalogue from six decoded osm_query_bbox response payloads."""
    elements = {}
    for tag_filter in MCP_FILTERS:
        payload = responses.get(tag_filter)
        if (not isinstance(payload, dict) or payload.get('complete') is not True
                or payload.get('remark') or not isinstance(payload.get('elements'), list)):
            raise ValueError(f'Неподтверждённая выборка MCP: {tag_filter}')
        for item in payload['elements']:
            kind = item['type']
            if kind not in ('node', 'way', 'relation'):
                raise ValueError(f'Неизвестный тип OSM: {kind}')
            osm_id = int(item['id'])
            point = item['location'] if kind == 'node' else item['center']
            element = dict(type=kind, id=osm_id, lat=point['latitude'], lon=point['longitude'],
                           tags=item.get('tags', {}))
            key = (kind, osm_id)
            if key in elements and elements[key] != element:
                raise ValueError(f'Расходятся данные об объекте {kind}/{osm_id}')
            elements[key] = element
    places = parse(elements.values(), campus)
    if not places:
        raise ValueError('Выборка MCP дала пустой каталог')
    return places


def main():
    raw = json.loads((ROOT / 'osm-places-audit-input.json').read_text(encoding='utf-8'))
    cache_path = ROOT / 'places-cache.json'
    original = read_snapshot(cache_path)
    cached = json.loads(original)
    fresh = parse(raw['elements'])
    old_by_id = {p['id']: p for p in cached['places']}
    new_by_id = {p['id']: p for p in fresh}
    fields = ('name', 'lat', 'lon', 'category', 'label', 'address', 'hours', 'distance', 'walk', 'source_url')
    changed = []
    details = []
    for item in raw['elements']:
        identity = f"{item['type']}/{item['id']}"
        if identity not in new_by_id:
            continue
        tags = item['tags']
        place = new_by_id[identity]
        changes = {key: {'before': old_by_id[identity].get(key), 'after': place.get(key)}
                   for key in fields if identity in old_by_id and old_by_id[identity].get(key) != place.get(key)}
        if changes:
            changed.append({'id': identity, 'name': place['name'], 'fields': changes})
        details.append(dict(id=identity, name=place['name'], source_url=place['source_url'],
                            missing_address=not bool(tags.get('addr:street') and tags.get('addr:housenumber')),
                            missing_hours=not bool(tags.get('opening_hours')),
                            check_date=tags.get('check_date'),
                            hours_check_date=tags.get('check_date:opening_hours'),
                            access=tags.get('access'), changes=changes))
    unnamed = [dict(id=f"{e['type']}/{e['id']}", tags=e['tags']) for e in raw['elements']
               if not (e['tags'].get('name:ru') or e['tags'].get('name') or e['tags'].get('brand'))
               and round(distance(e['lat'], e['lon'])) * 1.3 / 80 <= 10]
    report = dict(queried_at=raw['queried_at'], source=raw['source'], bbox=raw['bbox'],
                  previous_fetched_at=datetime.fromtimestamp(cached['fetched_at']).isoformat(),
                  previous_count=len(old_by_id), current_count=len(fresh),
                  added=sorted(new_by_id.keys() - old_by_id.keys()),
                  removed=sorted(old_by_id.keys() - new_by_id.keys()), changed=changed,
                  missing_address=sum(p['missing_address'] for p in details),
                  missing_hours=sum(p['missing_hours'] for p in details),
                  missing_check_date=sum(not p['check_date'] for p in details),
                  restricted=[p for p in details if p['access'] in ('private', 'no')],
                  unnamed_excluded=unnamed, places=details,
                  limitation='Comparison with the current OSM mirror; business operation and opening hours are not independently confirmed. Walking times are estimates. The mirror updates daily.')
    updated = dict(cached, places=fresh, fetched_at=datetime.fromisoformat(raw['queried_at'].replace('Z', '+00:00')).timestamp(),
                   source=raw['source'])
    audit_files = [(cache_path.with_suffix('.before-audit.json'), original),
                   (ROOT / 'places-audit.json', json.dumps(report, ensure_ascii=False, indent=2).encode('utf-8'))]
    replace_catalogue(cache_path, original, updated, audit_files=audit_files)
    print(json.dumps({k: v for k, v in report.items() if k not in ('places', 'unnamed_excluded')}, ensure_ascii=False, indent=2))
    print('Unnamed excluded:', len(unnamed))


if __name__ == '__main__':
    main()
