-- =============================================================================
-- FUSION — core schema
-- Money is stored as numeric (exact). Timestamps are timestamptz (UTC on disk).
-- Table status is derived from `sessions` (single source of truth); the partial
-- unique index `sessions_one_open_per_table` makes duplicate active sessions on
-- one table impossible, even under concurrent requests.
-- =============================================================================

create table public.floors (
  id          smallint generated always as identity primary key,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index floors_name_key on public.floors (lower(btrim(name)));

-- Staff/admin profiles. Identity + password live in Supabase Auth (bcrypt); this
-- table only holds authorization data and is never writable by clients.
create table public.app_users (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  full_name   text not null check (char_length(btrim(full_name)) between 1 and 80),
  role        text not null check (role in ('admin', 'staff')),
  floor_id    smallint references public.floors (id) on delete restrict,
  permissions text[] not null default '{}'
              check (permissions <@ array['apply_discount', 'delete_sales', 'cancel_session', 'counter_sale',
                                          'manage_customers', 'adjust_stock', 'view_own_sales']::text[]),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index app_users_username_key on public.app_users (username);

create table public.settings (
  id                         smallint primary key default 1 check (id = 1),
  club_name                  text not null default 'FUSION Gaming Lounge' check (char_length(btrim(club_name)) between 1 and 80),
  club_address               text not null default '' check (char_length(club_address) <= 200),
  club_phone                 text not null default '' check (char_length(club_phone) <= 40),
  receipt_footer             text not null default 'Thank you for playing at FUSION' check (char_length(receipt_footer) <= 200),
  business_timezone          text not null default 'Asia/Karachi',
  day_start_hour             smallint not null default 0 check (day_start_hour between 0 and 23),
  billing_increment_minutes  smallint not null default 1 check (billing_increment_minutes between 1 and 60),
  billing_rounding           text not null default 'up' check (billing_rounding in ('up', 'nearest', 'down')),
  minimum_charge_minutes     smallint not null default 0 check (minimum_charge_minutes between 0 and 600),
  admin_idle_lock_minutes    smallint not null default 15 check (admin_idle_lock_minutes between 0 and 240),
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references public.app_users (id) on delete set null
);
insert into public.settings (id) values (1);

create table public.table_categories (
  id             smallint generated always as identity primary key,
  name           text not null check (char_length(btrim(name)) between 1 and 40),
  rate_per_hour  numeric(10, 2) not null check (rate_per_hour > 0 and rate_per_hour <= 100000),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index table_categories_name_key on public.table_categories (lower(btrim(name)));

create table public.club_tables (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 1 and 40),
  category_id    smallint not null references public.table_categories (id) on delete restrict,
  floor_id       smallint not null references public.floors (id) on delete restrict,
  rate_override  numeric(10, 2) check (rate_override is null or (rate_override > 0 and rate_override <= 100000)),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index club_tables_name_key on public.club_tables (lower(btrim(name))) where is_active;
create index club_tables_floor_idx on public.club_tables (floor_id);

create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  phone       text check (phone is null or phone ~ '^\+?[0-9]{7,15}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index customers_phone_key on public.customers (phone) where phone is not null;
create index customers_name_idx on public.customers (lower(name) text_pattern_ops);

-- Products are never physically deleted (is_active = false instead) so open
-- table tabs and historical sale lines always keep a valid reference.
create table public.inventory_products (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(btrim(name)) between 1 and 80),
  category             text not null default '' check (char_length(category) <= 40),
  cost_price           numeric(12, 2) not null default 0 check (cost_price >= 0),
  selling_price        numeric(12, 2) not null check (selling_price >= 0),
  track_stock          boolean not null default true,
  stock_quantity       integer not null default 0 check (stock_quantity >= 0),
  low_stock_threshold  integer not null default 5 check (low_stock_threshold >= 0),
  units_sold           integer not null default 0 check (units_sold >= 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index inventory_products_name_key on public.inventory_products (lower(btrim(name))) where is_active;

-- Billable time = (coalesce(ended_at, paused_at, now()) - started_at) - paused_ms.
-- Everything the timer needs is persisted, so the display and the bill are
-- identical across re-renders, terminals and application restarts.
create table public.sessions (
  id                uuid primary key default gen_random_uuid(),
  table_id          uuid not null references public.club_tables (id) on delete restrict,
  customer_id       uuid references public.customers (id) on delete set null,
  status            text not null check (status in ('running', 'paused', 'billing', 'completed')),
  rate_per_hour     numeric(10, 2) not null check (rate_per_hour > 0),
  booked_seconds    integer check (booked_seconds is null or booked_seconds > 0),
  booked_amount     numeric(12, 2) check (booked_amount is null or booked_amount >= 0),
  started_at        timestamptz not null default now(),
  paused_at         timestamptz,
  paused_ms         bigint not null default 0 check (paused_ms >= 0),
  ended_at          timestamptz,
  billable_seconds  integer check (billable_seconds is null or billable_seconds >= 0),
  base_amount       numeric(12, 2) check (base_amount is null or base_amount >= 0),
  started_by        uuid not null references public.app_users (id),
  ended_by          uuid references public.app_users (id),
  created_at        timestamptz not null default now(),
  constraint sessions_booking_pair check ((booked_seconds is null) = (booked_amount is null)),
  constraint sessions_pause_state check ((status = 'paused') = (paused_at is not null)),
  constraint sessions_end_state check ((status in ('billing', 'completed')) = (ended_at is not null)),
  constraint sessions_bill_state check (
    (status in ('billing', 'completed')) = (billable_seconds is not null and base_amount is not null))
);
create unique index sessions_one_open_per_table on public.sessions (table_id)
  where status in ('running', 'paused', 'billing');
create index sessions_status_idx on public.sessions (status);

-- Items served to a table during a session (the table's tab). Stock is taken
-- when the item is added and returned if it is removed; the price is
-- snapshotted so later price edits cannot change an open tab.
create table public.session_items (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.sessions (id) on delete cascade,
  product_id    uuid not null references public.inventory_products (id) on delete restrict,
  product_name  text not null,
  unit_price    numeric(12, 2) not null check (unit_price >= 0),
  quantity      integer not null check (quantity between 1 and 999),
  added_by      uuid not null references public.app_users (id),
  created_at    timestamptz not null default now(),
  unique (session_id, product_id)
);

create table public.sales (
  id                 uuid primary key default gen_random_uuid(),
  receipt_no         bigint generated always as identity unique,
  client_ref         uuid not null unique,
  session_id         uuid unique references public.sessions (id) on delete set null,
  table_name         text,
  floor_id           smallint references public.floors (id) on delete set null,
  customer_id        uuid references public.customers (id) on delete set null,
  customer_name      text,
  customer_phone     text,
  cashier_id         uuid not null references public.app_users (id) on delete restrict,
  cashier_name       text not null,
  payment_method     text not null check (payment_method in ('cash', 'bank_transfer')),
  session_seconds    integer check (session_seconds is null or session_seconds >= 0),
  rate_per_hour      numeric(10, 2),
  base_amount        numeric(12, 2) not null default 0 check (base_amount >= 0),
  products_subtotal  numeric(12, 2) not null default 0 check (products_subtotal >= 0),
  discount           numeric(12, 2) not null default 0 check (discount >= 0),
  final_amount       numeric(12, 2) not null check (final_amount >= 0),
  business_date      date not null,
  created_at         timestamptz not null default now(),
  constraint sales_discount_limit check (discount <= base_amount + products_subtotal),
  constraint sales_final_amount check (final_amount = base_amount + products_subtotal - discount)
);
create index sales_business_date_idx on public.sales (business_date);
create index sales_cashier_idx on public.sales (cashier_id, business_date);

create table public.sale_items (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references public.sales (id) on delete cascade,
  product_id    uuid references public.inventory_products (id) on delete set null,
  product_name  text not null,
  unit_price    numeric(12, 2) not null check (unit_price >= 0),
  quantity      integer not null check (quantity > 0),
  line_total    numeric(12, 2) not null,
  constraint sale_items_line_total check (line_total = unit_price * quantity)
);
create index sale_items_sale_idx on public.sale_items (sale_id);
create index sale_items_product_idx on public.sale_items (product_id);

-- After "Close Day & Archive", only these three totals survive for a date.
create table public.daily_summaries (
  id             uuid primary key default gen_random_uuid(),
  business_date  date not null unique,
  total_cash     numeric(14, 2) not null default 0 check (total_cash >= 0),
  total_bank     numeric(14, 2) not null default 0 check (total_bank >= 0),
  total_sales    numeric(14, 2) not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.app_users (id) on delete set null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.app_users (id) on delete set null,
  constraint daily_summaries_total check (total_sales = total_cash + total_bank)
);
