-- =============================================================================
-- FUSION 1600: sales of one business day, hour by hour, for the History and
-- Reports charts when a single day is chosen (Today, Yesterday, one custom day).
--
-- Impact on existing data: none — one read-only function, no table changes.
--
-- The permanent ledger (shift_daily_totals) is kept per day, so the hour of a
-- sale comes from its invoice (sales.created_at in the club's time zone).
-- Voided invoices are deleted (and reversed on the ledger), so the retained
-- invoices of a day add up to the ledger's total for that day — until the
-- retention job removes old invoices. The result therefore says how much of
-- the day it covers, and the screens compare it with the day's permanent total
-- before drawing it (never presenting partial detail as the whole day).
-- p_closed_only = true counts only counters that are already closed (Reports'
-- final figures); false counts every counter (History).
-- =============================================================================

create function public.get_sales_by_hour(p_date date, p_closed_only boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_start integer;
  v_hours jsonb;
begin
  perform public.fusion_require_admin();
  if p_date is null then
    raise exception 'Choose a day.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select st.business_timezone, st.day_start_hour into v_tz, v_start from public.settings st where st.id = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'hour', h.hour, 'cash', h.cash, 'bank', h.bank, 'total', h.cash + h.bank, 'invoices', h.invoices)
           order by (h.hour - v_start + 24) % 24), '[]'::jsonb)
    into v_hours
  from (select extract(hour from (s.created_at at time zone v_tz))::integer as hour,
               sum(public.fusion_cash_part(s)) as cash, sum(public.fusion_bank_part(s)) as bank, count(*) as invoices
        from public.sales s
        left join public.counter_shifts c on c.id = s.shift_id
        where s.business_date = p_date and (not coalesce(p_closed_only, false) or c.status = 'closed')
        group by 1) h;

  return jsonb_build_object(
    'date', p_date, 'closed_only', coalesce(p_closed_only, false), 'hours', v_hours,
    'day_start_hour', v_start, 'timezone', v_tz,
    'covered_total', coalesce((select sum((x ->> 'total')::numeric) from jsonb_array_elements(v_hours) x), 0),
    'retention_days', (select st.sales_retention_days from public.settings st where st.id = 1));
end;
$$;

revoke all on function public.get_sales_by_hour(date, boolean) from public, anon, authenticated;
-- Administrators only (the function calls fusion_require_admin()).
grant execute on function public.get_sales_by_hour(date, boolean) to authenticated;
