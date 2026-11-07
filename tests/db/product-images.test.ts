/**
 * Product images (migration 1900): files in the Storage bucket
 * "product-images", one folder per product. Administrators manage them;
 * everyone signed in sees which products have one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'adjust_stock'] })
})
afterEach(async () => db.close())

const upload = (user: TestUser, name: string) =>
  db.as(user.id, () => db.pg.query(`insert into storage.objects (bucket_id, name) values ('product-images', $1) returning name`, [name]).then((r) => r.rows))
const setImage = (user: TestUser, productId: string, path: string | null) =>
  db.rpc<{ id: string; image_path: string | null }>(user.id, 'admin_set_product_image', { p_product_id: productId, p_path: path })
const file = (productId: string) => `${productId}/7c1d2b9e-4a5f-4c3b-9e8d-1f2a3b4c5d6e.webp`

describe('the product-images bucket', () => {
  it('is public (images load by URL), up to 2 MB and images only', async () => {
    expect(await db.one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images'`)).toEqual({
      public: true,
      file_size_limit: 2097152,
      allowed_mime_types: ['image/webp', 'image/png', 'image/jpeg']
    })
  })

  it('only administrators upload or delete product images', async () => {
    expect(await upload(admin, file(club.products.cola))).toEqual([{ name: file(club.products.cola) }])
    await expect(upload(staff, file(club.products.chips))).rejects.toThrow(/row-level security/)
    expect(
      await db.as(staff.id, () =>
        db.pg.query(`delete from storage.objects where bucket_id = 'product-images' and name = $1 returning name`, [file(club.products.cola)]).then((r) => r.rows)
      )
    ).toEqual([])
    expect(await db.sql(`select name from storage.objects where bucket_id = 'product-images'`)).toEqual([{ name: file(club.products.cola) }])
  })

  it('leaves the profile pictures bucket to its own rules', async () => {
    // An admin uploading to "avatars" is still limited to their own folder.
    await expect(
      db.as(admin.id, () => db.pg.query(`insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${staff.id}/x.jpg`]))
    ).rejects.toThrow(/row-level security/)
  })
})

describe('admin_set_product_image', () => {
  it('sets and clears an image in the product’s own folder', async () => {
    expect(await setImage(admin, club.products.cola, file(club.products.cola))).toMatchObject({ id: club.products.cola, image_path: file(club.products.cola) })
    expect(await setImage(admin, club.products.cola, null)).toMatchObject({ image_path: null })
  })

  it('refuses another product’s folder, odd file names, unknown products and staff', async () => {
    for (const p of [file(club.products.chips), `${club.products.cola}/../x.webp`, `${club.products.cola}/x.gif`, 'x.webp']) {
      expect((await rejects(setImage(admin, club.products.cola, p))).hint, p).toBe('invalid_input')
    }
    const unknown = '00000000-0000-4000-8000-000000000000'
    expect((await rejects(setImage(admin, unknown, file(unknown)))).hint).toBe('not_found')
    expect((await rejects(setImage(staff, club.products.cola, file(club.products.cola)))).hint).toBe('forbidden')
  })
})

describe('get_product_images', () => {
  it('lists only the products with an image, for staff as well as admins', async () => {
    expect(await db.rpc(staff.id, 'get_product_images')).toEqual([])
    await setImage(admin, club.products.cola, file(club.products.cola))
    const expected = [{ id: club.products.cola, name: 'Cola', image_path: file(club.products.cola) }]
    expect(await db.rpc(staff.id, 'get_product_images')).toEqual(expected)
    expect(await db.rpc(admin.id, 'get_product_images')).toEqual(expected)
    expect((await rejects(db.rpc(null, 'get_product_images'))).message).toMatch(/permission denied/)
  })
})
