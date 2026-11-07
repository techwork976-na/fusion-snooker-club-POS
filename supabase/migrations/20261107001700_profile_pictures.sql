-- =============================================================================
-- FUSION 1700: profile pictures for every account (admin or staff).
--
-- Impact on existing data: none. One nullable column is added to app_users
-- (NULL for every existing account, which keeps showing its initials); no rows
-- are rewritten. The pictures themselves are files in Supabase Storage, not in
-- the database.
--
--   * Storage bucket "avatars" (public: pictures are served by URL to <img>).
--     Each picture is `<user id>/<random>.jpg`, about 10–20 KB (the app crops
--     and shrinks it before uploading); the bucket refuses anything over
--     512 KB or not an image.
--   * Storage policies: a signed-in, active account may add, replace or delete
--     files only in its own folder (`<its user id>/…`).
--   * set_my_avatar(p_path) records the account's current picture (or NULL to
--     go back to initials) — only a path inside its own folder.
--   * get_my_profile() now returns avatar_path.
-- =============================================================================

-- 1. Which picture is each account's ------------------------------------------------------------
alter table public.app_users
  add column avatar_path text
    constraint app_users_avatar_path check (
      avatar_path is null
      or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$');

comment on column public.app_users.avatar_path is
  'Profile picture in the storage bucket "avatars" (<user id>/<file>); NULL shows the initials.';

-- 2. The bucket ------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 3. Each account writes only its own folder ---------------------------------------------------------
create policy "fusion avatars: read own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "fusion avatars: upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.fusion_is_active_user());

create policy "fusion avatars: replace in own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.fusion_is_active_user());

create policy "fusion avatars: delete from own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 4. Setting the picture ---------------------------------------------------------------------------
create function public.set_my_avatar(p_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
begin
  if p_path is not null and (split_part(p_path, '/', 1) <> v_me.id::text
       or p_path !~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$') then
    raise exception 'That picture does not belong to your account.' using errcode = '42501', hint = 'forbidden';
  end if;
  update public.app_users set avatar_path = p_path where id = v_me.id;
  return public.get_my_profile();
end;
$$;

-- (get_my_profile is unchanged apart from the line marked "1700".)
create or replace function public.get_my_profile()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
begin
  return jsonb_build_object(
    'id', v_me.id, 'username', v_me.username, 'full_name', v_me.full_name, 'role', v_me.role,
    'floor_id', v_me.floor_id,
    'floor_name', (select f.name from public.floors f where f.id = v_me.floor_id),
    'permissions', to_jsonb(v_me.permissions),
    -- 1700
    'avatar_path', v_me.avatar_path);
end;
$$;

-- 5. Grants ------------------------------------------------------------------------------------------
revoke all on function public.set_my_avatar(text) from public, anon, authenticated;
-- Any signed-in account, for itself only (the function checks the folder).
grant execute on function public.set_my_avatar(text) to authenticated;
