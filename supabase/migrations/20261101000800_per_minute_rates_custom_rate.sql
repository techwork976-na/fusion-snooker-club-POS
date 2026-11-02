-- =============================================================================
-- FUSION — rates are per minute; custom rate per minute at checkout.
--
-- IMPACT ON EXISTING DATA (nothing is deleted; no amount already billed changes):
--   * Every rate is now rupees PER MINUTE. The hourly columns are renamed and
--     converted in place: per minute = per hour / 60, kept to 4 decimals so
--     existing prices bill as before (PKR 600/hour -> 10/min; 400/hour ->
--     6.6667/min — set a round figure in Settings if you prefer one).
--     Converted: table_categories.rate_per_hour, club_tables.rate_override,
--     sessions.rate_per_hour (snapshot), sales.rate_per_hour (snapshot).
--   * Stored amounts (session charges, invoices, shift ledger, day summaries,
--     customer statistics) are not recalculated.
--   * Terminals need the matching FUSION version: the admin save functions now
--     take p_rate_per_minute, so an older app fails loudly instead of saving an
--     hourly figure as a per-minute one.
--
-- New: complete_checkout(..., p_custom_rate_per_minute) re-prices a table's
-- time at a rate the cashier enters (permission "apply_discount"). The flat
-- discount still applies after it. The invoice keeps the standard rate and the
-- standard charge it replaced; the shift ledger receives the amount paid.
-- =============================================================================

-- 1. Rate columns: per hour -> per minute -------------------------------------------
alter table public.table_categories drop constraint if exists table_categories_rate_per_hour_check;
alter table public.table_categories rename column rate_per_hour to rate_per_minute;
alter table public.table_categories
  alter column rate_per_minute type numeric(12, 4) using round(rate_per_minute / 60, 4);
alter table public.table_categories add constraint table_categories_rate_per_minute_check
  check (rate_per_minute > 0 and rate_per_minute <= 10000);

alter table public.club_tables drop constraint if exists club_tables_rate_override_check;
alter table public.club_tables
  alter column rate_override type numeric(12, 4) using round(rate_override / 60, 4);
alter table public.club_tables add constraint club_tables_rate_override_check
  check (rate_override is null or (rate_override > 0 and rate_override <= 10000));

alter table public.sessions drop constraint if exists sessions_rate_per_hour_check;
alter table public.sessions rename column rate_per_hour to rate_per_minute;
alter table public.sessions
  alter column rate_per_minute type numeric(12, 4) using round(rate_per_minute / 60, 4);
alter table public.sessions add constraint sessions_rate_per_minute_check check (rate_per_minute > 0);
alter table public.sessions add column custom_rate_per_minute numeric(12, 4)
  constraint sessions_custom_rate_check
  check (custom_rate_per_minute is null or (custom_rate_per_minute > 0 and custom_rate_per_minute <= 10000));

alter table public.sales rename column rate_per_hour to rate_per_minute;
alter table public.sales
  alter column rate_per_minute type numeric(12, 4) using round(rate_per_minute / 60, 4);
alter table public.sales
  add column standard_rate_per_minute numeric(12, 4),
  add column standard_base_amount numeric(12, 2);
alter table public.sales add constraint sales_standard_rate check (
  (standard_rate_per_minute is null) = (standard_base_amount is null)
  and (standard_rate_per_minute is null
       or (standard_rate_per_minute > 0 and standard_base_amount >= 0 and rate_per_minute is not null)));

-- Named NOT NULL constraints (PostgreSQL 18+) keep the old column name; rename them.
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl, c.conname
    from pg_constraint c
    where c.connamespace = 'public'::regnamespace and c.conname like '%rate\_per\_hour%'
  loop
    execute format('alter table %s rename constraint %I to %I',
                   r.tbl, r.conname, replace(r.conname, 'rate_per_hour', 'rate_per_minute'));
  end loop;
end;
$$;

comment on column public.table_categories.rate_per_minute is 'Rupees per minute of play.';
comment on column public.club_tables.rate_override is 'Rupees per minute for this table; null = the category rate.';
comment on column public.sessions.rate_per_minute is 'The table''s rupees-per-minute rate, snapshotted when the session started.';
comment on column public.sessions.custom_rate_per_minute is 'Rate set by the cashier at checkout (null = the standard rate).';
comment on column public.sales.rate_per_minute is 'Rate charged for the table time (the custom rate when one was set).';
comment on column public.sales.standard_rate_per_minute is 'The table''s standard rate, when a custom rate replaced it.';
comment on column public.sales.standard_base_amount is 'Table charge at the standard rate, when a custom rate replaced it.';

-- 2. Billing rules (mirrored by src/shared/billing.ts; a parity test compares them)
--   amount        = billed minutes x rate per minute, rounded half-up to a rupee.
--   custom rate   = the same rules at the custom rate for all of the time; a
--                   booking's time is re-priced pro rata (seconds x rate / 60).
create or replace function public.fusion_amount_for_minutes(p_minutes integer, p_rate numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(p_minutes::numeric * p_rate, 0);
$$;
comment on function public.fusion_amount_for_minutes(integer, numeric) is
  'Billed minutes x rupees per minute, rounded half-up to a whole rupee.';

create or replace function public.fusion_amount_for_seconds(p_seconds integer, p_rate numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(p_seconds::numeric * p_rate / 60, 0);
$$;

create or replace function public.fusion_charge_at_rate(
  p_billable_seconds integer, p_rate numeric, p_booked_seconds integer,
  p_increment integer, p_rounding text, p_minimum integer)
returns numeric language sql immutable set search_path = '' as $$
  select public.fusion_session_charge(
    p_billable_seconds, p_rate, p_booked_seconds,
    case when p_booked_seconds is null then null
         else public.fusion_amount_for_seconds(p_booked_seconds, p_rate) end,
    p_increment, p_rounding, p_minimum);
$$;

create or replace function public.fusion_valid_rate(p_rate numeric)
returns boolean language sql immutable set search_path = '' as $$
  select p_rate is not null and p_rate > 0 and p_rate <= 10000 and p_rate = round(p_rate, 4);
$$;

-- 3. Sessions ---------------------------------------------------------------------
create or replace function public.start_session(
  p_table_id uuid, p_booking text default 'open', p_minutes integer default null, p_amount numeric default null,
  p_customer_id uuid default null, p_customer_name text default null, p_customer_phone text default null)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_customer public.customers;
  v_table public.club_tables;
  v_rate numeric(12, 4);
  v_booked_seconds integer;
  v_booked_amount numeric(12, 2);
  v_session public.sessions;
begin
  select t.* into v_table from public.club_tables t where t.id = p_table_id for update;
  if not found or not v_table.is_active then
    raise exception 'Table not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform public.fusion_assert_floor(v_table.floor_id);

  if exists (select 1 from public.sessions s
             where s.table_id = p_table_id and s.status in ('running', 'paused', 'billing')) then
    raise exception 'Table "%" is already in use. End its current session first.', v_table.name
      using errcode = 'P0001', hint = 'table_busy';
  end if;

  select coalesce(v_table.rate_override, c.rate_per_minute) into v_rate
  from public.table_categories c where c.id = v_table.category_id;

  case coalesce(p_booking, 'open')
    when 'open' then
      null;
    when 'minutes' then
      if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
        raise exception 'Booked time must be between 1 and 1440 minutes.' using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_seconds := p_minutes * 60;
      v_booked_amount := public.fusion_amount_for_minutes(p_minutes, v_rate);
    when 'amount' then
      if p_amount is null or p_amount <= 0 or p_amount > 1000000 or p_amount <> round(p_amount, 2) then
        raise exception 'Enter a valid amount.' using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_seconds := floor(p_amount * 60 / v_rate)::integer;
      if v_booked_seconds < 60 then
        raise exception 'PKR % does not cover one minute of play at PKR %/min.', p_amount, trim_scale(v_rate)
          using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_amount := p_amount;
    else
      raise exception 'Unknown booking type.' using errcode = '22023', hint = 'invalid_input';
  end case;

  v_customer := public.fusion_resolve_customer(p_customer_id, p_customer_name, p_customer_phone);

  insert into public.sessions (table_id, customer_id, customer_name, status, rate_per_minute, booked_seconds,
                               booked_amount, started_at, started_by, started_shift_id)
  values (p_table_id, v_customer.id,
          coalesce(v_customer.name, nullif(btrim(coalesce(p_customer_name, '')), '')),
          'running', v_rate, v_booked_seconds, v_booked_amount, now(), v_me.id,
          (select c.id from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open'))
  returning * into v_session;
  return v_session;
exception
  when unique_violation then
    raise exception 'This table is already in use.' using errcode = 'P0001', hint = 'table_busy';
end;
$$;

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
  v_billable := greatest(0, (public.fusion_ms_between(v_session.started_at, now()) - v_paused_ms) / 1000)::integer;

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
    v_billable := greatest(0, (public.fusion_ms_between(v_session.started_at, now()) - v_paused_ms) / 1000)::integer;
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

-- 4. Checkout with an optional custom rate per minute ---------------------------------
drop function public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text);

create function public.complete_checkout(
  p_client_ref uuid, p_payment_method text, p_session_id uuid default null, p_items jsonb default null,
  p_discount numeric default 0, p_customer_id uuid default null, p_customer_name text default null,
  p_customer_phone text default null, p_custom_rate_per_minute numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_shift public.counter_shifts;
  v_policy public.settings := public.fusion_billing_policy();
  v_existing uuid;
  v_session public.sessions;
  v_table public.club_tables;
  v_customer public.customers;
  v_customer_name text;
  v_product public.inventory_products;
  v_line record;
  v_discount numeric(12, 2) := coalesce(p_discount, 0);
  v_custom_rate numeric(12, 4);
  v_base numeric(12, 2) := 0;
  v_products numeric(12, 2) := 0;
  v_final numeric(12, 2);
  v_floor smallint;
  v_sale_id uuid;
  v_date date;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_client_ref is null then
    raise exception 'Missing checkout reference.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select s.id into v_existing from public.sales s where s.client_ref = p_client_ref;
  if found then
    return public.fusion_receipt_json(v_existing);
  end if;

  v_shift := public.fusion_require_open_shift(v_me);

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer') then
    raise exception 'Choose Cash or Bank Transfer.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if coalesce(p_discount, 0) < 0 or coalesce(p_discount, 0) <> round(coalesce(p_discount, 0), 2) then
    raise exception 'Discount must be a positive amount.' using errcode = '22023', hint = 'invalid_discount';
  end if;
  if v_discount > 0 and not ('apply_discount' = any (v_me.permissions)) then
    raise exception 'You do not have permission to apply discounts.' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_custom_rate_per_minute is not null then
    if p_session_id is null then
      raise exception 'A custom rate applies to table checkouts only.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if not public.fusion_valid_rate(p_custom_rate_per_minute) then
      raise exception 'Enter a rate per minute above zero.' using errcode = '22023', hint = 'invalid_rate';
    end if;
  end if;

  if p_session_id is not null then
    if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
      raise exception 'Table checkouts use the items on the table tab.' using errcode = '22023', hint = 'invalid_input';
    end if;
    v_session := public.fusion_lock_session(p_session_id);
    if v_session.status = 'completed' then
      select s.id into v_existing from public.sales s where s.client_ref = p_client_ref;
      if found then
        return public.fusion_receipt_json(v_existing);
      end if;
      raise exception 'This session has already been paid.' using errcode = 'P0001', hint = 'already_paid';
    end if;
    if v_session.status <> 'billing' then
      raise exception 'End the session before checking out.' using errcode = 'P0001', hint = 'invalid_state';
    end if;
    select t.* into v_table from public.club_tables t where t.id = v_session.table_id;
    v_floor := v_table.floor_id;
    v_base := v_session.base_amount;
    -- A custom rate re-prices all of the session's time at that rate; the
    -- discount below still applies to the re-priced bill.
    if p_custom_rate_per_minute is not null and p_custom_rate_per_minute <> v_session.rate_per_minute then
      if not ('apply_discount' = any (v_me.permissions)) then
        raise exception 'You do not have permission to set a custom rate.' using errcode = '42501', hint = 'forbidden';
      end if;
      v_custom_rate := p_custom_rate_per_minute;
      v_base := public.fusion_charge_at_rate(
        v_session.billable_seconds, v_custom_rate, v_session.booked_seconds,
        v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                                                 'unit_price', i.unit_price, 'quantity', i.quantity)
                              order by i.product_id), '[]'::jsonb)
      into v_lines
    from public.session_items i where i.session_id = p_session_id;
  else
    if not ('counter_sale' = any (v_me.permissions)) then
      raise exception 'You do not have permission to make counter sales.' using errcode = '42501', hint = 'forbidden';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      raise exception 'Add at least one product.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if jsonb_array_length(p_items) > 100 then
      raise exception 'Too many lines in one sale.' using errcode = '22023', hint = 'invalid_input';
    end if;
    v_floor := v_me.floor_id;
    for v_line in
      select x.product_id, sum(x.quantity)::integer as quantity, min(x.unit_price) as unit_price,
             max(x.unit_price) as max_price
      from jsonb_to_recordset(p_items) as x(product_id uuid, quantity integer, unit_price numeric)
      group by x.product_id order by x.product_id
    loop
      if v_line.product_id is null or v_line.quantity is null or v_line.quantity < 1 or v_line.quantity > 999
         or v_line.unit_price is null or v_line.unit_price <> v_line.max_price then
        raise exception 'The cart contains an invalid line.' using errcode = '22023', hint = 'invalid_input';
      end if;
      select p.* into v_product from public.inventory_products p where p.id = v_line.product_id for update;
      if not found then
        raise exception 'A product in the cart no longer exists.' using errcode = 'P0002', hint = 'product_unavailable';
      end if;
      if v_product.selling_price <> v_line.unit_price then
        raise exception 'The price of % changed to PKR %. Review the cart and try again.',
          v_product.name, v_product.selling_price using errcode = 'P0001', hint = 'price_changed';
      end if;
      if v_product.track_stock then
        if v_product.stock_quantity < v_line.quantity then
          raise exception 'Only % × % left in stock.', v_product.stock_quantity, v_product.name
            using errcode = 'P0001', hint = 'insufficient_stock';
        end if;
        update public.inventory_products set stock_quantity = stock_quantity - v_line.quantity, updated_at = now()
        where id = v_product.id;
      end if;
      v_lines := v_lines || jsonb_build_object('product_id', v_product.id, 'name', v_product.name,
                                               'unit_price', v_product.selling_price, 'quantity', v_line.quantity);
    end loop;
  end if;

  select coalesce(sum((l ->> 'unit_price')::numeric * (l ->> 'quantity')::integer), 0)
    into v_products from jsonb_array_elements(v_lines) l;

  if v_discount > v_base + v_products then
    raise exception 'Discount (PKR %) cannot exceed the bill (PKR %).', v_discount, v_base + v_products
      using errcode = '22023', hint = 'invalid_discount';
  end if;

  v_customer := public.fusion_resolve_customer(
    coalesce(p_customer_id, case when p_customer_name is null and p_customer_phone is null
                                 then v_session.customer_id end),
    p_customer_name, p_customer_phone);
  v_customer_name := coalesce(v_customer.name, nullif(btrim(coalesce(p_customer_name, '')), ''),
                              case when p_customer_name is null and p_customer_phone is null
                                   then v_session.customer_name end);

  v_final := v_base + v_products - v_discount;
  v_date := public.fusion_business_date(now());

  insert into public.sales (client_ref, session_id, shift_id, table_name, floor_id, customer_id, customer_name,
                            customer_phone, cashier_id, cashier_name, payment_method, session_seconds,
                            rate_per_minute, standard_rate_per_minute, standard_base_amount,
                            base_amount, products_subtotal, discount, final_amount, business_date)
  values (p_client_ref, v_session.id, v_shift.id, v_table.name, v_floor, v_customer.id, v_customer_name,
          v_customer.phone, v_me.id, v_me.full_name, p_payment_method, v_session.billable_seconds,
          coalesce(v_custom_rate, v_session.rate_per_minute),
          case when v_custom_rate is not null then v_session.rate_per_minute end,
          case when v_custom_rate is not null then v_session.base_amount end,
          v_base, v_products, v_discount, v_final, v_date)
  returning id into v_sale_id;

  insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total)
  select v_sale_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::integer, (l ->> 'unit_price')::numeric * (l ->> 'quantity')::integer
  from jsonb_array_elements(v_lines) l;

  update public.inventory_products p set units_sold = p.units_sold + q.quantity
  from (select (l ->> 'product_id')::uuid as product_id, sum((l ->> 'quantity')::integer) as quantity
        from jsonb_array_elements(v_lines) l group by 1 order by 1) q
  where p.id = q.product_id;

  -- Snack sales are a breakdown of the same money: they are posted as their
  -- own figure but are already inside the cash or bank amount.
  perform public.fusion_post_ledger(v_shift.id, v_me.id, v_date,
    case when p_payment_method = 'cash' then v_final else 0 end,
    case when p_payment_method = 'bank_transfer' then v_final else 0 end,
    v_products, v_discount, 0, 1, 0, 0);
  perform public.fusion_post_visit(v_customer.id, v_date, 1, v_final, coalesce(v_session.billable_seconds, 0)::bigint);

  if v_session.id is not null then
    -- The session keeps the charge actually billed (and the custom rate, if any).
    update public.sessions
    set status = 'completed', customer_id = coalesce(v_customer.id, customer_id),
        customer_name = coalesce(v_customer_name, customer_name),
        custom_rate_per_minute = v_custom_rate, base_amount = v_base
    where id = v_session.id;
    delete from public.session_items where session_id = v_session.id;
    update public.bookings set status = 'completed', updated_at = now()
    where session_id = v_session.id and status = 'started';
  end if;

  return public.fusion_receipt_json(v_sale_id);
end;
$$;

-- 5. Receipt and shift invoices show the rate per minute --------------------------------
create or replace function public.fusion_receipt_json(p_sale_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sale_id', s.id,
    'receipt_no', s.receipt_no,
    'created_at', s.created_at,
    'business_date', s.business_date,
    'club', jsonb_build_object('name', st.club_name, 'address', st.club_address,
                               'phone', st.club_phone, 'footer', st.receipt_footer),
    'table_name', s.table_name,
    'floor_name', f.name,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'cashier_name', s.cashier_name,
    'payment_method', s.payment_method,
    'session', case when s.session_seconds is null then null else jsonb_build_object(
      'started_at', se.started_at, 'ended_at', se.ended_at, 'billable_seconds', s.session_seconds,
      'rate_per_minute', s.rate_per_minute, 'standard_rate_per_minute', s.standard_rate_per_minute,
      'standard_base_amount', s.standard_base_amount, 'booked_seconds', se.booked_seconds,
      'booked_amount', se.booked_amount) end,
    'base_amount', s.base_amount,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'name', i.product_name, 'unit_price', i.unit_price,
                 'quantity', i.quantity, 'line_total', i.line_total) order by i.product_name)
               from public.sale_items i where i.sale_id = s.id), '[]'::jsonb),
    'products_subtotal', s.products_subtotal,
    'discount', s.discount,
    'final_amount', s.final_amount)
  from public.sales s
  cross join public.settings st
  left join public.floors f on f.id = s.floor_id
  left join public.sessions se on se.id = s.session_id
  where s.id = p_sale_id and st.id = 1;
$$;

create or replace function public.get_shift_detail(p_shift_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_shift public.counter_shifts;
  v_invoices_visible boolean;
begin
  select c.* into v_shift from public.counter_shifts c where c.id = p_shift_id;
  if not found or (v_me.role <> 'admin' and v_shift.user_id <> v_me.id) then
    raise exception 'Counter shift not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  v_invoices_visible := v_me.role = 'admin' or 'view_own_sales' = any (v_me.permissions)
                        or 'delete_sales' = any (v_me.permissions);
  return public.fusion_shift_json(p_shift_id) || jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object(
                        'business_date', t.business_date, 'cash', t.cash_sales, 'bank', t.bank_sales,
                        'snack', t.snack_sales, 'expenses', t.expenses, 'invoices', t.invoice_count,
                        'total', t.cash_sales + t.bank_sales) order by t.business_date)
                      from public.shift_daily_totals t where t.shift_id = p_shift_id), '[]'::jsonb),
    'expense_list', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', e.id, 'amount', e.amount, 'description', e.description,
                                'created_at', e.created_at, 'voided_at', e.voided_at) order by e.created_at)
                              from public.expenses e where e.shift_id = p_shift_id), '[]'::jsonb),
    'invoices_visible', v_invoices_visible,
    'retained_invoices', (select count(*) from public.sales s where s.shift_id = p_shift_id),
    'retention_days', (select st.sales_retention_days from public.settings st where st.id = 1),
    'invoice_list', case when not v_invoices_visible then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'receipt_no', s.receipt_no, 'created_at', s.created_at,
               'business_date', s.business_date, 'table_name', s.table_name,
               'customer_name', s.customer_name, 'customer_phone', s.customer_phone,
               'payment_method', s.payment_method, 'session_seconds', s.session_seconds,
               'rate_per_minute', s.rate_per_minute, 'standard_rate_per_minute', s.standard_rate_per_minute,
               'standard_base_amount', s.standard_base_amount,
               'base_amount', s.base_amount, 'products_subtotal', s.products_subtotal,
               'discount', s.discount, 'final_amount', s.final_amount,
               'items', coalesce((select jsonb_agg(jsonb_build_object(
                                    'name', i.product_name, 'unit_price', i.unit_price,
                                    'quantity', i.quantity, 'line_total', i.line_total) order by i.product_name)
                                  from public.sale_items i where i.sale_id = s.id), '[]'::jsonb))
             order by s.created_at)
      from public.sales s where s.shift_id = p_shift_id), '[]'::jsonb) end);
end;
$$;

-- 6. Category and table rates (admin), now per minute ---------------------------------
drop function public.admin_save_category(smallint, text, numeric, integer, boolean);

create function public.admin_save_category(
  p_id smallint, p_name text, p_rate_per_minute numeric, p_sort_order integer default 0,
  p_is_active boolean default true)
returns public.table_categories language plpgsql security definer set search_path = '' as $$
declare
  v_category public.table_categories;
begin
  perform public.fusion_require_admin();
  if not public.fusion_valid_rate(p_rate_per_minute) then
    raise exception 'Enter a rate per minute above zero.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.table_categories (name, rate_per_minute, sort_order, is_active)
    values (btrim(p_name), p_rate_per_minute, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
    returning * into v_category;
  else
    update public.table_categories
    set name = btrim(p_name), rate_per_minute = p_rate_per_minute,
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
    raise exception 'Category needs a name and a rate per minute above zero.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

drop function public.admin_save_table(uuid, text, smallint, smallint, numeric, integer);

create function public.admin_save_table(
  p_id uuid, p_name text, p_category_id smallint, p_floor_id smallint,
  p_rate_per_minute numeric default null, p_sort_order integer default 0)
returns public.club_tables language plpgsql security definer set search_path = '' as $$
declare
  v_table public.club_tables;
begin
  perform public.fusion_require_admin();
  if p_rate_per_minute is not null and not public.fusion_valid_rate(p_rate_per_minute) then
    raise exception 'Enter a rate per minute above zero.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.club_tables (name, category_id, floor_id, rate_override, sort_order)
    values (btrim(p_name), p_category_id, p_floor_id, p_rate_per_minute, coalesce(p_sort_order, 0))
    returning * into v_table;
  else
    -- Rates are snapshotted when a session starts, so editing a table never
    -- changes the bill of a session already in progress.
    update public.club_tables
    set name = btrim(p_name), category_id = p_category_id, floor_id = p_floor_id,
        rate_override = p_rate_per_minute, sort_order = coalesce(p_sort_order, sort_order)
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

-- 7. Grants ------------------------------------------------------------------------
-- Supabase grants new functions to the API roles by default; take that back.
revoke all on function
  public.fusion_amount_for_seconds(integer, numeric),
  public.fusion_charge_at_rate(integer, numeric, integer, integer, text, integer),
  public.fusion_valid_rate(numeric),
  public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text, numeric),
  public.admin_save_category(smallint, text, numeric, integer, boolean),
  public.admin_save_table(uuid, text, smallint, smallint, numeric, integer)
  from public, anon, authenticated;

-- Floor operation (checks the caller's open counter and permissions itself).
grant execute on function
  public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text, numeric)
  to authenticated;

-- Administration (each function calls fusion_require_admin()).
grant execute on function
  public.admin_save_category(smallint, text, numeric, integer, boolean),
  public.admin_save_table(uuid, text, smallint, smallint, numeric, integer)
  to authenticated;

notify pgrst, 'reload schema';
