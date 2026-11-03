-- =============================================================================
-- FUSION — PERMANENTLY delete all operational (business) data.
--
-- !! DESTRUCTIVE. NOT A MIGRATION. `supabase db push` never runs this file. !!
--
-- Used once (2026-11-03, approved by the owner) to clear the test data before
-- the club went live. Running it again deletes every table session, sale,
-- shift, expense, booking and customer — keep it only for resetting a test
-- database. It refuses to run unless the caller first sets:
--
--   set fusion.confirm_reset = 'DELETE-ALL-OPERATIONAL-DATA';
--
-- DELETES (all rows, physically — TRUNCATE, no soft delete or archive):
--   sessions, session_items, bookings, sales, sale_items, counter_shifts,
--   shift_daily_totals, expenses, daily_summaries, product_sales_daily,
--   customers, customer_visits, retention_runs (cleanup log)
-- RESETS:
--   receipt numbers (restart at 1); every product's stock and units sold to 0
-- KEEPS:
--   logins (auth.users, app_users: roles, permissions, floors), settings,
--   floors, categories and rates, tables, the product list and prices, every
--   function, RLS policy, grant, the realtime publication and the pg_cron job.
--
-- One transaction: if anything fails, nothing is deleted. TRUNCATE without
-- CASCADE lists every table explicitly, so a missed dependency stops the
-- reset instead of removing anything unexpected.
-- =============================================================================

begin;

do $$
begin
  if coalesce(current_setting('fusion.confirm_reset', true), '') <> 'DELETE-ALL-OPERATIONAL-DATA' then
    raise exception 'Refusing to reset: set fusion.confirm_reset = ''DELETE-ALL-OPERATIONAL-DATA'' first.';
  end if;
end;
$$;

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

update public.inventory_products set stock_quantity = 0, units_sold = 0, updated_at = now();

commit;
