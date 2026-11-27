"""Import the lazily initialized local app without opening an operator's REPORT_DB."""
import os
from unittest.mock import patch

with patch.dict(os.environ):
    os.environ.pop('REPORT_DB', None)
    from app import app, MOSCOW
