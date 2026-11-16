import asyncio
import csv
import io
import struct
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from vernier_lab.acquisition import Lab
from vernier_lab.hardware import CompatibleBLEDevice
from vernier_lab.server import create_app


@pytest.fixture
def client():
    with TestClient(create_app()) as client:
        yield client


def setup_demo(client, count=1, period=10):
    for _ in range(count):
        assert client.post('/api/demo').status_code == 200
    selections = {f'demo-{i}': [1, 2, 3, 4] for i in range(1, count + 1)}
    assert client.post('/api/configure', json={'selections': selections, 'period_ms': period}).status_code == 200


def test_multi_device_collection_resume_export_and_reset(client):
    setup_demo(client, count=2)
    assert client.post('/api/start').status_code == 200
    time.sleep(.08)
    first = client.post('/api/stop').json()
    assert first['total_points'] >= 32
    assert len(first['series']) == 8
    fetched = client.get('/api/state').json()
    assert len(fetched['points']) == first['total_points']
    assert {p['series'] for p in fetched['points']} == {s['id'] for s in first['series']}
    points = [p for p in fetched['points'] if p['series'] == 'demo-1/1']
    assert points[1]['t'] - points[0]['t'] == pytest.approx(.01, abs=1e-6)
    assert client.get('/api/state', params={'after': fetched['cursor'], 'generation': fetched['generation']}).json()['points'] == []
    time.sleep(.02)
    assert client.post('/api/start').status_code == 200
    time.sleep(.04)
    second = client.post('/api/stop').json()
    assert second['run'] == 2
    rows = list(csv.DictReader(io.StringIO(client.get('/api/export?series=demo-1/1').text)))
    assert {r['sensor'] for r in rows} == {'Force'}
    assert {r['unit'] for r in rows} == {'N'}
    assert {r['source'] for r in rows} == {'demo'}
    assert {r['run'] for r in rows} == {'1', '2'}
    assert float(next(r['time_s'] for r in rows if r['run'] == '2')) > float(rows[len(points)-1]['time_s'])
    reset = client.post('/api/reset').json()
    assert reset['generation'] != fetched['generation']
    assert reset['total_points'] == 0
    assert all(d['connected'] for d in reset['devices'])
    assert client.get('/api/export').status_code == 400


def test_validation_and_locked_settings(client):
    assert client.post('/api/start').status_code == 400
    setup_demo(client)
    for period in (0, 10001):
        assert client.post('/api/configure', json={'selections': {'demo-1': [1]}, 'period_ms': period}).status_code == 422
    for selection in ([99], [1, 1]):
        assert client.post('/api/configure', json={'selections': {'demo-1': selection}, 'period_ms': 50}).status_code == 400
    assert client.post('/api/start').status_code == 200
    for path, body in [('reset', {}), ('demo', {}), ('scan', {}), ('disconnect', {'device_id': 'demo-1'}),
                       ('configure', {'selections': {'demo-1': [1]}, 'period_ms': 50})]:
        assert client.post('/api/' + path, json=body).status_code == 400
    assert client.post('/api/stop').status_code == 200
    assert client.post('/api/disconnect', json={'device_id': 'demo-1'}).status_code == 200
    assert client.post('/api/start').status_code == 400


def test_cross_origin_requests_rejected(client):
    assert client.post('/api/demo', headers={'Origin': 'https://unrelated.example'}).status_code == 403
    assert client.get('/api/state', headers={'Host': 'unrelated.example'}).status_code == 400
    assert client.post('/api/demo', headers={'Origin': 'http://testserver'}).status_code == 200


def configured_lab(count=1):
    lab = Lab()
    for _ in range(count):
        lab.add_demo()
    return lab


def test_sensor_ranges_granularity_and_conflicts():
    lab = configured_lab()
    sensor = lab.devices['demo-1'].sensors[0]
    sensor['minimum_ms'] = 20
    sensor['step_ms'] = 20
    with pytest.raises(ValueError, match='requires'):
        lab.configure({'demo-1': [1]}, 10)
    with pytest.raises(ValueError, match='multiples'):
        lab.configure({'demo-1': [1]}, 25)
    sensor['exclusion_mask'] = 1 << 2
    with pytest.raises(ValueError, match='conflicts'):
        lab.configure({'demo-1': [1, 2]}, 40)
    sensor['supported'] = False
    with pytest.raises(ValueError, match='event-based'):
        lab.configure({'demo-1': [1]}, 40)


def test_start_failure_rolls_back_all_devices():
    lab = configured_lab(2)
    stopped = []
    for key, device in lab.devices.items():
        device.stop = lambda key=key: stopped.append(key)
    def fail(*args):
        raise RuntimeError('rejected')
    lab.devices['demo-2'].start = fail
    with pytest.raises(RuntimeError, match='rejected'):
        lab.start()
    assert set(stopped) == {'demo-1', 'demo-2'}
    assert not lab.recording
    assert not lab.points and not lab.series and lab.epoch is None


def test_disconnect_preserves_values_and_memory_limit(monkeypatch):
    lab = configured_lab()
    lab.start()
    lab.tick()
    assert lab.points
    prior = list(lab.points)
    lab.devices['demo-1'].connected = False
    with pytest.raises(RuntimeError, match='disconnected'):
        lab.tick()
    lab.stop()
    assert lab.points == prior
    lab.devices['demo-1'].connected = True
    monkeypatch.setattr('vernier_lab.acquisition.MAX_POINTS', len(lab.points))
    with pytest.raises(ValueError, match='full'):
        lab.start()


def test_demo_and_real_cannot_mix_even_across_runs():
    lab = configured_lab(2)
    lab.devices['demo-2'].demo = False
    with pytest.raises(ValueError, match='separate'):
        lab.start()
    lab.configure({'demo-1': [1]}, 50)
    lab.start(); lab.tick(); lab.stop()
    lab.configure({'demo-2': [1]}, 50)
    with pytest.raises(ValueError, match='separate'):
        lab.start()


def test_scan_error_is_actionable(client, monkeypatch):
    def fail(loop):
        raise RuntimeError('No Bluetooth adapters found')
    monkeypatch.setattr('vernier_lab.acquisition.scan_devices', fail)
    response = client.post('/api/scan')
    assert response.status_code == 400
    assert 'Enable Bluetooth' in response.json()['detail']


def test_sdk_packet_compatibility():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        device = CompatibleBLEDevice(None)
        device._sensors = {i: SimpleNamespace(values=[]) for i in (1, 17)}
        packet = bytearray([0x20, 19, 0, 0, device.MEASUREMENT_TYPE_WIDE_REAL32])
        packet.extend(struct.pack('<IBBff', (1 << 1) | (1 << 17), 1, 0, 2.5, 8.25))
        device._notify_callback(None, packet[:1])
        device._notify_callback(None, packet[1:8])
        device._notify_callback(None, packet[8:] + packet)
        assert device._responses.qsize() == 2
        device._GDX_handle_measurement(device._responses.get())
        assert device._sensors[1].values == [2.5]
        assert device._sensors[17].values == [8.25]
        single = bytearray([0x20, 12, 0, 0, device.MEASUREMENT_TYPE_SINGLE_CHANNEL_REAL32, 0, 17, 1])
        single.extend(struct.pack('<f', 9.0))
        device._GDX_handle_measurement(single)
        assert device._sensors[1].values == [2.5]
        assert device._sensors[17].values == [8.25, 9.0]
        device._read = lambda timeout: bytearray([0x20, 5, 0, 0, device.MEASUREMENT_TYPE_DROPPED])
        with pytest.raises(RuntimeError, match='dropped'):
            device._GDX_read_measurement(20)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


def test_desktop_quit_stops_acquisition_and_requests_graceful_shutdown():
    shutdown = []
    with TestClient(create_app(on_shutdown=lambda: shutdown.append(True))) as client:
        assert client.get('/api/app').json() == {'name': 'Vernier Lab', 'desktop': True}
        setup_demo(client)
        assert client.post('/api/start').status_code == 200
        assert client.post('/api/quit').json() == {'quitting': True}
        assert shutdown == [True]
        assert not client.get('/api/state').json()['recording']


def test_terminal_server_cannot_be_quit_from_the_browser(client):
    assert client.get('/api/app').json()['desktop'] is False
    assert client.post('/api/quit').status_code == 400


def test_start_accepts_the_exact_graph_selection_and_rejects_empty_selection(client):
    setup_demo(client, count=2)
    chosen = {'selections': {'demo-1': [2], 'demo-2': [1, 4]}, 'period_ms': 20}
    started = client.post('/api/start', json=chosen)
    assert started.status_code == 200
    assert {s['id'] for s in started.json()['series']} == {'demo-1/2', 'demo-2/1', 'demo-2/4'}
    assert started.json()['period_ms'] == 20
    assert client.post('/api/start', json=chosen).status_code == 400
    client.post('/api/stop')
    assert client.post('/api/start', json={'selections': {}, 'period_ms': 20}).status_code == 400
    changed = client.post('/api/start', json={'selections': {'demo-1': [3]}, 'period_ms': 50})
    assert changed.status_code == 200
    selected = {d['id']: d['selected'] for d in changed.json()['devices']}
    assert selected == {'demo-1': [3], 'demo-2': []}
    assert changed.json()['run'] == 2


def test_graph_selection_validation_happens_before_any_device_starts(client):
    setup_demo(client)
    invalid = client.post('/api/start', json={'selections': {'demo-1': [99]}, 'period_ms': 50})
    assert invalid.status_code == 400
    state = client.get('/api/state').json()
    assert not state['recording']
    assert not state['series']
    assert state['run'] == 0
