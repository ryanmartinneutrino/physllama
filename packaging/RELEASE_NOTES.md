Vernier Lab 0.2.2 preview

Bluetooth connections now use the device information found during scanning, avoiding an unnecessary second discovery. Transient failures trigger up to three connection attempts, with visible progress, deadlines, and cleanup between attempts. Permission errors stop with instructions for fixing access. The sensor response timeout now waits for the intended duration instead of expiring early.

The Mac download includes START HERE - Mac.txt with drag-to-install instructions, the System Settings > Privacy & Security > Open Anyway steps, and Bluetooth permission help. The README includes the same guidance and connection troubleshooting.

Download the Windows x64 setup executable or the Mac ZIP matching your processor (Apple Silicon or Intel). All packages include Python, dependencies, and browser assets for offline use. Each installer has a SHA-256 checksum file. Export your measurements and quit the old app before updating.

Validation: 19 backend tests and 4 browser tests pass, including simulated connection failures, retries, cleanup, timeouts, live progress, and preservation of recorded data. Installer integrity checks verify payload hashes and native runtime formats. The previous v0.2.1 installers and Bluetooth connections were successfully user-tested on Windows and Mac; the new connection changes still need physical-device testing on those platforms.

Installers remain unsigned and unnotarized, so operating-system approval prompts still apply. GitHub Actions remains disabled. Source is included with the bundles and in the release source archive.
