"""Command-line launcher for local or network Bluetooth data collection."""
import argparse
import threading
import webbrowser

import uvicorn


def listening_port(value):
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('Port must be an integer from 1 to 65535.') from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError('Port must be an integer from 1 to 65535.')
    return port


def main(argv=None):
    parser = argparse.ArgumentParser(description='Vernier Lab — local Bluetooth data collection')
    parser.add_argument('--server', action='store_true',
                        help='Listen on 0.0.0.0 for network access; do not open a browser.')
    parser.add_argument('--port', type=listening_port, default=8765,
                        help='Listening port (default: 8765).')
    parser.add_argument('--no-browser', action='store_true', help='Do not open a browser on startup.')
    args = parser.parse_args(argv)
    from vernier_lab.server import create_app

    if not args.no_browser and not args.server:
        threading.Timer(1.5, webbrowser.open, args=(f'http://127.0.0.1:{args.port}',)).start()
    uvicorn.run(create_app(server_mode=args.server), host='0.0.0.0' if args.server else '127.0.0.1',
                port=args.port, log_level='info')


if __name__ == '__main__':
    main()
