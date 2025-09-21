# SQLite Viewer

A minimalist, fast SQLite database viewer served directly with Python's standard library. It keeps track of the last opened database, supports very large text/blob fields, and exposes a snappy UI for browsing tables.

## Features
- Persist the most recently opened database path between refreshes.
- Inspect tables/views, column metadata, and row counts.
- Paginated row browsing with configurable ordering and page sizes.
- Inline previews for large text and blob values with modal expansion + blob download.
- Pure Python backend (no external packages) and static vanilla JS frontend.

## Running
```bash
python3 server.py
```

Environment variables:
- `PORT`: change the listening port (default `8000`).
- `HOST`: override the bind host if needed (default `127.0.0.1`).

The app serves at `http://127.0.0.1:<PORT>` by default. Open it in your browser, provide a database path, and start exploring.
