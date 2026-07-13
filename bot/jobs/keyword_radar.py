from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, cast

from bot.config import SupabaseSettings, ThreadsSettings
from bot.jobs.common import log
from bot.supabase import SupabaseClient
from bot.threads import SearchMode, SearchType, ThreadsClient


def load_queries(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise RuntimeError("Keyword config must contain a JSON array")
    return [item for item in data if isinstance(item, dict)]


def main() -> None:
    config_path = Path(os.getenv("KEYWORD_CONFIG_PATH", "config/keywords.json"))
    own_username = os.getenv("OWN_THREADS_USERNAME", "").strip().casefold()
    database = SupabaseClient(SupabaseSettings.from_env())
    threads = ThreadsClient(ThreadsSettings.from_env())

    inserted = 0
    for query_config in load_queries(config_path):
        query_text = str(query_config.get("query", "")).strip()
        search_type = str(query_config.get("search_type", "RECENT")).upper()
        search_mode = str(query_config.get("search_mode", "KEYWORD")).upper()
        if not query_text or search_type not in {"TOP", "RECENT"} or search_mode not in {"KEYWORD", "TAG"}:
            raise RuntimeError(f"Invalid keyword query config: {query_config}")

        results = threads.keyword_search(
            query_text,
            search_type=cast(SearchType, search_type),
            search_mode=cast(SearchMode, search_mode),
            limit=25,
        )
        for result in results:
            post_id = result.get("id")
            text = result.get("text")
            username = result.get("username")
            if not isinstance(post_id, (str, int)) or not isinstance(text, str) or not text.strip():
                continue
            if own_username and isinstance(username, str) and username.casefold() == own_username:
                continue

            record: dict[str, Any] = {
                "source_item_id": f"keyword_search:{post_id}",
                "source": "keyword_search",
                "event_type": "keyword_hit",
                "post_id": str(post_id),
                "comment_text": text.strip(),
                "signals": [f"query:{query_text}"],
            }
            if isinstance(username, str) and username.strip():
                record["username"] = username.strip()
            database.insert_keyword_interaction(record)
            inserted += 1

        log("keyword query completed", query=query_text, found=len(results))

    log("keyword radar completed", attempted_inserts=inserted)


if __name__ == "__main__":
    main()
