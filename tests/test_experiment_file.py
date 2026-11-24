import copy
import json
import time

import pytest
from fastapi.testclient import TestClient

from physllama.acquisition import Lab
from physllama.devices.demo import DemoDevice
from physllama.server import create_app


@pytest.fixture
def client():
    with TestClient(create_app(lab=Lab())) as client:
        yield client


def record_demo(client):
    client.post('/api/demo')
    client.post('/api/experiment', json={'name': 'Spring lab'})
    client.post('/api/start', json={'selections': {'demo-1': [1, 2]}, 'periods': {'demo-1': 20}})
    time.sleep(.15)
    return client.post('/api/stop').json()


def test_save_and_load_restore_data_devices_and_settings(client):
    stopped = record_demo(client)
    saved = client.get('/api/experiment/file').json()
    assert saved['format'] == 'physllama-experiment' and saved['version'] == 1
    assert saved['experiment_name'] == 'Spring lab'
    assert [(d['id'], d['selected'], d['period_ms']) for d in saved['devices']] == [('demo-1', [1, 2], 20)]
    assert len(saved['points']['t']) == stopped['total_points']

    client.post('/api/disconnect', json={'device_id': 'demo-1'})
    client.post('/api/reset')
    loaded = client.post('/api/experiment/file', json=saved)
    assert loaded.status_code == 200
    state = client.get('/api/state', params={'generation': ''}).json()
    assert state['experiment_name'] == 'Spring lab'
    assert state['total_points'] == stopped['total_points']
    assert {s['id'] for s in state['series']} == {'demo-1/1', 'demo-1/2'}
    device = next(d for d in state['devices'] if d['id'] == 'demo-1')
    assert device['connected'] and device['selected'] == [1, 2] and device['period_ms'] == 20
    assert state['saved_devices'] == []
    original = [(p['series'], p['t'], p['value'], p['run']) for p in client.get('/api/state').json()['points']]
    assert len(original) == stopped['total_points']

    # A new run continues the timeline after the loaded data, as run 2.
    client.post('/api/start', json={'selections': {'demo-1': [1, 2]}})
    time.sleep(.06)
    resumed = client.post('/api/stop').json()
    assert resumed['run'] == 2
    points = client.get('/api/state').json()['points']
    first_new = min(p['t'] for p in points if p['run'] == 2)
    assert first_new >= max(p['t'] for p in points if p['run'] == 1)


def test_real_devices_wait_for_reconnection_with_their_saved_settings():
    lab = Lab()
    saved = {'format': 'physllama-experiment', 'version': 1, 'experiment_name': 'Cart',
             'devices': [{'id': 'AA:BB', 'name': 'Red cart', 'nickname': 'Red cart', 'hardware_name': 'GDX-FOR 1',
                          'serial': None, 'family': 'Go Direct', 'driver': 'go-direct', 'demo': False,
                          'sensors': [{'number': 1, 'name': 'Force', 'unit': 'N', 'minimum_ms': 10, 'maximum_ms': 1000,
                                       'step_ms': 0, 'excluded_channels': [], 'supported': True}],
                          'selected': [1], 'period_ms': 40}],
             'series': [{'id': 'AA:BB/1', 'device_id': 'AA:BB', 'device': 'Red cart', 'hardware_name': 'GDX-FOR 1',
                         'serial': None, 'name': 'Force', 'unit': 'N', 'demo': False}],
             'points': {'series': [0, 0], 't': [0, .04], 'value': [1.5, None], 'run': [1, 1]}}
    state = lab.load_experiment(copy.deepcopy(saved))
    assert [d['id'] for d in state['saved_devices']] == ['AA:BB']
    assert state['saved_devices'][0]['sensors'][0]['name'] == 'Force'
    assert lab.names['AA:BB'] == 'Red cart'
    assert [p['value'] for p in lab.points] == [1.5, None]

    class Hardware(DemoDevice):
        demo = False

    hardware = Hardware()
    hardware.id = 'AA:BB'
    lab.devices[hardware.id] = hardware
    lab.connect('AA:BB')
    assert lab.selected['AA:BB'] == [1] and lab.periods['AA:BB'] == 40
    assert lab.saved_devices == {}
    assert lab.save_experiment()['devices'][0]['period_ms'] == 40


@pytest.mark.parametrize('change, message', [
    (lambda d: d.update(format='other'), 'not a PhysLlama experiment'),
    (lambda d: d.update(version=99), 'Unsupported experiment file version'),
    (lambda d: d['points'].update(t=[0]), 'Invalid samples'),
    (lambda d: d['points'].update(t=[0, float('nan')]), 'Invalid sample time'),
    (lambda d: d['points'].update(series=[0, 5]), 'Invalid sample series'),
    (lambda d: d['points'].update(t=[1, 0]), 'out of order'),
    (lambda d: d['series'][0].update(demo=False), 'mixes demo and real'),
    (lambda d: d['devices'][0].update(nickname=5), 'Invalid device nickname'),
    (lambda d: d['devices'][0].update(period_ms=1), 'Invalid sampling interval'),
])
def test_invalid_files_are_rejected_without_changing_the_session(client, change, message):
    record_demo(client)
    saved = client.get('/api/experiment/file').json()
    saved['points'] = {'series': [0, 0], 't': [0, .02], 'value': [1, 2], 'run': [1, 1]}
    before = client.get('/api/state').json()
    change(saved)
    # Raw JSON text, as a hand-edited file could contain NaN.
    response = client.post('/api/experiment/file', content=json.dumps(saved), headers={'Content-Type': 'application/json'})
    assert response.status_code == 400 and message in response.json()['detail']
    after = client.get('/api/state').json()
    assert after['generation'] == before['generation'] and after['total_points'] == before['total_points']


def test_save_and_load_require_collection_to_be_stopped(client):
    client.post('/api/demo')
    client.post('/api/start', json={'selections': {'demo-1': [1]}})
    assert client.get('/api/experiment/file').status_code == 400
    assert client.post('/api/experiment/file', json={'format': 'physllama-experiment'}).status_code == 400
