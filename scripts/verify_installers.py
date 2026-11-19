#!/usr/bin/env python3
"""Check packaged contents and native file types; this does not run target OS code."""
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def verify_manifest(manifest, read):
    for filename, expected in manifest['files'].items():
        actual = hashlib.sha256(read(filename)).hexdigest()
        if actual != expected:
            raise RuntimeError(f'Payload checksum mismatch: {filename}')
    for filename in ('app/desktop.py', 'app/physllama/server.py', 'app/physllama/static/app.js',
                     'app/physllama/devices/pasco.py', 'app/physllama/names.py',
                     'app/physllama/classroom.py', 'app/physllama/csv_export.py',
                     'app/physllama/vendor/pasco/pasco_ble_device.py',
                     'app/physllama/vendor/pasco/datasheets.py',
                     'app/physllama/vendor/pasco/LICENSE',
                     'app/physllama/vendor/pasco/PROVENANCE.json'):
        assert filename in manifest['files'], filename
    assert any('godirect/device.py' in filename for filename in manifest['files'])
    assert any('pydantic_core' in filename for filename in manifest['files'])
    assert 'Download CSV' in read('app/physllama/static/app.js').decode()
    assert manifest['source_commit'] == subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'Rebuild installers after committing source changes.'
    print(f"  {manifest['target']}: verified {len(manifest['files'])} payload files")


def main():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    artifacts = sorted((ROOT / 'dist').glob(f'PhysLlama-{version}-*'))
    artifacts = [p for p in artifacts if p.suffix in ('.exe', '.zip')]
    assert len(artifacts) == 3, 'Expected Windows setup and both Mac installer ZIPs.'
    for artifact in artifacts:
        expected = artifact.with_name(artifact.name + '.sha256').read_text().split()[0]
        assert hashlib.sha256(artifact.read_bytes()).hexdigest() == expected
        print(artifact.name)
        if artifact.suffix == '.zip':
            with zipfile.ZipFile(artifact) as archive:
                assert archive.testzip() is None
                assert 'Open Anyway' in archive.read('START HERE - Mac.txt').decode()
                prefix = 'PhysLlama.app/Contents/Resources/'
                manifest = json.loads(archive.read(prefix + 'BUILD-MANIFEST.json'))
                verify_manifest(manifest, lambda path: archive.read(prefix + path))
                info = plistlib.loads(archive.read('PhysLlama.app/Contents/Info.plist'))
                assert info['NSBluetoothAlwaysUsageDescription']
                assert archive.getinfo('Install PhysLlama.command').external_attr >> 16 & 0o111
                assert archive.getinfo('PhysLlama.app/Contents/MacOS/PhysLlama').external_attr >> 16 & 0o111
                executable = archive.read(prefix + 'python/bin/python3.12')
                assert executable[:4] in (b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe'), 'Expected Mach-O Python executable.'
                assert any('/objc/_objc.' in name for name in archive.namelist())
        else:
            assert artifact.read_bytes()[:2] == b'MZ', 'Expected Windows setup executable.'
            if not shutil.which('7z'):
                raise RuntimeError('Install 7z to verify the Windows installer payload.')
            with tempfile.TemporaryDirectory(prefix='verify-windows-') as temporary:
                subprocess.run(['7z', 'x', '-y', f'-o{temporary}', str(artifact)], check=True, stdout=subprocess.DEVNULL)
                folder = Path(temporary)
                manifest = json.loads((folder / 'BUILD-MANIFEST.json').read_text())
                verify_manifest(manifest, lambda path: (folder / path).read_bytes())
                assert (folder / 'python/pythonw.exe').read_bytes()[:2] == b'MZ'
                assert any(folder.glob('deps/winrt/*.pyd'))
    print('Installer integrity checks passed. Native OS launch/Bluetooth tests remain required.')


if __name__ == '__main__':
    main()
