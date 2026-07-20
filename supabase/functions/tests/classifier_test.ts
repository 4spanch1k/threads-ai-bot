import { Classifier } from "../_shared/classifier.ts";
import { assertEquals } from "./assert.ts";

const unusedGroq = {
  classify: () => Promise.reject(new Error("Groq must not be called")),
};

Deno.test("explicit commercial need is a high-confidence lead without Groq", async () => {
  const result = await new Classifier(unusedGroq, "https://wa.me/77000000000")
    .classify("Нужен сайт, сколько стоит разработка?");

  assertEquals(result.intent, "lead");
  assertEquals(result.confidenceLevel, "high");
  assertEquals(result.riskFlags, []);
  assertEquals(result.botReplyText?.includes("https://wa.me/77000000000"), true);
});

Deno.test("known promotion is classified as spam without Groq", async () => {
  const result = await new Classifier(unusedGroq).classify("Казино и гарантированный доход");
  assertEquals(result.intent, "spam");
  assertEquals(result.confidenceLevel, "high");
  assertEquals(result.botReplyText, null);
});

Deno.test("risk flags prevent automatic reply", async () => {
  const result = await new Classifier(unusedGroq).classify("Вы мошенники, верните деньги");
  assertEquals(result.riskFlags, ["complaint"]);
  assertEquals(result.confidenceLevel, "low");
  assertEquals(result.botReplyText, null);
});

Deno.test("ambiguous text is delegated to Groq evidence", async () => {
  const groq = {
    classify: () =>
      Promise.resolve({
        intent: "engagement" as const,
        signals: ["conversation"],
        riskFlags: [],
        proposedReply: "Спасибо за вопрос!",
      }),
  };
  const result = await new Classifier(groq).classify("Что вы думаете об этом?");
  assertEquals(result.intent, "engagement");
  assertEquals(result.confidenceLevel, "high");
  assertEquals(result.botReplyText, null);
});

Deno.test("sarcastic paraphrase is not a lead even when Groq overclassifies it", async () => {
  const groq = {
    classify: () =>
      Promise.resolve({
        intent: "lead" as const,
        signals: ["explicit_need", "service_interest"],
        riskFlags: [],
        proposedReply: "Давайте обсудим сайт.",
      }),
  };
  const result = await new Classifier(groq).classify(
    "Перевожу: у вас нет сайта или он настолько плох, что никто не покупает без менеджера",
  );

  assertEquals(result.intent, "engagement");
  assertEquals(result.confidenceLevel, "high");
  assertEquals(result.botReplyText, null);
  assertEquals(result.signals.includes("explicit_need"), false);
});

Deno.test("a direct service question can remain a lead", async () => {
  const groq = {
    classify: () =>
      Promise.resolve({
        intent: "lead" as const,
        signals: ["explicit_need", "service_interest"],
        riskFlags: [],
        proposedReply: "Да, делаем. Какой сайт вам нужен?",
      }),
  };
  const result = await new Classifier(groq).classify("Вы делаете сайты для клиник?");

  assertEquals(result.intent, "lead");
  assertEquals(result.confidenceLevel, "high");
});

Deno.test("a clarifying question about service scope can remain a lead", async () => {
  const groq = {
    classify: () =>
      Promise.resolve({
        intent: "lead" as const,
        signals: ["explicit_need", "service_interest"],
        riskFlags: [],
        proposedReply: "Сначала уточняем задачу и список страниц.",
      }),
  };
  const result = await new Classifier(groq).classify("Что входит в разработку сайта?");

  assertEquals(result.intent, "lead");
  assertEquals(result.confidenceLevel, "high");
});
