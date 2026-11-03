-- =============================================================================
-- FUSION — "Time's up" hold for booked sessions, snack sales, table sales.
--
-- IMPACT ON EXISTING DATA: none is deleted or recalculated. Two nullable
-- columns are added to `sessions`; existing sessions are unaffected.
--
-- 1. Time's up (fixed-time and fixed-amount sessions). When a booked session
--    has used its allocation, its billable clock HOLDS at exactly the booked
--    time: the bill stays at the booked amount and minutes before staff react
--    are never charged. Staff then
--      * end it (the bill is the booked amount), or
--      * continue_after_allocation(): play goes on, the minutes held are
--        recorded as paused, and extra time is billed per minute from then
--        on (the existing overtime rule).
--    acknowledge_allocation_alert() records that the alarm was dismissed, so
--    every terminal stops ringing and a page refresh never rings again.
--    Dismissing neither ends nor continues the session.
-- 2. get_snack_sales(): sales without a table (counter / snack-only sales) —
--    all of them for an administrator, a staff member's own otherwise.
-- 3. get_table_sales(): what each table took, read from the invoices
--    themselves, so invoices removed by the retention policy disappear from it
--    too (no hidden totals survive cleanup).
-- =============================================================================

-- 1. Time's up ----------------------------------------------------------------------
alter table public.sessions
  add column allocation_alert_ack_at timestamptz,
  add column allocation_extended_at timestamptz,
  add constraint sessions_allocation_needs_booking check (
    booked_seconds is not null or (allocation_alert_ack_at is null and allocation_extended_at is null));

comment on column public.sessions.allocation_alert_ack_at is
  'When staff dismissed the "time''s up" alarm of a booked session (any terminal).';
comment on column public.sessions.allocation_extended_at is
  'When staff chose to continue a booked session past its allocation; until then billing holds at the booked time.';

-- Billable seconds of a session at a moment. A booking that has not been
-- continued holds at its booked time (mirrored by billableMs in src/shared/billing.ts).
create or replace function public.fusion_billable_seconds(p_session public.sessions, p_at timestamptz)
returns integer language sql stable set search_path = '' as $$
  select case when p_session.booked_seconds is not null and p_session.allocation_extended_at is null
              then least(x.raw, p_session.booked_seconds)
              else x.raw end
  from (select greatest(0, (public.fusion_ms_between(p_session.started_at,
                                                     coalesce(p_session.ended_at, p_session.paused_at, p_at))
                            - p_session.paused_ms) / 1000)::integer as raw) x;
$$;

-- (end_session and cancel_session are unchanged apart from the lines marked "1000".)
create or replace function public.end_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_session public.sessions;
  v_policy public.settings := public.fusion_billing_policy();
  v_paused_ms bigint;
  v_billable integer;
begin
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused') then
    raise exception 'This session has already ended.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  v_paused_ms := v_session.paused_ms
    + case when v_session.status = 'paused' then public.fusion_ms_between(v_session.paused_at, now()) else 0 end;
  -- 1000: a booking that was not continued holds at its booked time.
  v_billable := public.fusion_billable_seconds(v_session, now());

  update public.sessions
  set status = 'billing',
      paused_at = null,
      paused_ms = v_paused_ms,
      ended_at = now(),
      ended_by = v_me.id,
      billable_seconds = v_billable,
      base_amount = public.fusion_session_charge(
        v_billable, rate_per_minute, booked_seconds, booked_amount,
        v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

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
    -- 1000: a booking that was not continued holds at its booked time.
    v_billable := public.fusion_billable_seconds(v_session, now());
    update public.sessions
    set status = 'cancelled', paused_at = null, paused_ms = v_paused_ms, ended_at = now(), ended_by = v_me.id,
        billable_seconds = v_billable,
        base_amount = public.fusion_session_charge(
          v_billable, rate_per_minute, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
    where id = p_session_id;
  end if;
  update public.bookings set status = 'cancelled', updated_at = now()
  where session_id = p_session_id and status = 'started';
end;
$$;

-- (get_tables_overview is unchanged apart from the line marked "1000".)
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
        'rate_per_minute', coalesce(t.rate_override, c.rate_per_minute),
        'session', (
          select jsonb_build_object(
            'id', s.id, 'status', s.status, 'rate_per_minute', s.rate_per_minute,
            'booked_seconds', s.booked_seconds, 'booked_amount', s.booked_amount,
            'started_at', s.started_at, 'paused_at', s.paused_at, 'paused_ms', s.paused_ms,
            'ended_at', s.ended_at, 'billable_seconds', s.billable_seconds, 'base_amount', s.base_amount,
            -- 1000: the "time's up" state of a booking.
            'allocation_alert_ack_at', s.allocation_alert_ack_at, 'allocation_extended_at', s.allocation_extended_at,
            'customer', case
                          when cu.id is not null then jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone)
                          when s.customer_name is not null then jsonb_build_object('id', null, 'name', s.customer_name, 'phone', null)
                        end,
            'booking_id', (select b.id from public.bookings b where b.session_id = s.id),
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

-- Silences the alarm on every terminal. The session keeps its state.
create or replace function public.acknowledge_allocation_alert(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.booked_seconds is null or v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'This session has no booking to acknowledge.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions set allocation_alert_ack_at = coalesce(allocation_alert_ack_at, now())
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

-- Lets play continue after the allocation ran out. The minutes the session was
-- held are recorded as paused, so they are never billed; extra time is billed
-- per minute from this moment. Calling it again changes nothing.
create or replace function public.continue_after_allocation(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
  v_raw_ms bigint;
  v_booked_ms bigint;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.booked_seconds is null or v_session.status not in ('running', 'paused') then
    raise exception 'Only a booked session that is still in play can continue.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_session.allocation_extended_at is not null then
    return v_session;
  end if;
  v_raw_ms := public.fusion_ms_between(v_session.started_at, coalesce(v_session.paused_at, now())) - v_session.paused_ms;
  v_booked_ms := v_session.booked_seconds::bigint * 1000;
  if v_raw_ms < v_booked_ms then
    raise exception 'This booking still has time left.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions
  set paused_ms = paused_ms + (v_raw_ms - v_booked_ms),
      allocation_extended_at = now(),
      allocation_alert_ack_at = coalesce(allocation_alert_ack_at, now())
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

-- 2. Snack sales (sales without a table) ---------------------------------------------
create or replace function public.get_snack_sales(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_all boolean := v_me.role = 'admin';
  v_totals jsonb;
  v_sales jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'Choose a valid date range (up to one year).' using errcode = '22023', hint = 'invalid_input';
  end if;

  select jsonb_build_object(
           'total', coalesce(sum(s.final_amount), 0),
           'cash', coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0),
           'bank', coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0),
           'count', count(*),
           'items', coalesce(sum((select sum(i.quantity) from public.sale_items i where i.sale_id = s.id)), 0))
    into v_totals
  from public.sales s
  where s.session_id is null and s.business_date between p_from and p_to and (v_all or s.cashier_id = v_me.id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'receipt_no', x.receipt_no, 'created_at', x.created_at, 'business_date', x.business_date,
           'cashier_name', x.cashier_name, 'payment_method', x.payment_method, 'discount', x.discount,
           'final_amount', x.final_amount,
           'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity)
                                               order by i.product_name)
                              from public.sale_items i where i.sale_id = x.id), '[]'::jsonb))
           order by x.created_at desc), '[]'::jsonb)
    into v_sales
  from (select s.* from public.sales s
        where s.session_id is null and s.business_date between p_from and p_to and (v_all or s.cashier_id = v_me.id)
        order by s.created_at desc limit 300) x;

  return jsonb_build_object('from', p_from, 'to', p_to, 'scope', case when v_all then 'all' else 'mine' end,
                            'totals', v_totals, 'sales', v_sales);
end;
$$;

-- 3. Table sales --------------------------------------------------------------------
-- Every paid table session's invoice, per table: total paid (table time plus
-- snacks on the tab, after discounts), cash and bank, sessions. Read from
-- `sales`, so invoices removed by the retention policy are not counted.
create or replace function public.get_table_sales(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days smallint;
  v_tables jsonb;
  v_totals jsonb;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'Choose a valid date range (up to one year).' using errcode = '22023', hint = 'invalid_input';
  end if;
  select st.sales_retention_days into v_days from public.settings st where st.id = 1;

  with paid as (
    select se.table_id, count(*) as sessions, sum(s.final_amount) as total,
           sum(s.final_amount) filter (where s.payment_method = 'cash') as cash,
           sum(s.final_amount) filter (where s.payment_method = 'bank_transfer') as bank,
           sum(s.base_amount) as table_time, sum(s.products_subtotal) as snacks, sum(s.discount) as discounts
    from public.sales s
    join public.sessions se on se.id = s.session_id
    where s.business_date between p_from and p_to
    group by se.table_id),
  rows as (
    select t.id, t.name, t.is_active, f.name as floor_name, f.sort_order as floor_order, c.name as category_name,
           t.sort_order, coalesce(p.sessions, 0) as sessions, coalesce(p.total, 0) as total,
           coalesce(p.cash, 0) as cash, coalesce(p.bank, 0) as bank, coalesce(p.table_time, 0) as table_time,
           coalesce(p.snacks, 0) as snacks, coalesce(p.discounts, 0) as discounts
    from public.club_tables t
    join public.floors f on f.id = t.floor_id
    join public.table_categories c on c.id = t.category_id
    left join paid p on p.table_id = t.id
    where t.is_active or p.table_id is not null)
  select coalesce(jsonb_agg(jsonb_build_object(
           'table_id', r.id, 'name', r.name, 'active', r.is_active, 'floor_name', r.floor_name,
           'category_name', r.category_name, 'sessions', r.sessions, 'total', r.total, 'cash', r.cash,
           'bank', r.bank, 'table_time', r.table_time, 'snacks', r.snacks, 'discounts', r.discounts)
           order by r.floor_order, r.floor_name, r.sort_order, r.name), '[]'::jsonb),
         jsonb_build_object('sessions', coalesce(sum(r.sessions), 0), 'total', coalesce(sum(r.total), 0),
                            'cash', coalesce(sum(r.cash), 0), 'bank', coalesce(sum(r.bank), 0),
                            'table_time', coalesce(sum(r.table_time), 0), 'snacks', coalesce(sum(r.snacks), 0),
                            'discounts', coalesce(sum(r.discounts), 0))
    into v_tables, v_totals
  from rows r;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'tables', v_tables, 'totals', v_totals,
    'retention_days', v_days,
    -- Invoices dated before this (from closed counters) may already have been removed.
    'retention_cutoff', public.fusion_business_date(now()) - v_days,
    'oldest_invoice_date', (select min(s.business_date) from public.sales s where s.session_id is not null));
end;
$$;

-- 4. Grants ---------------------------------------------------------------------------
-- Supabase grants new functions to the API roles by default; take that back.
revoke all on function
  public.fusion_billable_seconds(public.sessions, timestamptz),
  public.acknowledge_allocation_alert(uuid),
  public.continue_after_allocation(uuid),
  public.get_snack_sales(date, date),
  public.get_table_sales(date, date)
  from public, anon, authenticated;

-- Floor operations (floor-checked through fusion_lock_session).
grant execute on function
  public.acknowledge_allocation_alert(uuid),
  public.continue_after_allocation(uuid),
  public.get_snack_sales(date, date)
  to authenticated;

-- Administration (calls fusion_require_admin()).
grant execute on function public.get_table_sales(date, date) to authenticated;

notify pgrst, 'reload schema';
