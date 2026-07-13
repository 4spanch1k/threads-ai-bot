from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def log(message: str, **fields: Any) -> None:
    print(json.dumps({"message": message, **fields}, ensure_ascii=False, default=str), flush=True)
