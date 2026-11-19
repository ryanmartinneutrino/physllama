"""Entry point for the offline desktop bundles (Python is bundled alongside it)."""
import json
import logging
import os
from pathlib import Path
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

APP_DIR = Path(__file__).resolve().parent
sys.path[:0] = [str(APP_DIR), str(APP_DIR.parent / 'deps')]


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    if arguments:
        # Bundled Python needs the app/deps path setup above. Reuse the same
        # command-line launcher for instructor mode and custom ports.
        from run import main as launch
        return launch(arguments)
    import uvicorn
    from physllama.server import create_app

    # Reopening the installed app brings the existing experiment back into view.
    # A bound socket also prevents concurrent launches from creating two sessions.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(('127.0.0.1', 8765))
    except OSError:
        listener.close()
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8765/api/app', timeout=1) as response:
                    if json.load(response).get('name') == 'PhysLlama':
                        webbrowser.open('http://127.0.0.1:8765')
                        return
            except (OSError, ValueError):
                time.sleep(.1)
        raise RuntimeError('Port 8765 is already in use. Close the other local server and reopen PhysLlama.')
    listener.listen(128)
    app = create_app(on_shutdown=lambda: setattr(server, 'should_exit', True))
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=8765, log_level='info', use_colors=False))

    def open_when_ready():
        for _ in range(300):
            if server.should_exit:
                return
            if server.started:
                webbrowser.open('http://127.0.0.1:8765')
                return
            time.sleep(.1)

    threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()


def log_directory():
    if sys.platform == 'win32':
        return Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'PhysLlama' / 'Logs'
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Logs' / 'PhysLlama'
    return Path.home() / '.local' / 'state' / 'physllama'


if __name__ == '__main__':
    folder = log_directory()
    folder.mkdir(parents=True, exist_ok=True)
    log = folder / 'app.log'
    sys.stdout = sys.stderr = log.open('w', encoding='utf-8', buffering=1)
    try:
        main()
    except Exception:
        logging.exception('Could not start PhysLlama')
        message = f'PhysLlama could not start. See {log} for details.'
        if sys.platform == 'win32':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, 'PhysLlama', 0x10)
        elif sys.platform == 'darwin':
            import subprocess
            subprocess.run(['osascript', '-e', 'on run argv', '-e', 'display alert "PhysLlama" message (item 1 of argv)', '-e', 'end run', message], check=False)
        raise
