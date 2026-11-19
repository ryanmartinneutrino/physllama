import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from physllama.acquisition import Lab
from physllama.devices.pasco import PascoDevice
from physllama.names import DeviceNames
from physllama.server import create_app
from types import SimpleNamespace


def test_nickname_survives_rescan_reset_and_restart_without_changing_hardware_identity(tmp_path, monkeypatch):
    store = DeviceNames(tmp_path / 'device-names.json')
    lab = Lab(name_store=store)
    ble = SimpleNamespace(address='immutable-uuid', name='Smart Cart 123-456>5')
    adv = SimpleNamespace(local_name=ble.name, rssi=-40)
    monkeypatch.setattr(lab.registry, 'scan', lambda loop: [PascoDevice(ble, adv)])
    with TestClient(create_app(lab)) as client:
        client.post('/api/scan')
        result = client.post('/api/rename', json={'device_id': ble.address, 'name': '  Red cart  '})
        assert result.status_code == 200
        renamed = result.json()['devices'][0]
        assert renamed['name'] == 'Red cart'
        assert renamed['id'] == ble.address
        assert renamed['hardware_name'] == ble.name
        assert renamed['serial'] == '123-456'
        assert lab.devices[ble.address].name == ble.name
        for action in ('reset', 'scan'):
            assert client.post('/api/' + action).json()['devices'][0]['name'] == 'Red cart'
    reloaded = Lab(name_store=DeviceNames(store.path))
    reloaded.devices[ble.address] = PascoDevice(ble, adv)
    assert reloaded.snapshot()['devices'][0]['name'] == 'Red cart'
    restored = reloaded.rename(ble.address, '')['devices'][0]
    assert restored['name'] == ble.name
    assert restored['serial'] == '123-456'
    assert json.loads(store.path.read_text()) == {}


def test_rename_updates_graph_metadata_and_csv_but_keeps_series_ids():
    with TestClient(create_app()) as client:
        client.post('/api/demo')
        client.post('/api/start')
        assert client.post('/api/rename', json={'device_id': 'demo-1', 'name': 'Busy'}).status_code == 400
        client.post('/api/stop')
        before = client.get('/api/state').json()
        assert before['total_points'] > 0
        response = client.post('/api/rename', json={'device_id': 'demo-1', 'name': 'Bench 4'})
        after = response.json()
        assert [s['id'] for s in after['series']] == [s['id'] for s in before['series']]
        assert after['total_points'] == before['total_points']
        assert all(s['device'] == 'Bench 4' for s in after['series'])
        rows = list(csv.DictReader(io.StringIO(client.get('/api/export').text)))
        assert {row['device'] for row in rows} == {'Bench 4'}
        assert {row['device_id'] for row in rows} == {'demo-1'}
        assert {row['device_hardware_name'] for row in rows} == {'Demo Motion & Force 1'}
        assert client.post('/api/rename', json={'device_id': 'unknown', 'name': 'x'}).status_code == 400
        assert client.post('/api/rename', json={'device_id': 'demo-1', 'name': 'x' * 61}).status_code == 422
        assert client.post('/api/rename', json={'device_id': 'demo-1', 'name': 'a\x00b'}).status_code == 400


def test_failed_name_save_does_not_change_live_name(tmp_path, monkeypatch):
    store = DeviceNames(tmp_path / 'names.json')
    lab = Lab(name_store=store)
    lab.add_demo()
    def fail(names):
        raise OSError('Disk unavailable')
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(OSError):
        lab.rename('demo-1', 'New name')
    assert lab.snapshot()['devices'][0]['name'] == 'Demo Motion & Force 1'
