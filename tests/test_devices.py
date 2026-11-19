"""Prove a second family needs no changes to HTTP, acquisition or graph code."""
import csv
import io
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from physllama.acquisition import Lab
from physllama.devices.base import Reading
from physllama.devices.godirect import GoDirectDriver, GoDirectDevice
from physllama.hardware import DeviceRegistry
from physllama.server import create_app


class TestInput:
    __test__ = False
    demo = False
    battery = None
    charging = False
    connected = False

    def __init__(self, address, family, driver):
        self.id, self.name, self.rssi = address, f'{family} sensor', -40
        self.family, self.driver = family, driver
        # Deliberately use a channel outside the Go Direct bitmask range.
        self.sensors = [dict(number=101, name='Position', unit='m', minimum_ms=20,
                             maximum_ms=1000, step_ms=10, excluded_channels=[], supported=True)]

    def open(self, progress=None):
        self.connected = True

    def start(self, numbers, period):
        self.numbers = numbers

    def read(self):
        return {101: [Reading(1.25, time.monotonic())]}

    def stop(self):
        pass

    def close(self):
        self.connected = False

    def refresh_battery(self):
        pass


class TestDriver:
    __test__ = False

    def __init__(self, identifier, label):
        self.id, self.label = identifier, label

    def matches(self, device, advertisement):
        return (advertisement.local_name or device.name or '').startswith(self.label)

    def create(self, device, advertisement):
        return TestInput(device.address, self.label, self.id)


def advertisement(address, name):
    return (SimpleNamespace(address=address, name=name),
            SimpleNamespace(local_name=name, rssi=-40))


def test_one_scan_dispatches_known_families_ignores_unknown_and_preserves_connections(monkeypatch):
    scanner = AsyncMock(return_value={
        'a': advertisement('a', 'GDX-FOR'),
        'b': advertisement('b', 'Other sensor'),
        'c': advertisement('c', 'Headphones'),
        'd': advertisement('d', None),
    })
    monkeypatch.setattr('physllama.hardware.BleakScanner.discover', scanner)
    lab = Lab(DeviceRegistry((GoDirectDriver(), TestDriver('other', 'Other'))))
    with TestClient(create_app(lab)) as client:
        scanned = client.post('/api/scan')
        assert scanned.status_code == 200
        assert [(d['id'], d['family']) for d in scanned.json()['devices']] == [('a', 'Go Direct'), ('b', 'Other')]
        assert isinstance(lab.devices['a'], GoDirectDevice)
        assert lab.devices['a'].discovered_device is scanner.return_value['a'][0]
        assert scanner.await_count == 1
        assert client.post('/api/connect', json={'device_id': 'b'}).status_code == 200
        connected = lab.devices['b']
        scanner.return_value = {'b': advertisement('b', 'Other sensor')}
        rescanned = client.post('/api/scan').json()
        assert len(rescanned['devices']) == 1
        assert lab.devices['b'] is connected
        assert connected.connected


def test_two_independent_families_share_acquisition_and_export(monkeypatch):
    monkeypatch.setattr('physllama.hardware.BleakScanner.discover', AsyncMock(return_value={
        'a': advertisement('a', 'Alpha sensor'), 'b': advertisement('b', 'Beta sensor')}))
    lab = Lab(DeviceRegistry((TestDriver('alpha', 'Alpha'), TestDriver('beta', 'Beta'))))
    with TestClient(create_app(lab)) as client:
        assert client.post('/api/scan').status_code == 200
        for address in ('a', 'b'):
            assert client.post('/api/connect', json={'device_id': address}).status_code == 200
        assert client.post('/api/start', json={'selections': {'a': [101], 'b': [101]}, 'period_ms': 50}).status_code == 200
        time.sleep(.03)
        stopped = client.post('/api/stop').json()
        assert not stopped['recording']
        assert {s['device_id'] for s in stopped['series']} == {'a', 'b'}
        rows = list(csv.DictReader(io.StringIO(client.get('/api/export').text)))
        assert {r['device_id'] for r in rows} == {'a', 'b'}
        assert {r['unit'] for r in rows} == {'m'}
        assert {r['source'] for r in rows} == {'sensor'}
        # Variable polling times are preserved, rather than invented 50 ms intervals.
        times = [float(r['time_s']) for r in rows if r['device_id'] == 'a']
        assert len(times) > 1
        assert 0 < times[1] - times[0] < .05


def test_timestamped_samples_keep_irregular_spacing_and_reject_stale_times():
    lab = Lab(DeviceRegistry(()))
    device = TestInput('polled', 'Polled', 'polled')
    lab.devices[device.id] = device
    lab.connect(device.id)
    lab.start()
    start = lab.epoch + lab.offsets[device.id]
    device.read = lambda: {101: [Reading(2, start + .012), Reading(3, start + .089)]}
    lab.tick()
    assert lab.points[1]['t'] - lab.points[0]['t'] == pytest.approx(.077, abs=1e-6)
    prior = list(lab.points)
    device.read = lambda: {101: [Reading(4, start + .01)]}
    with pytest.raises(RuntimeError, match='invalid sample timing'):
        lab.tick()
    lab.stop()
    assert lab.points == prior


def test_duplicate_and_ambiguous_drivers_are_rejected():
    with pytest.raises(ValueError, match='unique'):
        DeviceRegistry((TestDriver('same', 'A'), TestDriver('same', 'B')))
    registry = DeviceRegistry((TestDriver('one', 'A'), TestDriver('two', 'A')))
    with pytest.raises(ValueError, match='Ambiguous'):
        registry.identify(*advertisement('address', 'A sensor'))
