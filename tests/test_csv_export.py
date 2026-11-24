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
    """Parse an export, check run_time_s on every row, and return rows without it."""
    parsed = list(csv.reader(io.StringIO(lab.export_csv(selected))))
    data = [[None if v == '' else float(v) for v in row] for row in parsed[1:]]
    assert parsed[0][2] == 'run_time_s'
    first = {}
    for run, t, run_time, *_ in data:
        first.setdefault(run, t)
        assert run_time == pytest.approx(t - first[run], abs=1e-9)
    return [*parsed[0][:2], *parsed[0][3:]], [[*row[:2], *row[3:]] for row in data]


def test_mixed_rates_keep_every_timestamp_and_never_interpolate():
    lab = experiment({'a/1': {1: [(0, 0), (1, 10), (2, 20), (3, 30)]},
                      'b/1': {1: [(.5, 101), (2.5, 105)]}})
    before = copy.deepcopy(lab.points)
    header, data = rows(lab)
    assert header[:2] == ['run', 'time_s']
    assert len(header) == 4
    assert 'a/1' in header[2] and 'b/1' in header[3]
    assert '123-456' in header[2] and 'Position [m]' in header[2]
    assert data == [[1, 0, 0, None], [1, .5, None, 101], [1, 1, 10, None], [1, 2, 20, None], [1, 2.5, None, 105], [1, 3, 30, None]]
    assert lab.points == before
    # A graph export changes only the columns, keeping the same experiment times.
    header, data = rows(lab, ['a/1'])
    assert len(header) == 3
    assert data == [[1, 0, 0], [1, .5, None], [1, 1, 10], [1, 2, 20], [1, 2.5, None], [1, 3, 30]]


def test_runs_never_interpolate_across_pauses_or_invent_absent_channels():
    lab = experiment({'a/1': {1: [(0, 1), (1, 3)], 2: [(10, 8), (11, 10)]},
                      'b/1': {1: [(0, 2), (.5, 4), (1, 6)]}})
    _, data = rows(lab)
    assert data == [[1, 0, 1, 2], [1, .5, None, 4], [1, 1, 3, 6],
                    [2, 10, 8, None], [2, 11, 10, None]]


def test_missing_samples_are_not_bridged_and_initial_missing_derivative_keeps_its_row():
    lab = experiment({'a/1': {1: [(0, None), (1, 3), (2, None), (3, 7)]},
                      'b/1': {1: [(0, 0), (1, 1), (1.5, 1.5), (2, 2), (2.5, 2.5), (3, 3)]}})
    _, data = rows(lab)
    assert data == [[1, 0, None, 0], [1, 1, 3, 1], [1, 1.5, None, 1.5], [1, 2, None, 2],
                    [1, 2.5, None, 2.5], [1, 3, 7, 3]]


@pytest.mark.parametrize('value', [None, math.nan, math.inf])
def test_all_missing_channel_and_nonoverlap_retain_available_data(value):
    lab = experiment({'a/1': {1: [(0, value)]}, 'b/1': {1: [(2, 6), (3, 7)]}})
    _, data = rows(lab)
    assert data == [[1, 0, None, None], [1, 2, None, 6], [1, 3, None, 7]]
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


def test_graph_export_keeps_rows_from_runs_with_only_other_channels():
    lab = experiment({'a/1': {1: [(0, 2)]}, 'b/1': {2: [(10, 3), (11, 4)]}})
    header, data = rows(lab, ['a/1'])
    assert len(header) == 3
    assert data == [[1, 0, 2], [2, 10, None], [2, 11, None]]


def test_channels_sharing_timestamps_fill_the_same_rows():
    lab = experiment({'a/1': {1: [(0, 1), (.1, 2)]}, 'a/2': {1: [(0, 5), (.1, 6)]},
                      'b/1': {1: [(.05, 9)]}})
    _, data = rows(lab)
    assert data == [[1, 0, 1, 5, None], [1, .05, None, None, 9], [1, .1, 2, 6, None]]


def test_run_time_restarts_at_zero_each_run_and_ignores_column_filtering():
    lab = experiment({'a/1': {1: [(.5, 1), (.6, 2)], 2: [(10.25, 3), (10.35, 4)]},
                      'b/1': {1: [(.45, 9)], 2: [(10.3, 8)]}})
    parsed = list(csv.reader(io.StringIO(lab.export_csv())))
    assert parsed[0][:3] == ['run', 'time_s', 'run_time_s']
    assert [(r[0], r[1], r[2]) for r in parsed[1:]] == [
        ('1', '0.45', '0.0'), ('1', '0.5', '0.05'), ('1', '0.6', '0.15'),
        ('2', '10.25', '0.0'), ('2', '10.3', '0.05'), ('2', '10.35', '0.1')]
    # A graph export of only a/1 keeps the same run-relative times.
    graph = list(csv.reader(io.StringIO(lab.export_csv(['a/1']))))
    assert [r[:3] for r in graph] == [r[:3] for r in parsed]
