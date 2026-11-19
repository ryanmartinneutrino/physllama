import asyncio
import math
import struct
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from physllama.acquisition import Lab
from physllama.devices.pasco import (CompatiblePascoDevice, PascoDevice, PascoDriver,
                                     VELOCITY, SPEED, identity, slope)
from physllama.hardware import DeviceRegistry
from physllama.server import create_app


def scanned(address='cart-a', name='Smart Cart 123-456>5'):
    return SimpleNamespace(address=address, name=name), SimpleNamespace(local_name=name, rssi=-48)


class WireClient:
    """Fake BLE transport; run the actual PASCO 0.3.65 metadata/packet decoder."""
    instances = []
    fail_notify = 0
    reply = 'normal'
    delay = 0

    def __init__(self, target):
        self.target = target
        self.owner = threading.get_ident()
        self.is_connected = False
        self.disconnected = False
        self.callbacks = {}
        self.requests = []
        self.services = [SimpleNamespace(characteristics=[SimpleNamespace(
            uuid=f'4a5c000{service}-0003-0000-0000-5c1e741f1c00',
            handle=service, properties=['notify'])]) for service in range(5)]
        self.instances.append(self)

    async def connect(self):
        assert threading.get_ident() == self.owner
        self.is_connected = True

    async def start_notify(self, uuid, callback):
        if self.fail_notify:
            type(self).fail_notify -= 1
            raise TimeoutError('Notification setup failed')
        self.callbacks[int(uuid[7])] = callback
        if int(uuid[7]) == 0:
            await callback(SimpleNamespace(handle=0), bytes([0x85, 0x24, 0x0f, 75, 0, 1]))

    async def write_gatt_char(self, uuid, command):
        assert threading.get_ident() == self.owner
        service = int(uuid[7])
        self.requests.append((service, bytes(command)))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.reply == 'hang':
            await asyncio.Future()
        payload = {1: struct.pack('<H', 32768), 2: struct.pack('<hhh', 1000, 0, 0),
                   3: struct.pack('<h', 8)}.get(service, b'')
        if self.reply == 'truncated':
            payload = b''
        status = 1 if self.reply == 'rejected' else 0
        await self.callbacks[service](SimpleNamespace(handle=service), bytearray([0xc0, status, command[0]]) + payload)

    async def disconnect(self):
        assert threading.get_ident() == self.owner
        self.disconnected = True
        self.is_connected = False


@pytest.fixture
def wire(monkeypatch):
    WireClient.instances = []
    WireClient.fail_notify = 0
    WireClient.reply = 'normal'
    WireClient.delay = 0
    monkeypatch.setattr('physllama.devices.pasco.BleakClient', WireClient)
    monkeypatch.setattr(PascoDevice, 'RETRY_DELAY', 0)
    return WireClient


def wait_for(function, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = function()
        if value:
            return value
        time.sleep(.005)
    pytest.fail('Timed out waiting for PASCO worker')


def test_discovery_matches_device_model_and_printed_id_without_serial_allowlist():
    driver = PascoDriver()
    assert driver.matches(*scanned())
    assert driver.matches(*scanned('cart-b', 'Smart Cart 987-654>5'))
    assert driver.matches(*scanned('temp', 'Temperature 333-444>1'))
    for name in ('Smart Cart', 'Headphones', 'Smart Cart 123-456>1', '//control.Node 123-456>8'):
        assert not driver.matches(*scanned(name=name))
    device, adv = scanned()
    device.name = 'cached name'
    adapted = driver.create(device, adv)
    assert adapted.discovered_device is device
    assert adapted.serial == '123-456'
    assert adapted.name == 'Smart Cart 123-456>5'
    assert identity('Smart Cart 987-654>5') == ('Smart Cart', '987-654')


def test_two_carts_use_actual_ids_sdk_decoder_battery_and_independent_workers(wire):
    devices = [PascoDevice(*scanned()), PascoDevice(*scanned('cart-b', 'Smart Cart 987-654>5'))]
    try:
        for device in devices:
            device.open()
            metadata = {s['name']: s for s in device.sensors}
            assert metadata['Accelerationx']['unit'] == 'm/s²'
            assert metadata['Force']['unit'] == 'N'
            assert 'AngularVelocityx' not in metadata  # Same exclusion as the tested source app.
            assert metadata['Velocity (derived)']['unit'] == 'm/s'
            numbers = [metadata[n]['number'] for n in ('Position', 'Force', 'Accelerationx')]
            device.start(numbers + [VELOCITY, SPEED], 20)
            readings = wait_for(device.read)
            assert readings[numbers[0]][0].value == 0  # Position zero at Start.
            assert readings[numbers[1]][0].value == 0
            assert readings[numbers[2]][0].value == pytest.approx(4.8)
            assert math.isnan(readings[VELOCITY][0].value)  # No invented initial speed.
            assert readings[numbers[0]][0].timestamp <= time.monotonic()
            later = wait_for(device.read)
            assert later[numbers[0]][-1].value > 0
            assert later[VELOCITY][-1].value > 0
            assert later[SPEED][-1].value == abs(later[VELOCITY][-1].value)
            wait_for(lambda: device.battery == 75)
            assert device.charging
        assert len({client.owner for client in wire.instances}) == 2
        assert all(client.owner != threading.get_ident() for client in wire.instances)
        assert [c.target for c in wire.instances] == [d.discovered_device for d in devices]
        for device in devices:
            device.stop()
            assert device.read() == {}
            device.start([VELOCITY, SPEED], 20)
            first = wait_for(device.read)
            assert math.isnan(first[VELOCITY][0].value)  # Never differentiate across runs.
            device.stop()
    finally:
        for device in devices:
            device.close()
            device.close()  # Idempotent.
    assert all(c.disconnected for c in wire.instances)


def test_partial_connection_retries_use_fresh_clients_and_cleanup(wire):
    wire.fail_notify = 1
    device = PascoDevice(*scanned())
    progress = []
    try:
        device.open(progress=lambda **value: progress.append(value))
        assert device.connected
        assert len(wire.instances) == 2
        assert wire.instances[0].disconnected
        assert any(p['status'] == 'retrying' for p in progress)
    finally:
        device.close()
    assert all(c.disconnected for c in wire.instances)


@pytest.mark.parametrize('reply', ['hang', 'truncated', 'rejected'])
def test_bad_reads_stop_collection_preserve_prior_data_and_require_reconnect(wire, monkeypatch, reply):
    monkeypatch.setattr('physllama.devices.pasco.READ_TIMEOUT', .04)
    lab = Lab(DeviceRegistry((PascoDriver(),)))
    device = PascoDevice(*scanned())
    lab.devices[device.id] = device
    with TestClient(create_app(lab)) as client:
        assert client.post('/api/connect', json={'device_id': device.id}).status_code == 200
        assert client.post('/api/start', json={'selections': {device.id: [3001]}, 'period_ms': 20}).status_code == 200
        wait_for(lambda: client.get('/api/state').json()['total_points'])
        wire.reply = reply
        stopped = wait_for(lambda: (s if not s['recording'] else None) if (s := client.get('/api/state').json()) else None)
        assert stopped['total_points'] > 0
        assert 'PASCO read failed' in stopped['error']
        assert client.post('/api/start').status_code == 503
        assert client.get('/api/state').json()['total_points'] == stopped['total_points']
    assert all(c.disconnected for c in wire.instances)


def test_slow_cart_does_not_block_shared_state_or_other_cart(wire, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = WireClient.write_gatt_char

    async def slow_one(self, uuid, command):
        if self.target.address == 'cart-a':
            entered.set()
            while not release.is_set():
                await asyncio.sleep(.005)
        return await original(self, uuid, command)

    monkeypatch.setattr(WireClient, 'write_gatt_char', slow_one)
    lab = Lab(DeviceRegistry((PascoDriver(),)))
    a, b = PascoDevice(*scanned()), PascoDevice(*scanned('cart-b', 'Smart Cart 987-654>5'))
    lab.devices = {a.id: a, b.id: b}
    try:
        with TestClient(create_app(lab)) as client:
            for device in (a, b):
                assert client.post('/api/connect', json={'device_id': device.id}).status_code == 200
            assert client.post('/api/start', json={'selections': {a.id: [3001], b.id: [3001]}, 'period_ms': 20}).status_code == 200
            assert entered.wait(1)
            state = wait_for(lambda: (s if s['total_points'] else None) if (s := client.get('/api/state').json()) else None)
            assert {p['series'] for p in state['points']} == {'cart-b/3001'}
            release.set()
            assert client.post('/api/stop').status_code == 200
    finally:
        release.set()


def test_slope_uses_actual_irregular_times():
    assert slope([(1, 3), (1.2, 3.4), (1.7, 4.4)]) == pytest.approx(2)
    assert slope([(1, 3), (1.2, 2.6), (1.7, 1.6)]) == pytest.approx(-2)
    assert math.isnan(slope([(1, 3)]))


def test_battery_updates_ignore_empty_and_invalid_packets():
    raw = CompatiblePascoDevice()
    try:
        raw._handle_service = {0: 0}
        for data in (b'', bytes([0x85]), bytes([0x85, 0, 0, 101])):
            raw._loop.run_until_complete(raw._notify_callback(SimpleNamespace(handle=0), data))
        assert raw.battery_status is None
    finally:
        raw._loop.close()


def test_macos_resolves_only_selected_uuid_on_owning_worker(wire, monkeypatch):
    monkeypatch.setattr('physllama.devices.pasco.REQUIRES_LOCAL_DISCOVERY', True)
    original, adv = scanned('mac-os-uuid', 'Smart Cart 123-456>5')
    resolved, _ = scanned('mac-os-uuid', 'Smart Cart 123-456>5')
    calls = []
    async def find(address, timeout):
        calls.append((address, threading.get_ident()))
        return resolved
    monkeypatch.setattr('physllama.devices.pasco.BleakScanner.find_device_by_address', find)
    device = PascoDevice(original, adv)
    try:
        device.open()
        assert wire.instances[0].target is resolved
        assert calls == [('mac-os-uuid', wire.instances[0].owner)]
        assert calls[0][1] != threading.get_ident()
    finally:
        device.close()
