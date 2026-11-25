"""Build the static, locally served SVG from OSM street geometry."""
import math
import re
from collections import defaultdict
import xml.etree.ElementTree as ET
from pathlib import Path
from places_source import CAMPUS
from universities import UNIVERSITIES
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--university', choices=UNIVERSITIES, default='mai')
parser.add_argument('--input', default=str(Path(__file__).with_name('osm-schematic.xml')))
args = parser.parse_args()
CAMPUS = UNIVERSITIES[args.university]['campus']

root = ET.parse(args.input).getroot()
nodes = {n.attrib['id']: (float(n.attrib['lat']), float(n.attrib['lon'])) for n in root.findall('node')}


def xy(lat, lon):
    return (500 + (lon-CAMPUS[1])*111195*math.cos(math.radians(CAMPUS[0]))/2.2,
            500 - (lat-CAMPUS[0])*111195/2.2)


parks, buildings, streets = [], [], []
for way in root.findall('way'):
    tags = {t.attrib['k']: t.attrib['v'] for t in way.findall('tag')}
    points = [xy(*nodes[n.attrib['ref']]) for n in way.findall('nd') if n.attrib['ref'] in nodes]
    if len(points) < 2:
        continue
    if not any(-50 < x < 1050 and -50 < y < 1050 for x, y in points):
        continue
    path = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in points)
    if tags.get('leisure') in ('park', 'garden') or tags.get('landuse') in ('forest', 'grass', 'recreation_ground') or tags.get('natural') in ('wood', 'scrub'):
        parks.append(f'<path d="{path} Z" fill="#dce7cf"/>')
    elif tags.get('building') and abs(sum(points[i][0]*points[(i+1)%len(points)][1]-points[(i+1)%len(points)][0]*points[i][1] for i in range(len(points)))/2) > 230:
        buildings.append(f'<path d="{path} Z" fill="#e2e7da" stroke="#dce2d3" stroke-width=".6"/>')
    highway = tags.get('highway')
    widths = {'trunk':15,'primary':13,'secondary':10,'tertiary':8,'residential':5,'unclassified':5,'living_street':4,'service':2.5}
    if highway in widths:
        streets.append((widths[highway],path))

def combine(paths, attributes):
    geometry = ' '.join(re.search(r'd="([^"]+)"', path).group(1) for path in paths)
    return f'<path d="{geometry}" {attributes}/>'


svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><clipPath id="area"><circle cx="500" cy="500" r="454.545"/></clipPath></defs>',
       '<rect width="1000" height="1000" fill="#f8f9f1"/><circle cx="500" cy="500" r="454.545" fill="#edf0e5"/>', '<g clip-path="url(#area)">', *parks, *buildings]
# Merge same-style geometry into a few drawing operations instead of thousands.
svg = svg[:3] + [combine(parks, 'fill="#dce7cf"'), combine(buildings, 'fill="#e2e7da" stroke="#dce2d3" stroke-width=".6"')]
street_groups = defaultdict(list)
for width, path in streets:
    street_groups[width].append(path)
for width, paths in sorted(street_groups.items()):
    path = ' '.join(paths)
    svg.append(f'<path d="{path}" fill="none" stroke="#d9dfd0" stroke-width="{width+2}" stroke-linecap="round" stroke-linejoin="round"/>')
    svg.append(f'<path d="{path}" fill="none" stroke="#fffef8" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')
svg.extend(['</g><circle cx="500" cy="500" r="454.545" fill="none" stroke="#adbd9a" stroke-width="2" stroke-dasharray="6 8"/>', '</svg>'])
Path(__file__).with_name('static').joinpath(UNIVERSITIES[args.university]['map']).write_text(''.join(svg), encoding='utf-8')
print(f'SVG: {len(streets)} streets, {len(buildings)} building outlines; clipped to 1 km')
