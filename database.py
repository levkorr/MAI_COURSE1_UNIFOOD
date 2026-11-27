import argparse
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3


def absolute_path(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f'SQLite path must be absolute: {value!r}')
    return path


def prepare_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS reports (
        place_id TEXT PRIMARY KEY, people_range TEXT NOT NULL, observed_at REAL NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS visitor_observations (
        id INTEGER PRIMARY KEY, place_id TEXT NOT NULL,
        people_range TEXT NOT NULL, observed_at REAL NOT NULL)''')
    db.execute('''CREATE INDEX IF NOT EXISTS observations_place_time
        ON visitor_observations(place_id, observed_at)''')
    db.execute('''CREATE TABLE IF NOT EXISTS visit_plans (
        visitor_id TEXT NOT NULL, visit_date TEXT NOT NULL,
        place_id TEXT NOT NULL, slot TEXT NOT NULL,
        university TEXT NOT NULL DEFAULT 'mai', PRIMARY KEY (visitor_id, visit_date))''')
    if 'university' not in [row['name'] for row in db.execute('PRAGMA table_info(visit_plans)')]:
        db.execute("ALTER TABLE visit_plans ADD COLUMN university TEXT NOT NULL DEFAULT 'mai'")
    db.execute('''INSERT INTO visitor_observations (place_id, people_range, observed_at)
        SELECT r.place_id, r.people_range, r.observed_at FROM reports r
        WHERE NOT EXISTS (
            SELECT 1 FROM visitor_observations o
            WHERE o.place_id = r.place_id AND o.people_range = r.people_range
              AND o.observed_at = r.observed_at)''')


@contextmanager
def database(path, *, existing=False, write=False):
    # SQLite's mode=rw also prevents recreation if the mounted file disappears later.
    target = Path(path).as_uri() + '?mode=rw' if existing else path
    try:
        connection = sqlite3.connect(target, timeout=10, uri=existing)
    except sqlite3.Error as error:
        raise sqlite3.OperationalError(f'Cannot open SQLite database {path}: {error}') from error
    with closing(connection) as db, db:
        db.row_factory = sqlite3.Row
        if db.execute('PRAGMA user_version').fetchone()[0] == 0:
            with db:
                db.execute('BEGIN IMMEDIATE')
                # A different connection may have migrated the file while we waited.
                if db.execute('PRAGMA user_version').fetchone()[0] == 0:
                    prepare_schema(db)
                    db.execute('PRAGMA user_version = 1')
        db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        yield db


def main():
    parser = argparse.ArgumentParser(description='Provision the reports database')
    parser.add_argument('command', choices=['init'])
    parser.add_argument('path')
    args = parser.parse_args()
    try:
        path = absolute_path(args.path)
        path.touch(exist_ok=False)
        try:
            with database(path, existing=True):
                pass
        except sqlite3.Error:
            path.unlink()
            raise
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f'Cannot initialize SQLite database: {error}\n')


if __name__ == '__main__':
    main()
