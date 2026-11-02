-- =============================================================================
-- FUSION — Reports, business expenses, inventory sales and profit.
--
-- IMPACT ON EXISTING DATA (nothing is deleted, no stored amount changes):
--   * expenses: `shift_id` becomes optional and a `category` column is added.
--     Every existing row is a counter expense and stays exactly as it is.
--     New *business expenses* (rent, utilities, …) are recorded by an
--     administrator, belong to no counter, and therefore never change a
--     counter's cash, the shift ledger or History.
--   * sale_items: new `unit_cost` — the product's cost price at the moment of
--     sale. Existing lines keep it empty: their cost was never recorded, and
--     FUSION does not guess historical costs.
--   * product_sales_daily: NEW permanent table, one row per product per
--     business date (quantity, revenue, share of discounts, cost). It is needed
--     because the retention policy deletes invoice lines; without it, product
--     sales history would disappear with them. It is filled once from the
--     invoice lines that still exist (without cost), then posted by every
--     checkout and reversed by every deleted sale. Retention never touches it.
--   * Reports read the permanent shift ledger (shift_daily_totals), so their
--     totals stay correct after invoice cleanup. No new table is used for them.
-- =============================================================================

-- 1. Business expenses ------------------------------------------------------------
alter table public.expenses alter column shift_id drop not null;
alter table public.expenses
  add column category text
    constraint expenses_category check (category is null or category in
      ('supplies', 'utilities', 'rent', 'maintenance', 'equipment', 'stock', 'other')),
  -- A counter expense belongs to a shift; a business expense has a category instead.
  add constraint expenses_counter_or_business check (shift_id is not null or category is not null);

comment on column public.expenses.shift_id is
  'The counter shift the money was paid from; null for a business expense recorded by an administrator.';
comment on column public.expenses.category is
  'Business-expense category (supplies, utilities, rent, maintenance, equipment, stock, other); null for counter expenses.';

-- 2. Cost at the moment of sale -------------------------------------------------------
alter table public.sale_items
  add column unit_cost numeric(12, 2) constraint sale_items_unit_cost check (unit_cost is null or unit_cost >= 0);
comment on column public.sale_items.unit_cost is
  'The product''s cost price when it was sold; null for lines sold before costs were recorded.';

-- 3. Permanent product sales ledger ------------------------------------------------
create table public.product_sales_daily (
  business_date    date not null,
  -- The product id, or "name:<name>" for a line whose product no longer exists.
  product_key      text not null,
  product_id       uuid references public.inventory_products (id) on delete set null,
  product_name     text not null,
  quantity         integer not null default 0 check (quantity >= 0),
  -- Selling price x quantity, before discounts.
  revenue          numeric(14, 2) not null default 0 check (revenue >= 0),
  -- The products' share of invoice discounts (pro rata to the invoice).
  discount         numeric(14, 4) not null default 0 check (discount >= 0),
  -- The same figures for the units whose cost is known, and that cost.
  costed_quantity  integer not null default 0 check (costed_quantity >= 0),
  costed_revenue   numeric(14, 2) not null default 0 check (costed_revenue >= 0),
  costed_discount  numeric(14, 4) not null default 0 check (costed_discount >= 0),
  cost             numeric(14, 2) not null default 0 check (cost >= 0),
  updated_at       timestamptz not null default now(),
  primary key (business_date, product_key),
  constraint product_sales_daily_costed check (costed_quantity <= quantity and costed_revenue <= revenue)
);
create index product_sales_daily_product_idx on public.product_sales_daily (product_key, business_date);
comment on table public.product_sales_daily is
  'Permanent product sales per business date. Posted with each checkout, reversed by deleted sales; never removed by retention.';

alter table public.product_sales_daily enable row level security;
revoke all on table public.product_sales_daily from anon, authenticated;

-- Posts (p_sign = 1) or reverses (p_sign = -1) one invoice's product lines.
-- The invoice discount covers table time and products alike; the products'
-- share is discount x products / (table time + products), spread over the
-- lines by value. A reversal recomputes exactly the same figures.
create or replace function public.fusion_post_product_sales(p_sale_id uuid, p_sign integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales;
  v_product_discount numeric;
  v_line record;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id;
  if not found or v_sale.products_subtotal <= 0 then
    return;
  end if;
  v_product_discount := case when v_sale.base_amount + v_sale.products_subtotal > 0
                             then v_sale.discount * v_sale.products_subtotal / (v_sale.base_amount + v_sale.products_subtotal)
                             else 0 end;
  for v_line in
    select coalesce(i.product_id::text, 'name:' || i.product_name) as product_key,
           (array_agg(i.product_id))[1] as product_id,
           min(i.product_name) as product_name,
           sum(i.quantity)::integer as quantity,
           sum(i.line_total) as revenue,
           round(v_product_discount * sum(i.line_total) / v_sale.products_subtotal, 4) as discount,
           coalesce(sum(i.quantity) filter (where i.unit_cost is not null), 0)::integer as costed_quantity,
           coalesce(sum(i.line_total) filter (where i.unit_cost is not null), 0) as costed_revenue,
           round(v_product_discount * coalesce(sum(i.line_total) filter (where i.unit_cost is not null), 0)
                 / v_sale.products_subtotal, 4) as costed_discount,
           coalesce(sum(i.unit_cost * i.quantity) filter (where i.unit_cost is not null), 0) as cost
    from public.sale_items i
    where i.sale_id = p_sale_id
    group by 1
    order by 1
  loop
    if p_sign > 0 then
      insert into public.product_sales_daily as d
        (business_date, product_key, product_id, product_name, quantity, revenue, discount,
         costed_quantity, costed_revenue, costed_discount, cost)
      values (v_sale.business_date, v_line.product_key, v_line.product_id, v_line.product_name, v_line.quantity,
              v_line.revenue, v_line.discount, v_line.costed_quantity, v_line.costed_revenue, v_line.costed_discount,
              v_line.cost)
      on conflict (business_date, product_key) do update
      set product_id = coalesce(excluded.product_id, d.product_id),
          product_name = excluded.product_name,
          quantity = d.quantity + excluded.quantity,
          revenue = d.revenue + excluded.revenue,
          discount = d.discount + excluded.discount,
          costed_quantity = d.costed_quantity + excluded.costed_quantity,
          costed_revenue = d.costed_revenue + excluded.costed_revenue,
          costed_discount = d.costed_discount + excluded.costed_discount,
          cost = d.cost + excluded.cost,
          updated_at = now();
    else
      update public.product_sales_daily d
      set quantity = d.quantity - v_line.quantity,
          revenue = d.revenue - v_line.revenue,
          discount = d.discount - v_line.discount,
          costed_quantity = d.costed_quantity - v_line.costed_quantity,
          costed_revenue = d.costed_revenue - v_line.costed_revenue,
          costed_discount = d.costed_discount - v_line.costed_discount,
          cost = d.cost - v_line.cost,
          updated_at = now()
      where d.business_date = v_sale.business_date and d.product_key = v_line.product_key;
      delete from public.product_sales_daily d
      where d.business_date = v_sale.business_date and d.product_key = v_line.product_key and d.quantity = 0;
    end if;
  end loop;
end;
$$;

-- Fill the ledger from the invoice lines that still exist (their cost is unknown).
do $$
declare
  r record;
begin
  for r in select s.id from public.sales s where s.products_subtotal > 0 order by s.created_at loop
    perform public.fusion_post_product_sales(r.id, 1);
  end loop;
end;
$$;

-- 4. Checkout records the cost and posts the product ledger; deleting a sale reverses it.
-- (Both functions are unchanged apart from the lines marked "0900".)
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
    case when v_sale.payment_method = 'cash' then -v_sale.final_amount else 0 end,
    case when v_sale.payment_method = 'bank_transfer' then -v_sale.final_amount else 0 end,
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

-- 5. Business expenses: add, void, list ----------------------------------------------
create or replace function public.admin_add_expense(
  p_client_ref uuid, p_business_date date, p_category text, p_amount numeric, p_description text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_today date := public.fusion_business_date(now());
  v_expense public.expenses;
begin
  if p_client_ref is null then
    raise exception 'Missing expense reference.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select e.* into v_expense from public.expenses e where e.client_ref = p_client_ref;
  if found then
    if v_expense.user_id <> v_me.id or v_expense.shift_id is not null then
      raise exception 'Expense not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
    return to_jsonb(v_expense);
  end if;
  if p_business_date is null or p_business_date > v_today or p_business_date < v_today - 366 then
    raise exception 'Choose a date in the last year (not in the future).' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_category is null or p_category not in ('supplies', 'utilities', 'rent', 'maintenance', 'equipment', 'stock', 'other') then
    raise exception 'Choose a category.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid amount.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 1 and 120 then
    raise exception 'Describe the expense (up to 120 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;

  insert into public.expenses (client_ref, shift_id, user_id, business_date, amount, description, category)
  values (p_client_ref, null, v_me.id, p_business_date, p_amount, btrim(p_description), p_category)
  returning * into v_expense;
  return to_jsonb(v_expense);
end;
$$;

-- Voids a business expense (kept, marked voided, for the audit trail). Counter
-- expenses are voided from their counter while it is open, as before.
create or replace function public.admin_void_expense(p_expense_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_expense public.expenses;
begin
  select e.* into v_expense from public.expenses e where e.id = p_expense_id for update;
  if not found then
    raise exception 'Expense not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_expense.shift_id is not null then
    raise exception 'Counter expenses are voided from the counter while it is open.'
      using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_expense.voided_at is null then
    update public.expenses set voided_at = now(), voided_by = v_me.id where id = p_expense_id returning * into v_expense;
  end if;
  return to_jsonb(v_expense);
end;
$$;

-- Every expense (counter and business) in a date range, with totals.
create or replace function public.get_expenses(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_totals jsonb;
  v_categories jsonb;
  v_days jsonb;
  v_items jsonb;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Expenses are limited to one year at a time.' using errcode = '22023', hint = 'invalid_input';
  end if;

  select jsonb_build_object(
           'total', coalesce(sum(e.amount) filter (where e.voided_at is null), 0),
           'counter', coalesce(sum(e.amount) filter (where e.voided_at is null and e.shift_id is not null), 0),
           'business', coalesce(sum(e.amount) filter (where e.voided_at is null and e.shift_id is null), 0),
           'count', count(*) filter (where e.voided_at is null),
           'voided_count', count(*) filter (where e.voided_at is not null))
    into v_totals
  from public.expenses e where e.business_date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('category', x.category, 'total', x.total, 'count', x.n)
                            order by x.total desc, x.category), '[]'::jsonb)
    into v_categories
  from (select coalesce(e.category, 'counter') as category, sum(e.amount) as total, count(*) as n
        from public.expenses e
        where e.business_date between p_from and p_to and e.voided_at is null
        group by 1) x;

  select coalesce(jsonb_agg(jsonb_build_object('date', d.d::date, 'counter', coalesce(x.counter, 0),
                                               'business', coalesce(x.business, 0),
                                               'total', coalesce(x.counter, 0) + coalesce(x.business, 0))
                            order by d.d), '[]'::jsonb)
    into v_days
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(d)
  left join (select e.business_date,
                    sum(e.amount) filter (where e.shift_id is not null) as counter,
                    sum(e.amount) filter (where e.shift_id is null) as business
             from public.expenses e
             where e.business_date between p_from and p_to and e.voided_at is null
             group by 1) x on x.business_date = d.d::date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'business_date', x.business_date, 'created_at', x.created_at,
           'kind', case when x.shift_id is null then 'business' else 'counter' end,
           'category', coalesce(x.category, 'counter'), 'amount', x.amount, 'description', x.description,
           'recorded_by', x.recorded_by, 'shift_id', x.shift_id,
           'voided_at', x.voided_at, 'voided_by', x.voided_by_name) order by x.business_date desc, x.created_at desc), '[]'::jsonb)
    into v_items
  from (select e.*, coalesce(u.full_name, c.staff_name) as recorded_by, vb.full_name as voided_by_name
        from public.expenses e
        left join public.app_users u on u.id = e.user_id
        left join public.counter_shifts c on c.id = e.shift_id
        left join public.app_users vb on vb.id = e.voided_by
        where e.business_date between p_from and p_to
        order by e.business_date desc, e.created_at desc
        limit 2000) x;

  return jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals, 'by_category', v_categories,
                            'days', v_days, 'items', v_items,
                            'truncated', (v_totals ->> 'count')::integer + (v_totals ->> 'voided_count')::integer > 2000);
end;
$$;

-- 6. Financial report --------------------------------------------------------------
-- Final figures come only from CLOSED counter shifts (plus amounts archived by
-- the pre-0700 Close Day). Open counters are reported separately as live,
-- provisional figures. Every figure is read from the permanent ledger.
create or replace function public.get_financial_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_legacy_cash numeric;
  v_legacy_bank numeric;
  v_business numeric;
  v_final jsonb;
  v_live jsonb;
  v_days jsonb;
  v_staff jsonb;
  v_closed jsonb;
  v_open jsonb;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Reports are limited to one year at a time.' using errcode = '22023', hint = 'invalid_input';
  end if;

  select coalesce(sum(d.legacy_cash), 0), coalesce(sum(d.legacy_bank), 0) into v_legacy_cash, v_legacy_bank
  from public.daily_summaries d where d.business_date between p_from and p_to;
  select coalesce(sum(e.amount), 0) into v_business
  from public.expenses e
  where e.shift_id is null and e.voided_at is null and e.business_date between p_from and p_to;

  with t as (
    select t.*, c.status
    from public.shift_daily_totals t
    join public.counter_shifts c on c.id = t.shift_id
    where t.business_date between p_from and p_to),
  f as (
    select coalesce(sum(t.cash_sales) filter (where t.status = 'closed'), 0) + v_legacy_cash as cash,
           coalesce(sum(t.bank_sales) filter (where t.status = 'closed'), 0) + v_legacy_bank as bank,
           coalesce(sum(t.snack_sales) filter (where t.status = 'closed'), 0) as snack,
           coalesce(sum(t.discounts) filter (where t.status = 'closed'), 0) as discounts,
           coalesce(sum(t.expenses) filter (where t.status = 'closed'), 0) as counter_expenses,
           coalesce(sum(t.invoice_count) filter (where t.status = 'closed'), 0) as invoices,
           coalesce(sum(t.voided_count) filter (where t.status = 'closed'), 0) as voided,
           count(distinct t.shift_id) filter (where t.status = 'closed') as shifts,
           coalesce(sum(t.cash_sales) filter (where t.status = 'open'), 0) as live_cash,
           coalesce(sum(t.bank_sales) filter (where t.status = 'open'), 0) as live_bank,
           coalesce(sum(t.snack_sales) filter (where t.status = 'open'), 0) as live_snack,
           coalesce(sum(t.discounts) filter (where t.status = 'open'), 0) as live_discounts,
           coalesce(sum(t.expenses) filter (where t.status = 'open'), 0) as live_expenses,
           coalesce(sum(t.invoice_count) filter (where t.status = 'open'), 0) as live_invoices,
           count(distinct t.shift_id) filter (where t.status = 'open') as live_shifts
    from t)
  select jsonb_build_object(
           'cash', f.cash, 'bank', f.bank, 'total', f.cash + f.bank, 'snack', f.snack, 'discounts', f.discounts,
           'counter_expenses', f.counter_expenses, 'business_expenses', v_business,
           'expenses', f.counter_expenses + v_business, 'net', f.cash + f.bank - f.counter_expenses - v_business,
           'invoices', f.invoices, 'voided', f.voided, 'shifts', f.shifts, 'legacy', v_legacy_cash + v_legacy_bank),
         jsonb_build_object(
           'cash', f.live_cash, 'bank', f.live_bank, 'total', f.live_cash + f.live_bank, 'snack', f.live_snack,
           'discounts', f.live_discounts, 'expenses', f.live_expenses,
           'net', f.live_cash + f.live_bank - f.live_expenses, 'invoices', f.live_invoices, 'shifts', f.live_shifts)
    into v_final, v_live
  from f;

  -- Final figures per business date (closed shifts, archived amounts, business expenses).
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d.d::date, 'cash', x.cash, 'bank', x.bank, 'total', x.cash + x.bank,
           'expenses', x.expenses, 'net', x.cash + x.bank - x.expenses) order by d.d), '[]'::jsonb)
    into v_days
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(d)
  cross join lateral (
    select coalesce((select sum(t.cash_sales) from public.shift_daily_totals t
                     join public.counter_shifts c on c.id = t.shift_id
                     where t.business_date = d.d::date and c.status = 'closed'), 0)
             + coalesce((select ds.legacy_cash from public.daily_summaries ds where ds.business_date = d.d::date), 0) as cash,
           coalesce((select sum(t.bank_sales) from public.shift_daily_totals t
                     join public.counter_shifts c on c.id = t.shift_id
                     where t.business_date = d.d::date and c.status = 'closed'), 0)
             + coalesce((select ds.legacy_bank from public.daily_summaries ds where ds.business_date = d.d::date), 0) as bank,
           coalesce((select sum(t.expenses) from public.shift_daily_totals t
                     join public.counter_shifts c on c.id = t.shift_id
                     where t.business_date = d.d::date and c.status = 'closed'), 0)
             + coalesce((select sum(e.amount) from public.expenses e
                         where e.shift_id is null and e.voided_at is null and e.business_date = d.d::date), 0) as expenses
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', x.user_id, 'name', x.name, 'shifts', x.shifts, 'cash', x.cash, 'bank', x.bank,
           'total', x.cash + x.bank, 'snack', x.snack, 'discounts', x.discounts, 'expenses', x.expenses,
           'net', x.cash + x.bank - x.expenses, 'invoices', x.invoices) order by x.cash + x.bank desc, x.name), '[]'::jsonb)
    into v_staff
  from (select t.user_id, max(coalesce(u.full_name, c.staff_name)) as name, count(distinct t.shift_id) as shifts,
               sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.snack_sales) as snack,
               sum(t.discounts) as discounts, sum(t.expenses) as expenses, sum(t.invoice_count) as invoices
        from public.shift_daily_totals t
        join public.counter_shifts c on c.id = t.shift_id
        left join public.app_users u on u.id = t.user_id
        where t.business_date between p_from and p_to and c.status = 'closed'
        group by t.user_id) x;

  -- Each shift's figures within the range; "partial" marks a shift that also
  -- traded on dates outside it (e.g. a counter open past the day start).
  with s as (
    select c.id, c.status, coalesce(u.full_name, c.staff_name) as name, c.business_date, c.opened_at, c.closed_at,
           c.imported, sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.snack_sales) as snack,
           sum(t.discounts) as discounts, sum(t.expenses) as expenses, sum(t.invoice_count) as invoices,
           sum(t.voided_count) as voided,
           exists (select 1 from public.shift_daily_totals o
                   where o.shift_id = c.id and o.business_date not between p_from and p_to) as partial
    from public.counter_shifts c
    join public.shift_daily_totals t on t.shift_id = c.id and t.business_date between p_from and p_to
    left join public.app_users u on u.id = c.user_id
    group by c.id, u.full_name)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'staff_name', s.name, 'status', s.status, 'business_date', s.business_date,
           'opened_at', s.opened_at, 'closed_at', s.closed_at, 'imported', s.imported,
           'cash', s.cash, 'bank', s.bank, 'total', s.cash + s.bank, 'snack', s.snack, 'discounts', s.discounts,
           'expenses', s.expenses, 'net', s.cash + s.bank - s.expenses, 'invoices', s.invoices, 'voided', s.voided,
           'partial', s.partial) order by s.opened_at desc) filter (where s.status = 'closed'), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'staff_name', s.name, 'status', s.status, 'business_date', s.business_date,
           'opened_at', s.opened_at, 'closed_at', s.closed_at, 'imported', s.imported,
           'cash', s.cash, 'bank', s.bank, 'total', s.cash + s.bank, 'snack', s.snack, 'discounts', s.discounts,
           'expenses', s.expenses, 'net', s.cash + s.bank - s.expenses, 'invoices', s.invoices, 'voided', s.voided,
           'partial', s.partial) order by s.opened_at desc) filter (where s.status = 'open'), '[]'::jsonb)
    into v_closed, v_open
  from s;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'club_name', (select st.club_name from public.settings st where st.id = 1),
    'timezone', (select st.business_timezone from public.settings st where st.id = 1),
    'final', v_final, 'live', v_live, 'days', v_days, 'by_staff', v_staff,
    'closed_shifts', v_closed, 'open_shifts', v_open);
end;
$$;

-- 7. Inventory sales and profit ------------------------------------------------------
-- Gross profit = (revenue − the products' share of discounts) − cost of goods
-- sold, counted only over units whose cost was recorded at the time of sale.
-- Table time is never product revenue; business expenses are not deducted.
create or replace function public.get_product_sales(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_products jsonb;
  v_totals jsonb;
  v_days jsonb;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Product sales are limited to one year at a time.' using errcode = '22023', hint = 'invalid_input';
  end if;

  with p as (
    select d.product_key,
           (array_agg(d.product_id) filter (where d.product_id is not null))[1] as product_id,
           (array_agg(d.product_name order by d.business_date desc))[1] as name,
           sum(d.quantity) as quantity, sum(d.revenue) as revenue, sum(d.discount) as discount,
           sum(d.costed_quantity) as costed_quantity, sum(d.costed_revenue) as costed_revenue,
           sum(d.costed_discount) as costed_discount, sum(d.cost) as cost
    from public.product_sales_daily d
    where d.business_date between p_from and p_to
    group by d.product_key
    having sum(d.quantity) > 0)
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_key', p.product_key, 'product_id', p.product_id, 'name', p.name,
           'category', ip.category, 'current_cost_price', ip.cost_price, 'current_selling_price', ip.selling_price,
           'quantity', p.quantity, 'revenue', p.revenue, 'discount', round(p.discount, 2),
           'net_revenue', round(p.revenue - p.discount, 2),
           'avg_price', round(p.revenue / p.quantity, 2),
           'costed_quantity', p.costed_quantity, 'uncosted_quantity', p.quantity - p.costed_quantity,
           'cost', p.cost,
           'avg_cost', case when p.costed_quantity > 0 then round(p.cost / p.costed_quantity, 2) end,
           'gross_profit', case when p.costed_quantity > 0
                                then round(p.costed_revenue - p.costed_discount - p.cost, 2) end,
           'margin', case when p.costed_quantity > 0 and p.costed_revenue - p.costed_discount > 0
                          then round((p.costed_revenue - p.costed_discount - p.cost)
                                     / (p.costed_revenue - p.costed_discount) * 100, 1) end)
           order by p.revenue desc, p.name), '[]'::jsonb),
         jsonb_build_object(
           'quantity', coalesce(sum(p.quantity), 0), 'revenue', coalesce(sum(p.revenue), 0),
           'discount', round(coalesce(sum(p.discount), 0), 2),
           'net_revenue', round(coalesce(sum(p.revenue - p.discount), 0), 2),
           'costed_quantity', coalesce(sum(p.costed_quantity), 0),
           'uncosted_quantity', coalesce(sum(p.quantity - p.costed_quantity), 0),
           'costed_net_revenue', round(coalesce(sum(p.costed_revenue - p.costed_discount), 0), 2),
           'cost', coalesce(sum(p.cost), 0),
           'gross_profit', round(coalesce(sum(p.costed_revenue - p.costed_discount - p.cost), 0), 2),
           'products', count(*))
    into v_products, v_totals
  from p
  left join public.inventory_products ip on ip.id = p.product_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d.d::date, 'quantity', coalesce(x.quantity, 0),
           'net_revenue', round(coalesce(x.net_revenue, 0), 2), 'gross_profit', round(coalesce(x.gross_profit, 0), 2))
           order by d.d), '[]'::jsonb)
    into v_days
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(d)
  left join (select ds.business_date, sum(ds.quantity) as quantity, sum(ds.revenue - ds.discount) as net_revenue,
                    sum(ds.costed_revenue - ds.costed_discount - ds.cost) as gross_profit
             from public.product_sales_daily ds
             where ds.business_date between p_from and p_to
             group by 1) x on x.business_date = d.d::date;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'products', v_products, 'totals', v_totals, 'days', v_days,
    'tracking_since', (select min(ds.business_date) from public.product_sales_daily ds),
    'cost_tracking_since', (select min(ds.business_date) from public.product_sales_daily ds where ds.costed_quantity > 0));
end;
$$;

-- 8. Grants ------------------------------------------------------------------------
-- Supabase grants new functions to the API roles by default; take that back.
revoke all on function
  public.fusion_post_product_sales(uuid, integer),
  public.admin_add_expense(uuid, date, text, numeric, text),
  public.admin_void_expense(uuid),
  public.get_expenses(date, date),
  public.get_financial_report(date, date),
  public.get_product_sales(date, date)
  from public, anon, authenticated;

-- Administration (each function calls fusion_require_admin()).
grant execute on function
  public.admin_add_expense(uuid, date, text, numeric, text),
  public.admin_void_expense(uuid),
  public.get_expenses(date, date),
  public.get_financial_report(date, date),
  public.get_product_sales(date, date)
  to authenticated;

notify pgrst, 'reload schema';
