-- =============================================================================
-- FUSION 1900: product images.
--
-- Impact on existing data: none. One nullable column is added to
-- inventory_products (NULL for every existing product, which keeps showing as
-- plain text everywhere); no rows are rewritten. The images are files in
-- Supabase Storage, not in the database.
--
--   * Storage bucket "product-images" (public: images are served by URL).
--     Each image is `<product id>/<random>.webp` (or .png), at most 640 px on
--     its longest side — the app resizes it with high-quality smoothing before
--     uploading, keeping transparency — so it stays crisp at every size the
--     app shows. The bucket refuses anything over 2 MB or not an image.
--   * Only administrators may add, replace or delete product images (they
--     manage products); everyone signed in sees them.
--   * admin_set_product_image(p_product_id, p_path) sets (or, with NULL,
--     clears) a product's image — only a path in that product's folder.
--   * get_product_images() lists the products that have an image (id, name,
--     path) for every signed-in account: staff read products through
--     search_products and the tables overview, not the table itself.
-- =============================================================================

-- 1. Which image is each product's ----------------------------------------------------------------
alter table public.inventory_products
  add column image_path text
    constraint inventory_products_image_path check (
      image_path is null
      or image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(webp|png|jpg|jpeg)$');

comment on column public.inventory_products.image_path is
  'Product image in the storage bucket "product-images" (<product id>/<file>); NULL shows the name only.';

-- 2. The bucket ------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 3. Administrators manage the files ----------------------------------------------------------------------
create policy "fusion product images: admins read" on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and (select public.fusion_is_admin()));

create policy "fusion product images: admins upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.fusion_is_admin()));

create policy "fusion product images: admins replace" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and (select public.fusion_is_admin()))
  with check (bucket_id = 'product-images' and (select public.fusion_is_admin()));

create policy "fusion product images: admins delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (select public.fusion_is_admin()));

-- 4. Setting a product's image -----------------------------------------------------------------------------
create function public.admin_set_product_image(p_product_id uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_product public.inventory_products;
begin
  perform public.fusion_require_admin();
  if p_path is not null and (split_part(p_path, '/', 1) <> p_product_id::text
       or p_path !~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}\.(webp|png|jpg|jpeg)$') then
    raise exception 'That image does not belong to this product.' using errcode = '22023', hint = 'invalid_input';
  end if;
  update public.inventory_products set image_path = p_path, updated_at = now()
  where id = p_product_id returning * into v_product;
  if not found then
    raise exception 'Product not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  return to_jsonb(v_product);
end;
$$;

-- 5. Which products have an image (any signed-in account) -------------------------------------------------
create function public.get_product_images()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_user();
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'image_path', p.image_path) order by p.name)
                   from public.inventory_products p where p.image_path is not null), '[]'::jsonb);
end;
$$;

-- 6. Grants ------------------------------------------------------------------------------------------------
revoke all on function public.admin_set_product_image(uuid, text), public.get_product_images() from public, anon, authenticated;
-- Administration (calls fusion_require_admin()).
grant execute on function public.admin_set_product_image(uuid, text) to authenticated;
-- Any signed-in account (calls fusion_require_user()).
grant execute on function public.get_product_images() to authenticated;
