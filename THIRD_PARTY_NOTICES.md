# Third-party components

The locally bundled Plotly.js basic distribution is licensed under the MIT license. Its complete notice is included in `vernier_lab/static/vendor/plotly-LICENSE`.

Python dependencies are installed separately from PyPI by `start.sh`:

- `godirect` — Vernier Science Education, GNU GPL v3. See <https://github.com/VernierST/godirect-py/blob/main/LICENSE>.
- `bleak` — MIT. See <https://github.com/hbldh/bleak>.
- `FastAPI` — MIT. See <https://github.com/fastapi/fastapi>.
- `Uvicorn` — BSD 3-Clause. See <https://github.com/encode/uvicorn>.

Their transitive dependencies retain their own notices in the installed distributions. A future packaged desktop distribution must include the applicable dependency licenses and satisfy the Go Direct library's GPL source requirements. This private prototype does not include a binary desktop distribution.
