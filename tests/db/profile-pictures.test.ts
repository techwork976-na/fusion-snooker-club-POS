/**
 * Profile pictures (migration 1700): files in the Storage bucket "avatars",
 * one folder per account. Storage policies let a signed-in, active account
 * write only its own folder; set_my_avatar records only a path in it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let admin: TestUser
let ali: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  const club = await seedClub(db)
  admin = await db.createUser('admin')
  ali = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

/** A storage call as the signed-in account (Supabase Storage runs it with that account's JWT). */
const asUser = (user: TestUser, sql: string, params: unknown[] = []) => db.as(user.id, () => db.pg.query(sql, params).then((r) => r.rows))
const upload = (user: TestUser, name: string) => asUser(user, `insert into storage.objects (bucket_id, name) values ('avatars', $1) returning name`, [name])

describe('the avatars bucket', () => {
  it('is public (pictures load by URL), small and images only', async () => {
    expect(await db.one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'`)).toEqual({
      public: true,
      file_size_limit: 524288,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
    })
  })

  it('lets an account upload, replace and delete only in its own folder', async () => {
    expect(await upload(ali, `${ali.id}/a.jpg`)).toEqual([{ name: `${ali.id}/a.jpg` }])
    await expect(upload(ali, `${admin.id}/a.jpg`)).rejects.toThrow(/row-level security/)
    await expect(upload(ali, 'a.jpg')).rejects.toThrow(/row-level security/) // not in any folder

    await upload(admin, `${admin.id}/b.jpg`)
    expect(await asUser(ali, `delete from storage.objects where bucket_id = 'avatars' and name = $1 returning name`, [`${admin.id}/b.jpg`])).toEqual([])
    expect(await asUser(ali, `update storage.objects set name = name where bucket_id = 'avatars' and name = $1 returning name`, [`${admin.id}/b.jpg`])).toEqual([])
    expect(await asUser(ali, `delete from storage.objects where bucket_id = 'avatars' and name = $1 returning name`, [`${ali.id}/a.jpg`])).toEqual([
      { name: `${ali.id}/a.jpg` }
    ])
    expect(await db.sql(`select name from storage.objects order by name`)).toEqual([{ name: `${admin.id}/b.jpg` }])
  })

  it('refuses uploads from a deactivated account and from anyone signed out', async () => {
    await db.sql(`update public.app_users set is_active = false where id = $1`, [ali.id])
    await expect(upload(ali, `${ali.id}/a.jpg`)).rejects.toThrow(/row-level security/)
    await expect(db.as(null, () => db.pg.query(`insert into storage.objects (bucket_id, name) values ('avatars', 'x/a.jpg')`))).rejects.toThrow()
  })
})

describe('set_my_avatar', () => {
  it('records a picture in the account’s own folder; the profile returns it; null goes back to initials', async () => {
    const path = `${ali.id}/3f1c2a7e-0b9d-4c55-8f0e-2d6a1b9c7e44.jpg`
    expect(await db.rpc(ali.id, 'set_my_avatar', { p_path: path })).toMatchObject({ id: ali.id, avatar_path: path })
    expect(await db.rpc(ali.id, 'get_my_profile')).toMatchObject({ avatar_path: path })
    expect(await db.rpc(ali.id, 'set_my_avatar', { p_path: null })).toMatchObject({ avatar_path: null })
  })

  it('refuses a path in another account’s folder or an unexpected file name', async () => {
    for (const p of [`${admin.id}/x.jpg`, `${ali.id}/../x.jpg`, `${ali.id}/x.exe`, 'x.jpg', `${ali.id}/sub/x.jpg`]) {
      expect((await rejects(db.rpc(ali.id, 'set_my_avatar', { p_path: p }))).hint, p).toBe('forbidden')
    }
    expect(await db.one<{ avatar_path: string | null }>(`select avatar_path from public.app_users where id = $1`, [ali.id])).toEqual({ avatar_path: null })
  })

  it('is for signed-in accounts only', async () => {
    expect((await rejects(db.rpc(null, 'set_my_avatar', { p_path: null }))).message).toMatch(/permission denied/)
  })
})
