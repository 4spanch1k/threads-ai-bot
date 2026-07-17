-- Run only after both Vault secrets exist:
--   project_url = https://<project-ref>.supabase.co
--   cron_secret = the same value as the Edge Function CRON_SECRET

do $setup$
declare
  v_missing_secret text;
  v_job_id bigint;
begin
  select required.name
  into v_missing_secret
  from (values ('project_url'), ('cron_secret')) as required(name)
  where not exists (
    select 1
    from vault.decrypted_secrets as secrets
    where secrets.name = required.name
      and nullif(trim(secrets.decrypted_secret), '') is not null
  )
  limit 1;

  if v_missing_secret is not null then
    raise exception 'Vault secret % is missing', v_missing_secret;
  end if;

  for v_job_id in
    select jobid
    from cron.job
    where jobname in (
      'threads-interaction-poller',
      'threads-interaction-processor',
      'threads-content-generator',
      'threads-content-poster',
      'threads-keyword-radar'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'threads-interaction-poller',
    '1,6,11,16,21,26,31,36,41,46,51,56 * * * *',
    'select private.invoke_edge_function(''interaction-poller'')'
  );

  perform cron.schedule(
    'threads-interaction-processor',
    '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
    'select private.invoke_edge_function(''interaction-processor'')'
  );

  perform cron.schedule(
    'threads-content-generator',
    '39 */6 * * *',
    'select private.invoke_edge_function(''content-generator'')'
  );

  perform cron.schedule(
    'threads-content-poster',
    '0 1,3,5,7,9,11,13,15,17,19,21,23 * * *',
    'select private.invoke_edge_function(''content-poster'')'
  );

  perform cron.schedule(
    'threads-keyword-radar',
    '23 */3 * * *',
    'select private.invoke_edge_function(''keyword-radar'')'
  );
end
$setup$;

select jobid, jobname, schedule, active
from cron.job
where jobname like 'threads-%'
order by jobname;
