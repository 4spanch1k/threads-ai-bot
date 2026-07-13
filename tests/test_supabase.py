from __future__ import annotations

import unittest

from bot.config import SupabaseSettings
from bot.supabase import SupabaseClient


class SupabaseClientTests(unittest.TestCase):
    def test_new_secret_key_is_not_sent_as_bearer_token(self) -> None:
        client = SupabaseClient(
            SupabaseSettings(
                url="https://project.supabase.co",
                service_role_key="sb_secret_test-key",
            )
        )

        self.assertEqual(client.headers["apikey"], "sb_secret_test-key")
        self.assertNotIn("Authorization", client.headers)

    def test_legacy_service_role_key_keeps_bearer_header(self) -> None:
        client = SupabaseClient(
            SupabaseSettings(
                url="https://project.supabase.co",
                service_role_key="legacy-service-role-key",
            )
        )

        self.assertEqual(client.headers["Authorization"], "Bearer legacy-service-role-key")


if __name__ == "__main__":
    unittest.main()
