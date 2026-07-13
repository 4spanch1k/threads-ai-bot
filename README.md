# Threads Lead Bot

Серверная автоматизация для Threads-аккаунта Mononyx: приём replies/mentions, поиск коммерческих запросов, классификация лидов и публикация контента. Первая версия запускается в обязательном shadow mode и не отвечает пользователям.

## Архитектура

```text
Meta webhook → Cloudflare Worker → Supabase interactions
                                      ↓
GitHub Actions → classifier/rules → Groq only for ambiguous items
               → Threads replies / Telegram alerts after shadow mode

GitHub Actions → content_queue → Threads container → threads_publish
GitHub Actions → keyword_search → interactions → classifier
```

Worker выполняет только проверку подписи и идемпотентный ingestion. Внешние действия выполняют короткоживущие GitHub Actions.

## Структура

- `worker/` — Cloudflare Worker на TypeScript и интеграционные тесты.
- `supabase/schema.sql` — таблицы, индексы, RLS и атомарные RPC-функции очередей.
- `bot/` — Python-клиенты Supabase, Threads, Groq, Telegram и фоновые задания.
- `config/keywords.json` — фразы и topic tags для radar.
- `.github/workflows/` — processor, poster, radar и CI.
- `tests/` — unit-тесты классификации и shadow mode.

Python-часть использует только стандартную библиотеку, поэтому установка pip-пакетов не требуется.

## 1. Supabase

Создайте бесплатный проект и целиком выполните [`supabase/schema.sql`](supabase/schema.sql) в SQL Editor. Затем выполните [`supabase/verify_security.sql`](supabase/verify_security.sql): скрипт завершится ошибкой, если `anon`/`authenticated` имеют доступ, RLS выключен, появилась неожиданная policy или `service_role` не получил минимально необходимые права.

Схема намеренно:

- включает RLS без политик для `anon` и `authenticated`;
- явно выдаёт Data API права только `service_role`;
- закрывает RPC-функции от публичных ролей;
- использует `FOR UPDATE SKIP LOCKED`;
- увеличивает `attempts` при каждом claim;
- переводит просроченные lease в retry/dead-letter.

## 2. Cloudflare Worker

Требуется Node.js 24+.

```bash
cd worker
npm ci
npx wrangler login
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npm run deploy:dry
npm run deploy
```

Webhook endpoint после деплоя:

```text
https://<worker-name>.<account>.workers.dev/webhook
```

Meta Threads API settings callbacks:

```text
OAuth redirect URL: https://<worker-name>.<account>.workers.dev/oauth/callback
Deauthorize callback: https://<worker-name>.<account>.workers.dev/oauth/deauthorize
Data deletion callback: https://<worker-name>.<account>.workers.dev/data-deletion
```

Оба callback принимают подписанный `signed_request`, проверяют HMAC-SHA256 через
`META_APP_SECRET` и не выводят идентификатор пользователя или секреты в логи.

Для первичного получения Threads-токена откройте в том же браузере, где выполнен вход в Threads:

```text
https://<worker-name>.<account>.workers.dev/oauth/start
```

Worker проверяет подписанный одноразовый `state`, обменивает код на долгосрочный токен и показывает
`THREADS_ACCESS_TOKEN` и `THREADS_USER_ID` только в браузере. Токен не сохраняется в Worker и не
попадает в логи. После копирования закройте вкладку и добавьте оба значения в GitHub Secrets.

В Meta App используйте тот же `META_WEBHOOK_VERIFY_TOKEN` и подпишитесь на доступные события replies/mentions. Worker проверяет `X-Hub-Signature-256` по исходным байтам тела до `JSON.parse`.

Структура Threads webhook может меняться. Для первого тестового события можно временно изменить `LOG_WEBHOOK_PAYLOADS` на `"true"` в `worker/wrangler.jsonc`, задеплоить Worker и сверить payload в Workers Logs. Сразу верните значение `"false"`: raw payload может содержать персональные данные.

## 3. GitHub Secrets и Variables

Добавьте в Repository Settings → Secrets and variables → Actions:

### Secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `THREADS_ACCESS_TOKEN`
- `THREADS_USER_ID`
- `GROQ_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WHATSAPP_CONTACT_LINK`

### Variables

- `SHADOW_MODE=true` — обязательное стартовое значение.
- `GROQ_MODEL=llama-3.3-70b-versatile` — можно заменить без изменения кода.
- `OWN_THREADS_USERNAME=mononyx` — исключает собственные посты из radar.

Workflow процессора запускается на 7/17/27/37/47/57 минуте каждого часа. Расписание GitHub приблизительное; фактическая готовность retry определяется `next_retry_at` в БД.

## 4. Shadow mode

В shadow mode процессор:

- сохраняет `intent`, `signals`, `risk_flags`, `confidence_level` и черновик ответа;
- не вызывает Threads reply;
- не отправляет Telegram;
- завершает запись статусом `classified`.

После ручной проверки 100–200 записей и калибровки правил задайте Repository Variable `SHADOW_MODE=false`. Новые записи начнут обрабатываться по матрице:

| Класс | Confidence | Действие |
|---|---|---|
| spam | любой | сохранить, ничего не делать |
| engagement | low/medium | только черновик |
| engagement | high | ответ для собственных replies |
| lead | medium | Telegram |
| lead | high | мягкий CTA + Telegram |
| risk flags | любой | Telegram для ручного разбора, без ответа |

На чужие посты из keyword radar бот никогда не отвечает автоматически.

## 5. Контент

Поставить текстовый пост в очередь:

```sql
insert into public.content_queue (text, status, scheduled_at)
values ('Текст публикации', 'scheduled', now() + interval '30 minutes');
```

Для изображения укажите публичный `media_url`. URL с расширением `.mp4`, `.mov` или `.webm` считается видео; остальные media URL считаются изображениями.

## 6. Локальные проверки

```bash
python3 -m compileall -q bot tests
python3 -m unittest discover -s tests -v

cd worker
npm ci
npm run typecheck
npm test
npm run deploy:dry
```

## Секреты и безопасность

- Никогда не коммитьте `.env`, `.dev.vars`, service role key и access tokens.
- `SUPABASE_SERVICE_ROLE_KEY` используется только Worker и GitHub Actions.
- В `SUPABASE_SERVICE_ROLE_KEY` можно и рекомендуется сохранить новый Supabase Secret key
  (`sb_secret_...`); имя переменной оставлено прежним для совместимости конфигурации.
- В логах нет токенов и ключей.
- При ошибке ingestion Worker возвращает `503`, чтобы Meta повторил доставку.
- Повторная доставка не меняет уже существующую запись: используется `ON CONFLICT DO NOTHING`.

Актуальные контракты сверены по [Cloudflare Workers docs](https://developers.cloudflare.com/workers/), [Supabase docs](https://supabase.com/docs), [официальному workspace Threads API от Meta](https://www.postman.com/meta/threads/overview) и [Groq API docs](https://console.groq.com/docs/api-reference).
