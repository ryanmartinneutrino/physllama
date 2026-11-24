"""Serialized Bluetooth worker and in-memory experiment store.

The SDK drives an asyncio loop synchronously. One dedicated thread owns that
loop and every device; HTTP requests never call Bluetooth directly.
"""
import asyncio
import copy
import math
import queue
import threading
import time
import uuid
from concurrent.futures import Future

from .devices.base import InputDevice, Reading
from .devices.demo import DemoDevice
from .hardware import default_registry
from .names import validate_name
from .csv_export import wide_csv

MAX_POINTS = 250_000


class Lab:
    def __init__(self, registry=None, name_store=None):
        self.registry = registry if registry is not None else default_registry()
        self.name_store = name_store
        self.names = name_store.load() if name_store is not None else {}
        self.experiment_name = None
        self.devices: dict[str, InputDevice] = {}
        self.selected = {}
        self.series = {}
        self.points = []
        self.recording = False
        self.period_ms = 50
        self.run = 0
        self.generation = uuid.uuid4().hex
        self.error = None
        self.epoch = None
        self.active = {}
        self.offsets = {}
        self.counts = {}
        self.last_times = {}
        self.last_seen = {}
        self.commands = queue.Queue()
        self.thread = None
        self.closing = False
        self.connection_lock = threading.Lock()
        self.connection = {'status': 'idle'}

    def connection_status(self):
        # Readable by HTTP while the single Bluetooth worker is connecting.
        with self.connection_lock:
            return self.connection.copy()

    def connection_progress(self, **status):
        with self.connection_lock:
            self.connection = status

    def launch(self):
        self.thread = threading.Thread(target=self._work, name='physllama-bluetooth', daemon=True)
        self.thread.start()

    async def call(self, action, **kwargs):
        future = Future()
        self.commands.put((future, action, kwargs))
        # Keep accepted operations alive even if the browser disconnects.
        return await asyncio.shield(asyncio.wrap_future(future))

    def _work(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            while not self.closing:
                try:
                    future, action, kwargs = self.commands.get(timeout=0.002)
                except queue.Empty:
                    pass
                else:
                    try:
                        result = getattr(self, action)(**kwargs)
                        future.set_result(result)
                    except Exception as exc:
                        future.set_exception(exc)
                try:
                    if self.recording:
                        self.tick()
                    # BLE notifications and disconnect events also need servicing
                    # while idle. Never run this event loop on the HTTP thread.
                    self.loop.run_until_complete(asyncio.sleep(0.002))
                except Exception as exc:
                    self.error = str(exc)
                    self.stop()
        finally:
            self.loop.close()

    def require_idle(self):
        if self.recording:
            raise ValueError('Stop collection before changing devices or recording settings.')

    def scan(self):
        self.require_idle()
        try:
            discovered = self.registry.scan(self.loop)
        except Exception as exc:
            raise ValueError(f'Bluetooth scan failed: {exc}. Enable Bluetooth on this computer and check its adapter; close other sensor apps.') from exc
        self.devices = {key: d for key, d in self.devices.items() if d.connected or d.demo}
        for device in discovered:
            if device.id not in self.devices:
                self.devices[device.id] = device
        return self.snapshot()

    def add_demo(self):
        self.require_idle()
        number = 1
        while f'demo-{number}' in self.devices:
            number += 1
        device = DemoDevice(number)
        self.devices[device.id] = device
        return self.connect(device.id)

    def connect(self, device_id):
        self.require_idle()
        if device_id not in self.devices:
            raise ValueError('Device not found. Search again.')
        device = self.devices[device_id]
        if not device.connected:
            try:
                self.connection_progress(status='connecting', device_id=device_id,
                                         message=f'Connecting to {device.name}…')
                device.open(progress=lambda **status: self.connection_progress(device_id=device_id, **status))
                self.connection_progress(status='connected', device_id=device_id)
            except Exception as exc:
                self.connection_progress(status='failed', device_id=device_id, message=str(exc))
                try:
                    device.close()
                except Exception:
                    pass
                raise
        if device_id not in self.selected:
            self.selected[device_id] = [s['number'] for s in device.sensors if s['supported']][:1]
        return self.snapshot()

    def disconnect(self, device_id):
        self.require_idle()
        if device_id not in self.devices:
            raise ValueError('Device not found.')
        self.devices[device_id].close()
        return self.snapshot()

    def attach(self, device):
        """Accept a device reserved for this Lab by the classroom coordinator."""
        self.require_idle()
        if device.id not in self.devices:
            self.devices[device.id] = device
        return self.connect(device.id)

    def release(self, device_id):
        self.disconnect(device_id)
        del self.devices[device_id]
        self.selected.pop(device_id, None)
        return self.snapshot()

    def expire(self):
        self.stop()
        self.error = 'This group was inactive for 30 minutes. Collection stopped; recorded data is preserved. Reconnect devices to continue.'
        return self.snapshot()

    def display_name(self, device):
        return self.names.get(device.id) or device.name

    def name_experiment(self, name):
        self.experiment_name = validate_name(name, 80) or 'Untitled experiment'
        return self.snapshot()

    def rename(self, device_id, name):
        self.require_idle()
        if device_id not in self.devices:
            raise ValueError('Device not found. Search again.')
        name = validate_name(name)
        updated = self.names.copy()
        if name:
            updated[device_id] = name
        else:
            updated.pop(device_id, None)
        if self.name_store is not None:
            self.name_store.save(updated)
        self.names = updated
        for series in self.series.values():
            if series['device_id'] == device_id:
                series['device'] = self.display_name(self.devices[device_id])
        return self.snapshot()

    def configure(self, selections, period_ms):
        self.require_idle()
        if not math.isfinite(period_ms) or not 10 <= period_ms <= 10000:
            raise ValueError('Choose a sampling interval from 10 to 10,000 ms.')
        for device_id, numbers in selections.items():
            device = self.devices.get(device_id)
            if device is None or not device.connected:
                raise ValueError('Connect the selected device first.')
            sensors = {s['number']: s for s in device.sensors}
            if len(set(numbers)) != len(numbers) or any(n not in sensors for n in numbers):
                raise ValueError('Invalid sensor selection.')
            for n in numbers:
                sensor = sensors[n]
                if not sensor['supported']:
                    raise ValueError(f"{sensor['name']} uses event-based sampling, which is not supported yet.")
                if any(other in sensor['excluded_channels'] for other in numbers if other != n):
                    raise ValueError(f"{sensor['name']} conflicts with another selected channel.")
                if not sensor['minimum_ms'] <= period_ms <= sensor['maximum_ms']:
                    raise ValueError(f"{sensor['name']} requires {sensor['minimum_ms']:g}–{sensor['maximum_ms']:g} ms.")
                step = sensor['step_ms']
                if step > 0 and not math.isclose(period_ms / step, round(period_ms / step), abs_tol=1e-5):
                    raise ValueError(f"{sensor['name']} requires an interval in multiples of {step:g} ms.")
        self.selected, self.period_ms = copy.deepcopy(selections), period_ms
        return self.snapshot()

    def start(self, selections=None, period_ms=None):
        self.require_idle()
        if selections is not None:
            self.configure(selections, self.period_ms if period_ms is None else period_ms)
        active = {key: numbers for key, numbers in self.selected.items()
                  if numbers and key in self.devices and self.devices[key].connected}
        if not active:
            raise ValueError('Connect a device and select at least one sensor to record.')
        if len(self.points) >= MAX_POINTS:
            raise ValueError('The session is full. Export your data and reset to continue.')
        self.configure(active, self.period_ms)
        # No mixed synthetic/real experiments, including data from earlier runs.
        kinds = {self.devices[key].demo for key in active}
        kinds.update(s['demo'] for s in self.series.values())
        if len(kinds) > 1:
            raise ValueError('Demo and real measurements need separate sessions. Export and reset first.')
        started = []
        offsets = {}
        epoch = self.epoch if self.epoch is not None else time.monotonic()
        try:
            for key, numbers in active.items():
                started.append(key)
                offsets[key] = time.monotonic() - epoch
                self.devices[key].start(numbers, self.period_ms)
        except Exception:
            for key in started:
                try:
                    self.devices[key].stop()
                except Exception:
                    pass
            raise
        self.epoch = epoch
        self.run += 1
        self.error = None
        self.active, self.offsets, self.counts = active, offsets, {}
        self.last_times = {}
        self.last_seen = {key: time.monotonic() for key in active}
        for key, numbers in active.items():
            device = self.devices[key]
            for sensor in device.sensors:
                if sensor['number'] in numbers:
                    series_id = f"{key}/{sensor['number']}"
                    self.series[series_id] = dict(id=series_id, device_id=key, device=self.display_name(device),
                        hardware_name=device.name, serial=getattr(device, 'serial', None),
                        name=sensor['name'], unit=sensor['unit'], demo=device.demo)
                    self.counts[series_id] = 0
        self.recording = True
        return self.snapshot()

    def tick(self):
        for key in self.active:
            device = self.devices[key]
            if not device.connected:
                raise RuntimeError(f'{device.name} disconnected. Collected data is preserved.')
            readings = device.read()
            for number, values in readings.items():
                series_id = f'{key}/{number}'
                if series_id not in self.counts:
                    continue
                for reading in values:
                    if len(self.points) >= MAX_POINTS:
                        raise RuntimeError('Session limit reached (250,000 values). Export and reset to continue.')
                    if isinstance(reading, Reading):
                        value, t = reading.value, reading.timestamp - self.epoch
                    else:
                        value = reading
                        t = self.offsets[key] + self.counts[series_id] * self.period_ms / 1000
                    if not math.isfinite(t) or t < self.offsets[key] or t < self.last_times.get(series_id, t):
                        raise RuntimeError(f'{device.name} reported invalid sample timing. Collection stopped.')
                    self.last_times[series_id] = t
                    self.counts[series_id] += 1
                    self.points.append(dict(seq=len(self.points) + 1, series=series_id,
                        t=round(t, 6), value=value if math.isfinite(value) else None, run=self.run))
                if values:
                    self.last_seen[key] = time.monotonic()
            if time.monotonic() - self.last_seen[key] > max(5, self.period_ms / 1000 * 3):
                raise RuntimeError(f'No data from {device.name}. Check its power and Bluetooth connection.')

    def stop(self):
        self.recording = False
        for key in self.active:
            try:
                self.devices[key].stop()
            except Exception as exc:
                self.error = self.error or str(exc)
        self.active = {}
        return self.snapshot()

    def reset(self):
        self.require_idle()
        self.points.clear()
        self.series.clear()
        self.epoch, self.run, self.error = None, 0, None
        self.generation = uuid.uuid4().hex
        return self.snapshot()

    def battery(self, device_id):
        self.require_idle()
        device = self.devices.get(device_id)
        if not device or not device.connected:
            raise ValueError('Connect the device first.')
        device.refresh_battery()
        return self.snapshot()

    def snapshot(self, after=0, generation=None):
        if generation != self.generation:
            after = 0
        after = min(max(after, 0), len(self.points))
        # Bounded deltas; a reloaded browser catches up over several polls.
        points = self.points[after:after + 10000] if generation is not None else []
        return dict(recording=self.recording, period_ms=self.period_ms,
            experiment_name=self.experiment_name,
            supported_devices=self.registry.families(),
            run=self.run, generation=self.generation, error=self.error,
            total_points=len(self.points), elapsed=max((p['t'] for p in self.points[-200:]), default=0),
            cursor=after + len(points), points=points, series=copy.deepcopy(list(self.series.values())),
            devices=[dict(id=d.id, name=self.display_name(d), hardware_name=d.name,
                nickname=self.names.get(d.id, ''), serial=getattr(d, 'serial', None),
                acquisition_note=getattr(d, 'acquisition_note', ''),
                rssi=d.rssi, demo=d.demo, connected=d.connected,
                driver=d.driver, family=d.family, timing=getattr(d, 'timing', None),
                battery=d.battery, charging=d.charging, sensors=copy.deepcopy(d.sensors),
                selected=self.selected.get(d.id, [])) for d in self.devices.values()])

    def export_csv(self, series_ids=None):
        ids = set(series_ids) if series_ids is not None else set(self.series)
        if not ids or not ids <= self.series.keys():
            raise ValueError('Select at least one recorded series to export.')
        return wide_csv([s for key, s in self.series.items() if key in ids], self.points)

    def shutdown(self):
        self.stop()
        for device in self.devices.values():
            try:
                device.close()
            except Exception:
                pass
        self.closing = True
