-- =============================================================================
-- FUSION — counter shifts, staff accounting, history, pre-bookings, customer
-- statistics and automatic sales-detail retention.
--
-- IMPACT ON EXISTING DATA (nothing is deleted by this migration):
--   * Every existing sale is attached to an "imported" closed counter shift
--     (one per cashier per business date; its times are the first and last
--     sale). The shift totals and the new permanent per-day ledger are filled
--     from those sales, so they keep counting after invoice cleanup.
--   * Totals saved by the old "Close Day & Archive" (whose sales were already
--     deleted) are kept as legacy amounts on daily_summaries and still count
--     in every report.
--   * Customer statistics are built from the existing sales that name a
--     customer. Sales already archived by the old close day had no
--     per-customer detail left, so they cannot contribute.
--   * Closing a business day no longer deletes anything. Detailed invoices are
--     removed only by the scheduled retention job (default: older than 30
--     days, only from closed shifts), after their totals are already stored.
--
-- New rules:
--   * Payments and expenses belong to the staff member's own open counter
--     shift. Administrators manage the business and cannot take payments.
--   * A closed shift is final: its sales cannot be voided and its expenses
--     cannot change.
--   * Staff see only their own sales, shifts and expenses.
--   * A customer profile is created only when a phone number identifies the
--     person (a name alone is kept on the session/sale, never merged).
-- =============================================================================

-- 1. Settings ------------------------------------------------------------------
alter table public.settings
  add column sales_retention_days smallint not null default 30
    constraint settings_sales_retention_days check (sales_retention_days in (1, 7, 30));

-- 2. New tables ----------------------------------------------------------------

-- One row per staff counter opening. Totals are posted live (in the same
-- transaction as each sale, void or expense) and are final once closed.
create table public.counter_shifts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.app_users (id) on delete restrict,
  staff_name         text not null,
  status             text not null default 'open' check (status in ('open', 'closed')),
  business_date      date not null,
  opened_at          timestamptz not null default now(),
  closed_at          timestamptz,
  closed_by          uuid references public.app_users (id) on delete restrict,
  cash_sales         numeric(14, 2) not null default 0 check (cash_sales >= 0),
  bank_sales         numeric(14, 2) not null default 0 check (bank_sales >= 0),
  snack_sales        numeric(14, 2) not null default 0 check (snack_sales >= 0),
  discounts          numeric(14, 2) not null default 0 check (discounts >= 0),
  expenses           numeric(14, 2) not null default 0 check (expenses >= 0),
  invoice_count      integer not null default 0 check (invoice_count >= 0),
  voided_count       integer not null default 0 check (voided_count >= 0),
  voided_amount      numeric(14, 2) not null default 0 check (voided_amount >= 0),
  handover_sessions  integer not null default 0 check (handover_sessions >= 0),
  imported           boolean not null default false,
  details_purged_at  timestamptz,
  constraint counter_shifts_closed_state check ((status = 'closed') = (closed_at is not null)),
  constraint counter_shifts_time_order check (closed_at is null or closed_at >= opened_at)
);
-- A staff member can never have two open counters.
create unique index counter_shifts_one_open_per_user on public.counter_shifts (user_id) where status = 'open';
create index counter_shifts_user_idx on public.counter_shifts (user_id, opened_at desc);
create index counter_shifts_business_date_idx on public.counter_shifts (business_date);

-- The permanent accounting ledger: one row per shift per business date. Every
-- report (live dashboard, history, day closing) reads these rows, so totals
-- never depend on detailed invoices still existing.
create table public.shift_daily_totals (
  shift_id       uuid not null references public.counter_shifts (id) on delete restrict,
  business_date  date not null,
  user_id        uuid not null references public.app_users (id) on delete restrict,
  cash_sales     numeric(14, 2) not null default 0 check (cash_sales >= 0),
  bank_sales     numeric(14, 2) not null default 0 check (bank_sales >= 0),
  snack_sales    numeric(14, 2) not null default 0 check (snack_sales >= 0),
  discounts      numeric(14, 2) not null default 0 check (discounts >= 0),
  expenses       numeric(14, 2) not null default 0 check (expenses >= 0),
  invoice_count  integer not null default 0 check (invoice_count >= 0),
  voided_count   integer not null default 0 check (voided_count >= 0),
  voided_amount  numeric(14, 2) not null default 0 check (voided_amount >= 0),
  updated_at     timestamptz not null default now(),
  primary key (shift_id, business_date)
);
create index shift_daily_totals_date_idx on public.shift_daily_totals (business_date);
create index shift_daily_totals_user_idx on public.shift_daily_totals (user_id, business_date);

-- Counter expenses. Never removed by retention; corrections are voids.
create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  client_ref     uuid not null unique,
  shift_id       uuid not null references public.counter_shifts (id) on delete restrict,
  user_id        uuid not null references public.app_users (id) on delete restrict,
  business_date  date not null,
  amount         numeric(12, 2) not null check (amount > 0 and amount <= 10000000),
  description    text not null check (char_length(btrim(description)) between 1 and 120),
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid references public.app_users (id) on delete restrict,
  constraint expenses_void_pair check ((voided_at is null) = (voided_by is null))
);
create index expenses_shift_idx on public.expenses (shift_id);
create index expenses_user_date_idx on public.expenses (user_id, business_date);
create index expenses_date_idx on public.expenses (business_date);

-- Admin pre-bookings. Starting one starts an ordinary table session.
create table public.bookings (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid references public.customers (id) on delete set null,
  customer_name   text not null check (char_length(btrim(customer_name)) between 1 and 80),
  customer_phone  text check (customer_phone is null or customer_phone ~ '^\+?[0-9]{7,15}$'),
  table_id        uuid references public.club_tables (id) on delete restrict,
  booking_at      timestamptz not null,
  notes           text not null default '' check (char_length(notes) <= 200),
  status          text not null default 'booked'
                  check (status in ('booked', 'started', 'completed', 'cancelled', 'no_show')),
  session_id      uuid unique references public.sessions (id) on delete restrict,
  created_by      uuid not null references public.app_users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  started_at      timestamptz,
  started_by      uuid references public.app_users (id) on delete restrict,
  constraint bookings_started_has_session check (status not in ('started', 'completed') or session_id is not null),
  constraint bookings_booked_has_no_session check (status <> 'booked' or session_id is null)
);
create index bookings_booking_at_idx on public.bookings (booking_at);
create index bookings_status_idx on public.bookings (status);

-- Permanent customer statistics, one row per customer per business date
-- (a "visit"). Posted exactly once per completed sale and reversed by voids;
-- untouched by invoice cleanup.
create table public.customer_visits (
  customer_id    uuid not null references public.customers (id) on delete cascade,
  business_date  date not null,
  invoices       integer not null check (invoices > 0),
  spent          numeric(14, 2) not null check (spent >= 0),
  play_seconds   bigint not null default 0 check (play_seconds >= 0),
  last_at        timestamptz not null,
  primary key (customer_id, business_date)
);
create index customer_visits_date_idx on public.customer_visits (business_date);

-- Log of every automatic or manual sales-detail cleanup.
create table public.retention_runs (
  id               bigint generated always as identity primary key,
  source           text not null check (source in ('schedule', 'manual')),
  run_by           uuid references public.app_users (id) on delete set null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null check (status in ('running', 'success', 'failed', 'skipped')),
  retention_days   smallint,
  cutoff_date      date,
  sales_deleted    integer not null default 0,
  items_deleted    integer not null default 0,
  shifts_affected  integer not null default 0,
  message          text
);
create index retention_runs_started_idx on public.retention_runs (started_at desc);

-- 3. Columns on existing tables -----------------------------------------------
alter table public.sales add column shift_id uuid references public.counter_shifts (id) on delete restrict;

alter table public.sessions
  add column customer_name text check (customer_name is null or char_length(customer_name) between 1 and 80),
  add column started_shift_id uuid references public.counter_shifts (id) on delete restrict;
create index sessions_started_shift_idx on public.sessions (started_shift_id) where started_shift_id is not null;

alter table public.daily_summaries
  add column snack_sales   numeric(14, 2) not null default 0 check (snack_sales >= 0),
  add column discounts     numeric(14, 2) not null default 0 check (discounts >= 0),
  add column expenses      numeric(14, 2) not null default 0 check (expenses >= 0),
  add column invoice_count integer not null default 0 check (invoice_count >= 0),
  add column legacy_cash   numeric(14, 2) not null default 0 check (legacy_cash >= 0),
  add column legacy_bank   numeric(14, 2) not null default 0 check (legacy_bank >= 0),
  add column closed_at     timestamptz,
  add column closed_by     uuid references public.app_users (id) on delete set null;

-- 4. Bring existing data across ----------------------------------------------
-- Totals saved by the old archive belong to sales that no longer exist.
update public.daily_summaries
set legacy_cash = total_cash, legacy_bank = total_bank, closed_at = updated_at, closed_by = updated_by;

insert into public.counter_shifts (user_id, staff_name, status, business_date, opened_at, closed_at, imported)
select s.cashier_id, (array_agg(s.cashier_name order by s.created_at desc))[1], 'closed', s.business_date,
       min(s.created_at), max(s.created_at), true
from public.sales s
group by s.cashier_id, s.business_date;

update public.sales s set shift_id = c.id
from public.counter_shifts c
where c.imported and c.user_id = s.cashier_id and c.business_date = s.business_date;

insert into public.shift_daily_totals (shift_id, business_date, user_id, cash_sales, bank_sales, snack_sales,
                                       discounts, invoice_count)
select s.shift_id, s.business_date, s.cashier_id,
       coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0),
       coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0),
       sum(s.products_subtotal), sum(s.discount), count(*)
from public.sales s
group by s.shift_id, s.business_date, s.cashier_id;

update public.counter_shifts c
set cash_sales = t.cash_sales, bank_sales = t.bank_sales, snack_sales = t.snack_sales,
    discounts = t.discounts, invoice_count = t.invoice_count
from public.shift_daily_totals t
where t.shift_id = c.id;

alter table public.sales alter column shift_id set not null;
create index sales_shift_idx on public.sales (shift_id);

insert into public.customer_visits (customer_id, business_date, invoices, spent, play_seconds, last_at)
select s.customer_id, s.business_date, count(*), sum(s.final_amount), coalesce(sum(s.session_seconds), 0), max(s.created_at)
from public.sales s
where s.customer_id is not null
group by s.customer_id, s.business_date;

-- 5. Internal helpers (not callable from the API) -----------------------------

-- The caller's open counter shift, locked so it cannot be closed while the
-- calling transaction posts to it. Administrators never have a counter.
create or replace function public.fusion_require_open_shift(p_me public.app_users)
returns public.counter_shifts language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.counter_shifts;
begin
  if p_me.role = 'admin' then
    raise exception 'Administrators manage the business and do not take payments. A staff member must use their own counter.'
      using errcode = '42501', hint = 'admin_no_sales';
  end if;
  select c.* into v_shift from public.counter_shifts c
  where c.user_id = p_me.id and c.status = 'open' for update;
  if not found then
    raise exception 'Open your counter first.' using errcode = 'P0001', hint = 'counter_closed';
  end if;
  return v_shift;
end;
$$;

-- Posts amounts (negative to reverse) to a shift and its per-day ledger row in
-- one step. Only open shifts accept postings; the CHECK constraints make a
-- reversal of something never posted impossible. The shift row is updated
-- (and so locked) first, which serialises all postings to one shift — so the
-- update-then-insert below cannot race. (An INSERT … ON CONFLICT would check
-- the proposed negative row against the constraints before resolving the
-- conflict, so it cannot carry reversals.)
create or replace function public.fusion_post_ledger(
  p_shift_id uuid, p_user_id uuid, p_date date,
  p_cash numeric, p_bank numeric, p_snack numeric, p_discount numeric, p_expenses numeric,
  p_invoices integer, p_voided_count integer, p_voided_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.counter_shifts
  set cash_sales = cash_sales + p_cash,
      bank_sales = bank_sales + p_bank,
      snack_sales = snack_sales + p_snack,
      discounts = discounts + p_discount,
      expenses = expenses + p_expenses,
      invoice_count = invoice_count + p_invoices,
      voided_count = voided_count + p_voided_count,
      voided_amount = voided_amount + p_voided_amount
  where id = p_shift_id and status = 'open';
  if not found then
    raise exception 'This counter shift is closed; its totals are final.' using errcode = 'P0001', hint = 'shift_closed';
  end if;

  update public.shift_daily_totals
  set cash_sales = cash_sales + p_cash,
      bank_sales = bank_sales + p_bank,
      snack_sales = snack_sales + p_snack,
      discounts = discounts + p_discount,
      expenses = expenses + p_expenses,
      invoice_count = invoice_count + p_invoices,
      voided_count = voided_count + p_voided_count,
      voided_amount = voided_amount + p_voided_amount,
      updated_at = now()
  where shift_id = p_shift_id and business_date = p_date;
  if not found then
    insert into public.shift_daily_totals (shift_id, business_date, user_id, cash_sales, bank_sales, snack_sales,
                                           discounts, expenses, invoice_count, voided_count, voided_amount)
    values (p_shift_id, p_date, p_user_id, p_cash, p_bank, p_snack, p_discount, p_expenses,
            p_invoices, p_voided_count, p_voided_amount);
  end if;
end;
$$;

-- Adds (or with p_invoices = -1, removes) a sale from a customer's statistics.
create or replace function public.fusion_post_visit(
  p_customer_id uuid, p_date date, p_invoices integer, p_spent numeric, p_seconds bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_customer_id is null then
    return;
  end if;
  if p_invoices > 0 then
    insert into public.customer_visits as v (customer_id, business_date, invoices, spent, play_seconds, last_at)
    values (p_customer_id, p_date, p_invoices, p_spent, p_seconds, now())
    on conflict (customer_id, business_date) do update
      set invoices = v.invoices + excluded.invoices,
          spent = v.spent + excluded.spent,
          play_seconds = v.play_seconds + excluded.play_seconds,
          last_at = greatest(v.last_at, excluded.last_at);
  else
    delete from public.customer_visits v
    where v.customer_id = p_customer_id and v.business_date = p_date and v.invoices + p_invoices <= 0;
    if not found then
      update public.customer_visits
      set invoices = invoices + p_invoices, spent = spent + p_spent, play_seconds = play_seconds + p_seconds
      where customer_id = p_customer_id and business_date = p_date;
    end if;
  end if;
end;
$$;

-- A shift as the API returns it.
create or replace function public.fusion_shift_json(p_shift_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'user_id', c.user_id, 'staff_name', coalesce(u.full_name, c.staff_name), 'status', c.status,
    'business_date', c.business_date, 'opened_at', c.opened_at, 'closed_at', c.closed_at,
    'closed_by_name', cb.full_name, 'closed_by_self', c.closed_by = c.user_id,
    'cash', c.cash_sales, 'bank', c.bank_sales, 'snack', c.snack_sales, 'discounts', c.discounts,
    'total', c.cash_sales + c.bank_sales, 'expenses', c.expenses,
    'net', c.cash_sales + c.bank_sales - c.expenses,
    'invoices', c.invoice_count, 'voided_count', c.voided_count, 'voided_amount', c.voided_amount,
    'handover_sessions', c.handover_sessions, 'imported', c.imported, 'details_purged_at', c.details_purged_at,
    'open_sessions', (select count(*) from public.sessions s
                      where s.started_shift_id = c.id and s.status in ('running', 'paused', 'billing')))
  from public.counter_shifts c
  left join public.app_users u on u.id = c.user_id
  left join public.app_users cb on cb.id = c.closed_by
  where c.id = p_shift_id;
$$;

-- Live staff-wise figures for one business date: every staff member with
-- activity that day or a counter currently open.
create or replace function public.fusion_staff_day(p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with ledger as (
    select t.user_id, sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.snack_sales) as snack,
           sum(t.expenses) as expenses, sum(t.invoice_count) as invoices, sum(t.voided_count) as voided
    from public.shift_daily_totals t
    where t.business_date = p_date
    group by t.user_id),
  shifts as (
    select c.user_id,
           bool_or(c.status = 'open') as is_open,
           (array_agg(c.id order by c.opened_at desc) filter (where c.status = 'open'))[1] as open_shift_id,
           min(c.opened_at) filter (where c.status = 'open') as open_since,
           max(c.closed_at) as last_closed_at,
           count(*) as shift_count
    from public.counter_shifts c
    where c.status = 'open' or c.business_date = p_date
       or c.id in (select t.shift_id from public.shift_daily_totals t where t.business_date = p_date)
    group by c.user_id),
  people as (select user_id from ledger union select user_id from shifts)
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', p.user_id, 'name', u.full_name, 'username', u.username,
           'status', case when coalesce(s.is_open, false) then 'open' else 'closed' end,
           'open_shift_id', s.open_shift_id, 'open_since', s.open_since, 'last_closed_at', s.last_closed_at,
           'shifts', coalesce(s.shift_count, 0),
           'cash', coalesce(l.cash, 0), 'bank', coalesce(l.bank, 0), 'snack', coalesce(l.snack, 0),
           'total', coalesce(l.cash, 0) + coalesce(l.bank, 0), 'expenses', coalesce(l.expenses, 0),
           'net', coalesce(l.cash, 0) + coalesce(l.bank, 0) - coalesce(l.expenses, 0),
           'invoices', coalesce(l.invoices, 0), 'voided', coalesce(l.voided, 0))
         order by coalesce(s.is_open, false) desc, coalesce(l.cash, 0) + coalesce(l.bank, 0) desc, u.full_name),
         '[]'::jsonb)
  from people p
  join public.app_users u on u.id = p.user_id
  left join ledger l on l.user_id = p.user_id
  left join shifts s on s.user_id = p.user_id;
$$;

-- 6. Customers and sessions ----------------------------------------------------

-- A phone number identifies a customer. Without one there is no reliable
-- identity (two people can share a name), so no profile is created or merged;
-- the name is kept on the session and sale instead.
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
  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'Customer name is too long.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if v_phone is null then
    return null;
  end if;

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
end;
$$;

-- Unchanged rules; now also records the starter's open counter shift and the
-- customer's name when no profile applies.
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

  insert into public.sessions (table_id, customer_id, customer_name, status, rate_per_hour, booked_seconds,
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

-- Cancelling a booked session also cancels its booking.
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
  update public.bookings set status = 'cancelled', updated_at = now()
  where session_id = p_session_id and status = 'started';
end;
$$;

-- 7. Checkout, voids and receipts --------------------------------------------
-- Same checkout rules as before, plus: the payment belongs to the caller's
-- open counter shift (administrators cannot take payments), the shift ledger
-- and customer statistics are posted in the same transaction, and a booking
-- linked to the session is marked completed. p_client_ref still makes the
-- call idempotent, so a retry can never post twice.
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
  v_shift public.counter_shifts;
  v_existing uuid;
  v_session public.sessions;
  v_table public.club_tables;
  v_customer public.customers;
  v_customer_name text;
  v_product public.inventory_products;
  v_line record;
  v_discount numeric(12, 2) := coalesce(p_discount, 0);
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
                            customer_phone, cashier_id, cashier_name, payment_method, session_seconds, rate_per_hour,
                            base_amount, products_subtotal, discount, final_amount, business_date)
  values (p_client_ref, v_session.id, v_shift.id, v_table.name, v_floor, v_customer.id, v_customer_name,
          v_customer.phone, v_me.id, v_me.full_name, p_payment_method, v_session.billable_seconds, v_session.rate_per_hour,
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
    update public.sessions
    set status = 'completed', customer_id = coalesce(v_customer.id, customer_id),
        customer_name = coalesce(v_customer_name, customer_name)
    where id = v_session.id;
    delete from public.session_items where session_id = v_session.id;
    update public.bookings set status = 'completed', updated_at = now()
    where session_id = v_session.id and status = 'started';
  end if;

  return public.fusion_receipt_json(v_sale_id);
end;
$$;

-- Void a sale. Staff (with "Delete sales") may void only their own sales, an
-- admin any sale — and only while its counter shift is still open, so a
-- closed shift's figures never change. The reversal is posted to the ledger
-- (with a void count for the audit trail) and to the customer statistics.
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

  delete from public.sale_items where sale_id = p_sale_id;
  delete from public.sales where id = p_sale_id;
  if v_sale.session_id is not null then
    update public.sessions set status = 'voided' where id = v_sale.session_id and status = 'completed';
  end if;
end;
$$;

-- Staff can reopen only their own receipts.
create or replace function public.get_receipt(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_sale public.sales;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id;
  if not found or not (v_me.role = 'admin' or v_sale.cashier_id = v_me.id) then
    raise exception 'Receipt not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  return public.fusion_receipt_json(p_sale_id);
end;
$$;

-- The floor view, now also showing a name-only customer.
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

-- 8. Counter shifts and expenses ----------------------------------------------

-- Opens the caller's counter. Idempotent: if it is already open, the open
-- shift is returned (so a retry or a second terminal never creates another).
create or replace function public.open_counter()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_id uuid;
begin
  if v_me.role = 'admin' then
    raise exception 'Administrators manage the business and do not run a counter.'
      using errcode = '42501', hint = 'admin_no_sales';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(7316, pg_catalog.hashtext(v_me.id::text));
  select c.id into v_id from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open';
  if v_id is null then
    insert into public.counter_shifts (user_id, staff_name, business_date)
    values (v_me.id, v_me.full_name, public.fusion_business_date(now()))
    returning id into v_id;
  end if;
  return public.fusion_shift_json(v_id);
end;
$$;

-- Closes a counter: the caller's own (p_shift_id null) or, for an admin, any
-- open counter. Table sessions started on this counter that are still open
-- need an explicit handover (their payment is recorded by whichever counter
-- checks them out — never lost, never counted twice). Before closing, the
-- shift totals are checked against the ledger, the expenses and (while they
-- still exist) the invoices themselves.
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
    select coalesce(sum(s.final_amount) filter (where s.payment_method = 'cash'), 0) as cash,
           coalesce(sum(s.final_amount) filter (where s.payment_method = 'bank_transfer'), 0) as bank,
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

-- Records an expense on the caller's open counter (idempotent by client_ref).
create or replace function public.add_expense(p_client_ref uuid, p_amount numeric, p_description text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_shift public.counter_shifts;
  v_expense public.expenses;
begin
  if p_client_ref is null then
    raise exception 'Missing expense reference.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select e.* into v_expense from public.expenses e where e.client_ref = p_client_ref;
  if found then
    if v_expense.user_id <> v_me.id then
      raise exception 'Expense not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
    return to_jsonb(v_expense);
  end if;

  v_shift := public.fusion_require_open_shift(v_me);
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid amount.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 1 and 120 then
    raise exception 'Describe the expense (up to 120 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;

  insert into public.expenses (client_ref, shift_id, user_id, business_date, amount, description)
  values (p_client_ref, v_shift.id, v_me.id, public.fusion_business_date(now()), p_amount, btrim(p_description))
  returning * into v_expense;
  perform public.fusion_post_ledger(v_shift.id, v_me.id, v_expense.business_date, 0, 0, 0, 0, v_expense.amount, 0, 0, 0);
  return to_jsonb(v_expense);
end;
$$;

-- Voids an expense while its counter is open (the owner, or an admin). The
-- record stays, marked voided, for the audit trail.
create or replace function public.void_expense(p_expense_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_expense public.expenses;
  v_shift public.counter_shifts;
begin
  select e.* into v_expense from public.expenses e where e.id = p_expense_id for update;
  if not found or (v_me.role <> 'admin' and v_expense.user_id <> v_me.id) then
    raise exception 'Expense not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_expense.voided_at is not null then
    return to_jsonb(v_expense);
  end if;
  select c.* into v_shift from public.counter_shifts c where c.id = v_expense.shift_id for update;
  if v_shift.status <> 'open' then
    raise exception 'This expense belongs to a closed counter shift; its totals are final.'
      using errcode = 'P0001', hint = 'shift_closed';
  end if;
  update public.expenses set voided_at = now(), voided_by = v_me.id where id = p_expense_id returning * into v_expense;
  perform public.fusion_post_ledger(v_shift.id, v_expense.user_id, v_expense.business_date, 0, 0, 0, 0,
                                    -v_expense.amount, 0, 0, 0);
  return to_jsonb(v_expense);
end;
$$;

-- The staff member's counter screen: the open shift, its expenses and recent
-- closed shifts. Always the caller's own data.
create or replace function public.get_my_counter()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_open uuid;
begin
  select c.id into v_open from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open';
  return jsonb_build_object(
    'can_operate', v_me.role = 'staff',
    'shift', case when v_open is null then null else public.fusion_shift_json(v_open) end,
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc)
                          from public.expenses e where e.shift_id = v_open), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(public.fusion_shift_json(x.id) order by x.opened_at desc)
                        from (select c.id, c.opened_at from public.counter_shifts c
                              where c.user_id = v_me.id and c.status = 'closed'
                              order by c.opened_at desc limit 15) x), '[]'::jsonb));
end;
$$;

-- One shift in detail. Admins see any shift; staff only their own, and its
-- invoices only with "See own sales" or "Delete sales". Invoices removed by
-- the retention policy are reported as expired, never as zero.
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

-- 9. Dashboard, history and day closing ---------------------------------------

-- A day's totals: the permanent ledger plus any amount archived before shifts
-- existed.
create or replace function public.fusion_day_totals(p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cash', coalesce(l.cash, 0) + coalesce(ds.legacy_cash, 0),
    'bank', coalesce(l.bank, 0) + coalesce(ds.legacy_bank, 0),
    'total', coalesce(l.cash, 0) + coalesce(l.bank, 0) + coalesce(ds.legacy_cash, 0) + coalesce(ds.legacy_bank, 0),
    'snack', coalesce(l.snack, 0),
    'expenses', coalesce(l.expenses, 0),
    'net', coalesce(l.cash, 0) + coalesce(l.bank, 0) + coalesce(ds.legacy_cash, 0) + coalesce(ds.legacy_bank, 0)
           - coalesce(l.expenses, 0),
    'count', coalesce(l.invoices, 0),
    'discounts', coalesce(l.discounts, 0),
    'archived', coalesce(ds.legacy_cash, 0) + coalesce(ds.legacy_bank, 0) > 0,
    'closed', ds.closed_at is not null)
  from (select 1) one
  left join public.daily_summaries ds on ds.business_date = p_date
  left join lateral (
    select sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.snack_sales) as snack,
           sum(t.expenses) as expenses, sum(t.invoice_count) as invoices, sum(t.discounts) as discounts
    from public.shift_daily_totals t where t.business_date = p_date) l on true;
$$;

-- Dates that need (re)closing: activity not yet finalised, or changed since.
create or replace function public.fusion_closing_candidates()
returns table (business_date date, invoice_count bigint, total_cash numeric, total_bank numeric, total_sales numeric,
               expenses numeric, open_counters bigint, closed_at timestamptz, changed_since_close boolean)
language sql stable security definer set search_path = '' as $$
  with ledger as (
    select t.business_date, sum(t.invoice_count) as invoices, sum(t.cash_sales) as cash, sum(t.bank_sales) as bank,
           sum(t.expenses) as expenses, count(distinct t.shift_id) filter (where c.status = 'open') as open_counters
    from public.shift_daily_totals t
    join public.counter_shifts c on c.id = t.shift_id
    group by t.business_date),
  days as (
    select coalesce(l.business_date, d.business_date) as business_date,
           coalesce(l.invoices, 0)::bigint as invoices,
           coalesce(l.cash, 0) + coalesce(d.legacy_cash, 0) as cash,
           coalesce(l.bank, 0) + coalesce(d.legacy_bank, 0) as bank,
           coalesce(l.expenses, 0) as expenses,
           coalesce(l.open_counters, 0)::bigint as open_counters,
           d.closed_at,
           d.closed_at is not null
             and (coalesce(l.cash, 0) + coalesce(d.legacy_cash, 0), coalesce(l.bank, 0) + coalesce(d.legacy_bank, 0),
                  coalesce(l.expenses, 0), coalesce(l.invoices, 0)::bigint)
                 is distinct from (d.total_cash, d.total_bank, d.expenses, d.invoice_count::bigint) as changed
    from ledger l
    full join public.daily_summaries d on d.business_date = l.business_date)
  select x.business_date, x.invoices, x.cash, x.bank, x.cash + x.bank, x.expenses, x.open_counters, x.closed_at, x.changed
  from days x
  where x.business_date <= public.fusion_business_date(now()) and (x.closed_at is null or x.changed)
  order by x.business_date desc;
$$;

create or replace function public.get_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_today date := public.fusion_business_date(now());
  v_tables jsonb;
  v_result jsonb;
  v_open uuid;
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
      'staff', public.fusion_staff_day(v_today),
      'yesterday_total', (public.fusion_day_totals(v_today - 1) ->> 'total')::numeric,
      'lifetime_total', coalesce((select sum(t.cash_sales + t.bank_sales) from public.shift_daily_totals t), 0)
                        + coalesce((select sum(d.legacy_cash + d.legacy_bank) from public.daily_summaries d), 0),
      'hourly', coalesce((
        select jsonb_agg(jsonb_build_object('hour', h.hour, 'total', h.total) order by h.hour)
        from (select extract(hour from (s.created_at at time zone st.business_timezone))::integer as hour,
                     sum(s.final_amount) as total
              from public.sales s cross join public.settings st
              where s.business_date = v_today and st.id = 1 group by 1) h), '[]'::jsonb),
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
      'open_days', (select count(*) from public.fusion_closing_candidates() c where c.business_date < v_today),
      'bookings_today', (select count(*) from public.bookings b
                         where b.status = 'booked' and public.fusion_business_date(b.booking_at) = v_today));
  else
    select c.id into v_open from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open';
    v_result := v_result || jsonb_build_object(
      'my_counter', case when v_open is null then null else public.fusion_shift_json(v_open) end);
  end if;
  return v_result;
end;
$$;

-- Admin history for a business-date range: totals, days, staff, shifts.
create or replace function public.get_history(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days jsonb;
  v_totals jsonb;
  v_staff jsonb;
  v_shifts jsonb;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_to - p_from > 366 then
    raise exception 'History is limited to one year at a time.' using errcode = '22023', hint = 'invalid_input';
  end if;

  with ledger as (
    select t.business_date as d, sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.snack_sales) as snack,
           sum(t.discounts) as discounts, sum(t.expenses) as expenses, sum(t.invoice_count) as invoices,
           sum(t.voided_count) as voided
    from public.shift_daily_totals t
    where t.business_date between p_from and p_to
    group by t.business_date),
  summary as (
    select d.business_date as d, d.legacy_cash, d.legacy_bank, d.closed_at, d.total_cash, d.total_bank,
           d.expenses as closed_expenses, d.invoice_count as closed_invoices
    from public.daily_summaries d
    where d.business_date between p_from and p_to),
  days as (
    select coalesce(l.d, s.d) as d,
           coalesce(l.cash, 0) + coalesce(s.legacy_cash, 0) as cash,
           coalesce(l.bank, 0) + coalesce(s.legacy_bank, 0) as bank,
           coalesce(l.snack, 0) as snack, coalesce(l.discounts, 0) as discounts,
           coalesce(l.expenses, 0) as expenses, coalesce(l.invoices, 0) as invoices, coalesce(l.voided, 0) as voided,
           coalesce(s.legacy_cash, 0) + coalesce(s.legacy_bank, 0) as legacy,
           s.closed_at is not null
             and (coalesce(l.cash, 0) + coalesce(s.legacy_cash, 0), coalesce(l.bank, 0) + coalesce(s.legacy_bank, 0),
                  coalesce(l.expenses, 0), coalesce(l.invoices, 0)::bigint)
                 is not distinct from (s.total_cash, s.total_bank, s.closed_expenses, s.closed_invoices::bigint) as closed
    from ledger l
    full join summary s on s.d = l.d)
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d, 'cash', cash, 'bank', bank, 'total', cash + bank, 'snack', snack, 'discounts', discounts,
           'expenses', expenses, 'net', cash + bank - expenses, 'invoices', invoices, 'voided', voided,
           'legacy', legacy, 'closed', closed) order by d), '[]'::jsonb),
         jsonb_build_object(
           'cash', coalesce(sum(cash), 0), 'bank', coalesce(sum(bank), 0), 'total', coalesce(sum(cash + bank), 0),
           'snack', coalesce(sum(snack), 0), 'discounts', coalesce(sum(discounts), 0),
           'expenses', coalesce(sum(expenses), 0), 'net', coalesce(sum(cash + bank - expenses), 0),
           'invoices', coalesce(sum(invoices), 0), 'voided', coalesce(sum(voided), 0),
           'legacy', coalesce(sum(legacy), 0), 'days', count(*))
    into v_days, v_totals
  from days;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', x.user_id, 'name', x.name, 'cash', x.cash, 'bank', x.bank, 'total', x.cash + x.bank,
           'snack', x.snack, 'expenses', x.expenses, 'net', x.cash + x.bank - x.expenses,
           'invoices', x.invoices, 'shifts', x.shifts) order by x.cash + x.bank desc, x.name), '[]'::jsonb)
    into v_staff
  from (select t.user_id, max(coalesce(u.full_name, c.staff_name)) as name,
               sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.snack_sales) as snack,
               sum(t.expenses) as expenses, sum(t.invoice_count) as invoices, count(distinct t.shift_id) as shifts
        from public.shift_daily_totals t
        join public.counter_shifts c on c.id = t.shift_id
        left join public.app_users u on u.id = t.user_id
        where t.business_date between p_from and p_to
        group by t.user_id) x;

  select coalesce(jsonb_agg(public.fusion_shift_json(x.id)
                            || jsonb_build_object('retained_invoices',
                                                  (select count(*) from public.sales s where s.shift_id = x.id))
                            order by x.opened_at desc), '[]'::jsonb)
    into v_shifts
  from (select c.id, c.opened_at from public.counter_shifts c
        where c.business_date between p_from and p_to
           or exists (select 1 from public.shift_daily_totals t
                      where t.shift_id = c.id and t.business_date between p_from and p_to)
        order by c.opened_at desc limit 500) x;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'totals', v_totals, 'days', v_days, 'by_staff', v_staff, 'shifts', v_shifts,
    'retention_days', (select st.sales_retention_days from public.settings st where st.id = 1),
    'oldest_invoice_date', (select min(s.business_date) from public.sales s));
end;
$$;

-- The previous report, rebuilt on the permanent ledger so its totals stay
-- correct after invoice cleanup (product lines cover retained invoices only).
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

  with ledger as (
    select t.business_date as d, sum(t.cash_sales) as cash, sum(t.bank_sales) as bank,
           sum(t.discounts) as discounts, sum(t.invoice_count) as cnt
    from public.shift_daily_totals t
    where t.business_date between p_from and p_to and (p_cashier_id is null or t.user_id = p_cashier_id)
    group by t.business_date),
  legacy as (
    select d.business_date as d, d.legacy_cash as cash, d.legacy_bank as bank
    from public.daily_summaries d
    where d.business_date between p_from and p_to and p_cashier_id is null and d.legacy_cash + d.legacy_bank > 0),
  days as (
    select coalesce(l.d, g.d) as d,
           coalesce(l.cash, 0) + coalesce(g.cash, 0) as cash,
           coalesce(l.bank, 0) + coalesce(g.bank, 0) as bank,
           coalesce(l.discounts, 0) as discounts,
           coalesce(l.cnt, 0) as live_count,
           g.d is not null as archived
    from ledger l full join legacy g on g.d = l.d)
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'cash', cash, 'bank', bank, 'total', cash + bank,
                                               'discounts', discounts, 'live_count', live_count,
                                               'archived', archived) order by d), '[]'::jsonb),
         jsonb_build_object('cash', coalesce(sum(cash), 0), 'bank', coalesce(sum(bank), 0),
                            'total', coalesce(sum(cash + bank), 0), 'discounts', coalesce(sum(discounts), 0),
                            'live_count', coalesce(sum(live_count), 0),
                            'archived_days', count(*) filter (where archived))
    into v_days, v_totals
  from days;

  select coalesce(jsonb_agg(jsonb_build_object('cashier_id', x.user_id, 'cashier_name', x.name,
                                               'cash', x.cash, 'bank', x.bank, 'total', x.cash + x.bank,
                                               'count', x.cnt) order by x.cash + x.bank desc), '[]'::jsonb)
    into v_staff
  from (select t.user_id, max(coalesce(u.full_name, c.staff_name)) as name,
               sum(t.cash_sales) as cash, sum(t.bank_sales) as bank, sum(t.invoice_count) as cnt
        from public.shift_daily_totals t
        join public.counter_shifts c on c.id = t.shift_id
        left join public.app_users u on u.id = t.user_id
        where t.business_date between p_from and p_to and (p_cashier_id is null or t.user_id = p_cashier_id)
        group by t.user_id) x;

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

drop function public.list_open_business_dates();
create function public.list_open_business_dates()
returns table (business_date date, invoice_count bigint, total_cash numeric, total_bank numeric, total_sales numeric,
               expenses numeric, open_counters bigint, closed_at timestamptz, changed_since_close boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  return query select * from public.fusion_closing_candidates();
end;
$$;

-- Close a business day: finalise its summary. Nothing is deleted. Every
-- counter with activity that day must be closed first, so the saved figures
-- are final. Running it again after late activity simply refreshes them.
create or replace function public.close_business_day(p_business_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_open text;
  v_ledger record;
  v_legacy record;
  v_summary public.daily_summaries;
begin
  if p_business_date is null then
    raise exception 'Choose the business date to close.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_business_date > public.fusion_business_date(now()) then
    raise exception 'You cannot close a business day that has not started.' using errcode = '22023', hint = 'invalid_input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(7314, (p_business_date - date '2000-01-01'));

  select string_agg(distinct coalesce(u.full_name, c.staff_name), ', ') into v_open
  from public.shift_daily_totals t
  join public.counter_shifts c on c.id = t.shift_id
  left join public.app_users u on u.id = c.user_id
  where t.business_date = p_business_date and c.status = 'open';
  if v_open is not null then
    raise exception 'Close these counters first: %.', v_open using errcode = 'P0001', hint = 'counters_open';
  end if;

  select count(*) as n, coalesce(sum(t.cash_sales), 0) as cash, coalesce(sum(t.bank_sales), 0) as bank,
         coalesce(sum(t.snack_sales), 0) as snack, coalesce(sum(t.discounts), 0) as discounts,
         coalesce(sum(t.expenses), 0) as expenses, coalesce(sum(t.invoice_count), 0)::integer as invoices
    into v_ledger
  from public.shift_daily_totals t where t.business_date = p_business_date;
  select coalesce(max(d.legacy_cash), 0) as cash, coalesce(max(d.legacy_bank), 0) as bank, count(*) as n
    into v_legacy
  from public.daily_summaries d where d.business_date = p_business_date;
  if v_ledger.n = 0 and v_legacy.n = 0 then
    raise exception 'There is no activity to close for %.', p_business_date using errcode = 'P0001', hint = 'nothing_to_close';
  end if;

  insert into public.daily_summaries as d (business_date, total_cash, total_bank, total_sales, snack_sales, discounts,
                                           expenses, invoice_count, closed_at, closed_by, created_by, updated_by)
  values (p_business_date, v_ledger.cash + v_legacy.cash, v_ledger.bank + v_legacy.bank,
          v_ledger.cash + v_legacy.cash + v_ledger.bank + v_legacy.bank, v_ledger.snack, v_ledger.discounts,
          v_ledger.expenses, v_ledger.invoices, now(), v_me.id, v_me.id, v_me.id)
  on conflict (business_date) do update
    set total_cash = excluded.total_cash, total_bank = excluded.total_bank, total_sales = excluded.total_sales,
        snack_sales = excluded.snack_sales, discounts = excluded.discounts, expenses = excluded.expenses,
        invoice_count = excluded.invoice_count, closed_at = excluded.closed_at, closed_by = excluded.closed_by,
        updated_at = now(), updated_by = excluded.updated_by
  returning * into v_summary;

  if (v_summary.total_cash, v_summary.total_bank, v_summary.expenses, v_summary.invoice_count)
     is distinct from (v_ledger.cash + v_legacy.cash, v_ledger.bank + v_legacy.bank, v_ledger.expenses, v_ledger.invoices) then
    raise exception 'The day summary could not be verified; nothing was saved.' using errcode = 'P0001', hint = 'close_failed';
  end if;

  return jsonb_build_object(
    'business_date', p_business_date,
    'summary', to_jsonb(v_summary) || jsonb_build_object('net_amount', v_summary.total_sales - v_summary.expenses),
    'staff', public.fusion_staff_day(p_business_date));
end;
$$;

-- 10. Pre-bookings (admin) -----------------------------------------------------

create or replace function public.admin_save_booking(
  p_id uuid, p_customer_name text, p_customer_phone text, p_date date, p_time time,
  p_table_id uuid default null, p_notes text default '')
returns public.bookings language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_name text := btrim(coalesce(p_customer_name, ''));
  v_phone text := public.fusion_normalize_phone(p_customer_phone);
  v_at timestamptz;
  v_booking public.bookings;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Enter the customer''s name.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_date is null or p_time is null then
    raise exception 'Choose the booking date and time.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if char_length(coalesce(p_notes, '')) > 200 then
    raise exception 'Notes are limited to 200 characters.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_table_id is not null and not exists (select 1 from public.club_tables t where t.id = p_table_id and t.is_active) then
    raise exception 'Table not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  -- Date and time are the club's local wall-clock time.
  select (p_date + p_time) at time zone s.business_timezone into v_at from public.settings s where s.id = 1;

  if p_id is null then
    insert into public.bookings (customer_name, customer_phone, table_id, booking_at, notes, created_by)
    values (v_name, v_phone, p_table_id, v_at, btrim(coalesce(p_notes, '')), v_me.id)
    returning * into v_booking;
  else
    update public.bookings
    set customer_name = v_name, customer_phone = v_phone, table_id = p_table_id, booking_at = v_at,
        notes = btrim(coalesce(p_notes, '')), updated_at = now()
    where id = p_id and status = 'booked'
    returning * into v_booking;
    if not found then
      if exists (select 1 from public.bookings b where b.id = p_id) then
        raise exception 'Only bookings that have not started can be edited.' using errcode = 'P0001', hint = 'invalid_state';
      end if;
      raise exception 'Booking not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_booking;
end;
$$;

create or replace function public.admin_set_booking_status(p_id uuid, p_status text)
returns public.bookings language plpgsql security definer set search_path = '' as $$
declare
  v_booking public.bookings;
begin
  perform public.fusion_require_admin();
  if p_status not in ('booked', 'cancelled', 'no_show') then
    raise exception 'Unknown booking status.' using errcode = '22023', hint = 'invalid_input';
  end if;
  update public.bookings set status = p_status, updated_at = now()
  where id = p_id and status in ('booked', 'cancelled', 'no_show')
  returning * into v_booking;
  if not found then
    if exists (select 1 from public.bookings b where b.id = p_id) then
      raise exception 'A booking that has started cannot be changed here.' using errcode = 'P0001', hint = 'invalid_state';
    end if;
    raise exception 'Booking not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  return v_booking;
end;
$$;

create or replace function public.admin_delete_booking(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  delete from public.bookings where id = p_id and session_id is null;
  if not found then
    if exists (select 1 from public.bookings b where b.id = p_id) then
      raise exception 'A booking that has started is kept with its session and cannot be deleted.'
        using errcode = 'P0001', hint = 'in_use';
    end if;
    raise exception 'Booking not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
end;
$$;

-- Starts a booking with the ordinary session engine (same timer and billing)
-- and links the two. The booking row lock makes a double start impossible.
create or replace function public.start_booking(p_booking_id uuid, p_table_id uuid default null)
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

  v_session := public.start_session(p_table_id => v_table, p_customer_id => v_booking.customer_id,
                                    p_customer_name => v_booking.customer_name,
                                    p_customer_phone => v_booking.customer_phone);
  update public.bookings
  set status = 'started', session_id = v_session.id, table_id = v_table, customer_id = v_session.customer_id,
      started_at = now(), started_by = v_me.id, updated_at = now()
  where id = p_booking_id returning * into v_booking;
  return jsonb_build_object('booking', to_jsonb(v_booking), 'session', to_jsonb(v_session));
end;
$$;

-- Bookings whose business date falls in the range, with table and session state.
create or replace function public.list_bookings(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  perform public.fusion_require_admin();
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'Choose a valid date range.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select (p_from::timestamp + make_interval(hours => s.day_start_hour)) at time zone s.business_timezone,
         ((p_to + 1)::timestamp + make_interval(hours => s.day_start_hour)) at time zone s.business_timezone
    into v_start, v_end
  from public.settings s where s.id = 1;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', b.id, 'customer_id', b.customer_id, 'customer_name', b.customer_name,
             'customer_phone', b.customer_phone, 'table_id', b.table_id, 'table_name', t.name, 'floor_name', f.name,
             'booking_at', b.booking_at, 'business_date', public.fusion_business_date(b.booking_at),
             'notes', b.notes, 'status', b.status, 'session_id', b.session_id, 'session_status', se.status,
             'started_at', b.started_at, 'created_at', b.created_at) order by b.booking_at)
    from public.bookings b
    left join public.club_tables t on t.id = b.table_id
    left join public.floors f on f.id = t.floor_id
    left join public.sessions se on se.id = b.session_id
    where b.booking_at >= v_start and b.booking_at < v_end), '[]'::jsonb);
end;
$$;

-- 11. Customer rankings (admin) -----------------------------------------------
create or replace function public.get_customer_rankings(p_metric text default 'visits', p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  if p_metric not in ('visits', 'play_time', 'spending') then
    raise exception 'Unknown ranking.' using errcode = '22023', hint = 'invalid_input';
  end if;
  return jsonb_build_object(
    'summary', (select jsonb_build_object(
                  'customers', (select count(*) from public.customers),
                  'with_visits', count(distinct v.customer_id),
                  'repeat', (select count(*) from (select v2.customer_id from public.customer_visits v2
                                                   group by v2.customer_id having count(*) > 1) r))
                from public.customer_visits v),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.rank, r.name)
      from (select rank() over (order by case p_metric when 'visits' then x.visits::numeric
                                                       when 'play_time' then x.play_seconds::numeric
                                                       else x.spent end desc) as rank,
                   x.*
            from (select c.id, c.name, c.phone, count(*) as visits, sum(v.invoices) as invoices,
                         sum(v.play_seconds) as play_seconds, sum(v.spent) as spent,
                         max(v.last_at) as last_visit_at, min(v.business_date) as first_visit_date
                  from public.customer_visits v join public.customers c on c.id = v.customer_id
                  group by c.id) x
            order by 1, x.name
            limit least(greatest(coalesce(p_limit, 25), 1), 100)) r), '[]'::jsonb));
end;
$$;

-- 12. Deleting configuration records safely -----------------------------------
-- A record that history refers to is never destroyed; the admin is told to
-- deactivate it instead. Unused records can be deleted for good.
create or replace function public.admin_delete_category(p_id smallint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_used integer;
begin
  perform public.fusion_require_admin();
  select count(*) into v_used from public.club_tables t where t.category_id = p_id;
  if v_used > 0 then
    raise exception 'This category is used by % table(s), including removed ones. Mark it inactive instead so their history stays intact.',
      v_used using errcode = 'P0001', hint = 'in_use';
  end if;
  delete from public.table_categories where id = p_id;
  if not found then
    raise exception 'Category not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
end;
$$;

create or replace function public.admin_delete_table(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  if exists (select 1 from public.sessions s where s.table_id = p_id)
     or exists (select 1 from public.bookings b where b.table_id = p_id) then
    raise exception 'This table has session or booking history, so it can only be removed (hidden), not deleted. Its history stays in reports.'
      using errcode = 'P0001', hint = 'in_use';
  end if;
  delete from public.club_tables where id = p_id;
  if not found then
    raise exception 'Table not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
end;
$$;

create or replace function public.admin_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
begin
  perform public.fusion_require_admin();
  select p.* into v_product from public.inventory_products p where p.id = p_id for update;
  if not found then
    raise exception 'Product not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_product.units_sold > 0
     or exists (select 1 from public.sale_items i where i.product_id = p_id)
     or exists (select 1 from public.session_items i where i.product_id = p_id) then
    raise exception '"%" has been sold or is on an open tab, so it can only be removed from sale. Past invoices keep its name and price.',
      v_product.name using errcode = 'P0001', hint = 'in_use';
  end if;
  delete from public.inventory_products where id = p_id;
end;
$$;

-- Checked by the admin-users Edge Function before it deletes a login.
create or replace function public.admin_check_user_deletable(p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
  v_user public.app_users;
begin
  if p_user_id = v_me.id then
    raise exception 'You cannot delete your own account.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  select u.* into v_user from public.app_users u where u.id = p_user_id;
  if not found then
    raise exception 'User not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_user.role = 'admin' then
    perform public.fusion_assert_admin_remains(p_user_id);
  end if;
  if exists (select 1 from public.counter_shifts c where c.user_id = p_user_id or c.closed_by = p_user_id)
     or exists (select 1 from public.sales s where s.cashier_id = p_user_id)
     or exists (select 1 from public.sessions s where s.started_by = p_user_id or s.ended_by = p_user_id)
     or exists (select 1 from public.session_items i where i.added_by = p_user_id)
     or exists (select 1 from public.expenses e where e.user_id = p_user_id or e.voided_by = p_user_id)
     or exists (select 1 from public.bookings b where b.created_by = p_user_id or b.started_by = p_user_id) then
    raise exception '% has sales, shift or session history, so the account can only be deactivated. Its history stays in reports.',
      v_user.full_name using errcode = 'P0001', hint = 'in_use';
  end if;
  return true;
end;
$$;

-- 13. Settings (adds the retention period) ------------------------------------
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
    sales_retention_days = coalesce((p_settings ->> 'sales_retention_days')::smallint, sales_retention_days),
    updated_at = now(),
    updated_by = v_me.id
  where id = 1 returning * into v_result;
  return v_result;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'One of the settings is out of range.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

-- 14. Automatic sales-detail retention ----------------------------------------
-- Removes invoices (sales + sale items) dated before (today − retention days)
-- that belong to CLOSED counter shifts. Their money is already in the shift
-- totals, the per-day ledger and the customer statistics, which are never
-- touched. Safe to run any number of times: a second run finds nothing more.
-- A transaction-level advisory lock prevents overlapping runs; every run is
-- logged, and a failure rolls back its deletions but keeps the log entry.
create or replace function public.fusion_run_retention(p_source text, p_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run_id bigint;
  v_days smallint;
  v_cutoff date;
  v_ids uuid[];
  v_shifts uuid[];
  v_sales integer := 0;
  v_items integer := 0;
begin
  select s.sales_retention_days into v_days from public.settings s where s.id = 1;
  v_cutoff := public.fusion_business_date(now()) - v_days;

  if not pg_catalog.pg_try_advisory_xact_lock(7315, 0) then
    insert into public.retention_runs (source, run_by, status, retention_days, cutoff_date, finished_at, message)
    values (p_source, p_by, 'skipped', v_days, v_cutoff, now(), 'Another cleanup was already running.')
    returning id into v_run_id;
    return (select to_jsonb(r) from public.retention_runs r where r.id = v_run_id);
  end if;

  insert into public.retention_runs (source, run_by, status, retention_days, cutoff_date)
  values (p_source, p_by, 'running', v_days, v_cutoff)
  returning id into v_run_id;

  begin
    select coalesce(array_agg(x.id order by x.id), '{}') into v_ids
    from (select s.id from public.sales s
          join public.counter_shifts c on c.id = s.shift_id
          where s.business_date < v_cutoff and c.status = 'closed'
          order by s.id
          limit 20000
          for update of s) x;
    select coalesce(array_agg(distinct s.shift_id), '{}') into v_shifts from public.sales s where s.id = any (v_ids);

    if exists (select 1 from public.sales s
               where s.id = any (v_ids)
                 and not exists (select 1 from public.shift_daily_totals t
                                 where t.shift_id = s.shift_id and t.business_date = s.business_date)) then
      raise exception 'Some invoices have no permanent summary; nothing was removed.' using errcode = 'P0001',
        hint = 'retention_unsafe';
    end if;

    delete from public.sale_items i where i.sale_id = any (v_ids);
    get diagnostics v_items = row_count;
    delete from public.sales s where s.id = any (v_ids);
    get diagnostics v_sales = row_count;
    update public.counter_shifts set details_purged_at = now() where id = any (v_shifts);
    delete from public.retention_runs r where r.started_at < now() - interval '180 days';

    update public.retention_runs
    set status = 'success', finished_at = now(), sales_deleted = v_sales, items_deleted = v_items,
        shifts_affected = coalesce(cardinality(v_shifts), 0),
        message = case when v_sales = 0 then 'Nothing was old enough to remove.' end
    where id = v_run_id;
  exception when others then
    update public.retention_runs set status = 'failed', finished_at = now(), message = left(sqlerrm, 500)
    where id = v_run_id;
  end;
  return (select to_jsonb(r) from public.retention_runs r where r.id = v_run_id);
end;
$$;

-- Entry point for the scheduler (pg_cron runs it as the database owner).
create or replace function public.fusion_retention_job()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.fusion_run_retention('schedule', null);
end;
$$;

create or replace function public.fusion_retention_scheduled()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_scheduled boolean := false;
begin
  if pg_catalog.to_regclass('cron.job') is null then
    return false;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1 and active)' into v_scheduled
    using 'fusion-sales-retention';
  return coalesce(v_scheduled, false);
exception when others then
  return false;
end;
$$;

create or replace function public.admin_run_retention()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
begin
  return public.fusion_run_retention('manual', v_me.id);
end;
$$;

-- What the next cleanup would remove, and how the job has been doing.
create or replace function public.get_retention_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days smallint;
  v_cutoff date;
  v_size bigint;
  v_detail_size bigint;
begin
  perform public.fusion_require_admin();
  select s.sales_retention_days into v_days from public.settings s where s.id = 1;
  v_cutoff := public.fusion_business_date(now()) - v_days;
  begin
    v_size := pg_catalog.pg_database_size(pg_catalog.current_database());
    v_detail_size := pg_catalog.pg_total_relation_size('public.sales') + pg_catalog.pg_total_relation_size('public.sale_items');
  exception when others then
    v_size := null;
    v_detail_size := null;
  end;
  return jsonb_build_object(
    'retention_days', v_days,
    'cutoff_date', v_cutoff,
    'scheduled', public.fusion_retention_scheduled(),
    'eligible_sales', (select count(*) from public.sales s join public.counter_shifts c on c.id = s.shift_id
                       where s.business_date < v_cutoff and c.status = 'closed'),
    'eligible_items', (select count(*) from public.sale_items i join public.sales s on s.id = i.sale_id
                       join public.counter_shifts c on c.id = s.shift_id
                       where s.business_date < v_cutoff and c.status = 'closed'),
    'waiting_on_open_shifts', (select count(*) from public.sales s join public.counter_shifts c on c.id = s.shift_id
                               where s.business_date < v_cutoff and c.status = 'open'),
    'retained_sales', (select count(*) from public.sales),
    'oldest_invoice_date', (select min(s.business_date) from public.sales s),
    'database_bytes', v_size,
    'detail_bytes', v_detail_size,
    'last_success', (select to_jsonb(r) from public.retention_runs r where r.status = 'success'
                     order by r.started_at desc limit 1),
    'recent_runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc)
                             from (select * from public.retention_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$$;

-- Schedule the job hourly with pg_cron where available (Supabase). If this
-- fails, the migration still applies and Settings shows the job as not
-- scheduled; see README for the manual step.
do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
      perform cron.schedule('fusion-sales-retention', '17 * * * *', 'select public.fusion_retention_job()');
    exception when others then
      raise warning 'FUSION: automatic sales cleanup could not be scheduled (%). See README.', sqlerrm;
    end;
  else
    raise notice 'FUSION: pg_cron is not available; automatic sales cleanup is not scheduled.';
  end if;
end;
$$;

-- 15. Row Level Security ---------------------------------------------------------
alter table public.counter_shifts     enable row level security;
alter table public.shift_daily_totals enable row level security;
alter table public.expenses           enable row level security;
alter table public.bookings           enable row level security;
alter table public.customer_visits    enable row level security;
alter table public.retention_runs     enable row level security;

-- Staff see only their own accounting; admins see everything.
create policy counter_shifts_read on public.counter_shifts
  for select to authenticated using (
    (select public.fusion_is_admin()) or (user_id = (select auth.uid()) and (select public.fusion_is_active_user())));
create policy shift_daily_totals_read on public.shift_daily_totals
  for select to authenticated using (
    (select public.fusion_is_admin()) or (user_id = (select auth.uid()) and (select public.fusion_is_active_user())));
create policy expenses_read on public.expenses
  for select to authenticated using (
    (select public.fusion_is_admin()) or (user_id = (select auth.uid()) and (select public.fusion_is_active_user())));
create policy bookings_read on public.bookings
  for select to authenticated using ((select public.fusion_is_admin()));
create policy customer_visits_read on public.customer_visits
  for select to authenticated using ((select public.fusion_is_admin()));
create policy retention_runs_read on public.retention_runs
  for select to authenticated using ((select public.fusion_is_admin()));

-- Sales: admins all; staff only their own (with "See own sales" or "Delete
-- sales") — never another staff member's, whatever their floor.
drop policy sales_read on public.sales;
create policy sales_read on public.sales
  for select to authenticated using (
    (select public.fusion_is_admin())
    or (cashier_id = (select auth.uid())
        and ((select public.fusion_has_perm('view_own_sales')) or (select public.fusion_has_perm('delete_sales')))));

-- 16. Grants -----------------------------------------------------------------------
-- Supabase grants new objects to the API roles by default; take that back and
-- allow-list explicitly, as in the grants migration.
revoke all on public.counter_shifts, public.shift_daily_totals, public.expenses, public.bookings,
              public.customer_visits, public.retention_runs from anon, authenticated;
revoke all on sequence public.retention_runs_id_seq from anon, authenticated;
grant select on public.counter_shifts, public.shift_daily_totals, public.expenses, public.bookings,
                public.customer_visits, public.retention_runs to authenticated;

revoke all on function
  public.fusion_require_open_shift(public.app_users),
  public.fusion_post_ledger(uuid, uuid, date, numeric, numeric, numeric, numeric, numeric, integer, integer, numeric),
  public.fusion_post_visit(uuid, date, integer, numeric, bigint),
  public.fusion_shift_json(uuid),
  public.fusion_staff_day(date),
  public.fusion_closing_candidates(),
  public.fusion_run_retention(text, uuid),
  public.fusion_retention_job(),
  public.fusion_retention_scheduled(),
  public.list_open_business_dates(),
  public.open_counter(),
  public.close_counter(uuid, boolean),
  public.add_expense(uuid, numeric, text),
  public.void_expense(uuid),
  public.get_my_counter(),
  public.get_shift_detail(uuid),
  public.get_history(date, date),
  public.admin_save_booking(uuid, text, text, date, time, uuid, text),
  public.admin_set_booking_status(uuid, text),
  public.admin_delete_booking(uuid),
  public.start_booking(uuid, uuid),
  public.list_bookings(date, date),
  public.get_customer_rankings(text, integer),
  public.admin_delete_category(smallint),
  public.admin_delete_table(uuid),
  public.admin_delete_product(uuid),
  public.admin_check_user_deletable(uuid),
  public.admin_run_retention(),
  public.get_retention_status()
  from public, anon, authenticated;

-- Staff counter operations (each function checks the caller itself).
grant execute on function
  public.open_counter(),
  public.close_counter(uuid, boolean),
  public.add_expense(uuid, numeric, text),
  public.void_expense(uuid),
  public.get_my_counter(),
  public.get_shift_detail(uuid)
  to authenticated;

-- Administration (each function calls fusion_require_admin()).
grant execute on function
  public.list_open_business_dates(),
  public.get_history(date, date),
  public.admin_save_booking(uuid, text, text, date, time, uuid, text),
  public.admin_set_booking_status(uuid, text),
  public.admin_delete_booking(uuid),
  public.start_booking(uuid, uuid),
  public.list_bookings(date, date),
  public.get_customer_rankings(text, integer),
  public.admin_delete_category(smallint),
  public.admin_delete_table(uuid),
  public.admin_delete_product(uuid),
  public.admin_check_user_deletable(uuid),
  public.admin_run_retention(),
  public.get_retention_status()
  to authenticated;

-- 17. Realtime: the admin dashboard follows counters, expenses and bookings live.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.counter_shifts, public.shift_daily_totals, public.expenses,
                                                  public.bookings;
  end if;
end;
$$;
