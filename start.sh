#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv || { echo 'Install Python 3.10+ and its venv package (Ubuntu/Debian: sudo apt install python3-venv).'; exit 1; }
fi
if ! cmp -s requirements.txt .venv/installed-requirements.txt; then
  .venv/bin/python -m pip install -r requirements.txt
  cp requirements.txt .venv/installed-requirements.txt
fi
exec .venv/bin/python run.py "$@"
