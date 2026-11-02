import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Receipt = {
  sale_id: string
  receipt_no: number
  base_amount: number
  products_subtotal: number
  discount: number
  final_amount: number
  payment_method: string
  customer_name: string | null
  customer_phone: string | null
  items: { name: string; unit_price: number; quantity: number; line_total: number }[]
  session: { billable_seconds: number } | null
}

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser
let cashier: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: club.floors.ground })
  cashier = await db.createUser('staff', {
    floorId: club.floors.ground,
    permissions: ['apply_discount', 'counter_sale', 'delete_sales', 'view_own_sales']
  })
  // Payments belong to the staff member's open counter.
  await db.openCounter(staff.id)
  await db.openCounter(cashier.id)
})
afterEach(async () => db.close())

async function stock(productId: string) {
  const [p] = await db.sql<{ stock_quantity: number; units_sold: number }>(
    `select stock_quantity, units_sold from public.inventory_products where id = $1`,
    [productId]
  )
  return p!
}

/** Starts a session on Snooker 1 (PKR 10/min), runs it `seconds`, ends it. */
async function endedSession(user: string, seconds: number) {
  const s = await db.rpc<{ id: string }>(user, 'start_session', { p_table_id: club.tables.snooker1 })
  await db.ageSession(s.id, seconds)
  return s.id
}

describe('table checkout', () => {
  it('combines session charge, tab items and discount into a matching receipt', async () => {
    const sessionId = await db.rpc<{ id: string }>(cashier.id, 'start_session', { p_table_id: club.tables.snooker1 }).then(
      (s) => s.id
    )
    await db.rpc(cashier.id, 'add_session_item', { p_session_id: sessionId, p_product_id: club.products.cola, p_quantity: 2 })
    await db.rpc(cashier.id, 'add_session_item', { p_session_id: sessionId, p_product_id: club.products.tea })
    await db.rpc(cashier.id, 'add_session_item', { p_session_id: sessionId, p_product_id: club.products.cola })
    await db.ageSession(sessionId, 3600)
    await db.rpc(cashier.id, 'end_session', { p_session_id: sessionId })

    const receipt = await db.rpc<Receipt>(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'bank_transfer',
      p_session_id: sessionId,
      p_discount: 10,
      p_customer_name: 'Ali Raza',
      p_customer_phone: '+92 300 1234567'
    })
    expect(receipt.base_amount).toBe(600)
    expect(receipt.products_subtotal).toBe(370) // 3 × 100 + 70
    expect(receipt.discount).toBe(10)
    expect(receipt.final_amount).toBe(960)
    expect(receipt.payment_method).toBe('bank_transfer')
    expect(receipt.customer_phone).toBe('03001234567')
    expect(receipt.items).toEqual([
      { name: 'Cola', unit_price: 100, quantity: 3, line_total: 300 },
      { name: 'Tea', unit_price: 70, quantity: 1, line_total: 70 }
    ])
    expect(receipt.session?.billable_seconds).toBe(3600)

    // Receipt equals the saved transaction.
    const [sale] = await db.sql<Record<string, string>>(`select * from public.sales where id = $1`, [receipt.sale_id])
    expect(Number(sale!.final_amount)).toBe(receipt.final_amount)
    expect(Number(sale!.base_amount)).toBe(receipt.base_amount)
    const reprint = await db.rpc<Receipt>(cashier.id, 'get_receipt', { p_sale_id: receipt.sale_id })
    expect(reprint).toEqual(receipt)

    // Stock taken once (when served), counter updated at checkout, tab cleared.
    expect(await stock(club.products.cola)).toEqual({ stock_quantity: 7, units_sold: 3 })
    const [tab] = await db.sql<{ n: number }>(`select count(*)::int n from public.session_items`)
    expect(tab!.n).toBe(0)
    const [session] = await db.sql<{ status: string }>(`select status from public.sessions where id = $1`, [sessionId])
    expect(session!.status).toBe('completed')
  })

  it('price edits after an item is served do not change the tab', async () => {
    const id = await endedSession(staff.id, 60).then(async (sid) => {
      await db.rpc(staff.id, 'add_session_item', { p_session_id: sid, p_product_id: club.products.cola })
      return sid
    })
    await db.sql(`update public.inventory_products set selling_price = 150 where id = $1`, [club.products.cola])
    await db.rpc(staff.id, 'end_session', { p_session_id: id })
    const r = await db.rpc<Receipt>(staff.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_session_id: id
    })
    expect(r.items[0]!.unit_price).toBe(100)
  })

  it('deactivating ("deleting") a product never breaks an open tab', async () => {
    const id = await endedSession(staff.id, 60)
    await db.rpc(staff.id, 'add_session_item', { p_session_id: id, p_product_id: club.products.chips })
    await db.rpc(admin.id, 'admin_set_product_active', { p_id: club.products.chips, p_active: false })
    await db.rpc(staff.id, 'end_session', { p_session_id: id })
    const r = await db.rpc<Receipt>(staff.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_session_id: id
    })
    expect(r.items).toHaveLength(1)
    // But it can no longer be added to new tabs.
    const s2 = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    const err = await rejects(
      db.rpc(staff.id, 'add_session_item', { p_session_id: s2.id, p_product_id: club.products.chips })
    )
    expect(err.hint).toBe('product_unavailable')
  })

  it('requires the session to be ended first', async () => {
    const s = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    const err = await rejects(
      db.rpc(staff.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id })
    )
    expect(err.hint).toBe('invalid_state')
  })

  it('is idempotent: retrying with the same reference never charges twice', async () => {
    const id = await endedSession(staff.id, 600)
    await db.rpc(staff.id, 'end_session', { p_session_id: id })
    const ref = randomUUID()
    const first = await db.rpc<Receipt>(staff.id, 'complete_checkout', { p_client_ref: ref, p_payment_method: 'cash', p_session_id: id })
    const again = await db.rpc<Receipt>(staff.id, 'complete_checkout', { p_client_ref: ref, p_payment_method: 'cash', p_session_id: id })
    expect(again.sale_id).toBe(first.sale_id)
    const [n] = await db.sql<{ n: number }>(`select count(*)::int n from public.sales`)
    expect(n!.n).toBe(1)
    // A different reference for the same session is refused.
    const err = await rejects(
      db.rpc(staff.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: id })
    )
    expect(err.hint).toBe('already_paid')
  })
})

describe('discounts and payment methods', () => {
  it('staff without permission cannot discount', async () => {
    const id = await endedSession(staff.id, 600)
    await db.rpc(staff.id, 'end_session', { p_session_id: id })
    const err = await rejects(
      db.rpc(staff.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_session_id: id,
        p_discount: 10
      })
    )
    expect(err.hint).toBe('forbidden')
  })

  it('rejects negative discounts and discounts above the bill', async () => {
    const id = await endedSession(cashier.id, 660) // 11 min = PKR 110
    await db.rpc(cashier.id, 'end_session', { p_session_id: id })
    const args = { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: id }
    expect((await rejects(db.rpc(cashier.id, 'complete_checkout', { ...args, p_discount: -5 }))).hint).toBe('invalid_discount')
    expect((await rejects(db.rpc(cashier.id, 'complete_checkout', { ...args, p_discount: 111 }))).hint).toBe('invalid_discount')
    const r = await db.rpc<Receipt>(cashier.id, 'complete_checkout', { ...args, p_discount: 10 })
    expect(r.base_amount).toBe(110)
    expect(r.final_amount).toBe(100)
    // A full discount to zero is allowed; never negative.
    const id2 = await endedSession(cashier.id, 60)
    await db.rpc(cashier.id, 'end_session', { p_session_id: id2 })
    const free = await db.rpc<Receipt>(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_session_id: id2,
      p_discount: 10
    })
    expect(free.final_amount).toBe(0)
  })

  it('accepts only cash and bank transfer', async () => {
    const id = await endedSession(staff.id, 60)
    await db.rpc(staff.id, 'end_session', { p_session_id: id })
    for (const method of ['credit', 'udhar', 'card', '']) {
      const err = await rejects(
        db.rpc(staff.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: method, p_session_id: id })
      )
      expect(err.hint).toBe('invalid_input')
    }
    const [shift] = await db.sql<{ id: string }>(`select id from public.counter_shifts where user_id = $1`, [staff.id])
    const err = await rejects(
      db.sql(
        `insert into public.sales (client_ref, cashier_id, cashier_name, payment_method, final_amount, business_date, shift_id)
         values (gen_random_uuid(), $1, 'x', 'credit', 0, current_date, $2)`,
        [staff.id, shift!.id]
      )
    )
    expect(err.message).toMatch(/payment_method/)
  })
})

describe('counter sales and stock', () => {
  it('requires the counter_sale permission', async () => {
    const err = await rejects(
      db.rpc(staff.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [{ product_id: club.products.cola, quantity: 1, unit_price: 100 }]
      })
    )
    expect(err.hint).toBe('forbidden')
  })

  it('sells, merges duplicate lines and takes stock', async () => {
    const r = await db.rpc<Receipt>(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [
        { product_id: club.products.cola, quantity: 1, unit_price: 100 },
        { product_id: club.products.cola, quantity: 2, unit_price: 100 },
        { product_id: club.products.chips, quantity: 1, unit_price: 50 }
      ]
    })
    expect(r.products_subtotal).toBe(350)
    expect(r.base_amount).toBe(0)
    expect(r.session).toBeNull()
    expect(await stock(club.products.cola)).toEqual({ stock_quantity: 7, units_sold: 3 })
  })

  it('prevents overselling and leaves stock untouched on failure', async () => {
    const err = await rejects(
      db.rpc(cashier.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [
          { product_id: club.products.cola, quantity: 2, unit_price: 100 },
          { product_id: club.products.chips, quantity: 4, unit_price: 50 }
        ]
      })
    )
    expect(err.hint).toBe('insufficient_stock')
    expect((await stock(club.products.cola)).stock_quantity).toBe(10)
    expect((await stock(club.products.chips)).stock_quantity).toBe(3)
  })

  it('refuses a stale cart price', async () => {
    await db.sql(`update public.inventory_products set selling_price = 120 where id = $1`, [club.products.cola])
    const err = await rejects(
      db.rpc(cashier.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [{ product_id: club.products.cola, quantity: 1, unit_price: 100 }]
      })
    )
    expect(err.hint).toBe('price_changed')
  })

  it('the stock constraint makes overselling impossible even outside the functions', async () => {
    const err = await rejects(
      db.sql(`update public.inventory_products set stock_quantity = stock_quantity - 4 where id = $1`, [club.products.chips])
    )
    expect(err.message).toMatch(/stock_quantity/)
  })

  it('tab quantity changes move stock by the difference', async () => {
    const s = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    const item = await db.rpc<{ id: string }>(staff.id, 'add_session_item', {
      p_session_id: s.id,
      p_product_id: club.products.chips,
      p_quantity: 2
    })
    expect((await stock(club.products.chips)).stock_quantity).toBe(1)
    expect((await rejects(db.rpc(staff.id, 'set_session_item_quantity', { p_item_id: item.id, p_quantity: 4 }))).hint).toBe(
      'insufficient_stock'
    )
    await db.rpc(staff.id, 'set_session_item_quantity', { p_item_id: item.id, p_quantity: 3 })
    expect((await stock(club.products.chips)).stock_quantity).toBe(0)
    await db.rpc(staff.id, 'set_session_item_quantity', { p_item_id: item.id, p_quantity: 0 })
    expect((await stock(club.products.chips)).stock_quantity).toBe(3)
  })

  it('adjusts stock by delta with permission only', async () => {
    expect((await rejects(db.rpcRows(staff.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: 5 }))).hint).toBe(
      'forbidden'
    )
    const [row] = await db.rpcRows<{ stock_quantity: number }>(admin.id, 'adjust_stock', {
      p_product_id: club.products.cola,
      p_delta: 5
    })
    expect(row!.stock_quantity).toBe(15)
    expect((await rejects(db.rpcRows(admin.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: -16 }))).hint).toBe(
      'insufficient_stock'
    )
  })
})

describe('customers', () => {
  it('a phone number identifies one customer; a name alone never creates or merges profiles', async () => {
    const make = async (name: string | null, phone: string | null) => {
      const r = await db.rpc<Receipt>(cashier.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }],
        p_customer_name: name,
        p_customer_phone: phone
      })
      return r
    }
    await make('Bilal', '0300-1112223')
    const again = await make('Bilal Khan', '+923001112223')
    expect(again.customer_name).toBe('Bilal')
    // Two different people can share a name: no profile, the name stays on the receipt.
    const walkIn = await make('Walk-in Sam', null)
    expect(walkIn.customer_name).toBe('Walk-in Sam')
    await make('walk-in sam', null)
    const [n] = await db.sql<{ n: number }>(`select count(*)::int n from public.customers`)
    expect(n!.n).toBe(1)
    const found = await db.rpcRows<{ name: string; phone: string }>(staff.id, 'search_customers', { p_query: '1112' })
    expect(found.map((c) => c.name)).toEqual(['Bilal'])
  })

  it('validates phone numbers', async () => {
    const err = await rejects(db.rpc(admin.id, 'save_customer', { p_id: null, p_name: 'X', p_phone: '12' }))
    expect(err.hint).toBe('invalid_phone')
  })
})

describe('deleting sales', () => {
  it('restores stock, removes the paid session and needs permission', async () => {
    const r = await db.rpc<Receipt>(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [{ product_id: club.products.cola, quantity: 4, unit_price: 100 }]
    })
    expect((await rejects(db.rpc(staff.id, 'delete_sale', { p_sale_id: r.sale_id }))).hint).toBe('forbidden')
    await db.rpc(cashier.id, 'delete_sale', { p_sale_id: r.sale_id })
    expect(await stock(club.products.cola)).toEqual({ stock_quantity: 10, units_sold: 0 })
    const [n] = await db.sql<{ n: number }>(`select count(*)::int n from public.sale_items`)
    expect(n!.n).toBe(0)
  })

  it('staff void only their own sales; an admin may void any sale of an open counter', async () => {
    const sameFloor = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['delete_sales'] })
    const id = await endedSession(cashier.id, 60)
    await db.rpc(cashier.id, 'end_session', { p_session_id: id })
    const r = await db.rpc<Receipt>(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_session_id: id
    })
    // Another staff member — even on the same floor and with "Delete sales" — cannot touch it.
    expect((await rejects(db.rpc(sameFloor.id, 'delete_sale', { p_sale_id: r.sale_id }))).hint).toBe('forbidden')
    await db.rpc(admin.id, 'delete_sale', { p_sale_id: r.sale_id })
    // The session record is kept and marked as voided.
    const sessions = await db.sql<{ status: string }>(`select status from public.sessions where id = $1`, [id])
    expect(sessions).toEqual([{ status: 'voided' }])
    const [n] = await db.sql<{ n: number }>(`select count(*)::int n from public.sales`)
    expect(n!.n).toBe(0)
  })
})
