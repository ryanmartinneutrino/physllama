"""Local, persistent display names keyed by immutable Bluetooth identity."""
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import unicodedata


def validate_name(name, max_length=60):
    name = name.strip()
    if len(name) > max_length or any(unicodedata.category(c).startswith('C') for c in name):
        raise ValueError(f'Use a name of at most {max_length} characters without control characters.')
    return name


def settings_directory():
    if os.environ.get('PHYSLLAMA_DATA_DIR'):
        return Path(os.environ['PHYSLLAMA_DATA_DIR'])
    if sys.platform == 'win32':
        return Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'PhysLlama'
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'PhysLlama'
    return Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'physllama'


class DeviceNames:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else settings_directory() / 'device-names.json'

    def load(self):
        try:
            names = json.loads(self.path.read_text())
            if not isinstance(names, dict):
                raise ValueError('Expected a device-name mapping.')
            return {key: validate_name(value) for key, value in names.items()
                    if isinstance(key, str) and isinstance(value, str)}
        except FileNotFoundError:
            return {}
        except (ValueError, OSError):
            logging.warning('Could not read saved device names from %s', self.path)
            return {}

    def save(self, names):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix='device-names-', suffix='.tmp', delete=False) as output:
                temporary = Path(output.name)
                json.dump(names, output, ensure_ascii=False, indent=2)
                output.write('\n')
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
