-- =============================================================================
-- FUSION — "Reset business data" (Settings → Data management), admin only.
--
-- IMPACT OF THIS MIGRATION: none on existing data. It adds two columns to
-- `settings` (when and by whom the last reset happened) and three functions.
-- Nothing runs automatically: a reset happens only when an administrator
-- starts it, enters their password and types RESET BUSINESS DATA. The 7-day /
-- monthly retention job is unchanged and never calls it.
--
-- A RESET PERMANENTLY DELETES (every row, TRUNCATE — no soft delete):
--   sessions, session_items, bookings, sales, sale_items, counter_shifts,
--   shift_daily_totals, expenses, daily_summaries, product_sales_daily,
--   customers, customer_visits, retention_runs (the cleanup log)
-- and restarts receipt numbering at 1 and every product's units-sold count
-- at 0. Product stock is kept unless the administrator asks to zero it.
-- IT NEVER TOUCHES logins (auth.users), app_users (roles, permissions,
-- floors), floors, tables, categories and their prices, the product list,
-- prices and cost prices, settings, functions, RLS, grants, the realtime
-- publication or the scheduled cleanup job.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

alter table public.settings
  add column business_reset_at timestamptz,
  add column business_reset_by uuid references public.app_users (id) on delete set null;
comment on column public.settings.business_reset_at is 'When an administrator last reset all business data.';
comment on column public.settings.business_reset_by is 'Who last reset all business data.';

-- The caller's own password, checked against Supabase Auth's bcrypt hash.
create or replace function public.fusion_verify_password(p_user_id uuid, p_password text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user_id and u.encrypted_password is not null and coalesce(p_password, '') <> ''
      and u.encrypted_password = extensions.crypt(p_password, u.encrypted_password));
$$;

-- Admin + password, or an error (a wrong password is slowed down).
create or replace function public.fusion_require_admin_password(p_password text)
returns public.app_users language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
begin
  if not public.fusion_verify_password(v_me.id, p_password) then
    perform pg_catalog.pg_sleep(1);
    raise exception 'The password is incorrect.' using errcode = 'P0001', hint = 'wrong_password';
  end if;
  return v_me;
end;
$$;

-- What a reset would remove (row counts) and when the last one happened.
create or replace function public.admin_business_data_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  return jsonb_build_object(
    'counts', jsonb_build_object(
      'sessions', (select count(*) from public.sessions),
      'open_sessions', (select count(*) from public.sessions where status in ('running', 'paused', 'billing')),
      'session_items', (select count(*) from public.session_items),
      'bookings', (select count(*) from public.bookings),
      'sales', (select count(*) from public.sales),
      'sale_items', (select count(*) from public.sale_items),
      'counter_shifts', (select count(*) from public.counter_shifts),
      'open_counters', (select count(*) from public.counter_shifts where status = 'open'),
      'shift_daily_totals', (select count(*) from public.shift_daily_totals),
      'expenses', (select count(*) from public.expenses),
      'daily_summaries', (select count(*) from public.daily_summaries),
      'product_sales_daily', (select count(*) from public.product_sales_daily),
      'customers', (select count(*) from public.customers),
      'customer_visits', (select count(*) from public.customer_visits),
      'retention_runs', (select count(*) from public.retention_runs)),
    'last_reset_at', (select st.business_reset_at from public.settings st where st.id = 1),
    'last_reset_by', (select u.full_name from public.settings st join public.app_users u on u.id = st.business_reset_by where st.id = 1));
end;
$$;

-- Optional backup before a reset: every row a reset would delete, as JSON.
create or replace function public.admin_export_business_data(p_password text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin_password(p_password);
begin
  return jsonb_build_object(
    'format', 'fusion-business-data-backup',
    'version', 1,
    'exported_at', now(),
    'exported_by', v_me.full_name,
    'club_name', (select st.club_name from public.settings st where st.id = 1),
    'business_timezone', (select st.business_timezone from public.settings st where st.id = 1),
    'summary', public.admin_business_data_summary() -> 'counts',
    'tables', jsonb_build_object(
      'sessions', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at) from public.sessions x), '[]'::jsonb),
      'session_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.session_items x), '[]'::jsonb),
      'bookings', coalesce((select jsonb_agg(to_jsonb(x) order by x.booking_at) from public.bookings x), '[]'::jsonb),
      'sales', coalesce((select jsonb_agg(to_jsonb(x) order by x.receipt_no) from public.sales x), '[]'::jsonb),
      'sale_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.sale_id) from public.sale_items x), '[]'::jsonb),
      'counter_shifts', coalesce((select jsonb_agg(to_jsonb(x) order by x.opened_at) from public.counter_shifts x), '[]'::jsonb),
      'shift_daily_totals', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.shift_daily_totals x), '[]'::jsonb),
      'expenses', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.expenses x), '[]'::jsonb),
      'daily_summaries', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.daily_summaries x), '[]'::jsonb),
      'product_sales_daily', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.product_sales_daily x), '[]'::jsonb),
      'customers', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.customers x), '[]'::jsonb),
      'customer_visits', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.customer_visits x), '[]'::jsonb),
      'retention_runs', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at) from public.retention_runs x), '[]'::jsonb),
      'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'stock_quantity', p.stock_quantity,
                                                                'units_sold', p.units_sold) order by p.name)
                            from public.inventory_products p), '[]'::jsonb)));
end;
$$;

-- The reset itself: one transaction, so it either completes or changes nothing.
create or replace function public.admin_reset_business_data(p_password text, p_confirmation text, p_reset_stock boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users;
  v_removed jsonb;
begin
  if p_confirmation is distinct from 'RESET BUSINESS DATA' then
    perform public.fusion_require_admin();
    raise exception 'Type RESET BUSINESS DATA to confirm.' using errcode = '22023', hint = 'invalid_input';
  end if;
  v_me := public.fusion_require_admin_password(p_password);
  -- One reset at a time; the retention job waits rather than running alongside.
  if not pg_catalog.pg_try_advisory_xact_lock(7316, 0) then
    raise exception 'A reset is already running. Wait a moment and check again.' using errcode = 'P0001', hint = 'busy';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(7315, 0);

  v_removed := public.admin_business_data_summary() -> 'counts';

  truncate table
    public.bookings,
    public.session_items,
    public.sale_items,
    public.sales,
    public.sessions,
    public.expenses,
    public.shift_daily_totals,
    public.counter_shifts,
    public.daily_summaries,
    public.product_sales_daily,
    public.customer_visits,
    public.customers,
    public.retention_runs
    restart identity;

  update public.inventory_products
  set units_sold = 0,
      stock_quantity = case when coalesce(p_reset_stock, false) then 0 else stock_quantity end,
      updated_at = now();
  update public.settings set business_reset_at = now(), business_reset_by = v_me.id where id = 1;

  return jsonb_build_object('reset_at', now(), 'reset_by', v_me.full_name, 'removed', v_removed,
                            'stock_reset', coalesce(p_reset_stock, false));
end;
$$;

-- Grants -------------------------------------------------------------------------
-- Supabase grants new functions to the API roles by default; take that back.
revoke all on function
  public.fusion_verify_password(uuid, text),
  public.fusion_require_admin_password(text),
  public.admin_business_data_summary(),
  public.admin_export_business_data(text),
  public.admin_reset_business_data(text, text, boolean)
  from public, anon, authenticated;

-- Administration (each requires an administrator; export and reset also the password).
grant execute on function
  public.admin_business_data_summary(),
  public.admin_export_business_data(text),
  public.admin_reset_business_data(text, text, boolean)
  to authenticated;

notify pgrst, 'reload schema';
