"""University locations and user-supplied break schedules."""

UNIVERSITIES = {
    'mai': {
        'name': 'МАИ', 'title': 'Московский авиационный институт',
        'campus': (55.8104364, 37.4983111), 'origin_label': 'Выход ГУК',
        'map': 'neighborhood.svg',
        'breaks': [('10:30', '10:45'), ('12:15', '13:00'), ('14:30', '14:45'),
                   ('16:15', '16:30'), ('18:00', '18:15')],
    },
    'mgsu': {
        'name': 'МГСУ', 'title': 'Московский государственный строительный университет',
        'campus': (55.856067, 37.6954835), 'origin_label': 'МГСУ',
        'address': 'Москва, Ярославское шоссе, 26',
        'location_source': 'https://press.mgsu.ru/contacts/',
        'map': 'neighborhood-mgsu.svg',
        'breaks': [('09:50', '10:00'), ('11:20', '11:30'), ('12:50', '13:00')],
    },
}

for university in UNIVERSITIES.values():
    periods = []
    for start, end in university['breaks']:
        first, last = (int(t[:2])*60 + int(t[3:]) for t in (start, end))
        periods.append(dict(start=start, end=end, duration=last-first,
                            slots=[f'{m//60:02d}:{m%60:02d}' for m in range(first, last+1, 5)]))
    university['breaks'] = periods
    university['slots'] = [slot for period in periods for slot in period['slots']]
