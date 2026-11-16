"""Desktop-friendly entry point. Run from the project virtual environment."""
import argparse
import threading
import webbrowser

import uvicorn

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Vernier Lab — local Bluetooth data collection')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, args=(f'http://127.0.0.1:{args.port}',)).start()
    uvicorn.run('vernier_lab.server:app', host='127.0.0.1', port=args.port, log_level='info')
