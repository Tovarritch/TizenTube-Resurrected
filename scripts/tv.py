#!/usr/bin/env python3
"""Run JavaScript in TizenTube on the TV (debug APK only) and print the result.

    py scripts/tv.py "location.hash"
    py scripts/tv.py "tt.set('liveChatPosition', 'left')"
    py scripts/tv.py "tt.el('ytlr-live-chat')"
    py scripts/tv.py -s "const v = document.querySelector('video'); return v.currentTime"
    py scripts/tv.py -f check.js

An expression is returned as is; -s runs statements (use return). `tt` helpers:
get/set (TizenTube settings), cmd (YouTube command), el (describe elements),
text (visible text). Needs the debug APK, built with
prepare_android_shell.py --debug-console and build_android_release.py --debug.
The TV is 192.168.178.143:5555 unless TT_TV says otherwise.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PORT = 18946
DEBUG_BUNDLE = Path(__file__).resolve().parents[1] / 'dbgs' / 'userScript.js'
TV = os.environ.get('TT_TV', '192.168.178.143:5555')


def adb_path() -> str:
    found = shutil.which('adb')
    if found:
        return found
    sdk = Path(os.environ.get('LOCALAPPDATA', '')) / 'Android' / 'Sdk' / 'platform-tools' / 'adb.exe'
    if sdk.exists():
        return str(sdk)
    sys.exit('adb not found')


def adb(*args: str) -> str:
    return subprocess.run([adb_path(), *args], capture_output=True, text=True, encoding='utf-8', errors='replace').stdout


TOKEN_CACHE = Path(os.environ.get('TEMP', '.')) / 'tizentube-tv-token'


def token(fresh: bool = False) -> str:
    """The console key: cached on the PC, read again from the TV log when needed
    (the log rotates; the key changes only when the app restarts)."""
    adb('connect', TV)
    adb('-s', TV, 'forward', f'tcp:{PORT}', f'tcp:{PORT}')
    if not fresh and TOKEN_CACHE.exists():
        return TOKEN_CACHE.read_text().strip()
    found = re.findall(r'TTDEV token=([0-9a-z]+)', adb('-s', TV, 'logcat', '-d'))
    if not found:
        sys.exit('No console token in the TV log. Restart the debug app (the key is logged at start).')
    TOKEN_CACHE.write_text(found[-1])
    return found[-1]


def request(method: str, path: str, secret: str, body: bytes = None, timeout: int = 75):
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', data=body, method=method,
                                 headers={'X-TT-Token': secret, 'Content-Type': 'text/plain'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


_secret = None


def run(code: str, timeout: int = 75):
    """Run statements on the TV and return the value; exits on errors."""
    global _secret
    _secret = _secret or token()
    try:
        try:
            command = request('POST', '/cmd', _secret, code.encode('utf-8'))
        except urllib.error.HTTPError as error:
            if error.code != 403:
                raise
            _secret = token(fresh=True)  # the app restarted: new key
            command = request('POST', '/cmd', _secret, code.encode('utf-8'))
        result = request('GET', f"/wait?id={command['id']}", _secret, timeout=timeout)
    except urllib.error.HTTPError as error:
        sys.exit(f'HTTP {error.code}: {error.read().decode("utf-8", "replace")}')
    except urllib.error.URLError as error:
        sys.exit(f'Console not reachable ({error.reason}). Is the debug APK running?')
    if not result.get('ok'):
        sys.exit(f"Error on the TV:\n{result.get('error')}")
    return result.get('value')


def wait_for_page(secret_needed: bool = True, seconds: int = 60) -> None:
    """After a reload: wait until the new page's console answers."""
    deadline = time.time() + seconds
    time.sleep(3)
    while time.time() < deadline:
        try:
            command = request('POST', '/cmd', _secret, b'return window.tizenTubeBuild')
            result = request('GET', f"/wait?id={command['id']}", _secret, timeout=10)
            if result.get('ok') and result.get('value'):
                return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(2)
    sys.exit('The TV did not come back within a minute.')


def main() -> None:
    # Titles can contain any language; the Windows console's default code page cannot.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('code', nargs='?')
    parser.add_argument('-s', '--statements', action='store_true', help='code is statements; use return')
    parser.add_argument('-f', '--file', type=Path, help='run statements from a file')
    parser.add_argument('--load', nargs='?', const=DEBUG_BUNDLE, type=Path, metavar='BUNDLE',
                        help='run a test build (default dbgs/userScript.js) on the TV until --unload; no GitHub push')
    parser.add_argument('--unload', action='store_true', help='go back to the build the APK loads')
    args = parser.parse_args()
    if args.load or args.unload:
        # Stored in localStorage and picked up by dev/override.js after a reload.
        store = (f'localStorage.setItem("tt-dev-bundle", {json.dumps(args.load.read_text(encoding="utf-8"))});'
                 if args.load else 'localStorage.removeItem("tt-dev-bundle");')
        code = store + ' setTimeout(() => location.reload(), 200); return "reloading";'
        run(code)
        wait_for_page(secret_needed=True)
        print(run('return window.tizenTubeBuild + (window.__ttDevOverride ? " (test build from adb)" : " (from the APK)")'))
        return
    if args.file:
        code = args.file.read_text(encoding='utf-8')
    elif args.code:
        code = args.code if args.statements else f'return ({args.code});'
    else:
        parser.error('give code or -f')
    value = run(code)
    print(value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()
