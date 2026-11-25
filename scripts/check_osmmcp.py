"""Verify the local osmmcp server and optionally fetch nearby MAI cafes."""
import json
import argparse
import queue
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--offline', action='store_true', help='Only check initialization, tools and version; no external API calls')
parser.add_argument('--server', type=Path, default=ROOT / '.tools/osmmcp/osmmcp-fixed.exe', help='Server executable to verify')
parser.add_argument('--overpass-endpoint', default='https://ovp.dresel.systems/api/interpreter', help='Preferred supported Overpass endpoint (default: Europe mirror configured for MAI)')
parser.add_argument('--idle-seconds', type=float, default=0, help='Verify the server stays alive after an idle period')
args = parser.parse_args()
server_args = [str(args.server.resolve()), '--enable-monitoring=false']
if args.overpass_endpoint:
    server_args.extend(['--overpass-endpoint', args.overpass_endpoint])
log_path = ROOT / '.tools/osmmcp/check-stderr.log'
log_file = log_path.open('w', encoding='utf-8')
process = subprocess.Popen(
    server_args,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log_file,
    text=True, encoding='utf-8', cwd=ROOT,
)
messages = queue.Queue()
def read_messages():
    try:
        for line in process.stdout:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError:
                pass
    finally:
        messages.put(None)
threading.Thread(target=read_messages, daemon=True).start()

def send(message):
    process.stdin.write(json.dumps(message) + '\n')
    process.stdin.flush()

def call(number, method, params):
    send(dict(jsonrpc='2.0', id=number, method=method, params=params))
    while True:
        try:
            response = messages.get(timeout=150)
        except queue.Empty as exc:
            raise RuntimeError(f'MCP response timed out; see {log_path}') from exc
        if response is None:
            raise RuntimeError(f'MCP server closed stdout; see {log_path}')
        if response.get('id') == number:
            if 'error' in response:
                raise RuntimeError(response['error'])
            return response['result']

try:
    info = call(1, 'initialize', dict(protocolVersion='2024-11-05', capabilities={}, clientInfo=dict(name='mai-map-check', version='1.0')))
    print(json.dumps(info, ensure_ascii=False))
    send(dict(jsonrpc='2.0', method='notifications/initialized'))
    tools = call(2, 'tools/list', {})['tools']
    print('Tools:', ', '.join(tool['name'] for tool in tools))
    required = {'get_version', 'geocode_address', 'find_nearby_places'}
    missing = required - {tool['name'] for tool in tools}
    if missing:
        raise RuntimeError(f'Missing tools: {sorted(missing)}')
    version = call(3, 'tools/call', dict(name='get_version', arguments={}))
    print(json.dumps(version, ensure_ascii=False))
    if version.get('isError'):
        raise RuntimeError('Version query failed')
    if args.offline:
        raise SystemExit(0)
    result = call(4, 'tools/call', dict(name='find_nearby_places', arguments=dict(latitude=55.8104364, longitude=37.4983111, radius=700, category='cafe', limit=5)))
    output = ROOT / '.tools/osmmcp/nearby-mai.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    if result.get('isError'):
        raise RuntimeError(f'Nearby places query failed; see {log_path}')
    payload = json.loads(next(item['text'] for item in result['content'] if item['type'] == 'text'))
    if not payload.get('places'):
        raise RuntimeError('Expected nearby MAI cafes, got an empty response')
    bbox_result = call(5, 'tools/call', dict(name='osm_query_bbox', arguments=dict(
        bbox=dict(minLat=55.808, minLon=37.495, maxLat=55.813, maxLon=37.501),
        tags=dict(amenity='cafe'))))
    (ROOT / '.tools/osmmcp/bbox-mai.json').write_text(json.dumps(bbox_result, ensure_ascii=False, indent=2), encoding='utf-8')
    if bbox_result.get('isError'):
        raise RuntimeError(f'Bounding-box query failed; see {log_path}')
    bbox_payload = json.loads(next(item['text'] for item in bbox_result['content'] if item['type'] == 'text'))
    if not bbox_payload.get('elements'):
        raise RuntimeError('Expected cafe elements in MAI bounding box')
    print('Verified nearby cafes and bounding-box query')
    if args.idle_seconds:
        time.sleep(args.idle_seconds)
        alive = call(6, 'tools/call', dict(name='get_version', arguments={}))
        if alive.get('isError'):
            raise RuntimeError('Server failed after idle period')
        print(f'Verified server remains alive after {args.idle_seconds:g} seconds idle')
finally:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
    log_file.close()
