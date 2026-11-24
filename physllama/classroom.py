"""Independent experiments with exclusive ownership of instructor-side devices.

The HTTP loop owns the reservation/session maps. Each group owns a Lab worker;
the radio lock serializes discovery and connection without blocking other Labs.
"""
import asyncio
from dataclasses import dataclass, field
import secrets
import time
import uuid

from .acquisition import Lab
from .hardware import default_registry
from .names import validate_name

MAX_GROUPS = 16
IDLE_SECONDS = 30 * 60


class DeviceBusy(ValueError):
    pass


@dataclass
class Group:
    name: str
    lab: Lab
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    code: str = field(default_factory=lambda: ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(10)))
    last_seen: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def info(self):
        return dict(id=self.id, name=self.name, join_code=f'{self.code[:5]}-{self.code[5:]}')


class Classroom:
    def __init__(self, registry=None):
        self.registry = registry if registry is not None else default_registry()
        self.groups = {}  # Private cookie token -> group; never expose these keys.
        self.catalog = {}
        self.owners = {}  # Device ID -> private group token.
        self.radio_lock = asyncio.Lock()
        self.maintenance = None
        self.last_scan = None
        self.operations = set()

    async def launch(self):
        self.maintenance = asyncio.create_task(self._maintain())

    def authenticate(self, token):
        group = self.groups.get(token)
        if group is not None:
            group.last_seen = time.monotonic()
        return group

    def create(self, name):
        name = validate_name(name)
        if not name:
            raise ValueError('Enter a name for your group.')
        if any(group.name.casefold() == name.casefold() for group in self.groups.values()):
            raise ValueError('That group name is already in use. Join with its code or choose another name.')
        if len(self.groups) >= MAX_GROUPS:
            raise ValueError(f'This server already has {MAX_GROUPS} groups. End an unused group session first.')
        group = Group(name=name, lab=Lab(registry=self.registry))
        while any(other.code == group.code for other in self.groups.values()):
            group.code = Group(name=name, lab=group.lab).code
        self.groups[group.token] = group
        group.lab.launch()
        return group

    def join(self, code):
        normalized = code.strip().upper().replace('-', '').replace(' ', '')
        for group in self.groups.values():
            if normalized.isascii() and secrets.compare_digest(group.code, normalized):
                group.last_seen = time.monotonic()
                return group
        raise ValueError('Group code not found. Check the code with your teammate.')

    def require_owner(self, group, device_id):
        # Demo IDs are local to each group; physical reservations are global.
        device = group.lab.devices.get(device_id)
        if device is not None and device.demo:
            return
        if self.owners.get(device_id) != group.token:
            raise PermissionError('This device is not reserved by your group. Connect it first.')

    def _scan(self):
        # Discovery has its own loop; device adapters establish their actual
        # connections on the owning group's/device's loop afterwards.
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return self.registry.scan(loop)
        finally:
            loop.close()
            asyncio.set_event_loop(None)

    @staticmethod
    def device_info(device):
        return dict(id=device.id, name=device.name, hardware_name=device.name,
                    nickname='', serial=getattr(device, 'serial', None),
                    driver=device.driver, family=device.family, rssi=device.rssi,
                    demo=False, connected=False, battery=None, charging=False,
                    sensors=[], selected=[], acquisition_note='')

    async def snapshot(self, group, **kwargs):
        result = await group.lab.call('snapshot', **kwargs)
        own = {device['id']: device for device in result['devices']}
        visible = []
        for device_id, device in self.catalog.items():
            row = own.pop(device_id, None) or self.device_info(device)
            owner = self.groups.get(self.owners.get(device_id))
            row.update(owned=owner is group, reserved_by=owner.name if owner else None)
            visible.append(row)
        for row in own.values():
            row.update(owned=True, reserved_by=group.name)
            visible.append(row)
        result.update(devices=visible, workspace=group.info(), last_scan=self.last_scan)
        return result

    async def _accepted(self, coroutine):
        # A closed tab must not release a radio/reservation lock while its BLE
        # operation is still running on a Lab worker.
        task = asyncio.create_task(coroutine)
        self.operations.add(task)
        def finished(completed):
            self.operations.discard(completed)
            if not completed.cancelled():
                completed.exception()  # Retrieve errors even after a client disconnects.
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def call(self, group, action, **kwargs):
        return await self._accepted(self._call(group, action, **kwargs))

    async def _call(self, group, action, **kwargs):
        async with group.lock:
            # An End request may have won this lock while another request waited.
            if group.token not in self.groups:
                raise PermissionError('This group session has ended.')
            if action == 'snapshot':
                return await self.snapshot(group, **kwargs)
            if action == 'scan':
                await group.lab.call('require_idle')
                async with self.radio_lock:
                    try:
                        discovered = await asyncio.to_thread(self._scan)
                    except Exception as exc:
                        raise ValueError(f'Bluetooth scan failed: {exc}. Check Bluetooth on the instructor’s computer.') from exc
                    self.catalog = {key: device for key, device in self.catalog.items() if key in self.owners}
                    for device in discovered:
                        if device.id not in self.owners:
                            self.catalog[device.id] = device
                    self.last_scan = time.time()
            elif action == 'connect':
                await group.lab.call('require_idle')
                device_id = kwargs['device_id']
                device = group.lab.devices.get(device_id)
                if device is not None and device.demo:
                    await group.lab.call('connect', device_id=device_id)
                else:
                    if device_id not in self.catalog:
                        raise ValueError('Device not found. Search again.')
                    owner = self.owners.get(device_id)
                    if owner is not None and owner != group.token:
                        raise DeviceBusy(f'This device is in use by {self.groups[owner].name}. Choose your workbench’s device.')
                    # No await between checking and claiming: competing HTTP
                    # requests cannot both acquire the same physical device.
                    self.owners[device_id] = group.token
                    group.lab.connection_progress(status='connecting', device_id=device_id,
                        message='Waiting for the instructor’s Bluetooth adapter…')
                    async with self.radio_lock:
                        await group.lab.call('attach', device=self.catalog[device_id])
                    # Failed handshakes retain their reservation until explicit
                    # release, including when partial-connection cleanup failed.
            elif action == 'disconnect':
                self.require_owner(group, kwargs['device_id'])
                await group.lab.call('release', **kwargs)
                self.owners.pop(kwargs['device_id'], None)
            elif action in ('rename', 'battery'):
                self.require_owner(group, kwargs['device_id'])
                await group.lab.call(action, **kwargs)
            elif action in ('start', 'configure'):
                selections = kwargs.get('selections', group.lab.selected)
                for device_id in {*selections, *(kwargs.get('periods') or {})}:
                    self.require_owner(group, device_id)
                await group.lab.call(action, **kwargs)
            elif action in ('export_csv', 'save_experiment'):
                return await group.lab.call(action, **kwargs)
            elif action in ('stop', 'reset', 'add_demo', 'name_experiment', 'load_experiment'):
                await group.lab.call(action, **kwargs)
            else:
                raise ValueError('Unknown classroom operation.')
            return await self.snapshot(group)

    async def _release_all(self, group):
        await group.lab.call('stop')
        for device_id in list(group.lab.devices):
            await group.lab.call('release', device_id=device_id)
            self.owners.pop(device_id, None)

    async def end(self, group):
        return await self._accepted(self._end(group))

    async def _end(self, group):
        async with group.lock:
            if group.token not in self.groups:
                raise PermissionError('This group session has ended.')
            await self._release_all(group)
            await group.lab.call('shutdown')
            await asyncio.to_thread(group.lab.thread.join, 6)
            self.groups.pop(group.token, None)

    async def expire_idle(self):
        now = time.monotonic()
        for group in list(self.groups.values()):
            if now - group.last_seen < IDLE_SECONDS or group.lock.locked() or not group.lab.devices:
                continue
            async with group.lock:
                await group.lab.call('expire')
                try:
                    await self._release_all(group)
                except Exception:
                    # Keep ownership when disconnect fails; never hand a
                    # potentially live connection to a different experiment.
                    continue

    async def _maintain(self):
        while True:
            await asyncio.sleep(30)
            await self.expire_idle()

    async def shutdown(self):
        if self.maintenance is not None:
            self.maintenance.cancel()
            await asyncio.gather(self.maintenance, return_exceptions=True)
        await asyncio.gather(*self.operations, return_exceptions=True)
        for group in list(self.groups.values()):
            await group.lab.call('shutdown')
            await asyncio.to_thread(group.lab.thread.join, 6)
        self.groups.clear()
        self.owners.clear()
