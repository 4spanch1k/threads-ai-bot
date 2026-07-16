from __future__ import annotations

import unittest
from unittest.mock import patch

from bot.jobs.content_poster import main


class ContentPosterTests(unittest.TestCase):
    @patch.dict("os.environ", {"SHADOW_MODE": "true"}, clear=True)
    @patch("bot.jobs.content_poster.ThreadsClient")
    @patch("bot.jobs.content_poster.SupabaseClient")
    def test_shadow_mode_skips_before_loading_clients(
        self,
        database_client: object,
        threads_client: object,
    ) -> None:
        main()

        database_client.assert_not_called()  # type: ignore[attr-defined]
        threads_client.assert_not_called()  # type: ignore[attr-defined]


if __name__ == "__main__":
    unittest.main()
