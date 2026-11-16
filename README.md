# Vernier Lab

A local web app for recording and exploring Vernier Go Direct Bluetooth sensors. Run it on the computer with the Bluetooth adapter; the browser is the interface, and a Python service talks to the sensors. No cloud account or Web Bluetooth browser support is needed.

## Run on your Linux laptop

Requires Python 3.10+ and a working Bluetooth Low Energy adapter. On Ubuntu/Debian, install prerequisites if needed:

```bash
sudo apt install python3 python3-venv bluez
```

Clone this private repository using your GitHub account, then launch:

```bash
git clone git@github.com:ryanmartinneutrino/vernierserver.git
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

## Collect and explore

- Connect one or more discovered Go Direct devices. Each device has its own channel selection and disconnect control.
- Select channels to **record**, then choose a sampling interval between 10 and 10,000 ms (100 Hz to 0.1 Hz). The app checks the channel's reported limits, granularity, and mutually exclusive sensor combinations. Start at 50 ms; Bluetooth throughput varies with device and channel count.
- **Start collection** starts a new run. **Stop** keeps the data. Start again to append another run, with a time gap and a break in the plotted line. Stop before changing devices or sampling settings.
- **Series** chooses what each graph displays, independently of what is recorded. Overlay channels or add more graphs. Different units use separate labeled axes; series with the same units share an axis.
- Scroll to zoom, drag a zoom rectangle, or select pan in the Plotly toolbar. Hover for the sensor, value, units, time, and run. Zooming switches off **Follow live**. **Fit view** resets the axes; check **Follow live** to keep fitting new samples.
- **Export CSV** downloads every recorded sample from the series selected on any graph, including samples outside the zoomed view. To export every channel, select every recorded series on a graph. The Plotly camera button exports a graph as an image.
- **Reset** asks before removing all collected runs. It preserves device connections and the graph layout.
- The battery reading comes from the device when connected. Click its **refresh** label while stopped to update it. No battery percentage is invented for demo devices or devices with an unavailable reading.

**Add demo device** provides clearly labeled generated force/acceleration measurements for trying the interface without hardware. Add it more than once to test multiple devices. Synthetic and real measurements cannot be recorded in the same session, even across separate runs; export and reset before switching. Disconnect or deselect demo devices before starting real acquisition.

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

The automated backend tests cover multi-device acquisition, units and filtered CSV, resume/reset, range/granularity/conflict checks, rollback after a failed Start, data preservation on disconnect, session limits, demo isolation, origin checks, and SDK packet parsing. Browser tests exercise the actual UI: device/channel controls, mixed-unit graphs, zoom/hover/fit, export, refresh recovery, reset, error messages, and a narrow viewport.

**A real sensor has not yet been verified.** On the development computer Linux exposes `hci0`, but BlueZ reports “No default controller available” and Bleak reports “No Bluetooth adapters found.” The next step is a real-device smoke test on the Linux laptop:

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
run.py                       Local launcher; loopback only
start.sh                     Linux/macOS virtualenv setup and launch
vernier_lab/server.py        HTTP API and static asset serving
vernier_lab/acquisition.py   Serialized Bluetooth worker and session store
vernier_lab/hardware.py      Vernier/Bleak adapter and explicit demo device
vernier_lab/static/          HTML, CSS, JavaScript, and bundled Plotly
tests/                      Backend and browser tests
```

The SDK calls and BLE event loop live on one worker thread. Requests and acquisition are serialized there, avoiding cross-thread Bluetooth access. The browser polls bounded incremental batches and can rebuild its state after a reload. The service binds only to `127.0.0.1` and rejects foreign hosts/origins. Multiple tabs share one experiment; this is a single-user desktop service.

The adapter includes focused compatibility fixes for godirect 1.2.1: BLE notification reassembly, full 32-bit channel masks, correct single-channel routing, and explicit dropped-sample handling. Metadata packets are skipped, including during command responses. Hardware validation is still required on the target sensor.

## Future desktop packaging

The local service, transport adapter, and UI are separate so the same app can later be bundled using PyInstaller, optionally inside a pywebview window. Package the Python runtime and `vernier_lab/static/` together and route graceful app shutdown through `Lab.shutdown()`. Windows/macOS builds need to be produced and Bluetooth-tested on those operating systems; macOS also needs the appropriate Bluetooth permission description and signing. No installer or native release is claimed by this initial version.

For a manual macOS/Windows development run, create a virtualenv, install `requirements.txt`, and run `python run.py` with that environment. The current automated and UI validation was performed on Linux.

## Upstream references

- [Vernier's Go Direct Python library](https://github.com/VernierST/godirect-py) and [official getting-started examples](https://vernierst.github.io/godirect-examples/python/)
- [Bleak Bluetooth library](https://github.com/hbldh/bleak)
- [Plotly.js](https://github.com/plotly/plotly.js)

The private GitHub repository uses no Actions workflows, and GitHub Actions is disabled in its repository settings. Third-party license notices are in `THIRD_PARTY_NOTICES.md` and the bundled Plotly license. This is an independent project, not an official Vernier product.
