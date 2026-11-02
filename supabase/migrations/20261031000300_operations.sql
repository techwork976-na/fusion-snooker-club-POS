-- =============================================================================
-- FUSION — floor operations: sessions, table tabs, checkout, sales, customers
-- Every function validates the caller and its inputs; row locks serialise
-- concurrent operations on the same table, session or product.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal: lock a session (and check the caller may operate its table).
-- ---------------------------------------------------------------------------
create or replace function public.fusion_lock_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
  v_floor smallint;
begin
  select s.* into v_session from public.sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'Session not found. It may have been closed on another terminal.'
      using errcode = 'P0002', hint = 'not_found';
  end if;
  select t.floor_id into v_floor from public.club_tables t where t.id = v_session.table_id;
  perform public.fusion_assert_floor(v_floor);
  return v_session;
end;
$$;

create or replace function public.fusion_billing_policy()
returns public.settings language sql stable security definer set search_path = '' as $$
  select s.* from public.settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
create or replace function public.start_session(
  p_table_id uuid,
  p_booking text default 'open',
  p_minutes integer default null,
  p_amount numeric default null,
  p_customer_id uuid default null,
  p_customer_name text default null,
  p_customer_phone text default null)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_customer public.customers;
  v_table public.club_tables;
  v_rate numeric(10, 2);
  v_booked_seconds integer;
  v_booked_amount numeric(12, 2);
  v_session public.sessions;
begin
  -- Locking the table row serialises concurrent "start" requests for it.
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

  select coalesce(v_table.rate_override, c.rate_per_hour) into v_rate
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
      v_booked_seconds := floor(p_amount * 3600 / v_rate)::integer;
      if v_booked_seconds < 60 then
        raise exception 'PKR % does not cover one minute of play at PKR %/hour.', p_amount, v_rate
          using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_amount := p_amount;
    else
      raise exception 'Unknown booking type.' using errcode = '22023', hint = 'invalid_input';
  end case;

  v_customer := public.fusion_resolve_customer(p_customer_id, p_customer_name, p_customer_phone);

  insert into public.sessions (table_id, customer_id, status, rate_per_hour, booked_seconds, booked_amount,
                               started_at, started_by)
  values (p_table_id, v_customer.id, 'running', v_rate, v_booked_seconds, v_booked_amount, now(), v_me.id)
  returning * into v_session;
  return v_session;
exception
  when unique_violation then
    raise exception 'This table is already in use.' using errcode = 'P0001', hint = 'table_busy';
end;
$$;

create or replace function public.pause_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'running' then
    raise exception 'Only a running session can be paused.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions set status = 'paused', paused_at = now()
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

create or replace function public.resume_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'paused' then
    raise exception 'Only a paused session can be resumed.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions
  set status = 'running',
      paused_ms = paused_ms + public.fusion_ms_between(paused_at, now()),
      paused_at = null
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

-- Stops the clock and fixes the session charge; the table stays reserved in
-- "billing" until checkout completes (or the session is reopened).
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
        v_billable, rate_per_hour, booked_seconds, booked_amount,
        v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

-- Undo an accidental "End": the time spent in billing is not charged.
create or replace function public.reopen_session(p_session_id uuid)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'billing' then
    raise exception 'Only a session awaiting checkout can be reopened.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions
  set status = 'running',
      paused_ms = paused_ms + public.fusion_ms_between(ended_at, now()),
      ended_at = null, ended_by = null, billable_seconds = null, base_amount = null
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

-- Discard a session without charging (e.g. started on the wrong table).
create or replace function public.cancel_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_perm('cancel_session', 'cancel sessions');
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status = 'completed' then
    raise exception 'A paid session cannot be cancelled.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.inventory_products p
  set stock_quantity = p.stock_quantity + i.quantity, updated_at = now()
  from (select si.product_id, si.quantity from public.session_items si
        where si.session_id = p_session_id order by si.product_id) i
  where p.id = i.product_id and p.track_stock;
  delete from public.sessions where id = p_session_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Table tab (items served during a session)
-- ---------------------------------------------------------------------------
create or replace function public.add_session_item(p_session_id uuid, p_product_id uuid, p_quantity integer default 1)
returns public.session_items language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_session public.sessions;
  v_product public.inventory_products;
  v_item public.session_items;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 999 then
    raise exception 'Quantity must be between 1 and 999.' using errcode = '22023', hint = 'invalid_input';
  end if;
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'Items can only be added to an open session.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  select p.* into v_product from public.inventory_products p where p.id = p_product_id for update;
  if not found or not v_product.is_active then
    raise exception 'That product is no longer available.' using errcode = 'P0002', hint = 'product_unavailable';
  end if;
  if v_product.track_stock and v_product.stock_quantity < p_quantity then
    raise exception 'Only % × % left in stock.', v_product.stock_quantity, v_product.name
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

  if v_product.track_stock then
    update public.inventory_products set stock_quantity = stock_quantity - p_quantity, updated_at = now()
    where id = p_product_id;
  end if;

  insert into public.session_items as si (session_id, product_id, product_name, unit_price, quantity, added_by)
  values (p_session_id, p_product_id, v_product.name, v_product.selling_price, p_quantity, v_me.id)
  on conflict (session_id, product_id)
    do update set quantity = si.quantity + excluded.quantity
  returning * into v_item;
  return v_item;
exception
  when check_violation then
    raise exception 'Quantity must be between 1 and 999.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

-- Set an item's quantity (0 removes it). Stock is adjusted by the difference.
create or replace function public.set_session_item_quantity(p_item_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item public.session_items;
  v_session public.sessions;
  v_product public.inventory_products;
  v_delta integer;
begin
  perform public.fusion_require_user();
  if p_quantity is null or p_quantity < 0 or p_quantity > 999 then
    raise exception 'Quantity must be between 0 and 999.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select i.* into v_item from public.session_items i where i.id = p_item_id;
  if not found then
    raise exception 'That item is no longer on the tab.' using errcode = 'P0002', hint = 'not_found';
  end if;
  v_session := public.fusion_lock_session(v_item.session_id);
  if v_session.status = 'completed' then
    raise exception 'This session has already been paid.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  select i.* into v_item from public.session_items i where i.id = p_item_id for update;
  if not found then
    raise exception 'That item is no longer on the tab.' using errcode = 'P0002', hint = 'not_found';
  end if;

  v_delta := p_quantity - v_item.quantity;
  select p.* into v_product from public.inventory_products p where p.id = v_item.product_id for update;
  if v_delta > 0 and v_product.track_stock and v_product.stock_quantity < v_delta then
    raise exception 'Only % × % left in stock.', v_product.stock_quantity, v_product.name
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;
  if v_product.track_stock and v_delta <> 0 then
    update public.inventory_products set stock_quantity = stock_quantity - v_delta, updated_at = now()
    where id = v_product.id;
  end if;

  if p_quantity = 0 then
    delete from public.session_items where id = p_item_id;
  else
    update public.session_items set quantity = p_quantity where id = p_item_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
-- Finds or creates the customer for a checkout without creating duplicates:
-- a phone number identifies a customer; without a phone we reuse an existing
-- phone-less record with the same name.
create or replace function public.fusion_resolve_customer(p_customer_id uuid, p_name text, p_phone text)
returns public.customers language plpgsql security definer set search_path = '' as $$
declare
  v_customer public.customers;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_phone text := public.fusion_normalize_phone(p_phone);
begin
  if p_customer_id is not null then
    select c.* into v_customer from public.customers c where c.id = p_customer_id;
    if not found then
      raise exception 'Customer not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
    return v_customer;
  end if;
  if v_name is null and v_phone is null then
    return null;
  end if;
  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'Customer name is too long.' using errcode = '22023', hint = 'invalid_input';
  end if;

  if v_phone is not null then
    select c.* into v_customer from public.customers c where c.phone = v_phone;
    if found then
      return v_customer;
    end if;
    if v_name is null then
      raise exception 'Enter the customer''s name for a new phone number.' using errcode = '22023', hint = 'invalid_input';
    end if;
    insert into public.customers (name, phone) values (v_name, v_phone)
    on conflict (phone) where phone is not null do nothing
    returning * into v_customer;
    if v_customer.id is null then
      select c.* into v_customer from public.customers c where c.phone = v_phone;
    end if;
    return v_customer;
  end if;

  select c.* into v_customer from public.customers c
  where c.phone is null and lower(c.name) = lower(v_name) order by c.created_at limit 1;
  if found then
    return v_customer;
  end if;
  insert into public.customers (name) values (v_name) returning * into v_customer;
  return v_customer;
end;
$$;

create or replace function public.search_customers(p_query text default '', p_limit integer default 8)
returns setof public.customers language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
begin
  perform public.fusion_require_user();
  return query
    select c.* from public.customers c
    where v_q = ''
       or lower(c.name) like '%' || replace(replace(v_q, '%', ''), '_', '') || '%'
       or (char_length(v_digits) >= 3 and c.phone like '%' || v_digits || '%')
    order by (lower(c.name) like replace(replace(v_q, '%', ''), '_', '') || '%') desc, c.name
    limit least(greatest(coalesce(p_limit, 8), 1), 50);
end;
$$;

create or replace function public.save_customer(p_id uuid, p_name text, p_phone text)
returns public.customers language plpgsql security definer set search_path = '' as $$
declare
  v_customer public.customers;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := public.fusion_normalize_phone(p_phone);
begin
  perform public.fusion_require_perm('manage_customers', 'edit customers');
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Customer name is required (up to 80 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.customers (name, phone) values (v_name, v_phone) returning * into v_customer;
  else
    update public.customers set name = v_name, phone = v_phone, updated_at = now()
    where id = p_id returning * into v_customer;
    if not found then
      raise exception 'Customer not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_customer;
exception
  when unique_violation then
    raise exception 'Another customer already uses phone number %.', v_phone
      using errcode = '23505', hint = 'duplicate_phone';
end;
$$;

-- ---------------------------------------------------------------------------
-- Product search for the POS (sale-facing columns only — never cost price).
-- ---------------------------------------------------------------------------
create or replace function public.search_products(p_query text default '', p_limit integer default 40)
returns table (id uuid, name text, category text, selling_price numeric, track_stock boolean, stock_quantity integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := replace(replace(lower(btrim(coalesce(p_query, ''))), '%', ''), '_', '');
begin
  perform public.fusion_require_user();
  return query
    select p.id, p.name, p.category, p.selling_price, p.track_stock, p.stock_quantity
    from public.inventory_products p
    where p.is_active and (v_q = '' or lower(p.name) like '%' || v_q || '%' or lower(p.category) like v_q || '%')
    order by (lower(p.name) like v_q || '%') desc, p.name
    limit least(greatest(coalesce(p_limit, 40), 1), 100);
end;
$$;

-- Stock corrections and restocking (delta-based so they can never overwrite a
-- concurrent sale).
create or replace function public.adjust_stock(p_product_id uuid, p_delta integer)
returns table (id uuid, name text, stock_quantity integer) language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
begin
  perform public.fusion_require_perm('adjust_stock', 'adjust stock');
  if p_delta is null or p_delta = 0 or abs(p_delta) > 100000 then
    raise exception 'Enter a non-zero quantity.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select p.* into v_product from public.inventory_products p where p.id = p_product_id for update;
  if not found then
    raise exception 'Product not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not v_product.track_stock then
    raise exception '% does not track stock.', v_product.name using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_product.stock_quantity + p_delta < 0 then
    raise exception 'Stock cannot go below zero (currently %).', v_product.stock_quantity
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;
  update public.inventory_products p set stock_quantity = p.stock_quantity + p_delta, updated_at = now()
  where p.id = p_product_id returning * into v_product;
  return query select v_product.id, v_product.name, v_product.stock_quantity;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipts
-- ---------------------------------------------------------------------------
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
      'rate_per_hour', s.rate_per_hour, 'booked_seconds', se.booked_seconds,
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

create or replace function public.get_receipt(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_sale public.sales;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id;
  if not found
     or not (v_me.role = 'admin'
             or v_sale.cashier_id = v_me.id
             or ('delete_sales' = any (v_me.permissions) and public.fusion_can_access_floor(v_sale.floor_id))) then
    raise exception 'Receipt not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  return public.fusion_receipt_json(p_sale_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout
--   * Table checkout: p_session_id set; items come from the table's tab.
--   * Counter sale:   p_session_id null; p_items = [{product_id, quantity,
--                     unit_price}] (requires the counter_sale permission).
-- p_client_ref makes the call idempotent: retrying after a network failure
-- returns the original receipt instead of charging twice.
-- ---------------------------------------------------------------------------
create or replace function public.complete_checkout(
  p_client_ref uuid,
  p_payment_method text,
  p_session_id uuid default null,
  p_items jsonb default null,
  p_discount numeric default 0,
  p_customer_id uuid default null,
  p_customer_name text default null,
  p_customer_phone text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_existing uuid;
  v_session public.sessions;
  v_table public.club_tables;
  v_customer public.customers;
  v_product public.inventory_products;
  v_line record;
  v_discount numeric(12, 2) := coalesce(p_discount, 0);
  v_base numeric(12, 2) := 0;
  v_products numeric(12, 2) := 0;
  v_floor smallint;
  v_sale_id uuid;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_client_ref is null then
    raise exception 'Missing checkout reference.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select s.id into v_existing from public.sales s where s.client_ref = p_client_ref;
  if found then
    return public.fusion_receipt_json(v_existing);
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer') then
    raise exception 'Choose Cash or Bank Transfer.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if coalesce(p_discount, 0) < 0 or coalesce(p_discount, 0) <> round(coalesce(p_discount, 0), 2) then
    raise exception 'Discount must be a positive amount.' using errcode = '22023', hint = 'invalid_discount';
  end if;
  if v_discount > 0 and v_me.role <> 'admin' and not ('apply_discount' = any (v_me.permissions)) then
    raise exception 'You do not have permission to apply discounts.' using errcode = '42501', hint = 'forbidden';
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
    select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                                                 'unit_price', i.unit_price, 'quantity', i.quantity)
                              order by i.product_id), '[]'::jsonb)
      into v_lines
    from public.session_items i where i.session_id = p_session_id;
  else
    if v_me.role <> 'admin' and not ('counter_sale' = any (v_me.permissions)) then
      raise exception 'You do not have permission to make counter sales.' using errcode = '42501', hint = 'forbidden';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      raise exception 'Add at least one product.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if jsonb_array_length(p_items) > 100 then
      raise exception 'Too many lines in one sale.' using errcode = '22023', hint = 'invalid_input';
    end if;
    v_floor := v_me.floor_id;
    -- Lock products in a stable order (avoids deadlocks), verify price and
    -- stock, then take the stock. Products deactivated after being placed in
    -- the cart remain sellable so a cart is never invalidated.
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

  insert into public.sales (client_ref, session_id, table_name, floor_id, customer_id, customer_name, customer_phone,
                            cashier_id, cashier_name, payment_method, session_seconds, rate_per_hour,
                            base_amount, products_subtotal, discount, final_amount, business_date)
  values (p_client_ref, v_session.id, v_table.name, v_floor, v_customer.id, v_customer.name, v_customer.phone,
          v_me.id, v_me.full_name, p_payment_method, v_session.billable_seconds, v_session.rate_per_hour,
          v_base, v_products, v_discount, v_base + v_products - v_discount, public.fusion_business_date(now()))
  returning id into v_sale_id;

  insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total)
  select v_sale_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::integer, (l ->> 'unit_price')::numeric * (l ->> 'quantity')::integer
  from jsonb_array_elements(v_lines) l;

  update public.inventory_products p set units_sold = p.units_sold + q.quantity
  from (select (l ->> 'product_id')::uuid as product_id, sum((l ->> 'quantity')::integer) as quantity
        from jsonb_array_elements(v_lines) l group by 1 order by 1) q
  where p.id = q.product_id;

  if v_session.id is not null then
    update public.sessions set status = 'completed', customer_id = coalesce(v_customer.id, customer_id)
    where id = v_session.id;
    delete from public.session_items where session_id = v_session.id;
  end if;

  return public.fusion_receipt_json(v_sale_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Sale deletion (void). Returns stock and removes the paid session record.
-- Staff need the delete_sales permission, floor access, and may only delete
-- sales from the current business date.
-- ---------------------------------------------------------------------------
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

  delete from public.sales where id = p_sale_id;
  if v_sale.session_id is not null then
    delete from public.sessions where id = v_sale.session_id and status = 'completed';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live table overview (one consistent snapshot for the Tables screen).
-- SECURITY INVOKER: Row Level Security limits it to the caller's floors.
-- ---------------------------------------------------------------------------
create or replace function public.get_tables_overview()
returns jsonb language sql stable security invoker set search_path = '' as $$
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
  where t.is_active;
$$;
