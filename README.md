# Threads Lead Bot

Серверная автоматизация для Threads-аккаунта Mononyx: приём replies, поиск коммерческих запросов, классификация лидов и публикация контента. Система работает без постоянного сервера и по умолчанию остаётся в обязательном `SHADOW_MODE=true`.

## Архитектура

```text
Meta webhook -> Cloudflare Worker -> Supabase interactions/content_queue
                                             |
                                      Supabase Cron
                                             |
                                  Supabase Edge Functions
                         processor / poster / keyword radar
                                             |
                              Groq / Threads / Telegram
```

Cloudflare Worker только проверяет подпись и выполняет идемпотентный ingestion. Supabase Cron запускает короткоживущие Edge Functions. Python-задания и GitHub Actions сохранены как ручной резерв, но автоматических GitHub-расписаний нет.

## Структура

- `worker/` — Cloudflare Worker и интеграционные тесты.
- `supabase/schema.sql` — таблицы, индексы, RLS и атомарные RPC очередей.
- `supabase/functions/` — Edge Functions на TypeScript/Deno и их тесты.
- `supabase/migrations/` — инфраструктурные миграции для Cron и `pg_net`.
- `supabase/cron_setup.sql` — безопасная установка расписаний.
- `supabase/cron_teardown.sql` — удаление расписаний без удаления данных.
- `bot/` — резервные Python-задания для ручного запуска.
- `.github/workflows/` — только ручной резерв и ручной CI.
- `config/keywords.json` — запросы Keyword Radar.

## 1. База Supabase

Для нового проекта целиком выполните `supabase/schema.sql` в SQL Editor, затем `supabase/verify_security.sql`. Второй скрипт завершится ошибкой, если публичные роли получили доступ, RLS выключен или права `service_role` настроены неверно.

Схема:

- запрещает доступ `anon` и `authenticated` по умолчанию;
- разрешает серверный доступ только `service_role`;
- получает задания только через атомарные `claim_interactions` и `claim_due_content` с `FOR UPDATE SKIP LOCKED`;
- восстанавливает просроченные lease и переводит исчерпанные retry в `dead_letter`.

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

Endpoints после деплоя:

```text
Webhook:             https://<worker-name>.<account>.workers.dev/webhook
OAuth redirect:      https://<worker-name>.<account>.workers.dev/oauth/callback
Deauthorize callback:https://<worker-name>.<account>.workers.dev/oauth/deauthorize
Data deletion:       https://<worker-name>.<account>.workers.dev/data-deletion
OAuth start:         https://<worker-name>.<account>.workers.dev/oauth/start
```

В Meta Webhooks используйте тот же `META_WEBHOOK_VERIFY_TOKEN`. Worker проверяет `X-Hub-Signature-256` по исходным байтам тела до разбора JSON.

`LOG_WEBHOOK_PAYLOADS=true` разрешается включать только на время сверки реального тестового события. После проверки сразу верните `false`: payload может содержать персональные данные.

## 3. Edge Functions и секреты

Установите Supabase CLI, войдите и привяжите репозиторий к проекту:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

После `db push` снова выполните `supabase/verify_security.sql` в SQL Editor: он дополнительно проверит, что приватную Cron-функцию нельзя вызвать через роли Data API.

Создайте локальный файл `supabase/.env.functions`. Он игнорируется Git и должен содержать только реальные значения для Edge Functions:

```dotenv
CRON_SECRET=<длинная случайная строка>
THREADS_ACCESS_TOKEN=<token>
THREADS_USER_ID=<id>
GROQ_API_KEY=<key>
GROQ_MODEL=llama-3.3-70b-versatile
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<id>
WHATSAPP_CONTACT_LINK=https://wa.me/77000000000
SHADOW_MODE=true
OWN_THREADS_USERNAME=mononyx
```

Не присылайте значения в чат и не вводите секрет прямо в аргумент команды. Загрузите файл целиком:

```bash
npx supabase secrets set --env-file supabase/.env.functions
```

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Supabase автоматически предоставляет размещённым Edge Functions. Не добавляйте service role key в клиентский код.

Задеплойте три функции:

```bash
npx supabase functions deploy interaction-processor --no-verify-jwt
npx supabase functions deploy content-poster --no-verify-jwt
npx supabase functions deploy keyword-radar --no-verify-jwt
```

Публичная JWT-проверка отключена намеренно: каждый endpoint принимает только `POST` с отдельным заголовком `x-cron-secret`, который сравнивается с `CRON_SECRET`. Значение должно содержать минимум 32 случайных символа и использоваться только для Cron.

## 4. Supabase Vault и Cron

В Supabase Dashboard откройте Database → Vault и создайте два секрета:

- `project_url` — `https://<project-ref>.supabase.co`;
- `cron_secret` — в точности то же значение, что записано в `CRON_SECRET` Edge Functions.

Не помещайте значения в репозиторий или чат. После создания секретов выполните `supabase/cron_setup.sql` в SQL Editor. Скрипт проверит Vault, заменит только расписания этого проекта и установит:

- Interaction Processor — на 7/17/27/37/47/57 минуте;
- Content Poster — на 13/28/43/58 минуте;
- Keyword Radar — каждые 3 часа на 23-й минуте.

Проверка установки находится в последнем `SELECT` скрипта. Для остановки расписаний без удаления функций и данных выполните `supabase/cron_teardown.sql`.

После установки вручную вызовите безопасный processor и проверьте Edge Function Logs:

```sql
select private.invoke_edge_function('interaction-processor');
```

Ожидаемый результат — числовой request id, затем запись `job_complete` в логах функции. Сам `CRON_SECRET` в логи не выводится.

## 5. Shadow mode

Пока `SHADOW_MODE=true`:

- processor сохраняет классификацию и черновик, но не отвечает в Threads и не отправляет Telegram;
- content poster не получает задания из очереди и ничего не публикует;
- keyword radar только читает публичный поиск и сохраняет найденные посты;
- keyword radar никогда не отвечает под чужими публикациями автоматически.

Не выключайте режим до ручной проверки 100–200 классифицированных записей. После калибровки переход к реальным действиям выполняется отдельным явным решением.

## 6. Контент

Добавить текстовый пост в очередь:

```sql
insert into public.content_queue (text, status, scheduled_at)
values ('Текст публикации', 'scheduled', now() + interval '30 minutes');
```

Для изображения укажите публичный `media_url`. URL с расширением `.mp4`, `.mov` или `.webm` считается видео; остальные media URL считаются изображениями. Публикация начнётся только после явного переключения `SHADOW_MODE=false`.

## 7. Ручной резерв через GitHub

Workflows `Interaction Processor`, `Content Poster` и `Keyword Radar` запускаются только через `workflow_dispatch`. Расписаний в GitHub больше нет, поэтому работа бота не зависит от Actions, платёжного метода или включённого Mac.

Если резерв нужен, GitHub Secrets остаются прежними, а Repository Variable `SHADOW_MODE` должна быть `true`.

## 8. Локальные проверки

```bash
python3 -m compileall -q bot tests
python3 -m unittest discover -s tests -v

deno fmt --check supabase/functions
deno task --config supabase/functions/deno.json check
deno task --config supabase/functions/deno.json test

cd worker
npm ci
npm run typecheck
npm test
npm run deploy:dry
```

## Безопасность

- Никогда не коммитьте `.env`, `.dev.vars`, токены и ключи.
- Edge Functions защищены отдельным `CRON_SECRET`; его нет в URL и теле запроса.
- Vault хранит URL проекта и Cron secret для `pg_net`.
- Повторная доставка webhook не меняет существующую запись: используется `ON CONFLICT DO NOTHING`.
- При ошибке ingestion Worker возвращает `503`, чтобы Meta повторил доставку.
- Внешние действия выключены по умолчанию через `SHADOW_MODE=true`.

Документация: [Supabase Scheduled Functions](https://supabase.com/docs/guides/functions/schedule-functions), [Supabase Cron](https://supabase.com/docs/guides/cron), [Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets), [Edge Function Auth](https://supabase.com/docs/guides/functions/auth), [Cloudflare Workers](https://developers.cloudflare.com/workers/) и [официальный Threads API workspace](https://www.postman.com/meta/threads/overview).
