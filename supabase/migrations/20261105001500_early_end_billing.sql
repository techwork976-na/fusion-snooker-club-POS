-- =============================================================================
-- FUSION 1500: a fixed-time or fixed-amount booking ended EARLY charges only
-- the time played.
--
-- Impact on existing data: none. No tables or columns change, nothing is
-- rewritten. Sessions already ended keep the charge they were ended with, so
-- every existing invoice, shift, day total and report stays exactly as it is.
-- The new rule applies to sessions ended after this migration.
--
-- Until now a booking always charged its booked price ("leaving early still
-- pays the booking"): PKR 1,000 prepaid and 10 seconds played charged
-- PKR 1,000. Now:
--   * Used in full — the booked time ran out ("time's up" holds the clock at
--     the booked time, its alarm and popup unchanged) — the booking's price,
--     plus any time played after staff chose Continue. Unchanged.
--   * Ended early — fewer billable seconds than booked (paused time never
--     counts) — the time played, priced by the table's EXISTING pricing
--     functions (nothing about them changes), and never more than the booking:
--       per minute     billed minutes × the session's rate (the billing
--                      policy's block, rounding and minimum, as for open play);
--       under-1-hour   fusion_tier_price of the billed minutes, exactly as open
--                      play on that table (under 60 minutes at the under-1-hour
--                      rate, from 60 minutes at the hourly rate: with 800/600
--                      per hour, 30 min = 400, 45 min = 600, 1 h = 600,
--                      1 h 15 min = 750, 2 h 20 min = 1,400);
--       hourly + 30    fusion_slot_price of the billed minutes (exactly 30
--                      minutes = the 30-minute price, otherwise the hourly
--                      rate pro rata).
--     A custom checkout rate re-prices the same way (fusion_charge_at_rate
--     calls fusion_session_charge).
-- Mirrored by sessionCharge in src/shared/billing.ts (the
-- live timer and checkout preview); tests/db/billing-parity.test.ts keeps the
-- two identical.
-- =============================================================================

-- 1. Per-minute (and custom-rate) charge ---------------------------------------------------
create or replace function public.fusion_session_charge(
  p_billable_seconds integer, p_rate numeric, p_booked_seconds integer, p_booked_amount numeric,
  p_increment integer, p_rounding text, p_minimum integer)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p_booked_seconds is not null then
    -- 1500: ended before the booking was used up: the time played, never more than the booking.
    if p_billable_seconds < p_booked_seconds then
      return least(p_booked_amount, public.fusion_amount_for_minutes(
        public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_rate));
    end if;
    return p_booked_amount + case
      when p_billable_seconds > p_booked_seconds then public.fusion_amount_for_minutes(
        public.fusion_billed_minutes(p_billable_seconds - p_booked_seconds, p_increment, p_rounding, 0), p_rate)
      else 0 end;
  end if;
  return public.fusion_amount_for_minutes(
    public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_rate);
end;
$$;

-- 2. Under-1-hour (tiered) charge ----------------------------------------------------------
create or replace function public.fusion_tiered_charge(
  p_billable_seconds integer, p_hourly numeric, p_under_hour numeric, p_booked_seconds integer, p_booked_amount numeric,
  p_increment integer, p_rounding text, p_minimum integer)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_booked_seconds is null
              then public.fusion_tier_price(
                     public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_hourly, p_under_hour)
              -- 1500: ended early: the tier price of the time played, never more than the booking.
              when p_billable_seconds < p_booked_seconds
              then least(p_booked_amount, public.fusion_tier_price(
                     public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_hourly, p_under_hour))
              else greatest(p_booked_amount, public.fusion_tier_price(
                     public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, 0), p_hourly, p_under_hour)) end;
$$;

-- 3. Hourly + special 30-minute charge -----------------------------------------------------
-- These sessions are always booked; ended early they pay the minutes played
-- at the category's existing prices (fusion_slot_price, unchanged), never more
-- than the booking; otherwise the booked price as before.
create function public.fusion_slot_charge(
  p_billable_seconds integer, p_hourly numeric, p_special_30 numeric, p_rate numeric,
  p_booked_seconds integer, p_booked_amount numeric, p_increment integer, p_rounding text, p_minimum integer)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_booked_seconds is not null and p_billable_seconds < p_booked_seconds
              then least(p_booked_amount, public.fusion_slot_price(
                     public.fusion_billed_minutes(p_billable_seconds, p_increment, p_rounding, p_minimum), p_hourly, p_special_30))
              else public.fusion_session_charge(p_billable_seconds, p_rate, p_booked_seconds, p_booked_amount,
                                                p_increment, p_rounding, p_minimum) end;
$$;

-- 4. Ending and cancelling (unchanged apart from the lines marked "1500") -----------------------
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
      base_amount = case pricing_mode
        -- 1300: the whole time at the under-1-hour rate below 60 billed minutes, else the hourly rate.
        when 'tiered_hourly' then public.fusion_tiered_charge(
          v_billable, hourly_rate, under_hour_rate, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
        -- 1500: ended early, an hourly + 30-minute table pays the minutes played.
        when 'hourly_special30' then public.fusion_slot_charge(
          v_billable, hourly_rate, special_30_rate, rate_per_minute, booked_seconds, booked_amount,
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
        base_amount = case pricing_mode
          -- 1300: the whole time at the under-1-hour rate below 60 billed minutes, else the hourly rate.
          when 'tiered_hourly' then public.fusion_tiered_charge(
            v_billable, hourly_rate, under_hour_rate, booked_seconds, booked_amount,
            v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
          -- 1500: as end_session.
          when 'hourly_special30' then public.fusion_slot_charge(
            v_billable, hourly_rate, special_30_rate, rate_per_minute, booked_seconds, booked_amount,
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

-- 5. Grants -----------------------------------------------------------------------------------
-- Pure billing helpers stay inside the database (as fusion_session_charge since 1400).
revoke all on function
  public.fusion_slot_charge(integer, numeric, numeric, numeric, integer, numeric, integer, text, integer)
  from public, anon, authenticated;
