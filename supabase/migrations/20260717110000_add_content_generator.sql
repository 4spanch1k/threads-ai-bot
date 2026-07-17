alter table public.content_queue
  add column if not exists origin text not null default 'manual',
  add column if not exists generation_key text;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.content_queue'::regclass
      and conname = 'content_queue_origin_check'
  ) then
    alter table public.content_queue
      add constraint content_queue_origin_check
      check (origin in ('manual', 'ai_generated'));
  end if;
end;
$constraints$;

create unique index if not exists uq_content_queue_generation_key
  on public.content_queue (generation_key);

create table if not exists public.content_profiles (
  id uuid primary key default gen_random_uuid(),
  business_context text not null
    check (char_length(trim(business_context)) between 100 and 20000),
  target_audience text not null
    check (char_length(trim(target_audience)) between 20 and 5000),
  tone_of_voice text not null
    check (char_length(trim(tone_of_voice)) between 10 and 2000),
  publish_times_utc time without time zone[] not null
    default array['12:00'::time without time zone],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint content_profiles_publish_times_check
    check (cardinality(publish_times_utc) between 1 and 10)
);

create unique index if not exists uq_content_profiles_single_active
  on public.content_profiles (is_active)
  where is_active = true;

alter table public.content_profiles enable row level security;

revoke all on table public.content_profiles from anon, authenticated, service_role;
grant select, insert, update on table public.content_profiles to service_role;

create or replace function private.invoke_edge_function(p_function_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_url text;
  v_cron_secret text;
  v_request_id bigint;
begin
  if p_function_name not in (
    'interaction-poller',
    'interaction-processor',
    'content-generator',
    'content-poster',
    'keyword-radar'
  ) then
    raise exception 'Unsupported Edge Function: %', p_function_name;
  end if;

  select decrypted_secret
  into v_project_url
  from vault.decrypted_secrets
  where name = 'project_url'
  limit 1;

  select decrypted_secret
  into v_cron_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if nullif(trim(v_project_url), '') is null then
    raise exception 'Vault secret project_url is missing';
  end if;

  if nullif(trim(v_cron_secret), '') is null then
    raise exception 'Vault secret cron_secret is missing';
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/' || p_function_name,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', v_cron_secret
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 150000
  )
  into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function private.invoke_edge_function(text)
from public, anon, authenticated, service_role;

comment on function private.invoke_edge_function(text) is
  'Invokes one allowlisted Threads bot Edge Function using secrets stored in Supabase Vault.';
