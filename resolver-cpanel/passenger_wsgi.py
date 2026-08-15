"""
Passenger entry point — the file cPanel looks for.

cPanel's "Setup Python App" runs the application through Phusion Passenger,
which imports this module and expects a WSGI callable named `application`.
The name and location are fixed by Passenger; do not rename either.

Everything real lives in app.py. This file stays trivial on purpose: if an import
fails here, Passenger shows a bare 500 with no detail, so the less that happens in
this file the easier the app is to diagnose.
"""

import os
import sys

# Passenger's working directory is not guaranteed to be this folder, so make the
# import explicit rather than relying on cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import application  # noqa: E402,F401  (re-exported for Passenger)
