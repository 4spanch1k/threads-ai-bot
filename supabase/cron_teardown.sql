do $teardown$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in (
      'threads-interaction-processor',
      'threads-content-poster',
      'threads-keyword-radar'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end
$teardown$;
