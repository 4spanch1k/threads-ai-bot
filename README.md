# Threads Lead Bot

Серверная автоматизация для Threads-аккаунта Mononyx: приём replies, поиск коммерческих запросов, классификация лидов и публикация контента. Система работает без постоянного сервера и по умолчанию остаётся в обязательном `SHADOW_MODE=true`.

## Архитектура

```text
Meta webhook -> Cloudflare Worker --------------------+
                                                      |
Supabase Cron -> Threads polling fallback ------------+-> Supabase interactions
                                                      |           |
                                                      |    Interaction Processor
                                                      |           |
                                                      +-> Groq / Threads / Telegram

Supabase Cron -> Content Generator -> content_queue -> Content Poster -> Threads
Supabase Cron -> Keyword Radar -------------------------------> Supabase
```

Cloudflare Worker остаётся основным проверенным ingestion-каналом. `interaction-poller` — резерв на случай, если Meta не доставляет production webhook: он раз в 5 минут читает replies к пяти последним собственным публикациям и mentions через официальный Threads API. Оба канала используют одинаковые детерминированные `source_item_id`, поэтому повторное получение события не создаёт дубль и не откатывает его статус. Supabase Cron запускает короткоживущие Edge Functions. Python-задания и GitHub Actions сохранены как ручной резерв, но автоматических GitHub-расписаний нет.

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
CONTENT_GENERATION_BATCH_SIZE=7
```

Не присылайте значения в чат и не вводите секрет прямо в аргумент команды. Загрузите файл целиком:

```bash
npx supabase secrets set --env-file supabase/.env.functions
```

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Supabase автоматически предоставляет размещённым Edge Functions. Не добавляйте service role key в клиентский код.

Задеплойте пять функций:

```bash
npx supabase functions deploy interaction-poller --no-verify-jwt
npx supabase functions deploy interaction-processor --no-verify-jwt
npx supabase functions deploy content-generator --no-verify-jwt
npx supabase functions deploy content-poster --no-verify-jwt
npx supabase functions deploy keyword-radar --no-verify-jwt
```

Публичная JWT-проверка отключена намеренно: каждый endpoint принимает только `POST` с отдельным заголовком `x-cron-secret`, который сравнивается с `CRON_SECRET`. Значение должно содержать минимум 32 случайных символа и использоваться только для Cron.

## 4. Supabase Vault и Cron

В Supabase Dashboard откройте Database → Vault и создайте два секрета:

- `project_url` — `https://<project-ref>.supabase.co`;
- `cron_secret` — в точности то же значение, что записано в `CRON_SECRET` Edge Functions.

Не помещайте значения в репозиторий или чат. После создания секретов выполните `supabase/cron_setup.sql` в SQL Editor. Скрипт проверит Vault, заменит только расписания этого проекта и установит:

- Interaction Poller — каждые 5 минут, начиная с 1-й минуты часа;
- Interaction Processor — каждые 5 минут, через минуту после poller;
- Content Generator — каждые 6 часов на 39-й минуте;
- Content Poster — на 13/28/43/58 минуте;
- Keyword Radar — каждые 3 часа на 23-й минуте.

Проверка установки находится в последнем `SELECT` скрипта. Для остановки расписаний без удаления функций и данных выполните `supabase/cron_teardown.sql`.

После установки вручную вызовите безопасный processor и проверьте Edge Function Logs:

```sql
select private.invoke_edge_function('interaction-processor');
```

Ожидаемый результат — числовой request id, затем запись `job_complete` в логах функции. Сам `CRON_SECRET` в логи не выводится.

Для отдельной проверки polling fallback вызовите:

```sql
select private.invoke_edge_function('interaction-poller');
```

Poller не классифицирует события и не выполняет внешних действий. Он только вставляет новые `reply:<id>` и `mention:<id>` в `interactions`; обработка остаётся в существующем processor. При расписании из `cron_setup.sql` типичная задержка между новым комментарием и запуском processor составляет 1–6 минут. Poller ограничен пятью последними собственными публикациями и 50 свежими событиями на запрос, чтобы не расходовать API-вызовы без необходимости.

## 5. Shadow mode

Пока `SHADOW_MODE=true`:

- interaction poller читает replies/mentions и безопасно сохраняет только новые события;
- processor сохраняет классификацию и черновик, но не отвечает в Threads и не отправляет Telegram;
- content generator создаёт только черновики AI-постов и не планирует их публикацию;
- content poster не получает задания из очереди и ничего не публикует;
- keyword radar только читает публичный поиск и сохраняет найденные посты;
- keyword radar никогда не отвечает под чужими публикациями автоматически.

Не выключайте режим до ручной проверки 100–200 классифицированных записей. После калибровки переход к реальным действиям выполняется отдельным явным решением.

## 6. Контент

После применения миграций загрузите подтверждённый профиль Mononyx через SQL Editor:

```sql
-- Выполните весь файл supabase/seed_content_profile.sql.
```

Файл содержит только подтверждённые человеком факты, в том числе реальные стартовые цены: лендинг от 49 990 ₸, многостраничный сайт от 89 990 ₸ и WhatsApp/Telegram-бот от 200 000 ₸. Для мобильного приложения цена определяется после обсуждения. Любые другие цифры, сроки, показатели продаж, заявок и ROI генератору запрещены.

Профиль задаёт пять ежедневных слотов по времени Алматы (`Asia/Almaty`, UTC+5): 09:00, 11:30, 14:30, 17:00 и 20:00. В базе они хранятся как 04:00, 06:30, 09:30, 12:00 и 15:00 UTC. При `SHADOW_MODE=true` функция `content-generator` создаёт записи со статусом `draft`; они не публикуются. После ручной проверки профиля, черновиков и классификации отдельное решение о выходе из shadow mode позволит генератору создавать `scheduled`-посты, а Content Poster опубликует их через официальный двухшаговый Threads API.

Генератор планирует контент на ближайшие 14 дней, не дублирует уже созданные слоты и соблюдает лимит Threads в 500 символов. Чтобы лента не превращалась в повторы, он детерминированно чередует 15 ракурсов по услугам, проблемам аудитории, процессу работы и возражениям. Последние 25 публикаций передаются в Groq как контекст для подавления повторов. Перед сохранением код отдельно отклоняет неподтверждённые цифры, цену без слова «от», запрещённые ИИ-маркеры и искусственный контраст «не просто X, а Y». Ручная проверка запуска:

```sql
select private.invoke_edge_function('content-generator');

select id, text, status, scheduled_at, origin, generation_key
from public.content_queue
where origin = 'ai_generated'
order by created_at desc
limit 20;
```

Политика ответов под собственными публикациями:

- `lead` с уверенностью `medium` или `high` получает персонализированный мягкий ответ;
- `lead` с `low`, `engagement`, `spam` и события с risk-флагами сохраняются для анализа, но бот их игнорирует;
- Keyword Radar никогда не отвечает под чужими публикациями автоматически;
- в `SHADOW_MODE=true` любые ответы остаются черновиками.

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
