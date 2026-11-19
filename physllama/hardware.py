"""Discover known Bluetooth families with one scan on the acquisition thread."""
from bleak import BleakScanner

from .devices.base import BluetoothDriver
from .devices.godirect import GoDirectDriver
from .devices.pasco import PascoDriver


class DeviceRegistry:
    def __init__(self, drivers: tuple[BluetoothDriver, ...]):
        self.drivers = tuple(drivers)
        ids = [driver.id for driver in self.drivers]
        if len(set(ids)) != len(ids):
            raise ValueError('Device driver IDs must be unique.')

    def families(self):
        return [dict(id=driver.id, label=driver.label) for driver in self.drivers]

    def identify(self, device, advertisement):
        matches = [driver for driver in self.drivers if driver.matches(device, advertisement)]
        if len(matches) > 1:
            raise ValueError(f'Ambiguous device support for {device.address}. Check driver matchers.')
        return matches[0].create(device, advertisement) if matches else None

    def scan(self, loop):
        found = loop.run_until_complete(BleakScanner.discover(timeout=5, return_adv=True))
        devices = {}
        for device, advertisement in found.values():
            adapted = self.identify(device, advertisement)
            if adapted is not None:
                devices[adapted.id] = adapted
        return list(devices.values())


def default_registry():
    # Add a driver here only once its discovery and acquisition are implemented.
    return DeviceRegistry((GoDirectDriver(), PascoDriver()))
