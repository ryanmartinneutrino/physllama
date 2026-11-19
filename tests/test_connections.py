import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from physllama.acquisition import Lab
from physllama.devices.godirect import CompatibleBLEDevice, GoDirectDevice
from physllama.server import create_app


@pytest.fixture
def loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()
    asyncio.set_event_loop(None)


class FakeClient:
    def __init__(self, target):
        self.target = target
        self.is_connected = False
        self.disconnected = False

    async def connect(self):
        self.is_connected = True

    async def start_notify(self, *args):
        pass

    async def disconnect(self):
        self.is_connected = False
        self.disconnected = True


def test_uses_scanned_device_and_cleans_partial_notification_failure(loop, monkeypatch):
    scanned = object()
    clients = []

    class Client(FakeClient):
        def __init__(self, target):
            super().__init__(target)
            clients.append(self)

        async def start_notify(self, *args):
            raise PermissionError('Bluetooth access denied')

    monkeypatch.setattr('physllama.devices.godirect.BleakClient', Client)
    device = GoDirectDevice('id', 'GDX sensor', -40, scanned)
    with pytest.raises(RuntimeError, match='Privacy & Security'):
        device.open()
    assert len(clients) == 1  # Permission errors need user action, not retries.
    assert clients[0].target is scanned
    assert clients[0].disconnected
    assert not device.connected


@pytest.mark.parametrize('succeeds', [True, False])
def test_retry_uses_fresh_clients_and_releases_failed_connections(loop, monkeypatch, succeeds):
    monkeypatch.setattr(GoDirectDevice, 'RETRY_DELAY', 0)
    device = GoDirectDevice('id', 'GDX sensor', -40)
    clients, statuses = [], []

    def attempt():
        client = FakeClient('id')
        client.is_connected = True
        clients.append(client)
        device.raw._device = client
        assert not device.connected  # An incomplete handshake is not ready.
        if not succeeds or len(clients) == 1:
            device.raw._responses.put(b'old response')
            raise TimeoutError('Handshake timed out')
        assert device.raw._responses.empty()

    monkeypatch.setattr(device, '_open_once', attempt)
    if succeeds:
        device.open(progress=lambda **status: statuses.append(status))
        assert device.connected
        assert len(clients) == 2
        assert device.raw.connection_deadline is None
        assert clients[0].disconnected
        assert not clients[1].disconnected
        device.close()
    else:
        with pytest.raises(RuntimeError, match='after 3 attempt'):
            device.open(progress=lambda **status: statuses.append(status))
        assert len(clients) == 3
        assert not device.connected
    assert all(c.disconnected for c in clients)
    assert any(s['status'] == 'retrying' for s in statuses)


def test_cleanup_failure_stops_retrying_without_losing_client(loop, monkeypatch):
    device = GoDirectDevice('id', 'GDX sensor', -40)
    client = FakeClient('id')

    async def fail_disconnect():
        raise RuntimeError('Adapter stuck')

    client.disconnect = fail_disconnect

    def fail_open():
        device.raw._device = client
        raise TimeoutError()

    monkeypatch.setattr(device, '_open_once', fail_open)
    with pytest.raises(RuntimeError, match='release the previous Bluetooth connection'):
        device.open()
    assert device.raw._device is client
    assert not device.connected


def test_transport_has_elapsed_time_read_and_handshake_deadlines(loop, monkeypatch):
    raw = CompatibleBLEDevice(None)
    start = time.monotonic()
    assert raw._read(40) == bytearray()
    assert time.monotonic() - start >= .035
    raw.connection_deadline = time.monotonic() + .01
    with pytest.raises(TimeoutError):
        raw._read(1000)

    class HungClient(FakeClient):
        async def connect(self):
            await asyncio.sleep(60)

    monkeypatch.setattr('physllama.devices.godirect.BleakClient', HungClient)
    raw.id = 'id'
    raw.connection_deadline = time.monotonic() + .02
    with pytest.raises(asyncio.TimeoutError):
        raw._connect()


def test_progress_endpoint_responds_during_connect_and_data_survives_failure():
    lab = Lab()
    started, release = threading.Event(), threading.Event()

    def open_device(progress):
        progress(status='retrying', attempt=1, max_attempts=3, message='Retrying connection')
        started.set()
        assert release.wait(3)
        raise RuntimeError('Connection failed')

    device = SimpleNamespace(driver='test', family='Test', id='real', name='GDX sensor', connected=False, demo=False,
                             open=open_device, close=lambda: None, sensors=[],
                             rssi=-40, battery=None, charging=False)
    lab.devices['real'] = device
    lab.points = [{'t': 0, 'retained': True}]
    with TestClient(create_app(lab)) as client, ThreadPoolExecutor() as executor:
        future = executor.submit(client.post, '/api/connect', json={'device_id': 'real'})
        try:
            assert started.wait(2)
            response = client.get('/api/connection-status')
            assert response.status_code == 200
            assert response.json()['status'] == 'retrying'
            assert response.json()['device_id'] == 'real'
        finally:
            release.set()
        assert future.result().status_code == 503
        assert client.get('/api/connection-status').json()['status'] == 'failed'
        assert lab.points == [{'t': 0, 'retained': True}]
        assert not lab.recording


def test_go_direct_metadata_normalizes_vendor_channel_masks(loop):
    device = GoDirectDevice('id', 'GDX sensor', -40)
    sensors = {n: SimpleNamespace(sensor_number=n, sensor_description=f'Channel {n}',
               sensor_units='N' if n == 1 else '', min_measurement_period=10,
               max_measurement_period=1000, measurement_period_granularity=10,
               mutual_exclusion_mask=(1 << 17) if n == 1 else 0,
               sampling_mode=0 if n == 1 else 1) for n in (1, 17)}
    device.raw.open = lambda: True
    device.raw.list_sensors = lambda: sensors
    device.refresh_battery = lambda: None
    device._open_once()
    first, second = device.sensors
    assert first['excluded_channels'] == [17]
    assert first['unit'] == 'N' and first['supported']
    assert second['excluded_channels'] == []
    assert second['unit'] == 'a.u.' and not second['supported']
    assert first['minimum_ms'] == 10 and first['maximum_ms'] == 1000 and first['step_ms'] == 10


def test_corebluetooth_group_worker_resolves_same_uuid_when_scan_loop_differs(loop, monkeypatch):
    import physllama.devices.godirect as adapter
    monkeypatch.setattr(adapter, 'sys', SimpleNamespace(platform='darwin'))
    targets = []
    class Client(FakeClient):
        def __init__(self, target):
            super().__init__(target)
            targets.append(target)
    monkeypatch.setattr(adapter, 'BleakClient', Client)
    raw = CompatibleBLEDevice(None)
    raw.id = 'selected-mac-uuid'
    scanned = SimpleNamespace(details=(object(), SimpleNamespace(event_loop=object())))
    raw.discovered_device = scanned
    assert raw._connect()
    assert targets == ['selected-mac-uuid']
    loop.run_until_complete(raw._device.disconnect())
    scanned.details[1].event_loop = loop
    assert raw._connect()
    assert targets[-1] is scanned
    loop.run_until_complete(raw._device.disconnect())
