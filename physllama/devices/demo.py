"""Explicitly simulated input for exploring the workspace without hardware."""
import math
import time


class DemoDevice:
    demo = True
    driver = 'demo'
    family = 'Demo'

    def __init__(self, number=1):
        self.id, self.name, self.rssi = f'demo-{number}', f'Demo Motion & Force {number}', None
        self.connected, self.battery, self.charging = False, None, False
        self.sensors = [dict(number=i, name=name, unit=unit, minimum_ms=10,
                             maximum_ms=10000, step_ms=1, excluded_channels=[], supported=True)
                        for i, (name, unit) in enumerate([
                            ('Force', 'N'), ('Acceleration X', 'm/s²'),
                            ('Acceleration Y', 'm/s²'), ('Acceleration Z', 'm/s²')], 1)]

    def open(self, progress=None):
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
