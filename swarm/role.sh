#!/bin/bash
# Call a helper role (explore | looker | critic | oracle). Request on stdin, short answer on stdout.
# See roles.py for what each role is for.
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/roles.py" "$@"
