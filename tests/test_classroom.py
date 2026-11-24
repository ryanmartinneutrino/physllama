import asyncio
from concurrent.futures import ThreadPoolExecutor
import csv
import io
import threading
import time

import pytest
from fastapi.testclient import TestClient

from physllama.classroom import Classroom, IDLE_SECONDS
from physllama.devices.demo import DemoDevice
from physllama.server import create_app


class PhysicalFixture(DemoDevice):
    demo = False
    driver = 'test'
    family = 'Fixture sensor'

    def __init__(self, device_id):
        super().__init__()
        self.id, self.name = device_id, f'Sensor {device_id}'
        self.serial = device_id
        self.fail_open = self.fail_read = self.fail_close = False
        self.open_count = 0

    def open(self, progress=None):
        self.open_count += 1
        if self.fail_open:
            raise RuntimeError('Fixture handshake failed')
        super().open(progress)

    def read(self):
        if self.fail_read:
            raise RuntimeError('Fixture sensor failed')
        return super().read()

    def close(self):
        if self.fail_close:
            raise RuntimeError('Fixture disconnect failed')
        super().close()


class FixtureRegistry:
    def __init__(self):
        self.created = []

    def scan(self, loop):
        devices = [PhysicalFixture(key) for key in ('101-001', '202-002')]
        self.created.extend(devices)
        return devices

    def families(self):
        return [{'id': 'test', 'label': 'Fixture sensor'}]


@pytest.fixture
def classroom():
    manager = Classroom(registry=FixtureRegistry())
    with TestClient(create_app(multi_mode=True, classroom=manager)) as client:
        yield client, manager


def create(client, name):
    client.cookies.clear()
    response = client.post('/api/groups', json={'name': name}, headers={'Cookie': ''})
    assert response.status_code == 200, response.text
    return response.headers['set-cookie'].split(';', 1)[0], response.json()


def api(client, cookie, action='state', body=None, method=None):
    return client.request(method or ('GET' if body is None else 'POST'), '/api/' + action,
                          json=body, headers={'Cookie': cookie})


def wait_for(function):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        value = function()
        if value:
            return value
        time.sleep(.01)
    pytest.fail('Timed out waiting for classroom acquisition')


def test_groups_have_independent_runs_settings_data_and_exports(classroom):
    client, manager = classroom
    a, group_a = create(client, 'Workbench A')
    b, group_b = create(client, 'Workbench B')
    for cookie in (a, b):
        assert api(client, cookie, 'demo', {}).status_code == 200
    assert api(client, a, 'start', {'selections': {'demo-1': [1]}, 'period_ms': 10}).status_code == 200
    assert api(client, b, 'start', {'selections': {'demo-1': [2]}, 'period_ms': 50}).status_code == 200
    wait_for(lambda: api(client, b).json()['total_points'] > 2)
    state_a, state_b = api(client, a).json(), api(client, b).json()
    assert api(client, a, 'experiment', {'name': 'Force lab'}).status_code == 200
    assert api(client, b, 'experiment', {'name': 'Acceleration lab'}).status_code == 200
    assert api(client, a).json()['experiment_name'] == 'Force lab'
    assert api(client, b).json()['experiment_name'] == 'Acceleration lab'
    assert state_a['generation'] != state_b['generation']
    assert state_a['workspace'] == group_a
    assert state_b['workspace'] == group_b
    assert next(d['period_ms'] for d in state_a['devices'] if d['id'] == 'demo-1') == 10 and next(d['period_ms'] for d in state_b['devices'] if d['id'] == 'demo-1') == 50
    assert {s['id'] for s in state_a['series']} == {'demo-1/1'}
    assert {s['id'] for s in state_b['series']} == {'demo-1/2'}
    assert group_b['join_code'] not in str(state_a)
    assert api(client, a, 'stop', {}).status_code == 200
    stopped_points = api(client, a).json()['total_points']
    wait_for(lambda: api(client, b).json()['total_points'] > state_b['total_points'])
    assert api(client, a).json()['total_points'] == stopped_points
    assert api(client, a, 'export?series=demo-1/2').status_code == 400
    rows = list(csv.DictReader(io.StringIO(api(client, b, 'export').text)))
    assert len(rows[0]) == 3
    assert 'Acceleration X [m/s²]' in list(rows[0])[2]
    assert api(client, a, 'reset', {}).status_code == 200
    assert api(client, a).json()['total_points'] == 0
    assert api(client, b).json()['recording']
    assert api(client, b).json()['total_points'] >= state_b['total_points']


def test_auth_join_reload_and_end_affect_only_the_selected_group(classroom):
    client, manager = classroom
    assert api(client, '', 'state').status_code == 401
    assert api(client, '', 'demo', {}).status_code == 401
    assert api(client, '', 'connection-status').status_code == 401
    a, info = create(client, 'Team one')
    b, _ = create(client, 'Team two')
    assert api(client, a, 'demo', {}).status_code == 200
    teammate = api(client, '', 'groups/join', {'code': info['join_code'].lower()})
    assert teammate.status_code == 200
    teammate_cookie = teammate.headers['set-cookie'].split(';', 1)[0]
    assert api(client, teammate_cookie).json()['generation'] == api(client, a).json()['generation']
    assert api(client, teammate_cookie, 'session').json()['group'] == info
    assert api(client, '', 'groups/join', {'code': 'wrong'}).status_code == 400
    assert api(client, '', 'groups/join', {'code': 'é' * 10}).status_code == 400
    assert api(client, '', 'groups', {'name': 'TEAM ONE'}).status_code == 400
    assert api(client, a, 'quit', {}).status_code == 400
    assert api(client, a, 'groups/end', {}).status_code == 200
    assert api(client, teammate_cookie).status_code == 401
    assert api(client, '', 'groups/join', {'code': info['join_code']}).status_code == 400
    assert api(client, b).status_code == 200
    assert len(manager.groups) == 1


def test_physical_device_claim_is_atomic_and_foreign_operations_are_rejected(classroom):
    client, manager = classroom
    a, _ = create(client, 'Alpha')
    b, _ = create(client, 'Beta')
    assert api(client, a, 'scan', {}).status_code == 200
    with ThreadPoolExecutor() as pool:
        responses = list(pool.map(lambda c: api(client, c, 'connect', {'device_id': '101-001'}), (a, b)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    owner, other = (a, b) if responses[0].status_code == 200 else (b, a)
    assert manager.catalog['101-001'].open_count == 1
    assert api(client, owner, 'rename', {'device_id': '101-001', 'name': 'Red cart'}).status_code == 200
    visible = next(d for d in api(client, other).json()['devices'] if d['id'] == '101-001')
    assert not visible['owned'] and not visible['connected'] and visible['reserved_by']
    assert visible['name'] == 'Sensor 101-001'
    assert visible['serial'] == '101-001'
    assert visible['sensors'] == []
    for action in ('disconnect', 'rename', 'battery'):
        body = {'device_id': '101-001', **({'name': 'stolen'} if action == 'rename' else {})}
        assert api(client, other, action, body).status_code == 403
    for action in ('configure', 'start'):
        assert api(client, other, action, {'selections': {'101-001': [1]}, 'period_ms': 20}).status_code == 403
    assert api(client, owner, 'disconnect', {'device_id': '101-001'}).status_code == 200
    assert api(client, other, 'connect', {'device_id': '101-001'}).status_code == 200
    assert manager.catalog['101-001'].open_count == 2


def test_rescan_and_one_group_failure_do_not_replace_or_stop_another_groups_device(classroom):
    client, manager = classroom
    a, _ = create(client, 'Group A')
    b, _ = create(client, 'Group B')
    api(client, a, 'scan', {})
    api(client, a, 'connect', {'device_id': '101-001'})
    device_a = manager.catalog['101-001']
    assert api(client, a, 'start', {'selections': {'101-001': [1]}, 'period_ms': 10}).status_code == 200
    assert api(client, b, 'scan', {}).status_code == 200
    assert manager.catalog['101-001'] is device_a
    assert api(client, a).json()['recording']
    api(client, b, 'connect', {'device_id': '202-002'})
    assert api(client, b, 'start', {'selections': {'202-002': [2]}, 'period_ms': 20}).status_code == 200
    wait_for(lambda: api(client, b).json()['total_points'])
    device_a.fail_read = True
    wait_for(lambda: not api(client, a).json()['recording'])
    assert 'Fixture sensor failed' in api(client, a).json()['error']
    assert api(client, b).json()['recording']
    assert api(client, b).json()['error'] is None


def test_slow_connection_does_not_block_other_group_recording_or_controls(classroom):
    client, manager = classroom
    a, _ = create(client, 'Connecting group')
    b, _ = create(client, 'Recording group')
    api(client, a, 'scan', {})
    api(client, b, 'demo', {})
    api(client, b, 'start', {'selections': {'demo-1': [1]}, 'period_ms': 10})
    entered, release = threading.Event(), threading.Event()
    device = manager.catalog['101-001']
    original = device.open
    def delayed(progress=None):
        progress(status='connecting', message='Waiting for fixture handshake')
        entered.set()
        assert release.wait(3)
        original(progress)
    device.open = delayed
    with ThreadPoolExecutor() as pool:
        future = pool.submit(api, client, a, 'connect', {'device_id': device.id})
        try:
            assert entered.wait(1)
            assert api(client, a, 'connection-status').json()['status'] == 'connecting'
            assert api(client, b, 'connection-status').json()['status'] != 'connecting'
            wait_for(lambda: api(client, b).json()['total_points'] > 3)
            assert api(client, b, 'stop', {}).status_code == 200
        finally:
            release.set()
        assert future.result(timeout=2).status_code == 200


def test_failed_connection_keeps_reservation_until_successful_release(classroom):
    client, manager = classroom
    a, _ = create(client, 'A')
    b, _ = create(client, 'B')
    api(client, a, 'scan', {})
    device = manager.catalog['101-001']
    device.fail_open = True
    assert api(client, a, 'connect', {'device_id': device.id}).status_code == 503
    assert api(client, b, 'connect', {'device_id': device.id}).status_code == 409
    device.fail_close = True
    assert api(client, a, 'disconnect', {'device_id': device.id}).status_code == 503
    assert api(client, b, 'connect', {'device_id': device.id}).status_code == 409
    device.fail_close = device.fail_open = False
    assert api(client, a, 'disconnect', {'device_id': device.id}).status_code == 200
    assert api(client, b, 'connect', {'device_id': device.id}).status_code == 200


def test_idle_release_preserves_data_and_leaves_active_groups_untouched(classroom):
    client, manager = classroom
    a, _ = create(client, 'Away')
    b, _ = create(client, 'Present')
    api(client, a, 'scan', {})
    api(client, a, 'connect', {'device_id': '101-001'})
    api(client, a, 'start', {'selections': {'101-001': [1]}, 'period_ms': 10})
    api(client, b, 'demo', {})
    api(client, b, 'start', {'selections': {'demo-1': [1]}, 'period_ms': 10})
    wait_for(lambda: api(client, a).json()['total_points'])
    group = next(g for g in manager.groups.values() if g.name == 'Away')
    group.last_seen = time.monotonic() - IDLE_SECONDS - 1
    client.portal.call(manager.expire_idle)
    state = api(client, a).json()
    assert not state['recording'] and state['total_points'] > 0
    assert 'inactive' in state['error']
    assert '101-001' not in manager.owners
    assert not group.lab.devices
    assert api(client, b).json()['recording']
    assert api(client, b, 'stop', {}).status_code == 200
    assert api(client, b, 'connect', {'device_id': '101-001'}).status_code == 200


def test_group_limit_and_same_origin_controls(classroom, monkeypatch):
    client, manager = classroom
    monkeypatch.setattr('physllama.classroom.MAX_GROUPS', 1)
    cookie, _ = create(client, 'Only group')
    assert api(client, '', 'groups', {'name': 'Too many'}).status_code == 400
    assert client.post('/api/groups/end', headers={'Cookie': cookie, 'Origin': 'http://foreign.example'}).status_code == 403
    assert api(client, cookie).status_code == 200


def test_cancelled_browser_request_keeps_radio_lock_until_connection_finishes(classroom):
    client, manager = classroom
    cookie, _ = create(client, 'Interrupted browser')
    api(client, cookie, 'scan', {})
    group = next(iter(manager.groups.values()))
    entered, release = threading.Event(), threading.Event()
    device = manager.catalog['101-001']
    original = device.open
    def delayed(progress=None):
        entered.set()
        assert release.wait(3)
        original(progress)
    device.open = delayed

    async def scenario():
        request = asyncio.create_task(manager.call(group, 'connect', device_id=device.id))
        try:
            while not entered.is_set():
                await asyncio.sleep(.005)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert manager.radio_lock.locked()
            assert group.lock.locked()
            assert manager.owners[device.id] == group.token
        finally:
            release.set()
        await asyncio.gather(*manager.operations)
        assert not manager.radio_lock.locked()
        assert device.connected
        assert manager.owners[device.id] == group.token
    client.portal.call(scenario)
