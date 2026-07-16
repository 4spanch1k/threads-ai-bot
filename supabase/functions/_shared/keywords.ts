export interface KeywordQuery {
  query: string;
  searchType: "TOP" | "RECENT";
  searchMode: "KEYWORD" | "TAG";
}

// Kept in code so every Edge Function deployment contains its complete config.
// Update config/keywords.json and this list together; the Deno test checks parity.
export const KEYWORD_QUERIES: readonly KeywordQuery[] = [
  { query: "нужен сайт", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "ищу разработчика", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "кто сделает сайт", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "нужен интернет-магазин", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "нужно приложение", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "нужна автоматизация", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "сайт керек", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "әзірлеуші іздеймін", searchType: "RECENT", searchMode: "KEYWORD" },
  { query: "веб-разработка", searchType: "RECENT", searchMode: "TAG" },
  { query: "малый бизнес", searchType: "RECENT", searchMode: "TAG" },
];
