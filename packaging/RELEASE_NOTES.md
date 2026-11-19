PhysLlama 0.3.0 preview — source update, installers pending

Renames the app, Python package, exports, desktop launchers and installer templates to PhysLlama. A cartoon scientist llama appears in the logo; the collection mascot runs while acquisition is active and stands still after Stop or an error. Reduced-motion preferences are respected.

Bluetooth discovery now uses a shared scan and a registry of supported device families. The Go Direct adapter retains the existing connection retries, deadlines, cleanup and protocol fixes. Devices expose common channel metadata and acquisition methods, including timestamped PASCO polling. The PASCO adapter reuses the existing Smart Cart app’s worker, timeout, battery and measurement logic, removes hard-coded cart serials, and supports ordinary wireless sensors recognized by its pinned SDK. Cart position is zeroed each run, with derived velocity/speed. Control/code nodes and plugin hubs are excluded.

Device display names can be saved and changed without altering Bluetooth identity. Scan results always retain the advertised name, transport ID and available printed PASCO serial; exports include the original identity alongside nicknames. Names persist in a local settings file and are shared by connected browsers. Server mode continues to share one experiment; independent student workspaces are documented as future work.

Existing browser graph layouts are recovered from the previous storage key. Installation paths and app identifiers change; export and quit an older installation before launching PhysLlama. This source update does not replace or remove older installations.

Backend and browser tests cover discovery, acquisition, export and recording state. Rebuild installers from a clean committed checkout and repeat installation and physical Bluetooth tests on Windows and both Mac architectures before release. Packages remain unsigned and unnotarized.
