-- =============================================================================
-- FUSION — authorization helpers, billing rules and Row Level Security
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so RLS policies can call them
-- without recursing into app_users' own policies).
-- ---------------------------------------------------------------------------

create or replace function public.fusion_is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.id = auth.uid() and u.is_active);
$$;

create or replace function public.fusion_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.id = auth.uid() and u.is_active and u.role = 'admin');
$$;

create or replace function public.fusion_has_perm(p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_users u
    where u.id = auth.uid() and u.is_active and (u.role = 'admin' or p_perm = any (u.permissions)));
$$;

-- Admins see every floor; staff with no assigned floor see every floor; other
-- staff only their own floor. A NULL floor (e.g. a counter sale made by an
-- all-floors user) is only visible to admins and all-floors staff.
create or replace function public.fusion_can_access_floor(p_floor smallint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_users u
    where u.id = auth.uid() and u.is_active
      and (u.role = 'admin' or u.floor_id is null or u.floor_id = p_floor));
$$;

create or replace function public.fusion_can_access_table(p_table_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.club_tables t
    where t.id = p_table_id and public.fusion_can_access_floor(t.floor_id));
$$;

create or replace function public.fusion_require_user()
returns public.app_users language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users;
begin
  select u.* into v_me from public.app_users u where u.id = auth.uid() and u.is_active;
  if not found then
    raise exception 'You are not signed in, or your account has been deactivated.'
      using errcode = '42501', hint = 'not_authenticated';
  end if;
  return v_me;
end;
$$;

create or replace function public.fusion_require_admin()
returns public.app_users language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
begin
  if v_me.role <> 'admin' then
    raise exception 'Only an administrator can do this.' using errcode = '42501', hint = 'forbidden';
  end if;
  return v_me;
end;
$$;

create or replace function public.fusion_require_perm(p_perm text, p_action text)
returns public.app_users language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
begin
  if v_me.role <> 'admin' and not (p_perm = any (v_me.permissions)) then
    raise exception 'You do not have permission to %.', p_action using errcode = '42501', hint = 'forbidden';
  end if;
  return v_me;
end;
$$;

create or replace function public.fusion_assert_floor(p_floor smallint)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.fusion_can_access_floor(p_floor) then
    raise exception 'This table is not on your assigned floor.' using errcode = '42501', hint = 'wrong_floor';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Billing rules. These are pure functions mirrored exactly by
-- src/shared/billing.ts (a parity test compares both implementations).
--
--   billed minutes = increments of `p_increment` minutes, rounded up / to the
--                    nearest (half up) / down, then raised to the minimum.
--   amount         = billed minutes x hourly rate / 60, rounded half-up to a
--                    whole rupee.
--   booked session = booked amount + overtime (overtime has no minimum).
-- ---------------------------------------------------------------------------

create or replace function public.fusion_billed_minutes(
  p_seconds integer, p_increment integer, p_rounding text, p_minimum integer)
returns integer language plpgsql immutable set search_path = '' as $$
declare
  v_unit integer := p_increment * 60;
  v_units integer;
begin
  if p_increment is null or p_increment < 1 then
    raise exception 'Billing increment must be at least one minute.';
  end if;
  if p_seconds is null or p_seconds <= 0 then
    return 0;
  end if;
  v_units := case p_rounding
    when 'up' then (p_seconds + v_unit - 1) / v_unit
    when 'down' then p_seconds / v_unit
    when 'nearest' then (2 * p_seconds + v_unit) / (2 * v_unit)
  end;
  if v_units is null then
    raise exception 'Unknown billing rounding mode: %', p_rounding;
  end if;
  return greatest(v_units * p_increment, coalesce(p_minimum, 0));
end;
$$;

create or replace function public.fusion_amount_for_minutes(p_minutes integer, p_rate numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(p_minutes::numeric * p_rate / 60, 0);
$$;

create or replace function public.fusion_session_charge(
  p_billable_seconds integer, p_rate numeric, p_booked_seconds integer, p_booked_amount numeric,
  p_increment integer, p_rounding text, p_minimum integer)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p_booked_seconds is not null then
    return p_booked_amount + case
      when p_billable_seconds > p_booked_seconds then public.fusion_amount_for_minutes(
        public.fusion_billed_minutes(p_billable_seconds - p_booked_seconds, p_increment, p_rounding, 0), p_rate)
      else 0 end;
  end if;
  return public.fusion_amount_for_minutes(
    public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_rate);
end;
$$;

create or replace function public.fusion_ms_between(p_from timestamptz, p_to timestamptz)
returns bigint language sql immutable set search_path = '' as $$
  select greatest(0, floor(extract(epoch from (p_to - p_from)) * 1000))::bigint;
$$;

-- Business date of an instant: local date in the club timezone, shifted back
-- by the configured day-start hour (so 01:30 counts toward the previous day
-- when the business day starts at 06:00).
create or replace function public.fusion_business_date(p_at timestamptz)
returns date language sql stable security definer set search_path = '' as $$
  select ((p_at at time zone s.business_timezone) - make_interval(hours => s.day_start_hour))::date
  from public.settings s where s.id = 1;
$$;

create or replace function public.get_current_business_date()
returns date language sql stable security definer set search_path = '' as $$
  select public.fusion_business_date(now());
$$;

create or replace function public.get_server_time()
returns timestamptz language sql stable set search_path = '' as $$
  select now();
$$;

-- Pakistani mobile numbers are stored in local form (03xxxxxxxxx) so "+92 300…",
-- "0092300…" and "0300-…" all resolve to the same customer.
create or replace function public.fusion_normalize_phone(p_phone text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
begin
  if v = '' then
    return null;
  end if;
  v := case when left(v, 1) = '+' then '+' || replace(substr(v, 2), '+', '') else replace(v, '+', '') end;
  if v like '+92%' then
    v := '0' || substr(v, 4);
  elsif v like '0092%' then
    v := '0' || substr(v, 5);
  elsif v like '92%' and char_length(v) = 12 then
    v := '0' || substr(v, 3);
  end if;
  if v !~ '^\+?[0-9]{7,15}$' then
    raise exception 'Phone number "%" is not valid.', p_phone using errcode = '22023', hint = 'invalid_phone';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security. Clients can only SELECT; every write goes through the
-- validated SECURITY DEFINER functions defined in later migrations.
-- ---------------------------------------------------------------------------

alter table public.floors             enable row level security;
alter table public.app_users          enable row level security;
alter table public.settings           enable row level security;
alter table public.table_categories   enable row level security;
alter table public.club_tables        enable row level security;
alter table public.customers          enable row level security;
alter table public.inventory_products enable row level security;
alter table public.sessions           enable row level security;
alter table public.session_items      enable row level security;
alter table public.sales              enable row level security;
alter table public.sale_items         enable row level security;
alter table public.daily_summaries    enable row level security;

create policy floors_read on public.floors
  for select to authenticated using ((select public.fusion_is_active_user()));

create policy settings_read on public.settings
  for select to authenticated using ((select public.fusion_is_active_user()));

create policy table_categories_read on public.table_categories
  for select to authenticated using ((select public.fusion_is_active_user()));

create policy app_users_read on public.app_users
  for select to authenticated using (id = (select auth.uid()) or (select public.fusion_is_admin()));

create policy club_tables_read on public.club_tables
  for select to authenticated using (public.fusion_can_access_floor(floor_id));

create policy customers_read on public.customers
  for select to authenticated using ((select public.fusion_is_active_user()));

-- Cost prices are confidential: staff never read this table directly; they use
-- search_products(), which returns only sale-facing columns.
create policy inventory_products_read on public.inventory_products
  for select to authenticated using ((select public.fusion_is_admin()));

create policy sessions_read on public.sessions
  for select to authenticated using (public.fusion_can_access_table(table_id));

create policy session_items_read on public.session_items
  for select to authenticated using (
    exists (select 1 from public.sessions s where s.id = session_id and public.fusion_can_access_table(s.table_id)));

create policy sales_read on public.sales
  for select to authenticated using (
    (select public.fusion_is_admin())
    or (cashier_id = (select auth.uid()) and (select public.fusion_has_perm('view_own_sales')))
    or ((select public.fusion_has_perm('delete_sales')) and public.fusion_can_access_floor(floor_id)));

create policy sale_items_read on public.sale_items
  for select to authenticated using (exists (select 1 from public.sales s where s.id = sale_id));

create policy daily_summaries_read on public.daily_summaries
  for select to authenticated using ((select public.fusion_is_admin()));
