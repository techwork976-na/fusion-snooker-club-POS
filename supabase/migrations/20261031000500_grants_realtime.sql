-- =============================================================================
-- FUSION — least-privilege grants and realtime
-- Clients (the `authenticated` role) may only SELECT through RLS and EXECUTE
-- the allow-listed functions below. `anon` gets nothing. Internal helpers that
-- trust their caller (fusion_receipt_json, fusion_resolve_customer, …) are not
-- callable from the API at all.
-- When adding functions in later migrations, grant EXECUTE explicitly.
-- =============================================================================

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on public.floors, public.app_users, public.settings, public.table_categories, public.club_tables,
               public.customers, public.inventory_products, public.sessions, public.session_items,
               public.sales, public.sale_items, public.daily_summaries
  to authenticated;

-- Used inside RLS policies (evaluated with the caller's privileges).
grant execute on function
  public.fusion_is_active_user(),
  public.fusion_is_admin(),
  public.fusion_has_perm(text),
  public.fusion_can_access_floor(smallint),
  public.fusion_can_access_table(uuid)
  to authenticated;

-- Pure helpers and read-only utilities.
grant execute on function
  public.fusion_billed_minutes(integer, integer, text, integer),
  public.fusion_amount_for_minutes(integer, numeric),
  public.fusion_session_charge(integer, numeric, integer, numeric, integer, text, integer),
  public.get_server_time(),
  public.get_current_business_date()
  to authenticated;

-- Floor operations (each function performs its own permission checks).
grant execute on function
  public.get_my_profile(),
  public.list_switch_targets(),
  public.get_tables_overview(),
  public.start_session(uuid, text, integer, numeric, uuid, text, text),
  public.pause_session(uuid),
  public.resume_session(uuid),
  public.end_session(uuid),
  public.reopen_session(uuid),
  public.cancel_session(uuid),
  public.add_session_item(uuid, uuid, integer),
  public.set_session_item_quantity(uuid, integer),
  public.search_products(text, integer),
  public.adjust_stock(uuid, integer),
  public.search_customers(text, integer),
  public.save_customer(uuid, text, text),
  public.complete_checkout(uuid, text, uuid, jsonb, numeric, uuid, text, text),
  public.get_receipt(uuid),
  public.delete_sale(uuid),
  public.get_dashboard()
  to authenticated;

-- Administration (each function calls fusion_require_admin()).
grant execute on function
  public.admin_create_user_profile(uuid, text, text, text, smallint, text[]),
  public.admin_update_user(uuid, text, text, smallint, text[]),
  public.admin_set_user_active(uuid, boolean),
  public.admin_update_settings(jsonb),
  public.admin_save_floor(smallint, text, integer),
  public.admin_delete_floor(smallint),
  public.admin_save_category(smallint, text, numeric, integer, boolean),
  public.admin_save_table(uuid, text, smallint, smallint, numeric, integer),
  public.admin_set_table_active(uuid, boolean),
  public.admin_save_product(uuid, text, text, numeric, numeric, boolean, integer, integer),
  public.admin_set_product_active(uuid, boolean),
  public.get_sales_report(date, date, uuid),
  public.list_open_business_dates(),
  public.close_business_day(date)
  to authenticated;

-- Live updates between terminals. Realtime honours the SELECT policies above.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.club_tables, public.sessions, public.session_items, public.sales;
  end if;
end;
$$;
