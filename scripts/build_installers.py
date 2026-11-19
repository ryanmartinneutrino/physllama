#!/usr/bin/env python3
"""Assemble offline installers from verified runtimes and target-native wheels.

No foreign code is compiled or executed. On macOS the ZIP includes an offline
.command installer and .app; Windows uses NSIS to produce a setup executable.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'packaging/runtimes.json').read_text())
VERSION = json.loads((ROOT / 'package.json').read_text())['version']


def download_runtime(target, cache):
    runtime = CONFIG['targets'][target]
    filename = f"cpython-{CONFIG['python']}+{CONFIG['release']}-{runtime['triple']}-install_only_stripped.tar.gz"
    archive = cache / filename
    if not archive.exists():
        url = f"https://github.com/astral-sh/python-build-standalone/releases/download/{CONFIG['release']}/{filename}"
        print(f'Downloading {filename}', flush=True)
        with urllib.request.urlopen(url, timeout=120) as source, archive.open('wb') as output:
            shutil.copyfileobj(source, output)
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != runtime['sha256']:
        raise RuntimeError(f'Runtime checksum mismatch: {archive}. Remove this cached download and retry.')
    return archive


def zip_tree(folder, destination):
    # macOS Archive Utility preserves executable permissions and these symlinks.
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(folder.rglob('*')):
            relative = path.relative_to(folder).as_posix()
            if path.is_symlink():
                info = zipfile.ZipInfo(relative)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.readlink(path))
            elif path.is_file():
                archive.write(path, relative)


def prepare_payload(target, payload, archive, uv):
    payload.mkdir(parents=True)
    # Only extract upstream archives after matching their pinned SHA-256 digest.
    with tarfile.open(archive) as runtime:
        runtime.extractall(payload)
    subprocess.run([uv, 'pip', 'install', '--target', str(payload / 'deps'),
                    '--python-version', '3.12', '--python-platform', CONFIG['targets'][target]['triple'],
                    '--only-binary', ':all:', '--require-hashes',
                    '-r', str(ROOT / f'packaging/requirements-{target}.lock.txt')], check=True)
    app = payload / 'app'
    app.mkdir()
    shutil.copytree(ROOT / 'physllama', app / 'physllama', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for filename in ('desktop.py', 'run.py', 'requirements.txt', 'README.md', 'THIRD_PARTY_NOTICES.md'):
        shutil.copy2(ROOT / filename, app / filename)
    for filename in ('README.md', 'THIRD_PARTY_NOTICES.md'):
        shutil.copy2(ROOT / filename, payload / filename)
    # Full library .py sources and wheel license notices remain in deps/.
    manifest = {'app_version': VERSION, 'target': target, 'python_version': CONFIG['python'],
                'runtime_sha256': CONFIG['targets'][target]['sha256'],
                'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'signed': False, 'native_os_tested': False,
                'files': {p.relative_to(payload).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted(payload.rglob('*')) if p.is_file() and not p.is_symlink()}}
    (payload / 'BUILD-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')


def make_mac(target, workspace, runtime, uv, output):
    distribution = workspace / f'PhysLlama {VERSION}'
    bundle = distribution / 'PhysLlama.app'
    resources = bundle / 'Contents/Resources'
    prepare_payload(target, resources, runtime, uv)
    macos = bundle / 'Contents/MacOS'
    macos.mkdir(parents=True)
    launcher = macos / 'PhysLlama'
    launcher.write_text('#!/bin/sh\nset -eu\nresources="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"\nexec "$resources/python/bin/python3" -I "$resources/app/desktop.py"\n')
    launcher.chmod(0o755)
    info = {'CFBundleName': 'PhysLlama', 'CFBundleDisplayName': 'PhysLlama',
            'CFBundleIdentifier': 'org.physllama.desktop', 'CFBundleVersion': VERSION,
            'CFBundleShortVersionString': VERSION, 'CFBundlePackageType': 'APPL',
            'CFBundleExecutable': 'PhysLlama', 'LSMinimumSystemVersion': '13.0',
            'NSBluetoothAlwaysUsageDescription': 'PhysLlama connects to supported Bluetooth devices to record your experiment.',
            'NSBluetoothPeripheralUsageDescription': 'PhysLlama connects to supported Bluetooth devices to record your experiment.'}
    with (bundle / 'Contents/Info.plist').open('wb') as f:
        plistlib.dump(info, f)
    installer = distribution / 'Install PhysLlama.command'
    installer.write_text((ROOT / 'packaging/install-macos.command').read_text().replace('@ARCH@', 'arm64' if target.endswith('arm64') else 'x86_64'))
    installer.chmod(0o755)
    shutil.copy2(ROOT / 'README.md', distribution / 'README.md')
    shutil.copy2(ROOT / 'packaging/START HERE - Mac.txt', distribution / 'START HERE - Mac.txt')
    destination = output / f'PhysLlama-{VERSION}-{target}-installer.zip'
    zip_tree(distribution, destination)
    return destination


def make_windows(workspace, runtime, uv, output, makensis):
    payload = workspace / 'payload'
    prepare_payload('windows-x64', payload, runtime, uv)
    destination = output / f'PhysLlama-{VERSION}-windows-x64-setup.exe'
    prefix = '/' if sys.platform == 'win32' else '-'
    subprocess.run([makensis, f'{prefix}DVERSION={VERSION}', f'{prefix}DPAYLOAD={payload}',
                    f'{prefix}DOUTPUT={destination}', str(ROOT / 'packaging/windows.nsi')], check=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=[*CONFIG['targets'], 'all'], default='all')
    parser.add_argument('--uv', default=shutil.which('uv') or str(ROOT / '.venv/bin/uv'))
    parser.add_argument('--makensis', default=shutil.which('makensis'))
    args = parser.parse_args()
    targets = list(CONFIG['targets']) if args.target == 'all' else [args.target]
    if 'windows-x64' in targets and not args.makensis:
        parser.error('Install NSIS or supply --makensis to build the Windows setup executable.')
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip():
        parser.error('Commit source changes before building so the bundle identifies its exact source revision.')
    cache, output = ROOT / 'build/runtime-cache', ROOT / 'dist'
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(exist_ok=True)
    for target in targets:
        runtime = download_runtime(target, cache)
        with tempfile.TemporaryDirectory(prefix=f'{target}-', dir=ROOT / 'build') as temporary:
            workspace = Path(temporary)
            result = (make_windows(workspace, runtime, args.uv, output, args.makensis)
                      if target == 'windows-x64' else make_mac(target, workspace, runtime, args.uv, output))
            digest = hashlib.sha256(result.read_bytes()).hexdigest()
            result.with_name(result.name + '.sha256').write_text(f'{digest}  {result.name}\n')
            print(f'Created {result} ({result.stat().st_size / 1024**2:.1f} MiB)', flush=True)


if __name__ == '__main__':
    main()
