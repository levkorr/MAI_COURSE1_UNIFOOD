"""Compare tiny real Overpass queries across public endpoints and HTTP methods."""
import concurrent.futures
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

QUERY = '[out:json][timeout:10];node(14167376744);out tags;'
ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]


def probe(endpoint, method, query=QUERY, timeout=20):
    start = time.monotonic()
    data = urllib.parse.urlencode({'data': query}).encode()
    url = endpoint + ('?' + data.decode() if method == 'GET' else '')
    request = urllib.request.Request(url, data=data if method == 'POST' else None,
                                     headers={'User-Agent': 'MezhduParami-MCP-Diagnostics/1.0'})
    result = dict(endpoint=endpoint, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            result.update(status=response.status, elements=json.loads(body).get('elements'))
    except Exception as exc:
        result['error'] = str(exc)
        if isinstance(exc, urllib.error.HTTPError):
            result['body'] = exc.read(600).decode(errors='replace')
    result['seconds'] = round(time.monotonic() - start, 2)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', action='append')
    parser.add_argument('--method', choices=('GET', 'POST'), action='append')
    parser.add_argument('--query', default=QUERY)
    parser.add_argument('--timeout', type=int, default=20)
    args = parser.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(probe, endpoint, method, args.query, args.timeout) for endpoint in (args.endpoint or ENDPOINTS) for method in (args.method or ('GET', 'POST'))]
        results = [future.result() for future in futures]
    path = Path(__file__).resolve().parents[1] / '.tools/osmmcp/endpoint-diagnostics.json'
    path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))
