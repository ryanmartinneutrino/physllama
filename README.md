# Vernier Lab

A local web app for recording and exploring Vernier Go Direct Bluetooth sensors. Run it on the computer with the Bluetooth adapter; the browser is the interface, and a Python service talks to the sensors. No cloud account or Web Bluetooth browser support is needed.

## Standalone installers (Windows and Mac)

Download the installer for your computer from the public [v0.2.2 release](https://github.com/ryanmartinneutrino/vernierserver/releases/tag/v0.2.2). No GitHub account or sign-in is required.

| Computer | Download |
| --- | --- |
| Windows 11, Intel/AMD 64-bit | `VernierLab-0.2.2-windows-x64-setup.exe` |
| Mac with Apple Silicon (M1/M2/M3/M4 or later), macOS 13+ | `VernierLab-0.2.2-macos-arm64-installer.zip` |
| Mac with an Intel processor, macOS 13+ | `VernierLab-0.2.2-macos-x64-installer.zip` |

These are **offline, self-contained packages**: Python, platform-specific dependencies, the app, and graphing assets are included. Students do not need Python, Node, Git, a terminal command, or an internet connection to run the installed app. The Mac install script opens Terminal to confirm installation; app launches after installation use the browser directly.

**Release status:** unsigned installers. The user has successfully tested the v0.2.1 installers on Windows and Mac, including real Bluetooth connections; the Mac needed an explicit “Open Anyway” approval and sometimes took multiple connection attempts. Version 0.2.2 adds connection retries and clearer installation instructions. Automated tests and package integrity checks run on Linux; these new connection changes still need testing with physical sensors on each target OS. A `.sha256` file accompanies each installer.

### Windows

1. Run the setup `.exe`. It installs for the current user without administrator privileges.
2. Open **Vernier Lab** from the Start menu or desktop shortcut. It opens the local app in your default browser.
3. Enable Bluetooth in Windows Settings, turn on the sensor, and search/connect in the app.
4. Export before closing. Choose **Quit app** in the app's header to stop the service and release Bluetooth. Closing a browser tab alone keeps the session running. Reopening the shortcut brings back that session.

Uninstall through **Settings → Apps → Installed apps → Vernier Lab**, or `Uninstall.exe` in `%LOCALAPPDATA%\Programs\Vernier Lab`. Quit the app before upgrading or uninstalling. Runtime diagnostics are in `%LOCALAPPDATA%\Vernier Lab\Logs\app.log`.

### macOS

1. Choose the ZIP matching **Apple menu → About This Mac**: “Chip” means Apple Silicon; “Processor: Intel” means Intel. Extract it and open **START HERE - Mac.txt**.
2. In Finder, drag **Vernier Lab.app** into **Applications** in your home folder (create that folder if needed). This avoids having to approve the optional installer script as well as the app. Alternatively, double-click **Install Vernier Lab.command**, then type `y` and Return to copy it automatically.
3. Open the installed **Vernier Lab.app**. If macOS blocks it because its developer cannot be verified, dismiss the warning, open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** for Vernier Lab. Confirm **Open**, authenticating if asked. Try opening the app first so that this option appears. If using the optional `.command` installer, it may need the same approval separately.
4. Allow Bluetooth access when prompted. If previously denied, check **System Settings → Privacy & Security → Bluetooth**, enable access for the app shown there, then quit and reopen Vernier Lab.
5. Export your measurements, then use **Quit app** in the browser header when finished. Closing the browser tab keeps the session alive.

Approve only the download you intended to install. There is no need to disable macOS security globally. These packages remain unsigned and unnotarized, so this first-launch approval is still necessary. See [Apple’s instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445).

The installer never replaces an existing app silently. To update, quit Vernier Lab, move the previous `.app` to Trash, and run the new installer. To uninstall, quit and move the `.app` to Trash. Logs are in `~/Library/Logs/Vernier Lab/app.log`.

## Run on your Linux laptop

Requires Python 3.10+ and a working Bluetooth Low Energy adapter. On Ubuntu/Debian, install prerequisites if needed:

```bash
sudo apt install python3 python3-venv bluez
```

Clone the public repository, then launch:

```bash
git clone https://github.com/ryanmartinneutrino/vernierserver.git
cd vernierserver
./start.sh
```

The first launch creates `.venv` and installs the Python dependencies (internet required). Later launches use the existing environment. The browser opens at **http://127.0.0.1:8765**. Keep the terminal running; Ctrl+C shuts down the service and releases connected devices. All browser assets are bundled locally, so normal use needs no internet connection.

If you downloaded a ZIP, extract it and run `bash start.sh` in that directory.

```bash
./start.sh --no-browser              # open the URL yourself
./start.sh --port 8767               # use a different port
```

Enable Bluetooth in your desktop settings. Turn on the Go Direct sensor, click **Search for devices**, and connect it. Do not connect it to Graphical Analysis, LabQuest, or another app at the same time. Pairing through desktop settings is not normally required.

If scanning fails, check `bluetoothctl show` and `rfkill list`. “No default controller available” or “No Bluetooth adapters found” means the OS cannot currently expose an adapter to this app. Try the laptop's Bluetooth settings or a supported USB BLE adapter. Do not run the app as root.

## Bluetooth connection help

Connecting shows progress and automatically makes up to three attempts after transient failures, with a short pause and a fresh connection between attempts. Each attempt has a 30-second budget, including sensor initialization, plus up to five seconds for cleanup. Permission errors or unavailable Bluetooth stop immediately so you can fix the settings. If cleanup fails, retries stop to avoid leaving multiple connections open.

Keep the sensor awake and nearby, enable Bluetooth, and close Graphical Analysis, LabQuest, or other apps using it. After all attempts fail, check Bluetooth permissions, power-cycle the sensor, then search and connect again. On Mac, use **System Settings → Privacy & Security → Bluetooth**. The progress banner remains available while connecting, including after a page refresh. Existing recordings are preserved; a lost connection during collection stops the run and does not automatically restart it.

## Collect and explore

- Connect one or more discovered Go Direct devices. The Devices panel manages connections and battery status. Sensor selection happens only in graph dropdowns.
- Check sensors in the graphs’ **Sensors** dropdowns, then choose a sampling interval between 10 and 10,000 ms (100 Hz to 0.1 Hz). The app checks the channel's reported limits, granularity, and mutually exclusive sensor combinations. Start at 50 ms; Bluetooth throughput varies with device and channel count.
- **Start collection** starts a new run. **Stop** keeps the data. Start again to append another run, with a time gap and a break in the plotted line. Stop before changing devices or sampling settings.
- Each graph has a **Sensors** dropdown with checkboxes grouped by device. The union of checked sensors across all graphs determines what the next run records, with each sensor recorded once even when used on multiple graphs. New graphs start with no sensors selected. Check channels from one or more devices to overlay them; each graph keeps its own selection. All supported connected sensors are available directly in the dropdown. While recording, you can show or hide already-recorded channels; stop first to add a previously unrecorded sensor. Removing a graph or hiding a trace does not interrupt the current run, but changes the selection for the next Start. Different units use separate labeled axes; series with the same units share an axis.
- Graphs have a single editable title. Automatic titles renumber after deletion; custom titles survive deletion of other graphs and page reloads.
- Scroll to zoom, drag a zoom rectangle, or select pan in the Plotly toolbar. Hover for the sensor, value, units, time, and run. Zooming switches off **Follow live**. **Fit view** resets the axes; check **Follow live** to keep fitting new samples.
- **Download CSV** on a graph exports only that graph’s checked sensors, including their full recorded history regardless of zoom or display reduction. Its filename includes the graph title. **Export CSV** at the top exports the combined selection across all graphs. The Plotly camera button exports a graph as an image.
- **Reset** asks before removing all collected runs. It preserves device connections and the graph layout.
- The battery reading comes from the device when connected. Click its **refresh** label while stopped to update it. No battery percentage is invented for demo devices or devices with an unavailable reading.

**Add demo device** provides clearly labeled generated force/acceleration measurements for trying the interface without hardware. Add it more than once to test multiple devices. Synthetic and real measurements cannot be recorded in the same session, even across separate runs; export and reset before switching. Disconnect demo devices or uncheck their sensors in every graph before starting real acquisition.

## Data, units, and timing

The app records device-reported measurements and units without extra scaling, calibration, or zero offsets. An empty unit field is labeled `a.u.` (arbitrary units). Device calibration is handled by Vernier firmware/the library. Advanced calibration workflows and aperiodic/event channels are not implemented.

CSV is in long format:

```text
run,time_s,device,device_id,sensor,unit,value,source
1,0.000014,Demo Motion & Force 1,demo-1,Force,N,0.0,demo
```

Each row is one channel value, with full numeric precision and a `sensor` or `demo` source label. Missing/non-finite measurements export as empty values. `time_s` is relative to the first Start and includes pauses. Samples are ordered by receipt; each channel has its own time sequence.

Sample times are reconstructed from the requested sampling interval and the host's monotonic time immediately before each device's Start command. Devices are **not hardware synchronized**, so there can be Bluetooth command latency between their actual starts. This is suitable for introductory force/motion exploration, not precise cross-device phase measurements. Reported dropped-sample packets stop collection with an error instead of silently compressing the time axis. A connection loss or data timeout also stops collection and preserves prior samples.

Data lives in the local service's memory. Refreshing or reopening the browser recovers the current session; exiting the service loses it. Export before stopping the app. The session stops at **250,000 channel values** without discarding earlier samples. Large graphs use min/max display reduction after 4,000 values per series; CSV always includes every recorded value. Titles and graph preferences are saved in browser storage.

## Verification status

The automated backend tests cover multi-device acquisition, units and filtered CSV, resume/reset, range/granularity/conflict checks, rollback after a failed Start, data preservation on disconnect, session limits, demo isolation, origin checks, SDK packet parsing, retry limits, partial-connection cleanup, timeouts, and connection progress while the Bluetooth worker is busy. Browser tests exercise the actual UI: device/channel controls, mixed-unit graphs, zoom/hover/fit, export, refresh recovery, reset, error messages, and a narrow viewport.

**Windows and Mac installers and Bluetooth connections have been user-tested with v0.2.1.** The development Linux computer still has no usable Bluetooth adapter. For v0.2.2, repeat this physical-device smoke test, especially the Mac connection retries:

1. Search and connect the powered-on sensor; check its model, channel units, and battery reading.
2. Record force and compatible acceleration channels at 50 ms for 10 seconds while gently moving the sensor.
3. Stop, hover and zoom, export the CSV, then start a second run.
4. Power off the sensor while recording and confirm the error preserves the data; power on, reconnect, and record again.
5. When a second physical device is available, repeat with both devices.

## Development

There is no frontend build step for normal use. Plotly is vendored with its license. Node is needed only for browser tests or updating that asset.

```bash
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
npm ci
npx playwright install chromium
npm run test:ui
```

If Chromium is already installed in a nonstandard location, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable. Browser tests start an isolated service on port 8766. `npm run vendor` updates the tracked Plotly asset from the pinned package.

```text
desktop.py                   Bundled desktop entry point and graceful shutdown
run.py                       Local launcher; loopback only
start.sh                     Linux/macOS virtualenv setup and launch
vernier_lab/server.py        HTTP API and static asset serving
vernier_lab/acquisition.py   Serialized Bluetooth worker and session store
vernier_lab/hardware.py      Vernier/Bleak adapter and explicit demo device
vernier_lab/static/          HTML, CSS, JavaScript, and bundled Plotly
packaging/                   Runtime checksums, dependency locks, installer templates
scripts/build_installers.py  Offline Windows/Mac installer assembly
tests/                       Backend and browser tests
```

The SDK calls and BLE event loop live on one worker thread. Requests and acquisition are serialized there, avoiding cross-thread Bluetooth access. The browser polls bounded incremental batches and can rebuild its state after a reload. The service binds only to `127.0.0.1` and rejects foreign hosts/origins. Multiple tabs share one experiment; this is a single-user desktop service.

The adapter includes focused compatibility fixes for godirect 1.2.1: BLE notification reassembly, full 32-bit channel masks, correct single-channel routing, and explicit dropped-sample handling. Metadata packets are skipped, including during command responses. Hardware validation is still required on the target sensor.

## Rebuilding standalone installers

The builder assembles target-native packages without compiling foreign binaries. It downloads the pinned Astral standalone Python 3.12 runtime, verifies its SHA-256, and installs only target-native wheels from hashed per-platform lock files. The same Python source and local browser assets are included on every platform. Every bundle includes its source commit and file hashes in `BUILD-MANIFEST.json`, the Python library sources, and third-party notices.

Install the builder dependency and NSIS (NSIS is required only for Windows setup output):

```bash
.venv/bin/python -m pip install -r requirements-build.txt
# Ubuntu/Debian build host, Windows setup compiler:
sudo apt install nsis
.venv/bin/python scripts/build_installers.py --target all
```

Individual targets are `windows-x64`, `macos-arm64`, and `macos-x64`. `--uv` and `--makensis` can supply explicit executable paths. On Windows use the virtualenv's `Scripts/python.exe`, or any Python 3.10+ with the build dependency installed. This process needs internet while building; the resulting installers do not.

Commit source changes before building; the builder requires a clean checkout so its manifest identifies the exact source revision. Outputs are written to ignored `dist/`. The Mac ZIPs contain the offline installer, README, and a `.app` with Bluetooth usage descriptions. The Windows NSIS executable installs shortcuts and a per-user uninstaller. No GitHub Actions workflows or hosted build services are used. Upload artifacts to a GitHub release after validation; do not commit bundled runtimes into Git.

Run `.venv/bin/python scripts/verify_installers.py` after building (requires `7z`) to verify the installer checksums, every payload file against the build manifest, Mac executable permissions and Bluetooth metadata, and native Python executable formats. These integrity checks do not replace installation and Bluetooth tests on the target OS.

To regenerate dependency locks after deliberately updating `requirements.txt`:

```bash
.venv/bin/uv pip compile --python-version 3.12 --python-platform x86_64-pc-windows-msvc --generate-hashes -o packaging/requirements-windows-x64.lock.txt requirements.txt
.venv/bin/uv pip compile --python-version 3.12 --python-platform aarch64-apple-darwin --generate-hashes -o packaging/requirements-macos-arm64.lock.txt requirements.txt
.venv/bin/uv pip compile --python-version 3.12 --python-platform x86_64-apple-darwin --generate-hashes -o packaging/requirements-macos-x64.lock.txt requirements.txt
```

For a classroom release, test both CPU variants on Macs and the Windows installer on a clean Windows machine without Python. Confirm launch, Bluetooth permission, acquisition, graph-specific CSV, Quit, reopening, and uninstall. Code signing/notarization requires platform signing credentials and a macOS signing host; neither is included in this preview build.

## Upstream references

- [Vernier's Go Direct Python library](https://github.com/VernierST/godirect-py) and [official getting-started examples](https://vernierst.github.io/godirect-examples/python/)
- [Bleak Bluetooth library](https://github.com/hbldh/bleak)
- [Plotly.js](https://github.com/plotly/plotly.js)

The public GitHub repository uses no Actions workflows, and GitHub Actions is disabled in its repository settings. Third-party license notices are in `THIRD_PARTY_NOTICES.md` and the bundled Plotly license. This is an independent project, not an official Vernier product.
