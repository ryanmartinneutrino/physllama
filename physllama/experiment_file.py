"""Experiment files: everything needed to resume an experiment later.

A file holds the experiment name, the devices and their recording settings
(channels and sampling interval), every recorded series and sample, and the
browser's graph layout. Loaded files are untrusted input and are validated
completely before any session state changes.
"""
import math
from datetime import datetime, timezone

from .names import validate_name

FORMAT = 'physllama-experiment'
VERSION = 1
MAX_POINTS = 250_000
MAX_DEVICES = 64
MAX_SERIES = 512
MAX_GRAPHS = 12


def build(lab):
    """Serialize a Lab's experiment. Points are stored column-wise to keep files compact."""
    ids = list(lab.series)
    index = {series_id: i for i, series_id in enumerate(ids)}
    devices = {}
    for device in lab.devices.values():
        if device.connected:
            devices[device.id] = dict(
                id=device.id, name=lab.display_name(device), nickname=lab.names.get(device.id, ''),
                hardware_name=device.name, serial=getattr(device, 'serial', None), family=device.family,
                driver=device.driver, demo=device.demo, sensors=[dict(s) for s in device.sensors],
                selected=list(lab.selected.get(device.id, [])), period_ms=lab.periods.get(device.id))
    for device_id, saved in lab.saved_devices.items():
        devices.setdefault(device_id, dict(saved))
    return dict(
        format=FORMAT, version=VERSION,
        saved_at=datetime.now(timezone.utc).isoformat(timespec='seconds'),
        experiment_name=lab.experiment_name or 'Untitled experiment',
        devices=list(devices.values()),
        series=[dict(lab.series[series_id]) for series_id in ids],
        points=dict(series=[index[p['series']] for p in lab.points], t=[p['t'] for p in lab.points],
                    value=[p['value'] for p in lab.points], run=[p['run'] for p in lab.points]),
    )


def _text(value, field, limit=200, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise ValueError(f'Invalid {field} in experiment file.')
    return value


def _number(value, field, low=-math.inf, high=math.inf):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'Invalid {field} in experiment file.')
    return value


def _integer(value, field, low=0, high=2**31):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f'Invalid {field} in experiment file.')
    return value


def _sensor(raw):
    if not isinstance(raw, dict):
        raise ValueError('Invalid sensor in experiment file.')
    excluded = raw.get('excluded_channels', [])
    if not isinstance(excluded, list) or len(excluded) > 64:
        raise ValueError('Invalid sensor in experiment file.')
    return dict(number=_integer(raw.get('number'), 'sensor number'), name=_text(raw.get('name'), 'sensor name', 120),
                unit=_text(raw.get('unit'), 'sensor unit', 40), minimum_ms=_number(raw.get('minimum_ms'), 'sensor range', 0),
                maximum_ms=_number(raw.get('maximum_ms'), 'sensor range', 0), step_ms=_number(raw.get('step_ms', 0), 'sensor step', 0),
                excluded_channels=[_integer(n, 'sensor exclusion') for n in excluded], supported=raw.get('supported') is True)


def _device(raw):
    if not isinstance(raw, dict):
        raise ValueError('Invalid device in experiment file.')
    sensors = raw.get('sensors', [])
    selected = raw.get('selected', [])
    if not isinstance(sensors, list) or len(sensors) > 256 or not isinstance(selected, list) or len(selected) > 256:
        raise ValueError('Invalid device in experiment file.')
    period = raw.get('period_ms')
    return dict(
        id=_text(raw.get('id'), 'device ID', 200), name=_text(raw.get('name'), 'device name', 200),
        nickname=validate_name(_text(raw.get('nickname') or '', 'device nickname', 60, required=False)), hardware_name=_text(raw.get('hardware_name'), 'device name', 200),
        serial=_text(raw.get('serial'), 'device serial', 60, required=False), family=_text(raw.get('family'), 'device family', 80),
        driver=_text(raw.get('driver'), 'device driver', 40), demo=raw.get('demo') is True,
        sensors=[_sensor(s) for s in sensors], selected=[_integer(n, 'selected channel') for n in selected],
        period_ms=None if period is None else _number(period, 'sampling interval', 10, 10000))


def _series(raw):
    if not isinstance(raw, dict):
        raise ValueError('Invalid series in experiment file.')
    series = dict(id=_text(raw.get('id'), 'series ID', 240), device_id=_text(raw.get('device_id'), 'series device', 200),
                  device=_text(raw.get('device'), 'series device name', 200),
                  hardware_name=_text(raw.get('hardware_name'), 'series device name', 200),
                  serial=_text(raw.get('serial'), 'series serial', 60, required=False),
                  name=_text(raw.get('name'), 'series name', 120), unit=_text(raw.get('unit'), 'series unit', 40),
                  demo=raw.get('demo') is True)
    if not series['id'].startswith(series['device_id'] + '/'):
        raise ValueError('Invalid series ID in experiment file.')
    return series


def parse(data):
    """Validate an experiment file and return its normalized contents."""
    if not isinstance(data, dict) or data.get('format') != FORMAT:
        raise ValueError('This is not a PhysLlama experiment file.')
    if data.get('version') != VERSION:
        raise ValueError(f"Unsupported experiment file version {data.get('version')!r}. Update PhysLlama to open it.")
    devices, series, points = data.get('devices', []), data.get('series', []), data.get('points', {})
    if not isinstance(devices, list) or len(devices) > MAX_DEVICES or not isinstance(series, list) or len(series) > MAX_SERIES:
        raise ValueError('The experiment file has too many devices or series.')
    devices = [_device(d) for d in devices]
    series = [_series(s) for s in series]
    if len({d['id'] for d in devices}) != len(devices) or len({s['id'] for s in series}) != len(series):
        raise ValueError('The experiment file lists a device or series twice.')
    if len({s['demo'] for s in series} | {d['demo'] for d in devices}) > 1:
        raise ValueError('The experiment file mixes demo and real measurements.')

    if not isinstance(points, dict):
        raise ValueError('Invalid samples in experiment file.')
    columns = [points.get(key, []) for key in ('series', 't', 'value', 'run')]
    if not all(isinstance(c, list) for c in columns) or len({len(c) for c in columns}) != 1:
        raise ValueError('Invalid samples in experiment file.')
    if len(columns[0]) > MAX_POINTS:
        raise ValueError('The experiment file has more than 250,000 values.')
    parsed, last = [], {}
    for seq, (index, t, value, run) in enumerate(zip(*columns), 1):
        index = _integer(index, 'sample series', 0, len(series) - 1)
        t = _number(t, 'sample time', 0)
        run = _integer(run, 'sample run', 1)
        if value is not None:
            value = _number(value, 'sample value')
        key = series[index]['id']
        if (run, t) < last.get(key, (0, 0)):
            raise ValueError('Sample times in the experiment file are out of order.')
        last[key] = (run, t)
        parsed.append(dict(seq=seq, series=key, t=t, value=value, run=run))

    name = validate_name(_text(data.get('experiment_name') or '', 'experiment name', 80, required=False), 80) or 'Untitled experiment'
    return dict(experiment_name=name, devices=devices, series=series, points=parsed)
