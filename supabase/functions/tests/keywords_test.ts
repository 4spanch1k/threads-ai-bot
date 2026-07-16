import { KEYWORD_QUERIES } from "../_shared/keywords.ts";
import { assertEquals } from "./assert.ts";

Deno.test("deployed keyword list matches the repository configuration", async () => {
  const config = JSON.parse(
    await Deno.readTextFile("../../config/keywords.json"),
  ) as Array<{
    query: string;
    search_type: "TOP" | "RECENT";
    search_mode: "KEYWORD" | "TAG";
  }>;
  const normalized = config.map((item) => ({
    query: item.query,
    searchType: item.search_type,
    searchMode: item.search_mode,
  }));
  assertEquals(KEYWORD_QUERIES, normalized);
});
