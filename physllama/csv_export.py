"""Wide CSV: one row per recorded (run, time). Raw samples are written unmodified, never interpolated.

Columns: run, time_s (since the first Start), run_time_s (since the run's first sample), then one per channel.
"""
import csv
import io
import math


def channel_heading(series):
    identity = [series['id']]
    if series.get('serial'):
        identity.append(series['serial'])
    if series.get('hardware_name') != series['device']:
        identity.append(series['hardware_name'])
    if series['demo']:
        identity.append('DEMO')
    heading = f"{series['device']} — {series['name']} [{series['unit']}] ({'; '.join(identity)})"
    # Names may originate in Bluetooth advertisements or user input.
    return "'" + heading if heading.startswith(('=', '+', '-', '@', '\t', '\r')) else heading


def wide_csv(series, points):
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    ids = [s['id'] for s in series]
    selected = set(ids)
    writer.writerow(['run', 'time_s', 'run_time_s', *(channel_heading(s) for s in series)])
    runs = {}
    timelines = {}
    for point in points:
        # Both exports share the complete experiment timeline; filtering a
        # graph changes its columns, never discards timestamps or whole runs.
        timelines.setdefault(point['run'], set()).add(point['t'])
        if point['series'] in selected:
            value = point['value']
            value = value if value is not None and math.isfinite(value) else None
            runs.setdefault(point['run'], {}).setdefault(point['series'], {})[point['t']] = value

    for run, timeline in sorted(timelines.items()):
        channels = runs.get(run, {})
        times = sorted(timeline)
        for t in times:
            # Only values measured at exactly this time; no interpolation. A
            # channel without a sample at this time (another device's sample
            # time, outside its run, or a missing measurement) is left blank.
            # run_time_s counts from the run's first sample on any channel, so
            # every run starts at 0 and all exports of a run agree.
            writer.writerow([run, t, round(t - times[0], 6), *(channels.get(key, {}).get(t) for key in ids)])
    return output.getvalue()
