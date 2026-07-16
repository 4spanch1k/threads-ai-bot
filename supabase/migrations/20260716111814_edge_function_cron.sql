create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

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
    'interaction-processor',
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

revoke all on function private.invoke_edge_function(text) from public, anon, authenticated, service_role;

comment on function private.invoke_edge_function(text) is
  'Invokes one allowlisted Threads bot Edge Function using secrets stored in Supabase Vault.';
