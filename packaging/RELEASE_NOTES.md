Vernier Lab 0.2.1 preview

- Choose sensors only in each graph’s Sensors dropdown; the Devices panel now manages connections and battery status.
- Start records the union of checked sensors across all graphs, collecting each sensor only once.
- Show/hide existing data during recording; stop before adding new sensors. Previously collected data is preserved.
- Repository and installer downloads are now public and do not require signing in.
- Includes the light-blue interface, consistent graph titles, and per-graph full-history CSV downloads introduced in 0.2.0.

Offline Windows x64 setup executable and macOS installer ZIPs for Apple Silicon and Intel include Python and all dependencies. See README.md for installation, Bluetooth setup, updates, and uninstall instructions. Each artifact has a SHA-256 checksum file.

These are unsigned preview builds. macOS ZIPs contain an offline .command installer and .app, rather than a signed PKG/DMG. Windows and macOS installation, launch, permission prompts, and physical Bluetooth acquisition have not yet been tested on their native operating systems. Application tests and archive integrity checks are performed on Linux. Signing/notarization is not included.

GitHub Actions remains disabled. Source is included with the bundles and in this release’s source archive.
