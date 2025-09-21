#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import sqlite3
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
STATE_FILE = DATA_DIR / "active_db.json"

_lock = threading.Lock()
_connection: Optional[sqlite3.Connection] = None
_current_db_path: Optional[str] = None
_row_count_cache: Dict[str, int] = {}
_table_sql_cache: Dict[str, str] = {}
_table_has_rowid_cache: Dict[str, bool] = {}


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_state() -> None:
    if not STATE_FILE.exists():
        return
    try:
        data = json.loads(STATE_FILE.read_text())
    except json.JSONDecodeError:
        return
    path = data.get("path")
    if path:
        try:
            connect_to_db(path)
        except Exception:
            pass


def _persist_state() -> None:
    if _current_db_path is None:
        if STATE_FILE.exists():
            STATE_FILE.unlink(missing_ok=True)
        return
    payload = {"path": _current_db_path}
    STATE_FILE.write_text(json.dumps(payload, indent=2))


def connect_to_db(path: str) -> None:
    global _connection, _current_db_path, _row_count_cache, _table_sql_cache, _table_has_rowid_cache

    db_path = Path(path).expanduser()
    if not db_path.is_file():
        raise FileNotFoundError(f"SQLite database not found: {db_path}")

    new_conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    new_conn.row_factory = sqlite3.Row

    with _lock:
        if _connection is not None:
            _connection.close()
        _connection = new_conn
        _current_db_path = str(db_path)
        _row_count_cache = {}
        _table_sql_cache = {}
        _table_has_rowid_cache = {}
        _persist_state()


def _require_connection() -> sqlite3.Connection:
    if _connection is None:
        raise RuntimeError("No database open")
    return _connection


def _quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _get_table_sql(conn: sqlite3.Connection, table: str) -> Optional[str]:
    cached = _table_sql_cache.get(table)
    if cached is not None:
        return cached
    cursor = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
        (table,),
    )
    row = cursor.fetchone()
    sql = row["sql"] if row else None
    _table_sql_cache[table] = sql
    return sql


def _table_has_rowid(conn: sqlite3.Connection, table: str) -> bool:
    cached = _table_has_rowid_cache.get(table)
    if cached is not None:
        return cached
    sql = _get_table_sql(conn, table)
    if not sql:
        result = True
    else:
        result = "WITHOUT ROWID" not in sql.upper()
    _table_has_rowid_cache[table] = result
    return result


def _get_columns(conn: sqlite3.Connection, table: str) -> List[Dict[str, Any]]:
    cursor = conn.execute(f"PRAGMA table_info({_quote_identifier(table)})")
    return [dict(row) for row in cursor.fetchall()]


def _get_row_count(conn: sqlite3.Connection, table: str) -> Optional[int]:
    cached = _row_count_cache.get(table)
    if cached is not None:
        return cached
    try:
        cursor = conn.execute(f"SELECT COUNT(*) AS cnt FROM {_quote_identifier(table)}")
        count = cursor.fetchone()["cnt"]
        _row_count_cache[table] = count
        return count
    except sqlite3.DatabaseError:
        return None


def _serialize_preview(value: Any) -> Dict[str, Any]:
    if value is None:
        return {"kind": "null"}
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return {"kind": "text", "preview": repr(value), "length": len(repr(value)), "hasMore": False}
        return {"kind": "number", "value": value}
    if isinstance(value, bytes):
        preview_len = min(len(value), 256)
        preview = base64.b64encode(value[:preview_len]).decode("ascii")
        return {
            "kind": "blob",
            "size": len(value),
            "preview": preview,
            "previewEncoding": "base64",
            "hasMore": len(value) > preview_len,
        }
    if isinstance(value, str):
        limit = 512
        truncated = len(value) > limit
        preview = value if not truncated else value[:limit]
        return {
            "kind": "text",
            "preview": preview,
            "length": len(value),
            "hasMore": truncated,
        }
    return {"kind": "text", "preview": repr(value), "length": len(repr(value)), "hasMore": False}


def _serialize_full(value: Any) -> Dict[str, Any]:
    if value is None:
        return {"kind": "null"}
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return {"kind": "text", "value": repr(value)}
        return {"kind": "number", "value": value}
    if isinstance(value, bytes):
        payload = base64.b64encode(value).decode("ascii")
        return {
            "kind": "blob",
            "size": len(value),
            "data": payload,
            "encoding": "base64",
        }
    if isinstance(value, str):
        return {"kind": "text", "value": value, "length": len(value)}
    return {"kind": "text", "value": repr(value)}


def _list_tables(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    cursor = conn.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type='table' DESC, name"
    )
    result = []
    for row in cursor.fetchall():
        item = {"name": row["name"], "type": row["type"]}
        if row["type"] == "table":
            count = _get_row_count(conn, row["name"])
            item["rowCount"] = count
        result.append(item)
    return result


def _safe_table_name(conn: sqlite3.Connection, table: str) -> str:
    cursor = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
        (table,),
    )
    if cursor.fetchone() is None:
        raise ValueError(f"Table or view not found: {table}")
    return table


def _safe_column_name(columns: List[Dict[str, Any]], column: str) -> str:
    column_names = {col["name"] for col in columns}
    if column not in column_names:
        raise ValueError(f"Column not found: {column}")
    return column


def _build_select(table: str, columns: List[Dict[str, Any]], has_rowid: bool) -> str:
    column_list = ", ".join(_quote_identifier(col["name"]) for col in columns)
    if has_rowid:
        return f"rowid AS __rowid__, {column_list}"
    return column_list


def _coerce_limit(value: Optional[str]) -> int:
    if not value:
        return 100
    try:
        parsed = int(value)
    except ValueError:
        return 100
    return max(1, min(parsed, 500))


def _coerce_offset(value: Optional[str]) -> int:
    if not value:
        return 0
    try:
        parsed = int(value)
    except ValueError:
        return 0
    return max(0, parsed)


def _coerce_direction(value: Optional[str]) -> str:
    if not value:
        return "asc"
    lowered = value.lower()
    return "desc" if lowered == "desc" else "asc"


def handle_get_status(handler: "ApiRequestHandler") -> None:
    payload = {
        "ready": _connection is not None,
        "dbPath": _current_db_path,
        "dbExists": bool(_current_db_path and Path(_current_db_path).is_file()),
    }
    handler.respond_json(payload)


def handle_post_open(handler: "ApiRequestHandler") -> None:
    data = handler.read_json_body()
    if not isinstance(data, dict) or "path" not in data:
        handler.respond_json({"error": "Missing 'path'"}, status=HTTPStatus.BAD_REQUEST)
        return
    try:
        connect_to_db(str(data["path"]))
    except FileNotFoundError as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.NOT_FOUND)
        return
    except Exception as exc:  # pragma: no cover - unexpected
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
        return
    handler.respond_json({"ok": True, "dbPath": _current_db_path})


def handle_get_tables(handler: "ApiRequestHandler") -> None:
    try:
        conn = _require_connection()
    except RuntimeError as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        return
    tables = _list_tables(conn)
    handler.respond_json({"tables": tables})


def handle_get_table_info(handler: "ApiRequestHandler", table: str) -> None:
    try:
        conn = _require_connection()
        table = _safe_table_name(conn, table)
        columns = _get_columns(conn, table)
        has_rowid = _table_has_rowid(conn, table)
        row_count = _get_row_count(conn, table) if any(col["pk"] for col in columns) or has_rowid else _get_row_count(conn, table)
        payload = {
            "name": table,
            "columns": columns,
            "hasRowid": has_rowid,
            "primaryKeys": [col["name"] for col in columns if col.get("pk")],
            "rowCount": row_count,
        }
        handler.respond_json(payload)
    except (RuntimeError, ValueError) as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)


def handle_get_table_rows(handler: "ApiRequestHandler", table: str) -> None:
    params = handler.query
    try:
        conn = _require_connection()
        table = _safe_table_name(conn, table)
        columns = _get_columns(conn, table)
        has_rowid = _table_has_rowid(conn, table)
        limit = _coerce_limit(params.get("limit", [None])[0])
        offset = _coerce_offset(params.get("offset", [None])[0])
        order_by_param = params.get("orderBy", [None])[0]
        direction = _coerce_direction(params.get("dir", [None])[0])

        if order_by_param:
            order_column = _safe_column_name(columns, order_by_param)
            order_clause = f"ORDER BY {_quote_identifier(order_column)} {direction.upper()}"
            effective_order = order_column
        elif has_rowid:
            order_clause = f"ORDER BY rowid {direction.upper()}"
            effective_order = "rowid"
        else:
            fallback = columns[0]["name"] if columns else None
            if fallback:
                order_clause = f"ORDER BY {_quote_identifier(fallback)} {direction.upper()}"
            else:
                order_clause = ""
            effective_order = fallback

        select_clause = _build_select(table, columns, has_rowid)
        sql = f"SELECT {select_clause} FROM {_quote_identifier(table)} {order_clause} LIMIT ? OFFSET ?"
        cursor = conn.execute(sql, (limit, offset))
        fetched = cursor.fetchall()

        rows = []
        for index, row in enumerate(fetched):
            data = {}
            for col in columns:
                data[col["name"]] = _serialize_preview(row[col["name"]])
            rows.append(
                {
                    "offset": offset + index,
                    "rowid": row["__rowid__"] if has_rowid else None,
                    "cells": data,
                }
            )

        payload = {
            "table": table,
            "columns": [col["name"] for col in columns],
            "rows": rows,
            "limit": limit,
            "offset": offset,
            "orderBy": effective_order,
            "orderDir": direction,
            "rowCount": _get_row_count(conn, table),
            "hasRowid": has_rowid,
        }
        handler.respond_json(payload)
    except (RuntimeError, ValueError) as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
    except sqlite3.DatabaseError as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)


def handle_get_table_cell(handler: "ApiRequestHandler", table: str) -> None:
    params = handler.query
    try:
        conn = _require_connection()
        table = _safe_table_name(conn, table)
        columns = _get_columns(conn, table)
        has_rowid = _table_has_rowid(conn, table)

        column_name = params.get("column", [None])[0]
        if not column_name:
            raise ValueError("Missing column parameter")
        column_name = _safe_column_name(columns, column_name)

        direction = _coerce_direction(params.get("dir", [None])[0])
        order_by_param = params.get("orderBy", [None])[0]
        if order_by_param:
            order_column = _safe_column_name(columns, order_by_param)
            order_clause = f"ORDER BY {_quote_identifier(order_column)} {direction.upper()}"
        elif has_rowid:
            order_clause = f"ORDER BY rowid {direction.upper()}"
        elif columns:
            order_clause = f"ORDER BY {_quote_identifier(columns[0]['name'])} {direction.upper()}"
        else:
            order_clause = ""

        if "offset" in params:
            offset = _coerce_offset(params.get("offset", [None])[0])
            sql = f"SELECT {_quote_identifier(column_name)} FROM {_quote_identifier(table)} {order_clause} LIMIT 1 OFFSET ?"
            cursor = conn.execute(sql, (offset,))
        elif has_rowid and "rowid" in params:
            try:
                rowid_value = int(params.get("rowid", [None])[0])
            except (TypeError, ValueError):
                raise ValueError("Invalid rowid")
            sql = f"SELECT {_quote_identifier(column_name)} FROM {_quote_identifier(table)} WHERE rowid = ?"
            cursor = conn.execute(sql, (rowid_value,))
        else:
            raise ValueError("Missing offset or rowid parameter")

        row = cursor.fetchone()
        if row is None:
            handler.respond_json({"error": "Cell not found"}, status=HTTPStatus.NOT_FOUND)
            return

        handler.respond_json({"column": column_name, "value": _serialize_full(row[0])})
    except (RuntimeError, ValueError) as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
    except sqlite3.DatabaseError as exc:
        handler.respond_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)


class ApiRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/api/"):
            self.handle_api_get()
        else:
            super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/api/"):
            self.handle_api_post()
        else:
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Unsupported method")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        # Reduce noise; comment out for debugging
        pass

    # Helpers -----------------------------------------------------
    @property
    def query(self) -> Dict[str, List[str]]:
        parsed = urlparse(self.path)
        return parse_qs(parsed.query)

    def respond_json(self, payload: Dict[str, Any], *, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> Any:
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length) if length else b""
        if not data:
            return {}
        try:
            return json.loads(data.decode("utf-8"))
        except json.JSONDecodeError:
            raise ValueError("Invalid JSON body")

    # API routing -------------------------------------------------
    def handle_api_get(self) -> None:
        parsed = urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        try:
            if parts == ["api", "status"]:
                handle_get_status(self)
            elif parts == ["api", "tables"]:
                handle_get_tables(self)
            elif len(parts) == 3 and parts[:2] == ["api", "table"]:
                table = parts[2]
                handle_get_table_info(self, table)
            elif len(parts) == 4 and parts[:2] == ["api", "table"] and parts[3] == "rows":
                table = parts[2]
                handle_get_table_rows(self, table)
            elif len(parts) == 4 and parts[:2] == ["api", "table"] and parts[3] == "cell":
                table = parts[2]
                handle_get_table_cell(self, table)
            else:
                self.respond_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.respond_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def handle_api_post(self) -> None:
        parsed = urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        try:
            if parts == ["api", "open"]:
                handle_post_open(self)
            else:
                self.respond_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.respond_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)


def run_server(port: int = 8000) -> None:
    _ensure_data_dir()
    _load_state()
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), ApiRequestHandler)
    display_host = "127.0.0.1" if host in ("0.0.0.0", "::", "0:0:0:0:0:0:0:0") else host
    print(f"SQLite Viewer running on http://{display_host}:{port}")
    if _current_db_path:
        print(f"Using database: {_current_db_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        if _connection is not None:
            _connection.close()
        server.server_close()


if __name__ == "__main__":
    port_env = os.environ.get("PORT")
    port = int(port_env) if port_env else 8000
    run_server(port)
