PhysLlama 0.3.0 preview — source update, installers pending

Renames the app, Python package, exports, desktop launchers and installer templates to PhysLlama. A cartoon scientist llama appears in the logo; the collection mascot runs while acquisition is active and stands still after Stop or an error. Reduced-motion preferences are respected.

Bluetooth discovery now uses a shared scan and a registry of supported device families. The Go Direct adapter retains the existing connection retries, deadlines, cleanup and protocol fixes. Devices expose common channel metadata and acquisition methods, including timestamped PASCO polling. The PASCO adapter reuses the existing Smart Cart app’s worker, timeout, battery and measurement logic, removes hard-coded cart serials, and supports ordinary wireless sensors recognized by its pinned SDK. Cart position is zeroed each run, with derived velocity/speed. Control/code nodes and plugin hubs are excluded.

Device display names can be saved and changed without altering Bluetooth identity. Scan results always retain the advertised name, transport ID and available printed PASCO serial; exports include the original identity alongside nicknames. In default single mode, names persist in a local settings file and are shared by connected browsers. The new `--multi` mode uses the instructor’s Bluetooth with independent student groups, join codes, exclusive device reservations and separate acquisition controls/data. Group device names stay local to that group. Plain `--server` continues to share one experiment.

Experiments can be named. The top CSV exports all recorded channels; a graph CSV includes only its selected channels. CSV now has a time column and one column per channel, aligning differing rates by linear interpolation within each run’s overlapping time range. Missing channels or genuine gaps remain blank. No interpolation crosses runs or extrapolates past measured endpoints.

PASCO Start now explicitly uses the original cart app’s write-without-response behavior despite Bleak’s changed default, accepts measurement replies on the main service, and uses a separate timeout per sensor request. This fix has automated regression coverage but still needs physical Smart Cart retesting.

The GitHub repository is now `ryanmartinneutrino/physllama`.

Existing browser graph layouts are recovered from the previous storage key. Installation paths and app identifiers change; export and quit an older installation before launching PhysLlama. This source update does not replace or remove older installations.

Backend and browser tests cover discovery, acquisition, export and recording state. Rebuild installers from a clean committed checkout and repeat installation and physical Bluetooth tests on Windows and both Mac architectures before release. Packages remain unsigned and unnotarized.
