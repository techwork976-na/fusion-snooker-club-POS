-- =============================================================================
-- FUSION — administration, dashboard, reports and the daily archive
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Profile & portal switching
-- ---------------------------------------------------------------------------
create or replace function public.get_my_profile()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
begin
  return jsonb_build_object(
    'id', v_me.id, 'username', v_me.username, 'full_name', v_me.full_name, 'role', v_me.role,
    'floor_id', v_me.floor_id,
    'floor_name', (select f.name from public.floors f where f.id = v_me.floor_id),
    'permissions', to_jsonb(v_me.permissions));
end;
$$;

-- Accounts a signed-in user may switch to (names only; never floors,
-- permissions or credentials). Each switch still requires that account's
-- password through Supabase Auth.
create or replace function public.list_switch_targets()
returns table (id uuid, username text, full_name text, role text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_user();
  return query
    select u.id, u.username, u.full_name, u.role from public.app_users u
    where u.is_active order by u.role, u.full_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- User administration (auth accounts themselves are created by the
-- admin-users Edge Function, which calls these with the admin's JWT).
-- ---------------------------------------------------------------------------
create or replace function public.fusion_validate_profile(
  p_full_name text, p_role text, p_floor_id smallint, p_permissions text[])
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_full_name, ''))) not between 1 and 80 then
    raise exception 'Name is required (up to 80 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_role not in ('admin', 'staff') then
    raise exception 'Role must be Admin or Staff.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_floor_id is not null and not exists (select 1 from public.floors f where f.id = p_floor_id) then
    raise exception 'Floor not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not (coalesce(p_permissions, '{}') <@ array['apply_discount', 'delete_sales', 'cancel_session', 'counter_sale',
                                                 'manage_customers', 'adjust_stock', 'view_own_sales']::text[]) then
    raise exception 'Unknown permission.' using errcode = '22023', hint = 'invalid_input';
  end if;
end;
$$;

create or replace function public.fusion_assert_admin_remains(p_excluding uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.app_users u where u.role = 'admin' and u.is_active and u.id <> p_excluding) then
    raise exception 'FUSION needs at least one active administrator.' using errcode = 'P0001', hint = 'last_admin';
  end if;
end;
$$;

create or replace function public.admin_create_user_profile(
  p_user_id uuid, p_username text, p_full_name text, p_role text, p_floor_id smallint, p_permissions text[])
returns public.app_users language plpgsql security definer set search_path = '' as $$
declare
  v_user public.app_users;
begin
  perform public.fusion_require_admin();
  perform public.fusion_validate_profile(p_full_name, p_role, p_floor_id, p_permissions);
  if not exists (select 1 from auth.users a where a.id = p_user_id) then
    raise exception 'Auth account not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  insert into public.app_users (id, username, full_name, role, floor_id, permissions)
  values (p_user_id, lower(btrim(p_username)), btrim(p_full_name), p_role,
          case when p_role = 'admin' then null else p_floor_id end,
          case when p_role = 'admin' then '{}' else coalesce(p_permissions, '{}') end)
  returning * into v_user;
  return v_user;
exception
  when unique_violation then
    raise exception 'Username "%" is already taken.', p_username using errcode = '23505', hint = 'duplicate_username';
  when check_violation then
    raise exception 'Usernames use 3–32 lowercase letters, digits, dots, dashes or underscores.'
      using errcode = '22023', hint = 'invalid_input';
end;
$$;

create or replace function public.admin_update_user(
  p_user_id uuid, p_full_name text, p_role text, p_floor_id smallint, p_permissions text[])
returns public.app_users language plpgsql security definer set search_path = '' as $$
declare
  v_user public.app_users;
begin
  perform public.fusion_require_admin();
  perform public.fusion_validate_profile(p_full_name, p_role, p_floor_id, p_permissions);
  select u.* into v_user from public.app_users u where u.id = p_user_id for update;
  if not found then
    raise exception 'User not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_user.role = 'admin' and p_role <> 'admin' then
    perform public.fusion_assert_admin_remains(p_user_id);
  end if;
  update public.app_users
  set full_name = btrim(p_full_name), role = p_role,
      floor_id = case when p_role = 'admin' then null else p_floor_id end,
      permissions = case when p_role = 'admin' then '{}' else coalesce(p_permissions, '{}') end,
      updated_at = now()
  where id = p_user_id returning * into v_user;
  return v_user;
end;
$$;

create or replace function public.admin_set_user_active(p_user_id uuid, p_active boolean)
returns public.app_users language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_user public.app_users;
begin
  select u.* into v_user from public.app_users u where u.id = p_user_id for update;
  if not found then
    raise exception 'User not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not coalesce(p_active, false) then
    if p_user_id = v_me.id then
      raise exception 'You cannot deactivate your own account.' using errcode = 'P0001', hint = 'invalid_state';
    end if;
    if v_user.role = 'admin' then
      perform public.fusion_assert_admin_remains(p_user_id);
    end if;
  end if;
  update public.app_users set is_active = coalesce(p_active, false), updated_at = now()
  where id = p_user_id returning * into v_user;
  return v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Club configuration
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_settings(p_settings jsonb)
returns public.settings language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_current public.settings;
  v_tz text;
  v_result public.settings;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Invalid settings.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select s.* into v_current from public.settings s where s.id = 1 for update;
  v_tz := coalesce(p_settings ->> 'business_timezone', v_current.business_timezone);
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
    raise exception 'Unknown timezone "%".', v_tz using errcode = '22023', hint = 'invalid_input';
  end if;
  update public.settings set
    club_name = btrim(coalesce(p_settings ->> 'club_name', club_name)),
    club_address = btrim(coalesce(p_settings ->> 'club_address', club_address)),
    club_phone = btrim(coalesce(p_settings ->> 'club_phone', club_phone)),
    receipt_footer = btrim(coalesce(p_settings ->> 'receipt_footer', receipt_footer)),
    business_timezone = v_tz,
    day_start_hour = coalesce((p_settings ->> 'day_start_hour')::smallint, day_start_hour),
    billing_increment_minutes = coalesce((p_settings ->> 'billing_increment_minutes')::smallint, billing_increment_minutes),
    billing_rounding = coalesce(p_settings ->> 'billing_rounding', billing_rounding),
    minimum_charge_minutes = coalesce((p_settings ->> 'minimum_charge_minutes')::smallint, minimum_charge_minutes),
    admin_idle_lock_minutes = coalesce((p_settings ->> 'admin_idle_lock_minutes')::smallint, admin_idle_lock_minutes),
    updated_at = now(),
    updated_by = v_me.id
  where id = 1 returning * into v_result;
  return v_result;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'One of the settings is out of range.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

create or replace function public.admin_save_floor(p_id smallint, p_name text, p_sort_order integer default 0)
returns public.floors language plpgsql security definer set search_path = '' as $$
declare
  v_floor public.floors;
begin
  perform public.fusion_require_admin();
  if p_id is null then
    insert into public.floors (name, sort_order) values (btrim(p_name), coalesce(p_sort_order, 0)) returning * into v_floor;
  else
    update public.floors set name = btrim(p_name), sort_order = coalesce(p_sort_order, sort_order)
    where id = p_id returning * into v_floor;
    if not found then
      raise exception 'Floor not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_floor;
exception
  when unique_violation then
    raise exception 'A floor named "%" already exists.', btrim(p_name) using errcode = '23505', hint = 'duplicate_name';
  when check_violation or not_null_violation then
    raise exception 'Floor name is required (up to 40 characters).' using errcode = '22023', hint = 'invalid_input';
end;
$$;

create or replace function public.admin_delete_floor(p_id smallint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  delete from public.floors where id = p_id;
exception
  when foreign_key_violation then
    raise exception 'This floor still has tables or staff assigned to it.' using errcode = 'P0001', hint = 'in_use';
end;
$$;

create or replace function public.admin_save_category(
  p_id smallint, p_name text, p_rate_per_hour numeric, p_sort_order integer default 0, p_is_active boolean default true)
returns public.table_categories language plpgsql security definer set search_path = '' as $$
declare
  v_category public.table_categories;
begin
  perform public.fusion_require_admin();
  if p_rate_per_hour is null or p_rate_per_hour <> round(p_rate_per_hour, 2) then
    raise exception 'Enter a valid hourly rate.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.table_categories (name, rate_per_hour, sort_order, is_active)
    values (btrim(p_name), p_rate_per_hour, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
    returning * into v_category;
  else
    update public.table_categories
    set name = btrim(p_name), rate_per_hour = p_rate_per_hour,
        sort_order = coalesce(p_sort_order, sort_order), is_active = coalesce(p_is_active, is_active)
    where id = p_id returning * into v_category;
    if not found then
      raise exception 'Category not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_category;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists.', btrim(p_name) using errcode = '23505', hint = 'duplicate_name';
  when check_violation or not_null_violation then
    raise exception 'Category needs a name and an hourly rate above zero.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

create or replace function public.admin_save_table(
  p_id uuid, p_name text, p_category_id smallint, p_floor_id smallint,
  p_rate_override numeric default null, p_sort_order integer default 0)
returns public.club_tables language plpgsql security definer set search_path = '' as $$
declare
  v_table public.club_tables;
begin
  perform public.fusion_require_admin();
  if p_rate_override is not null and p_rate_override <> round(p_rate_override, 2) then
    raise exception 'Enter a valid hourly rate.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.club_tables (name, category_id, floor_id, rate_override, sort_order)
    values (btrim(p_name), p_category_id, p_floor_id, p_rate_override, coalesce(p_sort_order, 0))
    returning * into v_table;
  else
    -- Rates are snapshotted when a session starts, so editing a table never
    -- changes the bill of a session already in progress.
    update public.club_tables
    set name = btrim(p_name), category_id = p_category_id, floor_id = p_floor_id,
        rate_override = p_rate_override, sort_order = coalesce(p_sort_order, sort_order)
    where id = p_id returning * into v_table;
    if not found then
      raise exception 'Table not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_table;
exception
  when unique_violation then
    raise exception 'A table named "%" already exists.', btrim(p_name) using errcode = '23505', hint = 'duplicate_name';
  when foreign_key_violation then
    raise exception 'Choose a valid floor and category.' using errcode = '22023', hint = 'invalid_input';
  when check_violation or not_null_violation then
    raise exception 'Table needs a name, floor and category.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

create or replace function public.admin_set_table_active(p_id uuid, p_active boolean)
returns public.club_tables language plpgsql security definer set search_path = '' as $$
declare
  v_table public.club_tables;
begin
  perform public.fusion_require_admin();
  select t.* into v_table from public.club_tables t where t.id = p_id for update;
  if not found then
    raise exception 'Table not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not coalesce(p_active, false) and exists (
       select 1 from public.sessions s where s.table_id = p_id and s.status in ('running', 'paused', 'billing')) then
    raise exception 'Finish the session on "%" before removing it.', v_table.name using errcode = 'P0001', hint = 'table_busy';
  end if;
  update public.club_tables set is_active = coalesce(p_active, false) where id = p_id returning * into v_table;
  return v_table;
exception
  when unique_violation then
    raise exception 'Another active table already uses this name.' using errcode = '23505', hint = 'duplicate_name';
end;
$$;

create or replace function public.admin_save_product(
  p_id uuid, p_name text, p_category text, p_cost_price numeric, p_selling_price numeric,
  p_track_stock boolean, p_low_stock_threshold integer, p_initial_stock integer default 0)
returns public.inventory_products language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
begin
  perform public.fusion_require_admin();
  if p_cost_price is null or p_selling_price is null
     or p_cost_price <> round(p_cost_price, 2) or p_selling_price <> round(p_selling_price, 2) then
    raise exception 'Enter valid prices.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.inventory_products (name, category, cost_price, selling_price, track_stock,
                                           stock_quantity, low_stock_threshold)
    values (btrim(p_name), btrim(coalesce(p_category, '')), p_cost_price, p_selling_price, coalesce(p_track_stock, true),
            case when coalesce(p_track_stock, true) then coalesce(p_initial_stock, 0) else 0 end,
            coalesce(p_low_stock_threshold, 5))
    returning * into v_product;
  else
    -- Stock is only changed through adjust_stock (delta based), never
    -- overwritten here, so a concurrent sale can't be lost.
    update public.inventory_products
    set name = btrim(p_name), category = btrim(coalesce(p_category, '')), cost_price = p_cost_price,
        selling_price = p_selling_price, track_stock = coalesce(p_track_stock, track_stock),
        low_stock_threshold = coalesce(p_low_stock_threshold, low_stock_threshold), updated_at = now()
    where id = p_id returning * into v_product;
    if not found then
      raise exception 'Product not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_product;
exception
  when unique_violation then
    raise exception 'A product named "%" already exists.', btrim(p_name) using errcode = '23505', hint = 'duplicate_name';
  when check_violation or not_null_violation then
    raise exception 'Product needs a name, non-negative prices and stock.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

-- "Deleting" a product deactivates it: open tabs and past sale lines keep
-- their reference, and it disappears from POS search.
create or replace function public.admin_set_product_active(p_id uuid, p_active boolean)
returns public.inventory_products language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
begin
  perform public.fusion_require_admin();
  update public.inventory_products set is_active = coalesce(p_active, false), updated_at = now()
  where id = p_id returning * into v_product;
  if not found then
    raise exception 'Product not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  return v_product;
exception
  when unique_violation then
    raise exception 'An active product already uses this name.' using errcode = '23505', hint = 'duplicate_name';
end;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard. A day's total is always (archived summary) + (live sales), so a
-- day that was closed early and kept trading is still reported in full.
-- ---------------------------------------------------------------------------
create or replace function public.fusion_day_totals(p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cash', coalesce(ds.total_cash, 0) + coalesce(l.cash, 0),
    'bank', coalesce(ds.total_bank, 0) + coalesce(l.bank, 0),
    'total', coalesce(ds.total_sales, 0) + coalesce(l.total, 0),
    'count', coalesce(l.cnt, 0),
    'discounts', coalesce(l.discounts, 0),
    'archived', ds.business_date is not null)
  from (select 1) one
  left join public.daily_summaries ds on ds.business_date = p_date
  left join lateral (
    select sum(s.final_amount) filter (where s.payment_method = 'cash') as cash,
           sum(s.final_amount) filter (where s.payment_method = 'bank_transfer') as bank,
           sum(s.final_amount) as total, count(*) as cnt, sum(s.discount) as discounts
    from public.sales s where s.business_date = p_date) l on true;
$$;

create or replace function public.get_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_today date := public.fusion_business_date(now());
  v_tables jsonb;
  v_result jsonb;
begin
  select jsonb_build_object(
    'total', count(*),
    'available', count(*) filter (where s.status is null),
    'running', count(*) filter (where s.status = 'running'),
    'paused', count(*) filter (where s.status = 'paused'),
    'billing', count(*) filter (where s.status = 'billing'))
  into v_tables
  from public.club_tables t
  left join public.sessions s on s.table_id = t.id and s.status in ('running', 'paused', 'billing')
  where t.is_active and (v_me.role = 'admin' or v_me.floor_id is null or t.floor_id = v_me.floor_id);

  v_result := jsonb_build_object('business_date', v_today, 'server_time', now(), 'tables', v_tables);

  if v_me.role = 'admin' then
    v_result := v_result || jsonb_build_object(
      'today', public.fusion_day_totals(v_today),
      'yesterday_total', (public.fusion_day_totals(v_today - 1) ->> 'total')::numeric,
      'lifetime_total', coalesce((select sum(d.total_sales) from public.daily_summaries d), 0)
                        + coalesce((select sum(s.final_amount) from public.sales s), 0),
      'hourly', coalesce((
        select jsonb_agg(jsonb_build_object('hour', h.hour, 'total', h.total) order by h.hour)
        from (select extract(hour from (s.created_at at time zone st.business_timezone))::integer as hour,
                     sum(s.final_amount) as total
              from public.sales s cross join public.settings st
              where s.business_date = v_today and st.id = 1 group by 1) h), '[]'::jsonb),
      'staff_today', coalesce((
        select jsonb_agg(jsonb_build_object('cashier_id', x.cashier_id, 'cashier_name', x.cashier_name,
                                            'total', x.total, 'count', x.cnt) order by x.total desc)
        from (select s.cashier_id, max(s.cashier_name) as cashier_name, sum(s.final_amount) as total, count(*) as cnt
              from public.sales s where s.business_date = v_today group by s.cashier_id) x), '[]'::jsonb),
      'top_products', coalesce((
        select jsonb_agg(jsonb_build_object('name', x.name, 'quantity', x.qty, 'revenue', x.revenue)
                         order by x.qty desc, x.name)
        from (select i.product_name as name, sum(i.quantity) as qty, sum(i.line_total) as revenue
              from public.sale_items i join public.sales s on s.id = i.sale_id
              where s.business_date = v_today group by i.product_name order by 2 desc limit 5) x), '[]'::jsonb),
      'low_stock', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'stock_quantity', p.stock_quantity,
                                            'low_stock_threshold', p.low_stock_threshold)
                         order by p.stock_quantity, p.name)
        from public.inventory_products p
        where p.is_active and p.track_stock and p.stock_quantity <= p.low_stock_threshold), '[]'::jsonb),
      'open_days', (select count(distinct s.business_date) from public.sales s where s.business_date < v_today));
  elsif 'view_own_sales' = any (v_me.permissions) then
    v_result := v_result || jsonb_build_object('my_today', (
      select jsonb_build_object(
        'cash', coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0),
        'bank', coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0),
        'total', coalesce(sum(s.final_amount), 0),
        'count', count(*))
      from public.sales s where s.business_date = v_today and s.cashier_id = v_me.id));
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (admin). Archived dates contribute their saved totals only; staff
-- breakdowns and product lines exist only for dates not yet archived.
-- ---------------------------------------------------------------------------
create or replace function public.get_sales_report(p_from date, p_to date, p_cashier_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days jsonb;
  v_staff jsonb;
  v_products jsonb;
  v_totals jsonb;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Reports are limited to one year at a time.' using errcode = '22023', hint = 'invalid_input';
  end if;

  with live as (
    select s.business_date as d,
           sum(s.final_amount) filter (where s.payment_method = 'cash') as cash,
           sum(s.final_amount) filter (where s.payment_method = 'bank_transfer') as bank,
           sum(s.final_amount) as total, sum(s.discount) as discounts, count(*) as cnt
    from public.sales s
    where s.business_date between p_from and p_to and (p_cashier_id is null or s.cashier_id = p_cashier_id)
    group by s.business_date),
  arch as (
    select ds.business_date as d, ds.total_cash as cash, ds.total_bank as bank, ds.total_sales as total
    from public.daily_summaries ds
    where ds.business_date between p_from and p_to and p_cashier_id is null),
  days as (
    select coalesce(l.d, a.d) as d,
           coalesce(a.cash, 0) + coalesce(l.cash, 0) as cash,
           coalesce(a.bank, 0) + coalesce(l.bank, 0) as bank,
           coalesce(a.total, 0) + coalesce(l.total, 0) as total,
           coalesce(l.discounts, 0) as discounts,
           coalesce(l.cnt, 0) as live_count,
           a.d is not null as archived
    from live l full join arch a on a.d = l.d)
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'cash', cash, 'bank', bank, 'total', total,
                                               'discounts', discounts, 'live_count', live_count,
                                               'archived', archived) order by d), '[]'::jsonb),
         jsonb_build_object('cash', coalesce(sum(cash), 0), 'bank', coalesce(sum(bank), 0),
                            'total', coalesce(sum(total), 0), 'discounts', coalesce(sum(discounts), 0),
                            'live_count', coalesce(sum(live_count), 0),
                            'archived_days', count(*) filter (where archived))
    into v_days, v_totals
  from days;

  select coalesce(jsonb_agg(jsonb_build_object('cashier_id', x.cashier_id, 'cashier_name', x.cashier_name,
                                               'cash', x.cash, 'bank', x.bank, 'total', x.total, 'count', x.cnt)
                            order by x.total desc), '[]'::jsonb)
    into v_staff
  from (select s.cashier_id, max(s.cashier_name) as cashier_name,
               coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0) as cash,
               coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0) as bank,
               sum(s.final_amount) as total, count(*) as cnt
        from public.sales s
        where s.business_date between p_from and p_to and (p_cashier_id is null or s.cashier_id = p_cashier_id)
        group by s.cashier_id) x;

  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'quantity', x.qty, 'revenue', x.revenue)
                            order by x.qty desc, x.name), '[]'::jsonb)
    into v_products
  from (select i.product_name as name, sum(i.quantity) as qty, sum(i.line_total) as revenue
        from public.sale_items i join public.sales s on s.id = i.sale_id
        where s.business_date between p_from and p_to and (p_cashier_id is null or s.cashier_id = p_cashier_id)
        group by i.product_name order by 2 desc limit 10) x;

  return jsonb_build_object('from', p_from, 'to', p_to, 'cashier_id', p_cashier_id,
                            'days', v_days, 'totals', v_totals, 'by_staff', v_staff, 'top_products', v_products);
end;
$$;

-- Business dates that still hold individual sales (candidates for closing).
create or replace function public.list_open_business_dates()
returns table (business_date date, sale_count bigint, total_cash numeric, total_bank numeric, total_sales numeric,
               previously_archived boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  return query
    select s.business_date, count(*),
           coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0),
           coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0),
           sum(s.final_amount),
           exists (select 1 from public.daily_summaries d where d.business_date = s.business_date)
    from public.sales s group by s.business_date order by s.business_date desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Close Day & Archive Sales — atomic.
--   1. admin only; 2. date must not be in the future;
--   3. lock that date's sales and remember exactly which rows were summed;
--   4. add their totals to daily_summaries (one row per date, so a repeat run
--      only ever adds sales that were not archived before — no double counting);
--   5–6. delete exactly those sales, their sale items and their paid sessions.
-- Any error rolls back every step.
-- ---------------------------------------------------------------------------
create or replace function public.close_business_day(p_business_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_ids uuid[];
  v_cash numeric(14, 2);
  v_bank numeric(14, 2);
  v_count integer;
  v_summary public.daily_summaries;
  v_deleted integer;
begin
  if p_business_date is null then
    raise exception 'Choose the business date to close.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_business_date > public.fusion_business_date(now()) then
    raise exception 'You cannot close a business day that has not started.' using errcode = '22023', hint = 'invalid_input';
  end if;

  -- One archive per date at a time.
  perform pg_catalog.pg_advisory_xact_lock(7314, (p_business_date - date '2000-01-01'));

  select coalesce(array_agg(x.id), '{}') into v_ids
  from (select s.id from public.sales s where s.business_date = p_business_date order by s.id for update) x;
  v_count := coalesce(array_length(v_ids, 1), 0);

  if v_count = 0 then
    select d.* into v_summary from public.daily_summaries d where d.business_date = p_business_date;
    if not found then
      raise exception 'There are no sales to archive for %.', p_business_date
        using errcode = 'P0001', hint = 'nothing_to_archive';
    end if;
    return jsonb_build_object('business_date', p_business_date, 'archived_sales', 0,
                              'added', jsonb_build_object('cash', 0, 'bank', 0, 'total', 0),
                              'summary', to_jsonb(v_summary));
  end if;

  select coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0),
         coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0)
    into v_cash, v_bank
  from public.sales s where s.id = any (v_ids);

  insert into public.daily_summaries as d (business_date, total_cash, total_bank, total_sales, created_by, updated_by)
  values (p_business_date, v_cash, v_bank, v_cash + v_bank, v_me.id, v_me.id)
  on conflict (business_date) do update
    set total_cash = d.total_cash + excluded.total_cash,
        total_bank = d.total_bank + excluded.total_bank,
        total_sales = d.total_sales + excluded.total_sales,
        updated_at = now(),
        updated_by = excluded.updated_by
  returning * into v_summary;

  delete from public.sale_items where sale_id = any (v_ids);

  with removed as (
    delete from public.sales where id = any (v_ids) returning session_id)
  delete from public.sessions se
  using removed r
  where se.id = r.session_id and se.status = 'completed';

  select count(*) into v_deleted from public.sales s where s.id = any (v_ids);
  if v_deleted <> 0 then
    raise exception 'Archive verification failed; nothing was changed.' using errcode = 'P0001', hint = 'archive_failed';
  end if;

  return jsonb_build_object('business_date', p_business_date, 'archived_sales', v_count,
                            'added', jsonb_build_object('cash', v_cash, 'bank', v_bank, 'total', v_cash + v_bank),
                            'summary', to_jsonb(v_summary));
end;
$$;
