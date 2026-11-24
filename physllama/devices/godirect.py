"""Go Direct protocol adapter; all calls stay on one thread."""
import asyncio
import logging
import queue
import struct
import sys
import time

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakBluetoothNotAvailableError, BleakDeviceNotFoundError
from godirect.device_bleak import GoDirectDeviceBleak


class CompatibleBLEDevice(GoDirectDeviceBleak):
    connection_deadline = None
    discovered_device = None
    refresh_discovery = False

    def _timeout(self, limit):
        if self.connection_deadline is None:
            return limit
        remaining = self.connection_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('The sensor took too long to connect.')
        return min(limit, remaining)

    def _connect(self):
        # A scanned BLEDevice avoids Bleak's implicit second discovery, which
        # can interfere with existing connections (and CoreBluetooth on Macs).
        timeout = self._timeout(20)
        target = self.discovered_device or self.id
        refresh = self.refresh_discovery
        if sys.platform == 'darwin' and self.discovered_device is not None:
            # Classroom discovery belongs to a different worker. CoreBluetooth
            # delegates retain their original loop, so resolve the same UUID on
            # this group's loop when ownership has changed.
            details = self.discovered_device.details
            if details[1].event_loop is not self._loop:
                refresh = True
        self._loop.run_until_complete(asyncio.wait_for(self._connect_target(target, refresh), timeout))
        return self._device.is_connected

    async def _connect_target(self, target, refresh):
        if not refresh:
            self._device = BleakClient(target)
            await self._async_connect()
            return
        # Each OS keeps native handles in a BLEDevice. Reusing a stale handle
        # for every retry cannot recover. Resolve only the selected transport ID
        # on this worker's loop, never a name or the first nearby Go Direct cart.
        found = asyncio.get_running_loop().create_future()
        def discovered(device, advertisement):
            if device.address.casefold() == self.id.casefold() and not found.done():
                found.set_result(device)
        async with BleakScanner(detection_callback=discovered):
            try:
                target = await asyncio.wait_for(found, self._timeout(8))
            except asyncio.TimeoutError as exc:
                raise BleakDeviceNotFoundError(self.id,
                    f'The selected Bluetooth ID {self.id} was not found during connection recovery') from exc
            self.discovered_device = target
            self._device = BleakClient(target)
            # BlueZ can remove an unconnected device when discovery stops.
            # Keep this scan alive through connection/notification setup; it
            # neither disconnects nor resets any other device or adapter.
            await self._async_connect()

    async def _async_write(self, uuid, data_to_write, wait_for_response):
        timeout = self._timeout(5)
        await asyncio.wait_for(self._device.write_gatt_char(
            uuid, bytes(data_to_write), response=wait_for_response), timeout)

    def _read(self, timeout):
        # Use elapsed time, not SDK sleep counts: the shorter event-loop yield
        # otherwise turns a five-second response timeout into one second.
        deadline = time.monotonic() + self._timeout(timeout / 1000)
        while time.monotonic() < deadline:
            self._timeout(1)
            try:
                return self._responses.get_nowait()
            except queue.Empty:
                self._loop.run_until_complete(self._wait())
        self._timeout(1)
        return bytearray()

    # godirect 1.2.1 passes the loop as asyncio.sleep's result argument. Keep
    # event-loop ownership explicit and support fragmented/coalesced BLE packets.
    async def _wait(self):
        await asyncio.sleep(0.002)

    def _notify_callback(self, handle, value):
        self._response_buffer.extend(value)
        while len(self._response_buffer) >= 2:
            length = self._response_buffer[1]
            if length < 5:
                self._response_buffer.clear()
                return
            if len(self._response_buffer) < length:
                return
            self._responses.put(self._response_buffer[:length])
            del self._response_buffer[:length]

    def _GDX_read_measurement(self, timeout):
        deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < deadline:
            packet = self._read(max(10, (deadline - time.monotonic()) * 1000))
            if len(packet) < 5 or packet[0] != self.RESPONSE_MEASUREMENT:
                continue
            kind = packet[4]
            if kind == self.MEASUREMENT_TYPE_DROPPED:
                raise RuntimeError('Device reported dropped samples. Use a slower sampling interval.')
            if kind in (self.MEASUREMENT_TYPE_START_TIME, self.MEASUREMENT_TYPE_PERIOD):
                continue
            return self._GDX_handle_measurement(packet)
        return False

    def _GDX_handle_measurement(self, packet):
        # Correct upstream's truncated 32-bit mask and single-channel routing.
        kind = packet[4]
        if kind in (self.MEASUREMENT_TYPE_START_TIME, self.MEASUREMENT_TYPE_PERIOD):
            return False
        if kind == self.MEASUREMENT_TYPE_DROPPED:
            raise RuntimeError('Device reported dropped samples. Use a slower sampling interval.')
        fmt = '<f'
        if kind == self.MEASUREMENT_TYPE_NORMAL_REAL32:
            mask, count = struct.unpack_from('<HB', packet, 5)
            channels, offset = list(self._get_sensors_with_mask(mask).values()), 9
        elif kind == self.MEASUREMENT_TYPE_WIDE_REAL32:
            mask, count = struct.unpack_from('<IB', packet, 5)
            channels, offset = list(self._get_sensors_with_mask(mask).values()), 11
        elif kind in (self.MEASUREMENT_TYPE_SINGLE_CHANNEL_REAL32, self.MEASUREMENT_TYPE_SINGLE_CHANNEL_INT32):
            number, count = packet[6:8]
            channels, offset = [self.get_sensor(number)], 8
            if kind == self.MEASUREMENT_TYPE_SINGLE_CHANNEL_INT32:
                fmt = '<i'
        else:
            raise RuntimeError('This sensor uses an unsupported measurement format.')
        if len(packet) < offset + count * len(channels) * 4:
            raise RuntimeError('Incomplete measurement packet. Collection stopped to preserve timing.')
        for _ in range(count):
            for sensor in channels:
                sensor.values.append(struct.unpack_from(fmt, packet, offset)[0])
                offset += 4
        return True


class GoDirectDevice:
    demo = False
    driver = 'go-direct'
    family = 'Go Direct'
    # The sensor samples on its own clock and streams buffered values.
    timing = 'device'

    ATTEMPTS = 3
    ATTEMPT_TIMEOUT = 30
    RETRY_DELAY = 1

    def __init__(self, address, name, rssi, discovered_device=None):
        self.id, self.name, self.rssi = address, name, rssi
        self.discovered_device = discovered_device
        self.ready = False
        self._new_client()
        self.sensors = []
        self.battery = None
        self.charging = False

    def _new_client(self):
        self.raw = CompatibleBLEDevice(None)
        self.raw.id = self.id
        self.raw.type = 'BLE'
        self.raw.discovered_device = self.discovered_device
        self.raw.set_name_from_advertisement(self.name)

    @property
    def connected(self):
        return self.ready and self.raw._device is not None and self.raw.is_connected()

    def open(self, progress=None):
        report = progress or (lambda **status: None)
        self.close()
        for attempt in range(1, self.ATTEMPTS + 1):
            self._new_client()
            self.raw.refresh_discovery = attempt > 1
            self.raw.connection_deadline = time.monotonic() + self.ATTEMPT_TIMEOUT
            report(status='connecting', attempt=attempt, max_attempts=self.ATTEMPTS,
                   message=f'Connecting to {self.name} — attempt {attempt} of {self.ATTEMPTS}. Keep the sensor awake and nearby.')
            try:
                self._open_once()
                self.ready = True
                self.discovered_device = self.raw.discovered_device
                self.raw.connection_deadline = None
                return
            except Exception as exc:
                logging.getLogger(__name__).warning('Go Direct connection to %s failed (attempt %s/%s): %s',
                    self.id, attempt, self.ATTEMPTS, str(exc) or type(exc).__name__, exc_info=True)
                try:
                    self.close()
                except Exception as cleanup:
                    raise RuntimeError('Could not release the previous Bluetooth connection. '
                                       'Quit and reopen PhysLlama, then try again.') from cleanup
                reason = str(exc) or type(exc).__name__
                permanent = isinstance(exc, (BleakBluetoothNotAvailableError, PermissionError))
                if permanent or attempt == self.ATTEMPTS:
                    advice = ('Turn on Bluetooth and check its adapter or permissions. '
                              if isinstance(exc, BleakBluetoothNotAvailableError) else
                              'Allow Bluetooth access in system privacy settings. '
                              if isinstance(exc, PermissionError) else
                              f'Wake the sensor with Bluetooth ID {self.id}, keep it nearby, '
                              'and close other apps connected to that sensor. ')
                    raise RuntimeError(
                        f'Could not connect to {self.name} after {attempt} attempt(s): {reason}. '
                        + advice +
                        'On Mac, Bluetooth permissions are in System Settings → Privacy & Security → Bluetooth. '
                        'Then search again and reconnect. Your recorded data is preserved.') from exc
                report(status='retrying', attempt=attempt, max_attempts=self.ATTEMPTS,
                       message=f'{self.name}: connection interrupted. Retrying in {attempt} second(s) '
                               f'(next attempt {attempt + 1} of {self.ATTEMPTS}).')
                self.raw._loop.run_until_complete(asyncio.sleep(attempt * self.RETRY_DELAY))

    def _open_once(self):
        if not self.raw.open():
            raise RuntimeError('Device did not finish connecting. Wake it and try again.')
        sensors = self.raw.list_sensors()
        if not sensors:
            raise RuntimeError('The device did not provide sensor information.')
        self.sensors = [dict(
            number=s.sensor_number, name=s.sensor_description,
            unit=s.sensor_units or 'a.u.', minimum_ms=s.min_measurement_period,
            maximum_ms=s.max_measurement_period, step_ms=s.measurement_period_granularity,
            excluded_channels=[n for n in sensors if s.mutual_exclusion_mask & (1 << n)],
            supported=s.sampling_mode == 0,
        ) for s in sensors.values()]
        self.refresh_battery()

    def refresh_battery(self):
        if self.raw._GDX_get_status():
            level = self.raw.battery_level_percent
            self.battery = level if 0 <= level <= 100 else None
            self.charging = self.raw.charger_state == self.raw.CHARGER_STATE_CHARGING

    def start(self, numbers, period):
        for sensor in self.raw.sensors.values():
            sensor.enabled = False
        self.raw.enable_sensors(numbers)
        if {s.sensor_number for s in self.raw.get_enabled_sensors()} != set(numbers):
            raise ValueError('These sensor channels cannot be recorded together.')
        if not self.raw.start(period=period):
            raise RuntimeError('The device rejected this sampling interval or sensor selection.')

    def read(self):
        self.raw.read(timeout=20)
        result = {}
        for sensor in self.raw.get_enabled_sensors():
            if sensor.values:
                result[sensor.sensor_number] = sensor.values.copy()
                sensor.clear()
        return result

    def stop(self):
        if self.connected and not self.raw.stop():
            raise RuntimeError('The device did not acknowledge stopping.')

    def close(self):
        self.ready = False
        client = self.raw._device
        if client is not None:
            # Disconnect also removes notifications. Do this even after a
            # partial handshake, without depending on SDK stop-notify success.
            self.raw._loop.run_until_complete(asyncio.wait_for(client.disconnect(), 5))
            if client.is_connected:
                raise RuntimeError('Bluetooth connection did not close.')
            self.raw._device = None


class GoDirectDriver:
    id = 'go-direct'
    label = 'Go Direct'

    def matches(self, device, advertisement):
        return (advertisement.local_name or device.name or '').startswith('GDX')

    def create(self, device, advertisement):
        return GoDirectDevice(device.address, advertisement.local_name or device.name,
                              advertisement.rssi, device)
