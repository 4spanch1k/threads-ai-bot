alter table public.content_profiles
  add column if not exists publish_times_utc time without time zone[];

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'content_profiles'
      and column_name = 'publish_hour_utc'
  ) then
    execute $sql$
      update public.content_profiles
      set publish_times_utc = array[make_time(publish_hour_utc, 0, 0)]
      where publish_times_utc is null
    $sql$;
  end if;
end;
$migration$;

update public.content_profiles
set publish_times_utc = array['12:00'::time without time zone]
where publish_times_utc is null;

alter table public.content_profiles
  alter column publish_times_utc
    set default array['12:00'::time without time zone],
  alter column publish_times_utc set not null;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.content_profiles'::regclass
      and conname = 'content_profiles_publish_times_check'
  ) then
    alter table public.content_profiles
      add constraint content_profiles_publish_times_check
      check (cardinality(publish_times_utc) between 1 and 10);
  end if;
end;
$constraints$;

alter table public.content_profiles
  drop column if exists posts_per_week,
  drop column if exists publish_hour_utc;
