-- =============================================================================
-- FUSION — "Hourly + special 30-minute rate" pricing mode for categories.
--
-- IMPACT ON EXISTING DATA: none. New columns default to the existing per-minute
-- pricing, so every category, session and invoice keeps its price.
--
-- A category priced "hourly + special 30-minute rate" (e.g. PS5: PKR 600/hour,
-- 30 minutes PKR 400) sells time in 30-minute steps:
--   * exactly 30 minutes  = the special 30-minute price;
--   * 1 hour or more      = the hourly rate × hours (1.5 h = 1.5 × hourly).
-- The special price is never added to the hourly price. Such a session is a
-- fixed-time booking: its booked amount is computed by fusion_slot_price(),
-- and everything that already works for bookings (pause/resume, the "time's
-- up" hold and alarm, checkout, reports) applies unchanged.
--   * The session snapshots its hourly and 30-minute prices when it starts,
--     so a later price change never alters it, its extensions or its invoice.
--   * extend_session() adds 30-minute steps and re-prices the TOTAL duration
--     (1 h + 30 min = 1.5 h = 1.5 × hourly, not hourly + special).
--   * Open play, prepaid amounts, per-minute "continue" and per-minute custom
--     rates do not apply to these categories (a discount still does).
-- Per-minute categories (Snooker, Pool) are unchanged.
-- =============================================================================

-- 1. Category pricing mode -----------------------------------------------------------
alter table public.table_categories
  add column pricing_mode text not null default 'per_minute'
    constraint table_categories_pricing_mode check (pricing_mode in ('per_minute', 'hourly_special30')),
  add column hourly_rate numeric(12, 2),
  add column special_30_rate numeric(12, 2),
  add constraint table_categories_hourly_prices check (
    (pricing_mode = 'per_minute' and hourly_rate is null and special_30_rate is null)
    or (pricing_mode = 'hourly_special30'
        and hourly_rate > 0 and hourly_rate <= 1000000
        and special_30_rate > 0 and special_30_rate <= 1000000));

comment on column public.table_categories.pricing_mode is
  'per_minute (rate_per_minute) or hourly_special30 (30 min = special_30_rate; 1 h or more = hourly_rate × hours).';
comment on column public.table_categories.hourly_rate is 'Rupees per hour (hourly_special30 categories).';
comment on column public.table_categories.special_30_rate is 'Price of a 30-minute session (hourly_special30 categories).';

-- 2. Sessions keep the prices they started with ---------------------------------------
alter table public.sessions
  add column pricing_mode text not null default 'per_minute'
    constraint sessions_pricing_mode check (pricing_mode in ('per_minute', 'hourly_special30')),
  add column hourly_rate numeric(12, 2),
  add column special_30_rate numeric(12, 2),
  add constraint sessions_hourly_pricing check (
    (pricing_mode = 'per_minute' and hourly_rate is null and special_30_rate is null)
    or (pricing_mode = 'hourly_special30' and hourly_rate > 0 and special_30_rate > 0
        and booked_seconds is not null and booked_seconds % 1800 = 0));

comment on column public.sessions.pricing_mode is 'The category''s pricing mode when the session started.';
comment on column public.sessions.hourly_rate is 'Hourly rate snapshotted at start (hourly_special30 sessions).';
comment on column public.sessions.special_30_rate is '30-minute price snapshotted at start (hourly_special30 sessions).';

-- 3. The price of a duration (mirrored by slotPrice in src/shared/billing.ts) ----------
-- Valid for 30-minute steps: 30 minutes = the special price; otherwise the
-- hourly rate × hours, rounded half-up to a rupee.
create or replace function public.fusion_slot_price(p_minutes integer, p_hourly numeric, p_special_30 numeric)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_minutes = 30 then p_special_30 else round(p_hourly * p_minutes / 60.0, 0) end;
$$;

-- 4. Starting a session: the category's pricing mode decides the price -----------------
-- (start_session is unchanged apart from the lines marked "1100".)
create or replace function public.start_session(
  p_table_id uuid, p_booking text default 'open', p_minutes integer default null, p_amount numeric default null,
  p_customer_id uuid default null, p_customer_name text default null, p_customer_phone text default null)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_customer public.customers;
  v_table public.club_tables;
  v_category public.table_categories;
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

  -- 1100: the category's pricing mode decides how the session is priced.
  select c.* into v_category from public.table_categories c where c.id = v_table.category_id;
  v_rate := case when v_category.pricing_mode = 'hourly_special30' then v_category.rate_per_minute
                 else coalesce(v_table.rate_override, v_category.rate_per_minute) end;
  if v_category.pricing_mode = 'hourly_special30' and coalesce(p_booking, 'open') <> 'minutes' then
    raise exception '% is priced by the hour: choose a duration (30 minutes, 1 hour, 1.5 hours …).', v_category.name
      using errcode = '22023', hint = 'duration_required';
  end if;

  case coalesce(p_booking, 'open')
    when 'open' then
      null;
    when 'minutes' then
      if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
        raise exception 'Booked time must be between 1 and 1440 minutes.' using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_seconds := p_minutes * 60;
      if v_category.pricing_mode = 'hourly_special30' then
        -- 1100: 30 minutes = the special price; 1 hour or more = the hourly rate × hours.
        if p_minutes % 30 <> 0 then
          raise exception 'Choose the time in steps of 30 minutes.' using errcode = '22023', hint = 'invalid_input';
        end if;
        v_booked_amount := public.fusion_slot_price(p_minutes, v_category.hourly_rate, v_category.special_30_rate);
      else
        v_booked_amount := public.fusion_amount_for_minutes(p_minutes, v_rate);
      end if;
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

  -- 1100: the session keeps the category's prices from this moment on.
  insert into public.sessions (table_id, customer_id, customer_name, status, rate_per_minute, booked_seconds,
                               booked_amount, started_at, started_by, started_shift_id,
                               pricing_mode, hourly_rate, special_30_rate)
  values (p_table_id, v_customer.id,
          coalesce(v_customer.name, nullif(btrim(coalesce(p_customer_name, '')), '')),
          'running', v_rate, v_booked_seconds, v_booked_amount, now(), v_me.id,
          (select c.id from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open'),
          v_category.pricing_mode,
          case when v_category.pricing_mode = 'hourly_special30' then v_category.hourly_rate end,
          case when v_category.pricing_mode = 'hourly_special30' then v_category.special_30_rate end)
  returning * into v_session;
  return v_session;
exception
  when unique_violation then
    raise exception 'This table is already in use.' using errcode = 'P0001', hint = 'table_busy';
end;
$$;

-- Pre-bookings on an hourly-priced table start with a chosen duration.
drop function public.start_booking(uuid, uuid);
create function public.start_booking(p_booking_id uuid, p_table_id uuid default null, p_minutes integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_booking public.bookings;
  v_table uuid;
  v_session public.sessions;
begin
  select b.* into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_booking.status in ('started', 'completed') then
    raise exception 'This booking has already been started.' using errcode = 'P0001', hint = 'already_started';
  end if;
  if v_booking.status <> 'booked' then
    raise exception 'Only a booked reservation can be started.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  v_table := coalesce(p_table_id, v_booking.table_id);
  if v_table is null then
    raise exception 'Choose a table for this booking.' using errcode = '22023', hint = 'invalid_input';
  end if;

  -- 1100: a duration (required for tables priced by the hour) books the time.
  v_session := public.start_session(p_table_id => v_table,
                                    p_booking => case when p_minutes is null then 'open' else 'minutes' end,
                                    p_minutes => p_minutes, p_customer_id => v_booking.customer_id,
                                    p_customer_name => v_booking.customer_name,
                                    p_customer_phone => v_booking.customer_phone);
  update public.bookings
  set status = 'started', session_id = v_session.id, table_id = v_table, customer_id = v_session.customer_id,
      started_at = now(), started_by = v_me.id, updated_at = now()
  where id = p_booking_id returning * into v_booking;
  return jsonb_build_object('booking', to_jsonb(v_booking), 'session', to_jsonb(v_session));
end;
$$;

-- 5. Extending an hourly-priced session -------------------------------------------------
-- Adds 30-minute steps and re-prices the whole session from its total time.
-- Minutes a used-up booking was held (waiting for staff) are not used up, and
-- the "time's up" alarm re-arms for the new end. p_from_booked_seconds is the
-- booked time the caller saw: a repeated click or a second terminal can never
-- extend twice.
create or replace function public.extend_session(p_session_id uuid, p_minutes integer, p_from_booked_seconds integer)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
  v_raw_ms bigint;
  v_total integer;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.pricing_mode <> 'hourly_special30' then
    raise exception 'Only tables priced by the hour are extended in 30-minute steps.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_session.status not in ('running', 'paused') then
    raise exception 'Only a session that is still in play can be extended.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if p_minutes is null or p_minutes < 30 or p_minutes % 30 <> 0 then
    raise exception 'Extend in steps of 30 minutes.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_from_booked_seconds is distinct from v_session.booked_seconds then
    raise exception 'This session was just changed on another terminal. Check it and try again.'
      using errcode = 'P0001', hint = 'stale';
  end if;
  v_total := v_session.booked_seconds / 60 + p_minutes;
  if v_total > 1440 then
    raise exception 'A session can be booked for at most 24 hours.' using errcode = '22023', hint = 'invalid_input';
  end if;

  v_raw_ms := public.fusion_ms_between(v_session.started_at, coalesce(v_session.paused_at, now())) - v_session.paused_ms;
  update public.sessions
  set paused_ms = paused_ms + greatest(0, v_raw_ms - booked_seconds::bigint * 1000),
      booked_seconds = v_total * 60,
      booked_amount = public.fusion_slot_price(v_total, hourly_rate, special_30_rate),
      allocation_alert_ack_at = null
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

-- (continue_after_allocation is unchanged apart from the lines marked "1100".)
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
  -- 1100: tables priced by the hour are extended in 30-minute steps, never by the minute.
  if v_session.pricing_mode = 'hourly_special30' then
    raise exception 'This table is priced by the hour: extend it by 30 minutes or more instead.'
      using errcode = 'P0001', hint = 'use_extend';
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

-- (complete_checkout is unchanged apart from the lines marked "1100".)
create or replace function public.complete_checkout(
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
      -- 1100: tables priced by the hour are not re-priced per minute (a discount still applies).
      if v_session.pricing_mode = 'hourly_special30' then
        raise exception 'Custom rates per minute do not apply to tables priced by the hour. Use a discount instead.'
          using errcode = '22023', hint = 'invalid_rate';
      end if;
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

  -- 0900: each line keeps the product's cost price at the moment of sale.
  insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total, unit_cost)
  select v_sale_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::integer, (l ->> 'unit_price')::numeric * (l ->> 'quantity')::integer,
         (select p.cost_price from public.inventory_products p where p.id = (l ->> 'product_id')::uuid)
  from jsonb_array_elements(v_lines) l;
  -- 0900: the permanent product sales ledger.
  perform public.fusion_post_product_sales(v_sale_id, 1);

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

-- 6. Category administration ---------------------------------------------------------
drop function public.admin_save_category(smallint, text, numeric, integer, boolean);

create function public.admin_save_category(
  p_id smallint, p_name text, p_rate_per_minute numeric default null, p_sort_order integer default 0,
  p_is_active boolean default true, p_pricing_mode text default 'per_minute',
  p_hourly_rate numeric default null, p_special_30_rate numeric default null)
returns public.table_categories language plpgsql security definer set search_path = '' as $$
declare
  v_category public.table_categories;
  v_mode text := coalesce(p_pricing_mode, 'per_minute');
  v_rate numeric;
begin
  perform public.fusion_require_admin();
  if v_mode = 'hourly_special30' then
    if p_hourly_rate is null or p_hourly_rate <= 0 or p_hourly_rate > 1000000 or p_hourly_rate <> round(p_hourly_rate, 2) then
      raise exception 'Enter an hourly rate above zero.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if p_special_30_rate is null or p_special_30_rate <= 0 or p_special_30_rate > 1000000
       or p_special_30_rate <> round(p_special_30_rate, 2) then
      raise exception 'Enter a 30-minute price above zero.' using errcode = '22023', hint = 'invalid_input';
    end if;
    -- Kept for display and reporting only; sessions are priced by fusion_slot_price.
    v_rate := greatest(round(p_hourly_rate / 60, 4), 0.0001);
  elsif v_mode = 'per_minute' then
    if not public.fusion_valid_rate(p_rate_per_minute) then
      raise exception 'Enter a rate per minute above zero.' using errcode = '22023', hint = 'invalid_input';
    end if;
    v_rate := p_rate_per_minute;
  else
    raise exception 'Unknown pricing mode.' using errcode = '22023', hint = 'invalid_input';
  end if;

  if p_id is null then
    insert into public.table_categories (name, rate_per_minute, sort_order, is_active, pricing_mode, hourly_rate, special_30_rate)
    values (btrim(p_name), v_rate, coalesce(p_sort_order, 0), coalesce(p_is_active, true), v_mode,
            case when v_mode = 'hourly_special30' then p_hourly_rate end,
            case when v_mode = 'hourly_special30' then p_special_30_rate end)
    returning * into v_category;
  else
    update public.table_categories
    set name = btrim(p_name), rate_per_minute = v_rate,
        sort_order = coalesce(p_sort_order, sort_order), is_active = coalesce(p_is_active, is_active),
        pricing_mode = v_mode,
        hourly_rate = case when v_mode = 'hourly_special30' then p_hourly_rate end,
        special_30_rate = case when v_mode = 'hourly_special30' then p_special_30_rate end
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
    raise exception 'Category needs a name and valid prices.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

-- 7. The floor and receipts show the pricing ------------------------------------------
-- (Unchanged apart from the lines marked "1100".)
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
        -- 1100: the category's pricing mode (a table's own per-minute rate applies to per-minute pricing only).
        'rate_per_minute', case when c.pricing_mode = 'hourly_special30' then c.rate_per_minute
                                else coalesce(t.rate_override, c.rate_per_minute) end,
        'pricing_mode', c.pricing_mode, 'hourly_rate', c.hourly_rate, 'special_30_rate', c.special_30_rate,
        'session', (
          select jsonb_build_object(
            'id', s.id, 'status', s.status, 'rate_per_minute', s.rate_per_minute,
            'booked_seconds', s.booked_seconds, 'booked_amount', s.booked_amount,
            'started_at', s.started_at, 'paused_at', s.paused_at, 'paused_ms', s.paused_ms,
            'ended_at', s.ended_at, 'billable_seconds', s.billable_seconds, 'base_amount', s.base_amount,
            -- 1000: the "time's up" state of a booking.
            'allocation_alert_ack_at', s.allocation_alert_ack_at, 'allocation_extended_at', s.allocation_extended_at,
            -- 1100: the prices the session started with.
            'pricing_mode', s.pricing_mode, 'hourly_rate', s.hourly_rate, 'special_30_rate', s.special_30_rate,
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
      'booked_amount', se.booked_amount,
      -- 1100: hourly pricing is shown on the receipt.
      'pricing_mode', se.pricing_mode, 'hourly_rate', se.hourly_rate, 'special_30_rate', se.special_30_rate) end,
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

-- 8. Grants ------------------------------------------------------------------------
-- Supabase grants new functions to the API roles by default; take that back.
revoke all on function
  public.fusion_slot_price(integer, numeric, numeric),
  public.extend_session(uuid, integer, integer),
  public.start_booking(uuid, uuid, integer),
  public.admin_save_category(smallint, text, numeric, integer, boolean, text, numeric, numeric)
  from public, anon, authenticated;

-- Floor operation (floor-checked through fusion_lock_session).
grant execute on function public.extend_session(uuid, integer, integer) to authenticated;
-- Administration (each calls fusion_require_admin()).
grant execute on function
  public.start_booking(uuid, uuid, integer),
  public.admin_save_category(smallint, text, numeric, integer, boolean, text, numeric, numeric)
  to authenticated;

notify pgrst, 'reload schema';
