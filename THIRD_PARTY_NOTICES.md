# Third-party components

The locally bundled Plotly.js basic distribution is licensed under the MIT license. Its complete notice is included in `physllama/static/vendor/plotly-LICENSE`.

Python dependencies are installed from PyPI by `start.sh` or included in the standalone bundles with their source and license notices:

- `godirect` — Vernier Science Education, GNU GPL v3. See <https://github.com/VernierST/godirect-py/blob/main/LICENSE>.
- `bleak` — MIT. See <https://github.com/hbldh/bleak>.
- `FastAPI` — MIT. See <https://github.com/fastapi/fastapi>.
- `Uvicorn` — BSD 3-Clause. See <https://github.com/encode/uvicorn>.

Their transitive dependencies retain their own notices in the installed distributions (`deps/*.dist-info/licenses` or equivalent). The Go Direct library's Python source is included in `deps/godirect/`; the application's Python and JavaScript sources are included in `app/`. Build scripts and corresponding app sources are also available in this public repository and each release's source archive.

Standalone Python runtime distributions are provided by [Astral's python-build-standalone project](https://github.com/astral-sh/python-build-standalone), using CPython and its bundled dependencies under their respective licenses. Runtime licenses are retained in `python/`; upstream build inputs and source references are at the pinned [20261110 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261110). Runtime downloads are SHA-256 verified against `packaging/runtimes.json`.

The Windows installer is built using [NSIS](https://nsis.sourceforge.io/License). The NSIS installer stub uses the zlib/libpng license; its notice is distributed with NSIS source. Native Python dependencies include WinRT components on Windows and PyObjC frameworks on macOS, with their notices retained alongside the bundled packages.

The PASCO 0.3.65 protocol decoder and datasheets are bundled as source in `physllama/vendor/pasco/`. Copyright (c) 2021 PASCO Scientific. Its source-code EULA permits personal, non-commercial and educational use under its conditions; the complete notice and disclaimer are included in `physllama/vendor/pasco/LICENSE`. Original wheel/source checksums and the small local changes are recorded in `PROVENANCE.json`. The PhysLlama adapter reuses application logic from [ryanmartinneutrino/pascowebapp, commit 28f70c5](https://github.com/ryanmartinneutrino/pascowebapp/tree/28f70c55ea5fd7eea4aa28b75b2ee3086c976de9). These files and the license are included in standalone installer payloads.
