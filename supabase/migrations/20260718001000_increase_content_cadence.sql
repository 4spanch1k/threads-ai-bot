-- pg_cron runs on UTC in this project. These odd UTC hours correspond to
-- 00:00, 02:00, ..., 22:00 in Asia/Almaty (UTC+5).

alter table public.content_profiles
  drop constraint if exists content_profiles_publish_times_check;

alter table public.content_profiles
  add constraint content_profiles_publish_times_check
    check (cardinality(publish_times_utc) between 1 and 12);

update public.content_profiles
set publish_times_utc = array[
  '01:00'::time without time zone,
  '03:00'::time without time zone,
  '05:00'::time without time zone,
  '07:00'::time without time zone,
  '09:00'::time without time zone,
  '11:00'::time without time zone,
  '13:00'::time without time zone,
  '15:00'::time without time zone,
  '17:00'::time without time zone,
  '19:00'::time without time zone,
  '21:00'::time without time zone,
  '23:00'::time without time zone
]
where is_active = true;

-- Keep previous generated copy for review, but prevent off-grid future posts
-- from publishing after the schedule changes. Clearing their generation key
-- lets the generator create the correct replacement for any overlapping slot.
update public.content_queue
set status = 'draft',
    generation_key = null,
    processing_started_at = null,
    next_retry_at = null
where origin = 'ai_generated'
  and status = 'scheduled'
  and scheduled_at > now();

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

do $reschedule$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'threads-content-poster'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'threads-content-poster',
    '0 1,3,5,7,9,11,13,15,17,19,21,23 * * *',
    'select private.invoke_edge_function(''content-poster'')'
  );
end
$reschedule$;

-- Pre-fill the revised queue immediately. The next poster run publishes the
-- nearest due item at the next two-hour Asia/Almaty slot.
select private.invoke_edge_function('content-generator');
