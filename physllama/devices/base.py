"""Vendor-neutral contracts; device methods run on the Bluetooth worker thread."""
from dataclasses import dataclass
from typing import Callable, Protocol, TypedDict

from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData


class Channel(TypedDict):
    number: int
    name: str
    unit: str
    minimum_ms: float
    maximum_ms: float
    step_ms: float
    excluded_channels: list[int]
    supported: bool


@dataclass(frozen=True)
class Reading:
    """A measurement with its acquisition time in host time.monotonic() seconds.

    Use this for polled/irregular devices. Uniformly sampled buffered devices
    may return floats instead; their times are reconstructed from start/period.
    """
    value: float
    timestamp: float


class InputDevice(Protocol):
    id: str  # Stable transport address; never a display name or scan index.
    name: str
    driver: str
    family: str
    rssi: int | None
    demo: bool
    battery: int | None
    charging: bool
    sensors: list[Channel]

    @property
    def connected(self) -> bool: ...
    def open(self, progress: Callable[..., None] | None = None) -> None: ...
    def refresh_battery(self) -> None: ...
    def start(self, numbers: list[int], period: float) -> None: ...
    def read(self) -> dict[int, list[float | Reading]]: ...
    def stop(self) -> None: ...
    def close(self) -> None: ...


class BluetoothDriver(Protocol):
    id: str
    label: str

    def matches(self, device: BLEDevice, advertisement: AdvertisementData) -> bool: ...
    def create(self, device: BLEDevice, advertisement: AdvertisementData) -> InputDevice: ...
