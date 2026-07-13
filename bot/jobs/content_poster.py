from __future__ import annotations

from bot.config import SupabaseSettings, ThreadsSettings, env_int
from bot.jobs.common import log, utc_now
from bot.supabase import SupabaseClient
from bot.threads import ThreadsClient


def main() -> None:
    batch_size = env_int("CONTENT_BATCH_SIZE", 5, maximum=50)
    max_attempts = env_int("MAX_ATTEMPTS", 5, maximum=20)
    database = SupabaseClient(SupabaseSettings.from_env())
    threads = ThreadsClient(ThreadsSettings.from_env())

    items = database.claim_due_content(batch_size=batch_size, max_attempts=max_attempts)
    log("content batch claimed", count=len(items))
    failures = 0
    for item in items:
        try:
            container_id = item.container_id
            if not container_id:
                container_id = threads.create_container(item.text, media_url=item.media_url)
                database.update_content(item.id, {"container_id": container_id})

            post_id = threads.publish_container(container_id)
            database.update_content(
                item.id,
                {
                    "threads_post_id": post_id,
                    "status": "published",
                    "published_at": utc_now(),
                    "processing_started_at": None,
                    "next_retry_at": None,
                    "last_error": None,
                },
            )
            log("content published", content_id=item.id, threads_post_id=post_id)
        except Exception as error:
            failures += 1
            log("content publishing failed", content_id=item.id, error=str(error))
            database.mark_content_failed(item.id, str(error), max_attempts=max_attempts)

    if failures:
        raise SystemExit(f"{failures} content item(s) failed")


if __name__ == "__main__":
    main()
