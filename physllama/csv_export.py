"""Wide, per-run CSV alignment. Raw samples in Lab are never modified."""
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
    writer.writerow(['run', 'time_s', *(channel_heading(s) for s in series)])
    runs = {}
    for point in points:
        if point['series'] in selected:
            value = point['value']
            value = value if value is not None and math.isfinite(value) else None
            runs.setdefault(point['run'], {}).setdefault(point['series'], {})[point['t']] = value

    for run, channels in sorted(runs.items()):
        samples = {key: sorted(values.items()) for key, values in channels.items()}
        times = sorted({t for values in samples.values() for t, _ in values})
        bounds = []
        for values in samples.values():
            valid = [t for t, value in values if value is not None]
            if valid:
                bounds.append((valid[0], valid[-1]))
        if bounds:
            start, end = max(a for a, _ in bounds), min(b for _, b in bounds)
            if start <= end:
                times = [t for t in times if start <= t <= end]
        # If channels never overlap, retain their samples with blanks. Likewise
        # keep columns for channels absent from this run; never fabricate data.
        cursors = {key: 0 for key in samples}
        for t in times:
            row = [run, t]
            for key in ids:
                values = samples.get(key, [])
                if not values:
                    row.append(None)
                    continue
                i = cursors[key]
                while i + 1 < len(values) and values[i + 1][0] <= t:
                    i += 1
                cursors[key] = i
                before, value = values[i]
                if before == t:
                    row.append(value)
                elif before < t and i + 1 < len(values):
                    after, following = values[i + 1]
                    # A missing sample is a real gap, not permission to bridge it.
                    interpolated = None if value is None or following is None else (
                        value * (1 - (t - before) / (after - before))
                        + following * ((t - before) / (after - before)))
                    row.append(interpolated)
                else:
                    row.append(None)  # Never extrapolate beyond measured endpoints.
            writer.writerow(row)
    return output.getvalue()
