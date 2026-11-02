-- =============================================================================
-- FUSION — review fixes
--   1. Session records are never deleted.
--        * Close Day & Archive deletes only sales and sale items; sessions stay.
--        * Cancelling a session keeps it with status 'cancelled' (time played
--          and the waived charge are recorded).
--        * Deleting a sale keeps its session with status 'voided'.
--   2. Close Day reads the saved summary back and verifies it before deleting
--      anything (all in one transaction, so a failure changes nothing).
--   3. Staff see only open sessions and today's finished sessions on their
--      floor — never the floor's session history (past charges).
--   4. Customer records are readable in bulk only by admins and staff with
--      "Edit customers"; other staff can only look customers up by name/phone.
-- CREATE OR REPLACE keeps the existing EXECUTE grants.
-- =============================================================================

-- 1. Session statuses ---------------------------------------------------------
alter table public.sessions drop constraint sessions_status_check;
alter table public.sessions drop constraint sessions_end_state;
alter table public.sessions drop constraint sessions_bill_state;
alter table public.sessions
  add constraint sessions_status_check
    check (status in ('running', 'paused', 'billing', 'completed', 'cancelled', 'voided')),
  add constraint sessions_end_state
    check ((status in ('running', 'paused')) = (ended_at is null)),
  add constraint sessions_bill_state
    check ((status in ('running', 'paused')) = (billable_seconds is null)
           and (billable_seconds is null) = (base_amount is null));

create index if not exists sessions_ended_at_idx on public.sessions (ended_at);

-- Cancel without charging. The session is kept (status 'cancelled') with the
-- time played and the charge that was waived; tab items go back into stock.
create or replace function public.cancel_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_perm('cancel_session', 'cancel sessions');
  v_session public.sessions;
  v_policy public.settings := public.fusion_billing_policy();
  v_paused_ms bigint;
  v_billable integer;
begin
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'Only an open session can be cancelled.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  update public.inventory_products p
  set stock_quantity = p.stock_quantity + i.quantity, updated_at = now()
  from (select si.product_id, si.quantity from public.session_items si
        where si.session_id = p_session_id order by si.product_id) i
  where p.id = i.product_id and p.track_stock;
  delete from public.session_items where session_id = p_session_id;

  if v_session.status = 'billing' then
    update public.sessions set status = 'cancelled', ended_by = v_me.id where id = p_session_id;
  else
    v_paused_ms := v_session.paused_ms
      + case when v_session.status = 'paused' then public.fusion_ms_between(v_session.paused_at, now()) else 0 end;
    v_billable := greatest(0, (public.fusion_ms_between(v_session.started_at, now()) - v_paused_ms) / 1000)::integer;
    update public.sessions
    set status = 'cancelled', paused_at = null, paused_ms = v_paused_ms, ended_at = now(), ended_by = v_me.id,
        billable_seconds = v_billable,
        base_amount = public.fusion_session_charge(
          v_billable, rate_per_hour, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
    where id = p_session_id;
  end if;
end;
$$;

-- Delete (void) a sale: stock is returned and its session is kept as 'voided'.
create or replace function public.delete_sale(p_sale_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_perm('delete_sales', 'delete sales');
  v_sale public.sales;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found. It may already be deleted or archived.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_me.role <> 'admin' then
    if not public.fusion_can_access_floor(v_sale.floor_id) then
      raise exception 'This sale belongs to another floor.' using errcode = '42501', hint = 'wrong_floor';
    end if;
    if v_sale.business_date <> public.fusion_business_date(now()) then
      raise exception 'Only today''s sales can be deleted by staff.' using errcode = '42501', hint = 'forbidden';
    end if;
  end if;

  update public.inventory_products p
  set stock_quantity = case when p.track_stock then p.stock_quantity + q.quantity else p.stock_quantity end,
      units_sold = greatest(p.units_sold - q.quantity, 0),
      updated_at = now()
  from (select i.product_id, sum(i.quantity)::integer as quantity from public.sale_items i
        where i.sale_id = p_sale_id and i.product_id is not null group by 1 order by 1) q
  where p.id = q.product_id;

  delete from public.sale_items where sale_id = p_sale_id;
  delete from public.sales where id = p_sale_id;
  if v_sale.session_id is not null then
    update public.sessions set status = 'voided' where id = v_sale.session_id and status = 'completed';
  end if;
end;
$$;

-- 2. Close Day & Archive Sales ------------------------------------------------
--   lock the date → lock and remember exactly which sales are closed → sum
--   them → save the summary (adding to any earlier close of the same date) →
--   read the summary back and verify it → delete those sale items → delete
--   those sales → verify. Sessions are never touched. One transaction: any
--   failure rolls everything back, and a repeat run only adds sales that still
--   exist, so totals are never double-counted.
create or replace function public.close_business_day(p_business_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_ids uuid[];
  v_cash numeric(14, 2);
  v_bank numeric(14, 2);
  v_count integer;
  v_before public.daily_summaries;
  v_summary public.daily_summaries;
  v_remaining integer;
begin
  if p_business_date is null then
    raise exception 'Choose the business date to close.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_business_date > public.fusion_business_date(now()) then
    raise exception 'You cannot close a business day that has not started.' using errcode = '22023', hint = 'invalid_input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(7314, (p_business_date - date '2000-01-01'));

  select coalesce(array_agg(x.id), '{}') into v_ids
  from (select s.id from public.sales s where s.business_date = p_business_date order by s.id for update) x;
  v_count := coalesce(array_length(v_ids, 1), 0);

  select d.* into v_before from public.daily_summaries d where d.business_date = p_business_date for update;

  if v_count = 0 then
    if v_before.id is null then
      raise exception 'There are no sales to archive for %.', p_business_date
        using errcode = 'P0001', hint = 'nothing_to_archive';
    end if;
    return jsonb_build_object('business_date', p_business_date, 'archived_sales', 0,
                              'added', jsonb_build_object('cash', 0, 'bank', 0, 'total', 0),
                              'summary', to_jsonb(v_before));
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
        updated_by = excluded.updated_by;

  -- The summary must hold exactly what was there before plus these sales
  -- before a single sale is deleted.
  select d.* into v_summary from public.daily_summaries d where d.business_date = p_business_date;
  if v_summary.id is null
     or v_summary.total_cash <> coalesce(v_before.total_cash, 0) + v_cash
     or v_summary.total_bank <> coalesce(v_before.total_bank, 0) + v_bank
     or v_summary.total_sales <> coalesce(v_before.total_sales, 0) + v_cash + v_bank then
    raise exception 'The daily summary could not be verified; nothing was archived.'
      using errcode = 'P0001', hint = 'archive_failed';
  end if;

  delete from public.sale_items where sale_id = any (v_ids);
  delete from public.sales where id = any (v_ids);

  select count(*) into v_remaining from public.sales s where s.id = any (v_ids);
  if v_remaining <> 0 then
    raise exception 'Archive verification failed; nothing was archived.' using errcode = 'P0001', hint = 'archive_failed';
  end if;

  return jsonb_build_object('business_date', p_business_date, 'archived_sales', v_count,
                            'added', jsonb_build_object('cash', v_cash, 'bank', v_bank, 'total', v_cash + v_bank),
                            'summary', to_jsonb(v_summary));
end;
$$;

-- 3. Session visibility ------------------------------------------------------
-- Admins: all sessions. Staff: open sessions on their floor, plus sessions
-- that finished today (so the floor updates live), never older history.
grant execute on function public.fusion_business_date(timestamptz) to authenticated;
drop policy sessions_read on public.sessions;
create policy sessions_read on public.sessions
  for select to authenticated using (
    (select public.fusion_is_admin())
    or (public.fusion_can_access_table(table_id)
        and (status in ('running', 'paused', 'billing')
             or public.fusion_business_date(ended_at) = (select public.get_current_business_date()))));

-- 4. Customers ---------------------------------------------------------------
drop policy customers_read on public.customers;
create policy customers_read on public.customers
  for select to authenticated using ((select public.fusion_has_perm('manage_customers')));

-- Lookup for checkout autocomplete. Staff without "Edit customers" must type
-- at least 2 letters (or 3 digits) and get at most 8 matches.
create or replace function public.search_customers(p_query text default '', p_limit integer default 8)
returns setof public.customers language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_manager boolean := v_me.role = 'admin' or 'manage_customers' = any (v_me.permissions);
  v_q text := replace(replace(lower(btrim(coalesce(p_query, ''))), '%', ''), '_', '');
  v_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
begin
  if not v_manager and char_length(v_q) < 2 and char_length(v_digits) < 3 then
    return;
  end if;
  return query
    select c.* from public.customers c
    where v_q = ''
       or lower(c.name) like '%' || v_q || '%'
       or (char_length(v_digits) >= 3 and c.phone like '%' || v_digits || '%')
    order by (lower(c.name) like v_q || '%') desc, c.name
    limit least(greatest(coalesce(p_limit, 8), 1), case when v_manager then 50 else 8 end);
end;
$$;

-- The live floor view now reads customers itself (staff can no longer read
-- the customers table), so it runs as definer with an explicit floor filter.
create or replace function public.get_tables_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_user();
  return (
    select jsonb_build_object(
      'server_time', now(),
      'tables', coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'sort_order', t.sort_order,
        'category_id', c.id, 'category_name', c.name,
        'floor_id', f.id, 'floor_name', f.name,
        'rate_per_hour', coalesce(t.rate_override, c.rate_per_hour),
        'session', (
          select jsonb_build_object(
            'id', s.id, 'status', s.status, 'rate_per_hour', s.rate_per_hour,
            'booked_seconds', s.booked_seconds, 'booked_amount', s.booked_amount,
            'started_at', s.started_at, 'paused_at', s.paused_at, 'paused_ms', s.paused_ms,
            'ended_at', s.ended_at, 'billable_seconds', s.billable_seconds, 'base_amount', s.base_amount,
            'customer', case when cu.id is null then null
                             else jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone) end,
            'items', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', i.id, 'product_id', i.product_id, 'name', i.product_name,
                         'unit_price', i.unit_price, 'quantity', i.quantity) order by i.created_at)
                       from public.session_items i where i.session_id = s.id), '[]'::jsonb))
          from public.sessions s
          left join public.customers cu on cu.id = s.customer_id
          where s.table_id = t.id and s.status in ('running', 'paused', 'billing'))
      ) order by f.sort_order, f.name, t.sort_order, t.name), '[]'::jsonb))
    from public.club_tables t
    join public.table_categories c on c.id = t.category_id
    join public.floors f on f.id = t.floor_id
    where t.is_active and public.fusion_can_access_floor(t.floor_id));
end;
$$;
