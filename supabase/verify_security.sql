-- Threads Lead Bot — production security gate
-- Run after schema.sql in the Supabase SQL Editor. The script is read-only and fails
-- immediately if an unexpected grant, policy, or missing service_role grant is found.

do $verify$
declare
  table_name text;
  role_name text;
  privilege_name text;
  function_signature text;
  function_oid regprocedure;
begin
  foreach table_name in array array['interactions', 'content_queue'] loop
    if not exists (
      select 1
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = table_name
        and c.relkind = 'r'
        and c.relrowsecurity = true
    ) then
      raise exception 'RLS is not enabled on public.%', table_name;
    end if;

    if exists (
      select 1
      from pg_catalog.pg_policies
      where schemaname = 'public'
        and tablename = table_name
    ) then
      raise exception 'Unexpected RLS policy found on public.%', table_name;
    end if;

    foreach role_name in array array['anon', 'authenticated'] loop
      foreach privilege_name in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(role_name, format('public.%I', table_name), privilege_name) then
          raise exception 'Role % unexpectedly has % on public.%', role_name, privilege_name, table_name;
        end if;
      end loop;
    end loop;

    foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if not has_table_privilege('service_role', format('public.%I', table_name), privilege_name) then
        raise exception 'service_role is missing % on public.%', privilege_name, table_name;
      end if;
    end loop;

    if has_table_privilege('service_role', format('public.%I', table_name), 'DELETE') then
      raise exception 'service_role unexpectedly has DELETE on public.%', table_name;
    end if;
  end loop;

  foreach function_signature in array array[
    'public.claim_interactions(integer,integer,integer)',
    'public.claim_due_content(integer,integer,integer)',
    'public.mark_interaction_failed(uuid,text,integer)',
    'public.mark_content_failed(uuid,text,integer)'
  ] loop
    function_oid := to_regprocedure(function_signature);
    if function_oid is null then
      raise exception 'Required function % does not exist', function_signature;
    end if;

    foreach role_name in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_name, function_oid, 'EXECUTE') then
        raise exception 'Role % unexpectedly has EXECUTE on %', role_name, function_signature;
      end if;
    end loop;

    if not has_function_privilege('service_role', function_oid, 'EXECUTE') then
      raise exception 'service_role is missing EXECUTE on %', function_signature;
    end if;
  end loop;

  -- The Cron helper is optional until its migration is applied. When present it
  -- must remain inaccessible to every Data API role, including service_role.
  function_signature := 'private.invoke_edge_function(text)';
  function_oid := to_regprocedure(function_signature);
  if function_oid is not null then
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      if has_schema_privilege(role_name, 'private', 'USAGE') then
        raise exception 'Role % unexpectedly has USAGE on schema private', role_name;
      end if;
      if has_function_privilege(role_name, function_oid, 'EXECUTE') then
        raise exception 'Role % unexpectedly has EXECUTE on %', role_name, function_signature;
      end if;
    end loop;

    if not exists (
      select 1
      from pg_catalog.pg_proc
      where oid = function_oid
        and prosecdef = true
    ) then
      raise exception 'Cron helper % must be SECURITY DEFINER', function_signature;
    end if;
  end if;

  raise notice 'Threads Lead Bot security gate passed';
end;
$verify$;
