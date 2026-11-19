import copy
import csv
import io
import math

import pytest

from physllama.acquisition import Lab


def experiment(channels):
    lab = Lab()
    for key, runs in channels.items():
        lab.series[key] = dict(id=key, device='Bench', hardware_name='Smart Cart',
                               device_id=key.split('/')[0], name='Position', unit='m',
                               serial='123-456', demo=False)
        for run, samples in runs.items():
            for t, value in samples:
                lab.points.append(dict(run=run, series=key, t=t, value=value))
    return lab


def rows(lab, selected=None):
    parsed = list(csv.reader(io.StringIO(lab.export_csv(selected))))
    return parsed[0], [[None if v == '' else float(v) for v in row] for row in parsed[1:]]


def test_mixed_rates_interpolate_at_union_of_actual_times_within_common_interval():
    lab = experiment({'a/1': {1: [(0, 0), (1, 10), (2, 20), (3, 30)]},
                      'b/1': {1: [(.5, 101), (2.5, 105)]}})
    before = copy.deepcopy(lab.points)
    header, data = rows(lab)
    assert header[:2] == ['run', 'time_s']
    assert len(header) == 4
    assert 'a/1' in header[2] and 'b/1' in header[3]
    assert '123-456' in header[2] and 'Position [m]' in header[2]
    assert data == [[1, .5, 5, 101], [1, 1, 10, 102], [1, 2, 20, 104], [1, 2.5, 25, 105]]
    assert lab.points == before
    # A graph with one channel gets that channel's full original time sequence.
    header, data = rows(lab, ['a/1'])
    assert len(header) == 3
    assert data == [[1, t, 10*t] for t in range(4)]


def test_runs_never_interpolate_across_pauses_or_invent_absent_channels():
    lab = experiment({'a/1': {1: [(0, 1), (1, 3)], 2: [(10, 8), (11, 10)]},
                      'b/1': {1: [(0, 2), (.5, 4), (1, 6)]}})
    _, data = rows(lab)
    assert data == [[1, 0, 1, 2], [1, .5, 2, 4], [1, 1, 3, 6],
                    [2, 10, 8, None], [2, 11, 10, None]]


def test_missing_samples_are_not_bridged_and_initial_missing_derivative_is_trimmed():
    lab = experiment({'a/1': {1: [(0, None), (1, 3), (2, None), (3, 7)]},
                      'b/1': {1: [(0, 0), (1, 1), (1.5, 1.5), (2, 2), (2.5, 2.5), (3, 3)]}})
    _, data = rows(lab)
    assert data == [[1, 1, 3, 1], [1, 1.5, None, 1.5], [1, 2, None, 2],
                    [1, 2.5, None, 2.5], [1, 3, 7, 3]]


@pytest.mark.parametrize('value', [None, math.nan, math.inf])
def test_all_missing_channel_and_nonoverlap_retain_available_data(value):
    lab = experiment({'a/1': {1: [(0, value)]}, 'b/1': {1: [(2, 6), (3, 7)]}})
    _, data = rows(lab)
    assert data == [[1, 2, None, 6], [1, 3, None, 7]]
    lab.points[0]['value'] = 1
    _, data = rows(lab)
    assert data == [[1, 0, 1, None], [1, 2, None, 6], [1, 3, None, 7]]


def test_headers_are_unique_and_spreadsheet_safe_and_escaped():
    lab = experiment({'a/1': {1: [(0, 2)]}, 'b/1': {1: [(0, 3)]}})
    for series in lab.series.values():
        series['device'] = '=SUM(1,2)'
        series['name'] = 'Force, "raw"'
    header, data = rows(lab)
    assert len(header) == len(set(header)) == 4
    assert all(h.startswith("'=SUM(1,2)") and 'Force, "raw"' in h for h in header[2:])
    assert data == [[1, 0, 2, 3]]
