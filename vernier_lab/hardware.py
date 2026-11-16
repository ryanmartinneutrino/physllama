"""Small adapter around Vernier's protocol library; all calls stay on one thread."""
import asyncio
import math
import struct
import time

from bleak import BleakScanner
from godirect.device_bleak import GoDirectDeviceBleak


class CompatibleBLEDevice(GoDirectDeviceBleak):
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


class RealDevice:
    demo = False

    def __init__(self, address, name, rssi):
        self.id, self.name, self.rssi = address, name, rssi
        self.raw = CompatibleBLEDevice(None)
        self.raw.id = address
        self.raw.type = 'BLE'
        self.raw.set_name_from_advertisement(name)
        self.sensors = []
        self.battery = None
        self.charging = False

    @property
    def connected(self):
        return self.raw._device is not None and self.raw.is_connected()

    def open(self):
        if not self.raw.open():
            raise RuntimeError('Device did not finish connecting. Wake it and try again.')
        sensors = self.raw.list_sensors()
        if not sensors:
            raise RuntimeError('The device did not provide sensor information.')
        self.sensors = [dict(
            number=s.sensor_number, name=s.sensor_description,
            unit=s.sensor_units or 'a.u.', minimum_ms=s.min_measurement_period,
            maximum_ms=s.max_measurement_period, step_ms=s.measurement_period_granularity,
            exclusion_mask=s.mutual_exclusion_mask, supported=s.sampling_mode == 0,
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
        if self.connected:
            try:
                self.raw.close()
            finally:
                # An upstream stop-notify failure must still release the BLE link.
                if self.connected:
                    self.raw._loop.run_until_complete(self.raw._device.disconnect())


def scan_devices(loop):
    found = loop.run_until_complete(BleakScanner.discover(timeout=5, return_adv=True))
    return [RealDevice(d.address, a.local_name or d.name, a.rssi)
            for d, a in found.values() if (a.local_name or d.name or '').startswith('GDX')]


class DemoDevice:
    demo = True

    def __init__(self, number=1):
        self.id, self.name, self.rssi = f'demo-{number}', f'Demo Motion & Force {number}', None
        self.connected, self.battery, self.charging = False, None, False
        self.sensors = [dict(number=i, name=name, unit=unit, minimum_ms=10,
                             maximum_ms=10000, step_ms=1, exclusion_mask=0, supported=True)
                        for i, (name, unit) in enumerate([
                            ('Force', 'N'), ('Acceleration X', 'm/s²'),
                            ('Acceleration Y', 'm/s²'), ('Acceleration Z', 'm/s²')], 1)]

    def open(self):
        self.connected = True

    def refresh_battery(self):
        pass

    def start(self, numbers, period):
        self.numbers, self.period = numbers, period / 1000
        self.started, self.index = time.monotonic(), 0

    def read(self):
        count = int((time.monotonic() - self.started) / self.period) + 1
        result = {n: [] for n in self.numbers}
        for i in range(self.index, count):
            t = i * self.period
            for n in self.numbers:
                value = (4.2 if n == 1 else 1.8) * math.sin(t * 2.6 + (n - 1) * 0.7)
                result[n].append(value + (9.81 if n == 4 else 0))
        self.index = count
        return result

    def stop(self):
        pass

    def close(self):
        self.connected = False
