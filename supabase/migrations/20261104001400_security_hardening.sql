-- =============================================================================
-- FUSION 1400: security hardening (from the security audit).
--
-- Impact on existing data: none. One small append-only table is added (the
-- stock log); nothing is deleted, rewritten or backfilled.
--
-- 1. Stock log. Every manual stock change (Restock / Correct, and a new
--    product's opening stock) is recorded with who made it, by how much and
--    the stock afterwards, inside the same transaction as the change. Nobody
--    can write the log directly (no table privileges for the API roles); only
--    adjust_stock / admin_save_product add to it, and administrators read it
--    through get_stock_adjustments. Sales, voids and cancelled tabs already
--    record their stock movements in sales / sale_items / sessions.
-- 2. Switch portal: staff only see the admin accounts they can switch to (they
--    no longer receive every staff member's username).
-- 3. Least privilege: three pure billing-math helpers are no longer callable
--    from the API (they are used only inside the database's own functions).
-- 4. Secure by default: new tables, sequences and functions created in
--    `public` by future migrations are no longer granted to the API roles
--    automatically (Supabase's default); each migration grants what it needs,
--    as every FUSION migration already does.
-- =============================================================================

-- 1. Stock log ------------------------------------------------------------------------------
create table public.stock_adjustments (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references public.inventory_products (id) on delete cascade,
  delta       integer not null check (delta <> 0),
  stock_after integer not null check (stock_after >= 0),
  source      text not null check (source in ('opening', 'adjust')),
  user_id     uuid references public.app_users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index stock_adjustments_product_idx on public.stock_adjustments (product_id, created_at desc);
alter table public.stock_adjustments enable row level security;
revoke all on table public.stock_adjustments from public, anon, authenticated;

comment on table public.stock_adjustments is
  'Append-only log of manual stock changes (opening stock, restock and corrections). Written only by adjust_stock and admin_save_product.';

create or replace function public.adjust_stock(p_product_id uuid, p_delta integer)
returns table (id uuid, name text, stock_quantity integer) language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
  v_me public.app_users;
begin
  v_me := public.fusion_require_perm('adjust_stock', 'adjust stock');
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
  -- 1400: every manual stock change is logged, in the same transaction.
  insert into public.stock_adjustments (product_id, delta, stock_after, source, user_id)
  values (v_product.id, p_delta, v_product.stock_quantity, 'adjust', v_me.id);
  return query select v_product.id, v_product.name, v_product.stock_quantity;
end;
$$;

create or replace function public.admin_save_product(
  p_id uuid, p_name text, p_category text, p_cost_price numeric, p_selling_price numeric,
  p_track_stock boolean, p_low_stock_threshold integer, p_initial_stock integer default 0)
returns public.inventory_products language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
  v_me public.app_users;
begin
  v_me := public.fusion_require_admin();
  if p_cost_price is null or p_selling_price is null
     or p_cost_price <> round(p_cost_price, 2) or p_selling_price <> round(p_selling_price, 2) then
    raise exception 'Enter valid prices.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.inventory_products (name, category, cost_price, selling_price, track_stock,
                                           stock_quantity, low_stock_threshold)
    values (btrim(p_name), btrim(coalesce(p_category, '')), p_cost_price, p_selling_price, coalesce(p_track_stock, true),
            case when coalesce(p_track_stock, true) then coalesce(p_initial_stock, 0) else 0 end,
            coalesce(p_low_stock_threshold, 5))
    returning * into v_product;
    -- 1400: opening stock is the first entry of the product's stock log.
    if v_product.stock_quantity > 0 then
      insert into public.stock_adjustments (product_id, delta, stock_after, source, user_id)
      values (v_product.id, v_product.stock_quantity, v_product.stock_quantity, 'opening', v_me.id);
    end if;
  else
    -- Stock is only changed through adjust_stock (delta based), never
    -- overwritten here, so a concurrent sale can't be lost.
    update public.inventory_products
    set name = btrim(p_name), category = btrim(coalesce(p_category, '')), cost_price = p_cost_price,
        selling_price = p_selling_price, track_stock = coalesce(p_track_stock, track_stock),
        low_stock_threshold = coalesce(p_low_stock_threshold, low_stock_threshold), updated_at = now()
    where id = p_id returning * into v_product;
    if not found then
      raise exception 'Product not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_product;
exception
  when unique_violation then
    raise exception 'A product named "%" already exists.', btrim(p_name) using errcode = '23505', hint = 'duplicate_name';
  when check_violation or not_null_violation then
    raise exception 'Product needs a name, non-negative prices and stock.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

-- Administrators: a product's recent stock changes, newest first.
create or replace function public.get_stock_adjustments(p_product_id uuid, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'delta', a.delta, 'stock_after', a.stock_after, 'source', a.source,
             'user_name', u.full_name, 'created_at', a.created_at) order by a.created_at desc, a.id desc)
    from (select * from public.stock_adjustments s where s.product_id = p_product_id
          order by s.created_at desc, s.id desc limit least(greatest(coalesce(p_limit, 20), 1), 200)) a
    left join public.app_users u on u.id = a.user_id), '[]'::jsonb);
end;
$$;

-- 2. Switch portal targets --------------------------------------------------------------------
create or replace function public.list_switch_targets()
returns table (id uuid, username text, full_name text, role text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users;
begin
  v_me := public.fusion_require_user();
  -- 1400: staff only ever switch to the Admin portal, so they see admin accounts only;
  -- administrators pick any staff member.
  return query
    select u.id, u.username, u.full_name, u.role from public.app_users u
    where u.is_active and (v_me.role = 'admin' or u.role = 'admin') order by u.role, u.full_name;
end;
$$;

-- 3. Pure billing helpers stay inside the database --------------------------------------------
revoke execute on function
  public.fusion_amount_for_minutes(integer, numeric),
  public.fusion_billed_minutes(integer, integer, text, integer),
  public.fusion_session_charge(integer, numeric, integer, numeric, integer, text, integer)
  from public, anon, authenticated;

-- 4. Secure by default for future objects -------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;

-- Grants ----------------------------------------------------------------------------------------
revoke all on function public.get_stock_adjustments(uuid, integer) from public, anon, authenticated;
grant execute on function public.get_stock_adjustments(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
