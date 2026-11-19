"""PASCO adapter adapted from ryanmartinneutrino/pascowebapp.

Retains its per-device workers, bounded reads, battery decoding, midpoint
sample times and least-squares cart velocity. See vendor/pasco/PROVENANCE.json.
"""
import asyncio
from collections import deque
from concurrent.futures import Future
import math
import queue
import re
import sys
import threading
import time
from types import SimpleNamespace
import xml.etree.ElementTree as ET

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakBluetoothNotAvailableError

from ..vendor.pasco.pasco_ble_device import PASCOBLEDevice
from ..vendor.pasco.datasheets import datasheet
from .base import Reading

READ_TIMEOUT = 2.0
MAX_SAMPLE_HZ = 50.0
REQUIRES_LOCAL_DISCOVERY = sys.platform == 'darwin'
# The ordinary wireless input families supported by the upstream SDK. Nodes
# and plugin hubs need additional lifecycle/measurement routing, so omit them.
MODELS = {'Accel Alt', 'CO2', 'Conductivity', 'Current', 'Diffraction', 'Drop Counter',
          'Force Accel', 'Light', 'Load Cell', 'Mag Field', 'Motion', 'O2', 'Optical DO',
          'pH', 'Pressure', 'Rotary Motion', 'Smart Cart', 'Temperature', 'Voltage', 'Weather'}
INTERFACES = {int(i.get('ID')): i.get('AdvertisingName')
              for i in ET.fromstring(datasheet).findall('./Interfaces/Interface')
              if i.get('AdvertisingName') in MODELS}
CART_MEASUREMENTS = {'Position', 'Force', 'Accelerationx', 'Accelerationy',
                     'Accelerationz', 'AccelerationResultant'}
UNITS = {'ms2': 'm/s²', 'mps': 'm/s', 'degps': '°/s', 'degC': '°C', 'deg': '°'}
VELOCITY, SPEED = 900001, 900002


def identity(name):
    match = re.fullmatch(r'(.+) (\d{3}-\d{3})>([0-9A-Za-z*#]).*', name or '')
    if not match:
        return None
    model, serial, code = match.groups()
    interface = 1024 + '0123456789KLMNOPQRSTUVWXYZABCDEFGHIJabcdefghijklmnopqrstuvwxyz*#'.index(code)
    if INTERFACES.get(interface) != model:
        return None
    return model, serial


def slope(points):
    """Port of the Smart Cart app's least-squares derivative, using past samples."""
    if len(points) < 2:
        return math.nan
    mean_t = sum(t for t, _ in points) / len(points)
    mean_x = sum(x for _, x in points) / len(points)
    denominator = sum((t - mean_t) ** 2 for t, _ in points)
    return (sum((t - mean_t) * (x - mean_x) for t, x in points) / denominator
            if denominator > 0 else math.nan)


class CompatiblePascoDevice(PASCOBLEDevice):
    """Keep SDK decoding; adapt transport ownership and timeouts to modern Bleak."""
    deadline = None
    battery_status = None

    def budget(self, seconds):
        remaining = seconds if self.deadline is None else min(seconds, self.deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError('PASCO response timed out.')
        return remaining

    def connect_scanned(self, device, advertised_name):
        self._client = BleakClient(device)  # Exact selection; no implicit scan by serial/name.
        self._loop.run_until_complete(asyncio.wait_for(self._async_connect(), self.budget(20)))
        if not self.is_connected():
            raise RuntimeError('The PASCO device did not connect.')
        self._set_device_params(SimpleNamespace(address=device.address, name=advertised_name))
        if self._dev_type == 'Rotary Motion':
            self._loop.run_until_complete(self.write_await_callback(self.SENSOR_SERVICE_ID, self.WIRELESS_RMS_START))
        self.initialize_device()

    def _get_notify_uuids(self):
        return [str(value) for value in super()._get_notify_uuids()]

    def read_data_list(self, measurements):
        # SDK read_data_list with the same grouped requests/decoder, but retain
        # timeout and packet errors instead of masking them as InvalidParameter.
        if not self.is_connected():
            raise RuntimeError('PASCO device disconnected.')
        for sensor_id in sorted({self._measurement_sensor_ids[m] for m in measurements}):
            self._get_sensor_measurements(sensor_id)
        return {measurement: self._data_results[measurement] for measurement in measurements}

    async def write(self, service_id, command):
        # Unlike the SDK's bare except, preserve cancellation and transport errors.
        await self._client.write_gatt_char(str(self._set_uuid(service_id, self.SEND_CMD_CHAR_ID)), bytes(command))

    async def write_await_callback(self, service_id, one_shot_cmd):
        # Same deadline/queue cleanup as the source app, with gather rather than
        # TaskGroup so the existing Python 3.10+ desktop/runtime support remains.
        timeout = self.budget(READ_TIMEOUT)
        self._expected_response = (service_id, one_shot_cmd[0])
        self._response_error = None
        tasks = [asyncio.create_task(self.write(service_id, one_shot_cmd)),
                 asyncio.create_task(self.check_callback())]
        try:
            await asyncio.wait_for(asyncio.gather(*tasks), timeout)
            if self._response_error:
                raise RuntimeError(self._response_error)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            while not self._queue.empty():
                self._queue.get_nowait()
                self._queue.task_done()
            self._expected_response = None

    async def _notify_callback(self, char, data):
        if not data:
            return
        if data[0] == 0x85 and self._handle_service.get(char.handle) == self.SENSOR_SERVICE_ID:
            # From the source app: millivolts, percent, and charging flag.
            if len(data) >= 4 and 0 <= data[3] <= 100:
                self.battery_status = {'pct': data[3], 'mv': data[1] | (data[2] << 8),
                                       'charging': len(data) >= 6 and bool(data[5] & 1)}
            return
        if data[0] == self.GRSP_RESULT:
            service = self._handle_service.get(char.handle)
            expected = getattr(self, '_expected_response', None)
            if not expected or service != expected[0]:
                return  # Unsolicited/stale acknowledgement must not complete a read.
            if len(data) < 3:
                self._response_error = 'Incomplete PASCO response.'
            elif data[2] != expected[1]:
                return
            elif data[1] != 0:
                self._response_error = 'PASCO rejected the measurement request.'
            elif data[2] == self.GCMD_READ_ONE_SAMPLE:
                channel = next(c for c in self._device_channels if c['id'] == service - 1)
                if len(data) - 3 != channel['total_data_size']:
                    self._response_error = 'Incomplete PASCO measurement packet.'
            if self._response_error:
                await self._queue.put(True)
                return
        await super()._notify_callback(char, data)


class PascoDevice:
    demo = False
    driver = 'pasco'
    ATTEMPTS = 3
    RETRY_DELAY = 1
    ATTEMPT_TIMEOUT = 30

    def __init__(self, device, advertisement):
        self.id = device.address
        self.name = advertisement.local_name or device.name
        self.model, self.serial = identity(self.name)
        self.family = f'PASCO {self.model}'
        self.rssi = advertisement.rssi
        self.discovered_device = device
        self.sensors = []
        self.battery, self.charging = None, False
        self.acquisition_note = ('Polled samples: actual rate depends on Bluetooth and selected channels.'
            + (' Position starts at zero each run; velocity and speed use the last 3 position samples.'
               if self.model == 'Smart Cart' else ''))
        self.raw = None
        self._ready = self._recording = self._closing = False
        self._thread = None
        self._commands = queue.Queue()
        self._samples = queue.Queue(maxsize=512)
        self._error = None

    @property
    def connected(self):
        return self._ready and self.raw is not None and bool(self.raw.is_connected())

    def _call(self, action, *args):
        future = Future()
        self._commands.put((future, action, args))
        return future.result(timeout=120)  # Includes all bounded connection retries.

    def open(self, progress=None):
        self.close()
        self._closing = False
        self._thread = threading.Thread(target=self._work, name=f'pasco-{self.serial}', daemon=True)
        self._thread.start()
        self._call('_open', progress or (lambda **status: None))

    def _work(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            while not self._closing:
                try:
                    future, action, args = self._commands.get(timeout=.002)
                except queue.Empty:
                    pass
                else:
                    try:
                        future.set_result(getattr(self, action)(*args))
                    except Exception as exc:
                        future.set_exception(exc)
                if self._recording and time.monotonic() >= self._next_read:
                    try:
                        self._poll()
                    except Exception as exc:
                        self._error = RuntimeError(f'{self.name}: PASCO read failed ({str(exc) or type(exc).__name__}). '
                                                   'Stop, reconnect and start a new run. Recorded data is preserved.')
                        self._recording = False
                self._loop.run_until_complete(asyncio.sleep(.002))
                self._update_battery()
        finally:
            pending = asyncio.all_tasks(self._loop)
            for task in pending:
                task.cancel()
            self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self._loop.close()

    def _open(self, report):
        for attempt in range(1, self.ATTEMPTS + 1):
            report(status='connecting', attempt=attempt, max_attempts=self.ATTEMPTS,
                   message=f'Connecting to {self.name} — attempt {attempt} of {self.ATTEMPTS}.')
            try:
                self.raw = CompatiblePascoDevice()
                self.raw._loop.close()
                self.raw._loop = self._loop
                self.raw.deadline = time.monotonic() + self.ATTEMPT_TIMEOUT
                target = self.discovered_device
                if REQUIRES_LOCAL_DISCOVERY:
                    # A CoreBluetooth BLEDevice holds its scan loop's central
                    # delegate. Resolve this exact UUID on the device worker,
                    # as the source app did with per-cart scan ownership.
                    timeout = self.raw.budget(8)
                    target = self._loop.run_until_complete(asyncio.wait_for(
                        BleakScanner.find_device_by_address(self.id, timeout=timeout), timeout))
                    if target is None:
                        raise RuntimeError(f'The selected Bluetooth ID {self.id} is no longer advertising.')
                self.raw.connect_scanned(target, self.name)
                self._channels()
                self.raw.deadline = None
                self._ready = True
                self._error = None
                return
            except Exception as exc:
                self._release()
                if isinstance(exc, (PermissionError, BleakBluetoothNotAvailableError)) or attempt == self.ATTEMPTS:
                    raise RuntimeError(f'Could not connect to {self.name}: {str(exc) or type(exc).__name__}. '
                                       'Wake the device, check Bluetooth permissions, close other sensor apps, '
                                       'then search and reconnect.') from exc
                report(status='retrying', attempt=attempt, max_attempts=self.ATTEMPTS,
                       message=f'{self.name}: retrying connection (attempt {attempt + 1} of {self.ATTEMPTS}).')
                self._loop.run_until_complete(asyncio.sleep(self.RETRY_DELAY * attempt))

    def _channels(self):
        self._measurements = {}
        channels = []
        available = set(self.raw.get_measurement_list())
        if self.model == 'Smart Cart':
            # Reuse the tested app's channels; its SDK gyro decoder is unreliable.
            available &= CART_MEASUREMENTS
        for sensor_id, measurements in self.raw._device_measurements.items():
            for measurement_id, metadata in measurements.items():
                name = metadata['NameTag']
                if name not in available or not metadata.get('Visible') or metadata.get('Internal'):
                    continue
                number = (sensor_id + 1) * 1000 + measurement_id
                self._measurements[number] = name
                unit = self.raw.get_measurement_unit(name) or 'a.u.'
                channels.append(self._channel(number, name, UNITS.get(unit, unit)))
        if self.model == 'Smart Cart' and 'Position' in self._measurements.values():
            channels.extend([self._channel(VELOCITY, 'Velocity (derived)', 'm/s'),
                             self._channel(SPEED, 'Speed (derived)', 'm/s')])
        if not channels:
            raise ValueError('This PASCO model has no supported measurement channels.')
        self.sensors = channels

    @staticmethod
    def _channel(number, name, unit):
        return dict(number=number, name=name, unit=unit, minimum_ms=1000 / MAX_SAMPLE_HZ,
                    maximum_ms=10000, step_ms=0, excluded_channels=[], supported=True)

    def start(self, numbers, period):
        self._call('_start', numbers, period)

    def _start(self, numbers, period):
        if not self.connected or self._error:
            raise RuntimeError('Reconnect the PASCO device before starting a new run.')
        self._clear_samples()
        self._numbers = numbers
        self._wanted = list(dict.fromkeys(self._measurements[n] if n not in (VELOCITY, SPEED) else 'Position'
                                        for n in numbers))
        self._period = max(period / 1000, 1 / MAX_SAMPLE_HZ)
        self._position_zero = None
        self._positions = deque(maxlen=3)
        self._next_read = time.monotonic()
        self._recording = True

    def _poll(self):
        began = time.monotonic()
        self.raw.deadline = began + READ_TIMEOUT
        try:
            values = self.raw.read_data_list(self._wanted)
        finally:
            self.raw.deadline = None
        ended = time.monotonic()
        timestamp = (began + ended) / 2  # Source app's request/response midpoint.
        if 'Position' in values and self.model == 'Smart Cart':
            position = values['Position']
            if position is not None and math.isfinite(position):
                if self._position_zero is None:
                    self._position_zero = position
                values['Position'] = position - self._position_zero
                self._positions.append((timestamp, values['Position']))
            else:
                self._positions.clear()
        velocity = slope(self._positions)
        batch = {}
        for number in self._numbers:
            value = velocity if number == VELOCITY else abs(velocity) if number == SPEED else values[self._measurements[number]]
            batch[number] = [Reading(float(value) if value is not None else math.nan, timestamp)]
        try:
            self._samples.put_nowait(batch)
        except queue.Full as exc:
            raise RuntimeError('PASCO sample buffer is full; collection stopped without dropping older data.') from exc
        self._next_read = max(began + self._period, ended)

    def read(self):
        result = {}
        # Bound each drain even if the polling thread is producing concurrently.
        for _ in range(512):
            try:
                batch = self._samples.get_nowait()
            except queue.Empty:
                break
            for number, values in batch.items():
                result.setdefault(number, []).extend(values)
        if self._error and not result:
            raise self._error
        return result

    def _update_battery(self):
        status = self.raw.battery_status if self.raw else None
        if status:
            self.battery, self.charging = status['pct'], status['charging']

    def refresh_battery(self):
        # Status is unsolicited, as in the original app; never invent a charge.
        self._update_battery()

    def _clear_samples(self):
        while not self._samples.empty():
            self._samples.get_nowait()

    def stop(self):
        if self._thread and self._thread.is_alive():
            self._call('_stop')

    def _stop(self):
        self._recording = False
        self._clear_samples()

    def _release(self):
        self._ready = False
        if self.raw and self.raw._client:
            self._loop.run_until_complete(asyncio.wait_for(self.raw._client.disconnect(), 5))
            if self.raw._client.is_connected:
                raise RuntimeError('Could not release the PASCO connection. Quit and reopen PhysLlama.')
        self.raw = None
        self.battery, self.charging = None, False

    def close(self):
        if self._thread and self._thread.is_alive():
            self._call('_close')
            self._thread.join(timeout=6)
            if self._thread.is_alive():
                raise RuntimeError('PASCO worker did not shut down.')
        self._thread = None

    def _close(self):
        self._stop()
        self._release()
        self._closing = True


class PascoDriver:
    id = 'pasco'
    label = 'PASCO wireless sensors'

    def matches(self, device, advertisement):
        return identity(advertisement.local_name or device.name) is not None

    def create(self, device, advertisement):
        return PascoDevice(device, advertisement)
