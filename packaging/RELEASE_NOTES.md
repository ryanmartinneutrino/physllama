Vernier Lab 0.2.0 preview

- Light-blue interface and a compact, device-grouped Sensors dropdown on every graph.
- Single editable graph titles; automatic names remain consistent after deletion and reload.
- Per-graph Download CSV exports the full history of that graph's selected sensors, independent of zoom.
- Offline Windows x64 setup executable and macOS installer ZIPs for Apple Silicon and Intel. Python and all dependencies are included.
- Installed app launcher reopens the current session; Quit app releases devices and stops the service.

Download the installer for your operating system and processor. See README.md for installation, Bluetooth setup, updates, and uninstall instructions. Each artifact has a SHA-256 checksum file.

These are unsigned preview builds. macOS ZIPs contain an offline .command installer and .app, rather than a signed PKG/DMG. Windows and macOS installation, launch, permission prompts, and physical Bluetooth acquisition have not yet been tested on their native operating systems. Application tests and archive integrity checks were performed on Linux. OS security settings may block unsigned apps; signing/notarization is not included.

GitHub Actions remains disabled. Source is included with the bundles and in this release's source archive.
