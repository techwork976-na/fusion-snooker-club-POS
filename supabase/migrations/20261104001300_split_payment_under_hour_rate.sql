-- =============================================================================
-- FUSION 1300: split payments (cash + bank on one bill), an under-1-hour rate
-- for hourly-priced categories, and the Reset business data fix.
--
-- Impact on existing data: none. Three nullable columns are added to existing
-- tables (sales.split_cash_amount, table_categories.under_hour_rate,
-- sessions.under_hour_rate): no rows rewritten, NULL for every existing row,
-- no new tables, nothing deleted or backfilled.
--
-- 1. Split payment. sales.payment_method may be 'split': the bill is paid
--    partly in cash (sales.split_cash_amount) and the rest by bank transfer
--    (final_amount − split_cash_amount, not stored twice). The cash and bank
--    parts are posted to the counter ledger (shift_daily_totals) like any
--    payment, so counters, the dashboard, History, Reports and Close day split
--    them with no further change; the functions that read invoices directly
--    use fusion_cash_part / fusion_bank_part.
-- 2. Under-1-hour rate. A category may be priced 'tiered_hourly': hourly_rate
--    from 1 hour, under_hour_rate (per hour, higher) below it. The whole time
--    is charged at the under-1-hour rate while fewer than 60 minutes are
--    billed and at the hourly rate from 60 minutes (15 min at 800/hour = 200;
--    60 min at 600/hour = 600). Open play, fixed time and fixed amount work as
--    on per-minute tables; a booking never bills less than its booked amount.
--    Sessions keep the prices they started with.
-- 3. Reset business data: the API's safeupdate guard refuses an UPDATE
--    without a WHERE clause, which rolled every reset back with a server
--    error. The products update now names the rows it changes.
-- =============================================================================

-- 1. Split payments ------------------------------------------------------------------------
alter table public.sales drop constraint sales_payment_method_check;
alter table public.sales
  add column split_cash_amount numeric(12, 2),
  add constraint sales_payment_method_check check (payment_method in ('cash', 'bank_transfer', 'split')),
  add constraint sales_split_cash check (
    case when payment_method = 'split' then split_cash_amount > 0 and split_cash_amount < final_amount
         else split_cash_amount is null end);

comment on column public.sales.split_cash_amount is
  'Split payments only: the part paid in cash; the rest (final_amount − this) was paid by bank transfer.';

-- The cash and bank parts of an invoice.
create or replace function public.fusion_cash_part(p_sale public.sales)
returns numeric language sql immutable set search_path = '' as $$
  select case p_sale.payment_method when 'cash' then p_sale.final_amount
                                    when 'split' then p_sale.split_cash_amount else 0 end;
$$;
create or replace function public.fusion_bank_part(p_sale public.sales)
returns numeric language sql immutable set search_path = '' as $$
  select case p_sale.payment_method when 'bank_transfer' then p_sale.final_amount
                                    when 'split' then p_sale.final_amount - p_sale.split_cash_amount else 0 end;
$$;

-- 2. Under-1-hour rate ---------------------------------------------------------------------
alter table public.table_categories
  drop constraint table_categories_pricing_mode,
  drop constraint table_categories_hourly_prices;
alter table public.table_categories
  add column under_hour_rate numeric(12, 2),
  add constraint table_categories_pricing_mode
    check (pricing_mode in ('per_minute', 'hourly_special30', 'tiered_hourly')),
  add constraint table_categories_hourly_prices check (
    (pricing_mode = 'per_minute' and hourly_rate is null and special_30_rate is null and under_hour_rate is null)
    or (pricing_mode = 'hourly_special30'
        and hourly_rate > 0 and hourly_rate <= 1000000
        and special_30_rate > 0 and special_30_rate <= 1000000 and under_hour_rate is null)
    or (pricing_mode = 'tiered_hourly'
        and hourly_rate > 0 and hourly_rate <= 1000000
        and under_hour_rate > hourly_rate and under_hour_rate <= 1000000 and special_30_rate is null));

comment on column public.table_categories.pricing_mode is
  'per_minute (rate_per_minute); hourly_special30 (30 min = special_30_rate; 1 h or more = hourly_rate × hours); '
  'tiered_hourly (under 60 billed minutes = under_hour_rate per hour; from 60 minutes = hourly_rate per hour).';
comment on column public.table_categories.under_hour_rate is
  'Rupees per hour charged for play under 1 hour (tiered_hourly categories).';

alter table public.sessions
  drop constraint sessions_pricing_mode,
  drop constraint sessions_hourly_pricing;
alter table public.sessions
  add column under_hour_rate numeric(12, 2),
  add constraint sessions_pricing_mode check (pricing_mode in ('per_minute', 'hourly_special30', 'tiered_hourly')),
  add constraint sessions_hourly_pricing check (
    (pricing_mode = 'per_minute' and hourly_rate is null and special_30_rate is null and under_hour_rate is null)
    or (pricing_mode = 'hourly_special30' and hourly_rate > 0 and special_30_rate > 0 and under_hour_rate is null
        and booked_seconds is not null and booked_seconds % 1800 = 0)
    or (pricing_mode = 'tiered_hourly' and hourly_rate > 0 and under_hour_rate > 0 and special_30_rate is null));

comment on column public.sessions.under_hour_rate is 'Under-1-hour rate per hour snapshotted at start (tiered_hourly sessions).';

-- The price of billed minutes (mirrored by tierPrice in src/shared/billing.ts):
-- under 60 minutes at the under-1-hour rate, otherwise the hourly rate,
-- pro rata, rounded half-up to a rupee.
create or replace function public.fusion_tier_price(p_minutes integer, p_hourly numeric, p_under_hour numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(p_minutes::numeric * case when p_minutes < 60 then p_under_hour else p_hourly end / 60, 0);
$$;

-- The table charge of a tiered session (mirrored by sessionCharge): the billed
-- minutes priced by fusion_tier_price; a booking never bills less than it cost.
create or replace function public.fusion_tiered_charge(
  p_billable_seconds integer, p_hourly numeric, p_under_hour numeric, p_booked_seconds integer, p_booked_amount numeric,
  p_increment integer, p_rounding text, p_minimum integer)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_booked_seconds is null
              then public.fusion_tier_price(
                     public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_hourly, p_under_hour)
              else greatest(p_booked_amount, public.fusion_tier_price(
                     public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, 0), p_hourly, p_under_hour)) end;
$$;

-- Playing time a prepaid amount buys (mirrored by tierSecondsForAmount): at the
-- hourly rate when it covers an hour, otherwise at the under-1-hour rate.
create or replace function public.fusion_tier_seconds(p_amount numeric, p_hourly numeric, p_under_hour numeric)
returns integer language sql immutable set search_path = '' as $$
  select floor(p_amount * 3600 / case when p_amount >= p_hourly then p_hourly else p_under_hour end)::integer;
$$;

-- 3. Functions (unchanged apart from the lines marked "1300") --------------------------------
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

  -- 1300: the API's safeupdate guard refuses an UPDATE without WHERE (that
  -- rolled the whole reset back); only products that change are written.
  update public.inventory_products
  set units_sold = 0,
      stock_quantity = case when coalesce(p_reset_stock, false) then 0 else stock_quantity end,
      updated_at = now()
  where units_sold <> 0 or (coalesce(p_reset_stock, false) and stock_quantity <> 0);
  update public.settings set business_reset_at = now(), business_reset_by = v_me.id where id = 1;

  return jsonb_build_object('reset_at', now(), 'reset_by', v_me.full_name, 'removed', v_removed,
                            'stock_reset', coalesce(p_reset_stock, false));
end;
$$;

drop function public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text, numeric);

create function public.complete_checkout(
  p_client_ref uuid, p_payment_method text, p_session_id uuid default null, p_items jsonb default null,
  p_discount numeric default 0, p_customer_id uuid default null, p_customer_name text default null,
  p_customer_phone text default null, p_custom_rate_per_minute numeric default null,
  p_split_cash numeric default null)
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

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'split') then
    raise exception 'Choose Cash, Bank Transfer or Split.' using errcode = '22023', hint = 'invalid_input';
  end if;
  -- 1300: a split payment names its cash part; the rest is paid by bank transfer.
  if p_payment_method = 'split' then
    if p_split_cash is null or p_split_cash <= 0 or p_split_cash <> round(p_split_cash, 2) then
      raise exception 'Enter how much of a split payment was paid in cash.' using errcode = '22023', hint = 'invalid_split';
    end if;
  elsif p_split_cash is not null then
    raise exception 'A cash part is only for a split payment.' using errcode = '22023', hint = 'invalid_split';
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
      -- 1300: nor are tables with an under-1-hour rate.
      if v_session.pricing_mode <> 'per_minute' then
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
  if p_payment_method = 'split' and p_split_cash >= v_final then
    raise exception 'The cash part (PKR %) must be less than the total (PKR %); the rest is paid by bank transfer.',
      p_split_cash, v_final using errcode = '22023', hint = 'invalid_split';
  end if;
  v_date := public.fusion_business_date(now());

  insert into public.sales (client_ref, session_id, shift_id, table_name, floor_id, customer_id, customer_name,
                            customer_phone, cashier_id, cashier_name, payment_method, session_seconds,
                            rate_per_minute, standard_rate_per_minute, standard_base_amount,
                            base_amount, products_subtotal, discount, final_amount, business_date, split_cash_amount)
  values (p_client_ref, v_session.id, v_shift.id, v_table.name, v_floor, v_customer.id, v_customer_name,
          v_customer.phone, v_me.id, v_me.full_name, p_payment_method, v_session.billable_seconds,
          coalesce(v_custom_rate, v_session.rate_per_minute),
          case when v_custom_rate is not null then v_session.rate_per_minute end,
          case when v_custom_rate is not null then v_session.base_amount end,
          v_base, v_products, v_discount, v_final, v_date,
          case when p_payment_method = 'split' then p_split_cash end)
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
    case p_payment_method when 'cash' then v_final when 'split' then p_split_cash else 0 end,
    case p_payment_method when 'bank_transfer' then v_final when 'split' then v_final - p_split_cash else 0 end,
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

create or replace function public.delete_sale(p_sale_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_perm('delete_sales', 'delete sales');
  v_sale public.sales;
  v_shift public.counter_shifts;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found. It may already be deleted, or its details were removed by the retention policy.'
      using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_me.role <> 'admin' and v_sale.cashier_id <> v_me.id then
    raise exception 'You can only delete your own sales.' using errcode = '42501', hint = 'forbidden';
  end if;
  select c.* into v_shift from public.counter_shifts c where c.id = v_sale.shift_id for update;
  if v_shift.status <> 'open' then
    raise exception 'This sale belongs to a closed counter shift; its totals are final.'
      using errcode = 'P0001', hint = 'shift_closed';
  end if;

  update public.inventory_products p
  set stock_quantity = case when p.track_stock then p.stock_quantity + q.quantity else p.stock_quantity end,
      units_sold = greatest(p.units_sold - q.quantity, 0),
      updated_at = now()
  from (select i.product_id, sum(i.quantity)::integer as quantity from public.sale_items i
        where i.sale_id = p_sale_id and i.product_id is not null group by 1 order by 1) q
  where p.id = q.product_id;

  perform public.fusion_post_ledger(v_shift.id, v_sale.cashier_id, v_sale.business_date,
    -public.fusion_cash_part(v_sale),
    -public.fusion_bank_part(v_sale),
    -v_sale.products_subtotal, -v_sale.discount, 0, -1, 1, v_sale.final_amount);
  perform public.fusion_post_visit(v_sale.customer_id, v_sale.business_date, -1, -v_sale.final_amount,
                                   -coalesce(v_sale.session_seconds, 0)::bigint);

  -- 0900: take the sale back out of the permanent product sales ledger.
  perform public.fusion_post_product_sales(p_sale_id, -1);
  delete from public.sale_items where sale_id = p_sale_id;
  delete from public.sales where id = p_sale_id;
  if v_sale.session_id is not null then
    update public.sessions set status = 'voided' where id = v_sale.session_id and status = 'completed';
  end if;
end;
$$;

create or replace function public.close_counter(p_shift_id uuid default null, p_handover boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_shift public.counter_shifts;
  v_open_sessions integer;
  v_ledger record;
  v_sales record;
  v_expenses numeric;
begin
  if p_shift_id is null then
    select c.* into v_shift from public.counter_shifts c
    where c.user_id = v_me.id and c.status = 'open' for update;
    if not found then
      raise exception 'Your counter is not open.' using errcode = 'P0001', hint = 'counter_closed';
    end if;
  else
    select c.* into v_shift from public.counter_shifts c where c.id = p_shift_id for update;
    if not found or (v_me.role <> 'admin' and v_shift.user_id <> v_me.id) then
      raise exception 'Counter shift not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
    if v_shift.status <> 'open' then
      raise exception 'This counter is already closed.' using errcode = 'P0001', hint = 'already_closed';
    end if;
  end if;

  select count(*) into v_open_sessions from public.sessions s
  where s.started_shift_id = v_shift.id and s.status in ('running', 'paused', 'billing');
  if v_open_sessions > 0 and not coalesce(p_handover, false) then
    raise exception '% table session(s) started on this counter are still open. Confirm the handover to close: they will be paid at whichever counter checks them out.',
      v_open_sessions using errcode = 'P0001', hint = 'sessions_open';
  end if;

  select coalesce(sum(t.cash_sales), 0) as cash, coalesce(sum(t.bank_sales), 0) as bank,
         coalesce(sum(t.snack_sales), 0) as snack, coalesce(sum(t.expenses), 0) as expenses,
         coalesce(sum(t.invoice_count), 0)::integer as invoices
    into v_ledger
  from public.shift_daily_totals t where t.shift_id = v_shift.id;
  select coalesce(sum(e.amount), 0) into v_expenses from public.expenses e
  where e.shift_id = v_shift.id and e.voided_at is null;
  if (v_ledger.cash, v_ledger.bank, v_ledger.snack, v_ledger.expenses, v_ledger.invoices)
     is distinct from (v_shift.cash_sales, v_shift.bank_sales, v_shift.snack_sales, v_shift.expenses, v_shift.invoice_count)
     or v_expenses <> v_shift.expenses then
    raise exception 'The counter totals do not reconcile; nothing was closed. Contact support.'
      using errcode = 'P0001', hint = 'ledger_mismatch';
  end if;
  if v_shift.details_purged_at is null then
    select coalesce(sum(public.fusion_cash_part(s)), 0) as cash,
           coalesce(sum(public.fusion_bank_part(s)), 0) as bank,
           coalesce(sum(s.products_subtotal), 0) as snack, count(*)::integer as invoices
      into v_sales
    from public.sales s where s.shift_id = v_shift.id;
    if (v_sales.cash, v_sales.bank, v_sales.snack, v_sales.invoices)
       is distinct from (v_shift.cash_sales, v_shift.bank_sales, v_shift.snack_sales, v_shift.invoice_count) then
      raise exception 'The counter totals do not match its invoices; nothing was closed. Contact support.'
        using errcode = 'P0001', hint = 'ledger_mismatch';
    end if;
  end if;

  update public.counter_shifts
  set status = 'closed', closed_at = now(), closed_by = v_me.id, handover_sessions = v_open_sessions
  where id = v_shift.id;
  return public.fusion_shift_json(v_shift.id);
end;
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
               'payment_method', s.payment_method, 'split_cash_amount', s.split_cash_amount,
               'session_seconds', s.session_seconds,
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
           'cash', coalesce(sum(public.fusion_cash_part(s)), 0),
           'bank', coalesce(sum(public.fusion_bank_part(s)), 0),
           'count', count(*),
           'items', coalesce(sum((select sum(i.quantity) from public.sale_items i where i.sale_id = s.id)), 0))
    into v_totals
  from public.sales s
  where s.session_id is null and s.business_date between p_from and p_to and (v_all or s.cashier_id = v_me.id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'receipt_no', x.receipt_no, 'created_at', x.created_at, 'business_date', x.business_date,
           'cashier_name', x.cashier_name, 'payment_method', x.payment_method,
           'split_cash_amount', x.split_cash_amount, 'discount', x.discount,
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
           sum(public.fusion_cash_part(s)) as cash,
           sum(public.fusion_bank_part(s)) as bank,
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
    'split_cash_amount', s.split_cash_amount,
    'session', case when s.session_seconds is null then null else jsonb_build_object(
      'started_at', se.started_at, 'ended_at', se.ended_at, 'billable_seconds', s.session_seconds,
      'rate_per_minute', s.rate_per_minute, 'standard_rate_per_minute', s.standard_rate_per_minute,
      'standard_base_amount', s.standard_base_amount, 'booked_seconds', se.booked_seconds,
      'booked_amount', se.booked_amount,
      -- 1100: hourly pricing is shown on the receipt.
      'pricing_mode', se.pricing_mode, 'hourly_rate', se.hourly_rate, 'special_30_rate', se.special_30_rate,
      'under_hour_rate', se.under_hour_rate) end,
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
  -- 1300: a table's own per-minute rate applies to per-minute categories only.
  v_rate := case when v_category.pricing_mode <> 'per_minute' then v_category.rate_per_minute
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
      elsif v_category.pricing_mode = 'tiered_hourly' then
        -- 1300: under an hour at the under-1-hour rate, an hour or more at the hourly rate.
        v_booked_amount := public.fusion_tier_price(p_minutes, v_category.hourly_rate, v_category.under_hour_rate);
      else
        v_booked_amount := public.fusion_amount_for_minutes(p_minutes, v_rate);
      end if;
    when 'amount' then
      if p_amount is null or p_amount <= 0 or p_amount > 1000000 or p_amount <> round(p_amount, 2) then
        raise exception 'Enter a valid amount.' using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_seconds := case when v_category.pricing_mode = 'tiered_hourly'
                               then public.fusion_tier_seconds(p_amount, v_category.hourly_rate, v_category.under_hour_rate)
                               else floor(p_amount * 60 / v_rate)::integer end;
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
                               pricing_mode, hourly_rate, special_30_rate, under_hour_rate)
  values (p_table_id, v_customer.id,
          coalesce(v_customer.name, nullif(btrim(coalesce(p_customer_name, '')), '')),
          'running', v_rate, v_booked_seconds, v_booked_amount, now(), v_me.id,
          (select c.id from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open'),
          v_category.pricing_mode,
          case when v_category.pricing_mode <> 'per_minute' then v_category.hourly_rate end,
          case when v_category.pricing_mode = 'hourly_special30' then v_category.special_30_rate end,
          case when v_category.pricing_mode = 'tiered_hourly' then v_category.under_hour_rate end)
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
  -- 1000: a booking that was not continued holds at its booked time.
  v_billable := public.fusion_billable_seconds(v_session, now());

  update public.sessions
  set status = 'billing',
      paused_at = null,
      paused_ms = v_paused_ms,
      ended_at = now(),
      ended_by = v_me.id,
      billable_seconds = v_billable,
      base_amount = case when pricing_mode = 'tiered_hourly'
        -- 1300: the whole time at the under-1-hour rate below 60 billed minutes, else the hourly rate.
        then public.fusion_tiered_charge(
          v_billable, hourly_rate, under_hour_rate, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
        else public.fusion_session_charge(
          v_billable, rate_per_minute, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes) end
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
        base_amount = case when pricing_mode = 'tiered_hourly'
          -- 1300: the whole time at the under-1-hour rate below 60 billed minutes, else the hourly rate.
          then public.fusion_tiered_charge(
            v_billable, hourly_rate, under_hour_rate, booked_seconds, booked_amount,
            v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
          else public.fusion_session_charge(
            v_billable, rate_per_minute, booked_seconds, booked_amount,
            v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes) end
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
        -- 1100: the category's pricing mode (a table's own per-minute rate applies to per-minute pricing only).
        'rate_per_minute', case when c.pricing_mode <> 'per_minute' then c.rate_per_minute
                                else coalesce(t.rate_override, c.rate_per_minute) end,
        'pricing_mode', c.pricing_mode, 'hourly_rate', c.hourly_rate, 'special_30_rate', c.special_30_rate,
        'under_hour_rate', c.under_hour_rate,
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
            'under_hour_rate', s.under_hour_rate,
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

drop function public.admin_save_category(smallint, text, numeric, integer, boolean, text, numeric, numeric);

create function public.admin_save_category(
  p_id smallint, p_name text, p_rate_per_minute numeric default null, p_sort_order integer default 0,
  p_is_active boolean default true, p_pricing_mode text default 'per_minute',
  p_hourly_rate numeric default null, p_special_30_rate numeric default null,
  p_under_hour_rate numeric default null)
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
  elsif v_mode = 'tiered_hourly' then
    -- 1300: the hourly rate from 1 hour, a higher rate for shorter play.
    if p_hourly_rate is null or p_hourly_rate <= 0 or p_hourly_rate > 1000000 or p_hourly_rate <> round(p_hourly_rate, 2) then
      raise exception 'Enter an hourly rate above zero.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if p_under_hour_rate is null or p_under_hour_rate > 1000000 or p_under_hour_rate <> round(p_under_hour_rate, 2) then
      raise exception 'Enter the under-1-hour rate per hour.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if p_under_hour_rate <= p_hourly_rate then
      raise exception 'The under-1-hour rate must be higher than the hourly rate.' using errcode = '22023', hint = 'invalid_input';
    end if;
    -- The hourly rate per minute, for display and reporting; sessions are priced by fusion_tiered_charge.
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
    insert into public.table_categories (name, rate_per_minute, sort_order, is_active, pricing_mode, hourly_rate, special_30_rate,
                                         under_hour_rate)
    values (btrim(p_name), v_rate, coalesce(p_sort_order, 0), coalesce(p_is_active, true), v_mode,
            case when v_mode <> 'per_minute' then p_hourly_rate end,
            case when v_mode = 'hourly_special30' then p_special_30_rate end,
            case when v_mode = 'tiered_hourly' then p_under_hour_rate end)
    returning * into v_category;
  else
    update public.table_categories
    set name = btrim(p_name), rate_per_minute = v_rate,
        sort_order = coalesce(p_sort_order, sort_order), is_active = coalesce(p_is_active, is_active),
        pricing_mode = v_mode,
        hourly_rate = case when v_mode <> 'per_minute' then p_hourly_rate end,
        special_30_rate = case when v_mode = 'hourly_special30' then p_special_30_rate end,
        under_hour_rate = case when v_mode = 'tiered_hourly' then p_under_hour_rate end
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

-- 4. Grants ----------------------------------------------------------------------------------
-- Supabase grants new functions to the API roles by default; take that back.
revoke all on function
  public.fusion_cash_part(public.sales),
  public.fusion_bank_part(public.sales),
  public.fusion_tier_price(integer, numeric, numeric),
  public.fusion_tiered_charge(integer, numeric, numeric, integer, numeric, integer, text, integer),
  public.fusion_tier_seconds(numeric, numeric, numeric),
  public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text, numeric, numeric),
  public.admin_save_category(smallint, text, numeric, integer, boolean, text, numeric, numeric, numeric)
  from public, anon, authenticated;

-- Checkout: any signed-in user (the function checks the counter, floor and permissions).
grant execute on function public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text, numeric, numeric)
  to authenticated;
-- Administration (calls fusion_require_admin()).
grant execute on function public.admin_save_category(smallint, text, numeric, integer, boolean, text, numeric, numeric, numeric)
  to authenticated;

notify pgrst, 'reload schema';
