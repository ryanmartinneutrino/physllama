# Third-party components

The locally bundled Plotly.js basic distribution is licensed under the MIT license. Its complete notice is included in `vernier_lab/static/vendor/plotly-LICENSE`.

Python dependencies are installed from PyPI by `start.sh` or included in the standalone bundles with their source and license notices:

- `godirect` — Vernier Science Education, GNU GPL v3. See <https://github.com/VernierST/godirect-py/blob/main/LICENSE>.
- `bleak` — MIT. See <https://github.com/hbldh/bleak>.
- `FastAPI` — MIT. See <https://github.com/fastapi/fastapi>.
- `Uvicorn` — BSD 3-Clause. See <https://github.com/encode/uvicorn>.

Their transitive dependencies retain their own notices in the installed distributions (`deps/*.dist-info/licenses` or equivalent). The Go Direct library's Python source is included in `deps/godirect/`; the application's Python and JavaScript sources are included in `app/`. Build scripts and corresponding app sources are also available in this public repository and each release's source archive.

Standalone Python runtime distributions are provided by [Astral's python-build-standalone project](https://github.com/astral-sh/python-build-standalone), using CPython and its bundled dependencies under their respective licenses. Runtime licenses are retained in `python/`; upstream build inputs and source references are at the pinned [20261110 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261110). Runtime downloads are SHA-256 verified against `packaging/runtimes.json`.

The Windows installer is built using [NSIS](https://nsis.sourceforge.io/License). The NSIS installer stub uses the zlib/libpng license; its notice is distributed with NSIS source. Native Python dependencies include WinRT components on Windows and PyObjC frameworks on macOS, with their notices retained alongside the bundled packages.
