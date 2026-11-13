# Contract: `jevbench` CLI

```
jevbench [--port PORT] [--data-dir DIR] [--no-browser]
python -m jevbench [same flags]
```

| Flag | Default | Effect |
|------|---------|--------|
| `--port` | `8765` | Port on 127.0.0.1. If busy, exit 1 with "port N in use, try --port". |
| `--data-dir` | `~/.jevbench` | Where the DB and images live. Created if missing. |
| `--no-browser` | off | Don't auto-open the browser. |

Startup output (stdout):

```
jevbench running at http://127.0.0.1:8765  (Ctrl+C to stop)
data: C:\Users\me\.jevbench
api key: found (…ab12)            # or: NOT FOUND, set TYPESAFE_API_KEY in <project>/.env
```

Exit codes: `0` stopped with Ctrl+C · `1` startup error (port busy, data dir not writable).

The server binds to `127.0.0.1` only. There is no flag to bind elsewhere in v1.
