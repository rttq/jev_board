"""`jevbench` command: start the local server and open the browser."""

import argparse
import os
import sys
import webbrowser
from pathlib import Path

from . import server, store


def find_key(data_dir: Path) -> str | None:
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        f = data_dir / "api_key"
        if f.is_file():
            lines = f.read_text(encoding="utf-8").splitlines()
            key = lines[0].strip() if lines else ""
    return key or None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="jevbench", description="Local workbench for TypeSafe Jev")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data-dir", default=str(Path.home() / ".jevbench"))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir).expanduser()
    try:
        conn, notice = store.open_db(data_dir)
    except OSError as e:
        print(f"cannot use data folder {data_dir}: {e}", file=sys.stderr)
        return 1

    key = find_key(data_dir)
    client = None
    if key:
        from typesafe_sdk import TypeSafeClient
        client = TypeSafeClient(api_key=key)

    ctx = {"conn": conn, "client": client, "data_dir": data_dir, "notice": notice,
           "started_at": store.now(), "key_hint": key[-4:] if key else None, "models": None}
    try:
        httpd = server.make_server(ctx, args.port)
    except OSError:
        print(f"port {args.port} in use, try --port", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{args.port}"
    print(f"jevbench running at {url}  (Ctrl+C to stop)", flush=True)
    print(f"data: {data_dir}", flush=True)
    print(f"api key: found (…{key[-4:]})" if key else
          f"api key: NOT FOUND, set TYPESAFE_API_KEY or put it in {data_dir / 'api_key'}", flush=True)
    if notice:
        print(f"notice: {notice}", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
