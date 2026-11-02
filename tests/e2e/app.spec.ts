/**
 * End-to-end: the production web build (dist/e2e, served by `vite preview`
 * with the same security headers as Vercel) in real Chrome, real supabase-js,
 * real SQL migrations (PGlite behind a local Supabase-compatible test server).
 * Run with `npm run test:e2e` (builds first).
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { E2E, FakeSupabase } from './fake-supabase'

test.describe.configure({ mode: 'serial' })

const SHOTS = join(__dirname, 'screenshots')
const TIME_12H = /(0[1-9]|1[0-2]):[0-5]\d (AM|PM)/

let fake: FakeSupabase
let browser: Browser
let page: Page
let club: { snooker: string; snooker2: string; pool: string; cola: string; chai: string; ground: number; first: number }
let ali: { id: string }
let sara: { id: string }

/** Screenshot once entry animations (dialogs, tickers, charts — all under 1 s) have settled. */
const shot = async (name: string) => {
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}
const db = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => fake.exclusive(() => fake.db.sql<T>(sql, params))
const nav = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name })

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  fake = await FakeSupabase.start(E2E.supabasePort)
  const [ground] = await db<{ id: number }>(`insert into public.floors (name, sort_order) values ('Ground', 1) returning id`)
  const [first] = await db<{ id: number }>(`insert into public.floors (name, sort_order) values ('First', 2) returning id`)
  const [snookerCat] = await db<{ id: number }>(`insert into public.table_categories (name, rate_per_minute, sort_order) values ('Snooker', 10, 1) returning id`)
  const [poolCat] = await db<{ id: number }>(`insert into public.table_categories (name, rate_per_minute, sort_order) values ('Pool', 6.6667, 2) returning id`)
  const tables: string[] = []
  for (const [name, cat, floor, sort] of [
    ['Snooker 1', snookerCat!.id, ground!.id, 1],
    ['Snooker 2', snookerCat!.id, ground!.id, 2],
    ['Snooker 3', snookerCat!.id, ground!.id, 3],
    ['Pool 1', poolCat!.id, first!.id, 4],
    ['Pool 2', poolCat!.id, first!.id, 5]
  ] as const) {
    const [t] = await db<{ id: string }>(`insert into public.club_tables (name, category_id, floor_id, sort_order) values ($1, $2, $3, $4) returning id`, [name, cat, floor, sort])
    tables.push(t!.id)
  }
  const [cola] = await db<{ id: string }>(`insert into public.inventory_products (name, category, cost_price, selling_price, stock_quantity) values ('Cola 345ml', 'Drinks', 60, 100, 24) returning id`)
  await db(`insert into public.inventory_products (name, category, cost_price, selling_price, stock_quantity, low_stock_threshold) values ('Lays Masala', 'Snacks', 30, 50, 3, 5)`)
  const [chai] = await db<{ id: string }>(`insert into public.inventory_products (name, category, cost_price, selling_price, track_stock) values ('Doodh Patti Chai', 'Drinks', 25, 80, false) returning id`)
  club = { snooker: tables[0]!, snooker2: tables[1]!, pool: tables[3]!, cola: cola!.id, chai: chai!.id, ground: ground!.id, first: first!.id }
  await fake.exclusive(() => fake.addUser('owner', 'owner-pass-123', 'admin'))
  ali = await fake.exclusive(() =>
    fake.addUser('ali', 'ali-pass-123', 'staff', { floorId: ground!.id, permissions: ['view_own_sales', 'apply_discount', 'counter_sale', 'delete_sales'] })
  )
  sara = await fake.exclusive(() => fake.addUser('sara', 'sara-pass-123', 'staff', { floorId: first!.id, permissions: ['counter_sale'] }))

  browser = await chromium.launch({ channel: process.env.FUSION_E2E_CHANNEL || 'chrome' })
  // Like the club's PCs with Windows' "Show animations" off: the app must still animate.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  page = await context.newPage()
})

test.afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await fake?.stop()
})

test('the URL opens the sign-in screen: no server setup, no sign-up, strict security headers', async () => {
  const response = await page.goto(E2E.appUrl + '/')
  const headers = response!.headers()
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['content-security-policy']).toContain("script-src 'self'")
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-content-type-options']).toBe('nosniff')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/server connection|project url|sign up|create account|register/i)).toHaveCount(0)
  await expect(page).toHaveTitle('FUSION Gaming Lounge')
  // A plain browser page: no desktop bridge, no window buttons.
  expect(await page.evaluate(() => typeof (window as unknown as { fusion?: unknown }).fusion)).toBe('undefined')
  await expect(page.getByTestId('window-controls')).toHaveCount(0)
  // A deep link still lands on the sign-in screen first.
  await page.goto(E2E.appUrl + '/history')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await shot('01-login-web')
  await page.goto(E2E.appUrl + '/')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('rejects a wrong password, then signs the admin in to a management dashboard', async () => {
  await page.getByTestId('login-username').fill('owner')
  await page.getByTestId('login-password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Incorrect username or password.')).toBeVisible()
  await expect(page.getByText(TIME_12H).first()).toBeVisible() // the sign-in clock
  await shot('02-login')
  await page.getByTestId('login-password').fill('owner-pass-123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('today-sales')).toBeVisible()
  await expect(page.getByTestId('today-sales')).toContainText('PKR 0')
  await expect(page.getByTestId('staff-live')).toContainText('No counters have been opened today.')
  // Admins manage; they never sell.
  await expect(page.getByRole('button', { name: 'Counter sale' })).toHaveCount(0)
  await expect(nav('My counter')).toHaveCount(0)
  await shot('03-dashboard-empty')
})

test('admin books a table and starts it from Pre-bookings', async () => {
  await nav('Pre-bookings').click()
  await page.getByRole('button', { name: 'New booking' }).click()
  await page.getByTestId('booking-name').fill('Hamza Khan')
  await page.getByTestId('booking-phone').fill('0300-7654321')
  await page.getByRole('combobox', { name: 'Table' }).click()
  await page.getByRole('option', { name: 'Snooker 1' }).click()
  await page.getByTestId('save-booking').click()
  const list = page.getByTestId('booking-list')
  await expect(list).toContainText('Hamza Khan')
  await expect(list).toContainText('07:00 PM') // default time, shown in 12-hour form
  await expect(page.getByTestId('booking-count')).toContainText('1 booking')
  await shot('04-bookings')

  await page.getByTestId('start-booking-Hamza Khan').click()
  await page.getByTestId('confirm-start-booking').click()
  await expect(list).toContainText('Started')
  await expect(page.getByTestId('start-booking-Hamza Khan')).toHaveCount(0)
  const [b] = await db<{ status: string; session_id: string }>(`select status, session_id from public.bookings`)
  expect(b!.status).toBe('started')

  await nav('Tables').click()
  await expect(page.getByTestId('table-card-Snooker 1')).toContainText('Running')
  await expect(page.getByRole('button', { name: 'Counter sale' })).toHaveCount(0)
})

test('staff opens their own counter, runs the booked table and takes the payment', async () => {
  await page.getByTestId('account-menu').click()
  await page.getByRole('menuitem', { name: 'Switch to Staff portal' }).click()
  await page.getByRole('button', { name: /staff ali/ }).click()
  await page.getByLabel('Password').fill('not-it')
  await page.getByRole('button', { name: 'Switch' }).click()
  await expect(page.getByText('Incorrect username or password.')).toBeVisible()
  await page.getByLabel('Password').fill('ali-pass-123')
  await page.getByRole('button', { name: 'Switch' }).click()

  const card = page.getByTestId('my-counter-card')
  await expect(card).toContainText('Your counter is closed')
  await card.getByRole('button', { name: 'Open counter' }).click()
  await expect(card).toContainText('My counter · open')

  await nav('Tables').click()
  const snooker1 = page.getByTestId('table-card-Snooker 1')
  // A second table on a prepaid amount, so the floor looks lived-in.
  await page.getByTestId('table-card-Snooker 2').getByRole('button', { name: 'Start' }).click()
  await page.getByRole('button', { name: /Fixed amount/ }).click()
  await page.getByLabel('Amount received').fill('400')
  await expect(page.getByText(/buys 40 min of play/)).toBeVisible()
  await page.getByTestId('confirm-start').click()
  await expect(page.getByTestId('table-card-Snooker 2')).toContainText('left of booking')

  // The booked table: 29 minutes of play, then a pause that is not billed.
  await db(`update public.sessions set started_at = started_at - interval '29 minutes' where table_id = $1`, [club.snooker])
  await snooker1.getByRole('button', { name: 'Pause' }).click()
  await expect(snooker1).toContainText('Paused')
  await db(`update public.sessions set started_at = started_at - interval '10 minutes', paused_at = paused_at - interval '10 minutes' where table_id = $1`, [club.snooker])
  await snooker1.getByRole('button', { name: 'Resume' }).click()
  await expect(snooker1).toContainText('Running')
  await expect(snooker1.getByTestId('table-timer')).toContainText(/^29:\d\d$/)
  await shot('05-tables-live')

  await snooker1.click()
  await page.getByTestId('product-search').fill('cola')
  await page.getByRole('button', { name: /Cola 345ml/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Cola 345ml')
  await expect(page.getByRole('dialog')).toContainText(TIME_12H) // "Started" time
  await shot('06-session-panel')
  await page.getByTestId('end-session').click()

  // PKR 300 table (30 billed minutes @ PKR 10/min) + PKR 100 cola − PKR 10 discount.
  const dialog = page.getByRole('dialog', { name: /Checkout/ })
  await expect(dialog).toContainText('Checkout · Snooker 1')
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 400')
  await expect(page.getByTestId('customer-name')).toHaveValue('Hamza Khan') // from the booking
  // A custom rate per minute re-prices the table time instantly; clearing it restores the table's rate.
  await page.getByTestId('custom-rate').fill('9')
  await expect(page.getByTestId('checkout-table-charge')).toHaveText('PKR 270')
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 370')
  await dialog.getByRole('button', { name: 'Use table rate' }).click()
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 400')
  // A percentage discount becomes an amount of the bill.
  await page.getByTestId('discount-percent').click()
  await page.getByTestId('discount').fill('10')
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 360')
  await page.getByTestId('discount-flat').click()
  await page.getByTestId('discount').fill('10')
  await page.getByRole('radio', { name: 'Bank Transfer' }).click()
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 390')
  await shot('07-checkout')
  await page.getByTestId('complete-checkout').click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toContainText('390')
  await expect(receipt).toContainText('Bank Transfer')
  await expect(receipt).toContainText('Hamza Khan')
  await expect(receipt).toContainText(TIME_12H)
  await shot('08-receipt')

  const [sale] = await db<{ final_amount: string; payment_method: string; discount: string; customer_phone: string; mine: boolean }>(
    `select s.final_amount, s.payment_method, s.discount, s.customer_phone, c.user_id = $1 as mine
     from public.sales s join public.counter_shifts c on c.id = s.shift_id`,
    [ali.id]
  )
  expect(sale).toEqual({ final_amount: '390.00', payment_method: 'bank_transfer', discount: '10.00', customer_phone: '03007654321', mine: true })
  const [stock] = await db<{ stock_quantity: number }>(`select stock_quantity from public.inventory_products where id = $1`, [club.cola])
  expect(stock!.stock_quantity).toBe(23)
  const [booking] = await db<{ status: string }>(`select status from public.bookings`)
  expect(booking!.status).toBe('completed')

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(snooker1).toContainText('Available')
})

test('staff records an expense; their counter shows live figures and 12-hour times', async () => {
  await nav('My counter').click()
  const counter = page.getByTestId('my-counter')
  await expect(page.getByTestId('shift-total')).toHaveText('PKR 390')
  await page.getByRole('button', { name: 'Add expense' }).first().click()
  await page.getByTestId('expense-amount').fill('50')
  await page.getByTestId('expense-description').fill('Milk for tea')
  await page.getByTestId('save-expense').click()
  await expect(counter).toContainText('PKR 340') // net = 390 − 50
  await expect(counter).toContainText('PKR 100') // snack sales (inside the 390, not added again)
  await expect(page.getByText('Milk for tea')).toBeVisible()
  await expect(page.getByText(/Opened .*(0[1-9]|1[0-2]):[0-5]\d (AM|PM)/)).toBeVisible()
  await expect(page.getByText(/(?<![\d:])(1[3-9]|2[0-3]):[0-5]\d(?![\d:])(?! ?[AP]M)/)).toHaveCount(0) // no 24-hour clock anywhere
  await shot('09-my-counter')
})

test('staff are restricted to their own accounting and floor', async () => {
  for (const name of ['History', 'Pre-bookings', 'Staff', 'Settings']) await expect(nav(name)).toHaveCount(0)
  await nav('Dashboard').click()
  await expect(page.getByTestId('my-counter-card')).toContainText('PKR 390')
  await expect(page.getByTestId('today-sales')).toHaveCount(0)
  await expect(page.getByTestId('staff-live')).toHaveCount(0)
  await shot('10-staff-dashboard')

  // Typing an admin route redirects home; the database refuses admin calls.
  // (A full page load also proves the session survives a refresh.)
  await page.goto(E2E.appUrl + '/history')
  await expect(page.getByTestId('my-counter-card')).toBeVisible()
  await expect(page).toHaveURL(E2E.appUrl + '/')
  const call = (fn: string, body: Record<string, unknown>) =>
    page.evaluate(
      async ([f, b, base]) => {
        const token = JSON.parse(localStorage.getItem('sb-fusion-auth')!).access_token
        const res = await fetch(`${base}/rest/v1/rpc/${f}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(b)
        })
        return { status: res.status, body: await res.json() }
      },
      [fn, body, fake.url] as const
    )
  const forbidden = await call('admin_update_settings', { p_settings: { club_name: 'pwned' } })
  expect(forbidden.status).toBe(403)
  expect(forbidden.body.hint).toBe('forbidden')
  const history = await call('get_history', { p_from: '2026-01-01', p_to: '2030-01-01' })
  expect(history.body.hint).toBe('forbidden')

  // Floor restriction: ali (Ground) does not see first-floor tables.
  await nav('Tables').click()
  await expect(page.getByTestId('table-card-Snooker 1')).toBeVisible()
  await expect(page.getByTestId('table-card-Pool 1')).toHaveCount(0)
})

test('staff → admin needs the master password; the admin sees every staff member live', async () => {
  // Meanwhile Sara (First floor) works her own counter: one chai, then closes.
  await fake.exclusive(async () => {
    await fake.db.rpc(sara.id, 'open_counter')
    await fake.db.rpc(sara.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [{ product_id: club.chai, quantity: 1, unit_price: 80 }]
    })
    await fake.db.rpc(sara.id, 'close_counter')
  })

  await page.getByTestId('account-menu').click()
  await page.getByRole('menuitem', { name: 'Switch to Admin portal' }).click()
  await page.getByLabel('Admin master password').fill('guess')
  await page.getByRole('button', { name: 'Unlock Admin' }).click()
  await expect(page.getByText('Incorrect username or password.')).toBeVisible()
  await page.getByLabel('Admin master password').fill('owner-pass-123')
  await page.getByRole('button', { name: 'Unlock Admin' }).click()

  await expect(page.getByTestId('today-sales')).toContainText('PKR 470')
  const aliRow = page.getByTestId('staff-row-ali')
  await expect(aliRow).toContainText('Open')
  await expect(aliRow).toContainText('PKR 390')
  await expect(aliRow).toContainText('PKR 340')
  await expect(aliRow).toContainText(TIME_12H) // "Open since …"
  const saraRow = page.getByTestId('staff-row-sara')
  await expect(saraRow).toContainText('Closed')
  await expect(saraRow).toContainText('PKR 80')
  const total = page.getByTestId('staff-live-total')
  await expect(total).toContainText('PKR 470')
  await expect(total).toContainText('PKR 420') // net
  await shot('11-dashboard')
  await page.locator('#main').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await shot('11b-dashboard-lower')
  await page.locator('#main').evaluate((el) => el.scrollTo(0, 0))
})

test('history shows staff shifts and invoices; closing the day keeps every record', async () => {
  await nav('History').click()
  await expect(page.getByTestId('history-total')).toHaveText('PKR 470')
  await expect(page.getByTestId('history-staff')).toContainText('staff ali')
  await expect(page.getByTestId('history-staff')).toContainText('staff sara')
  await shot('12-history')

  await page.getByRole('tab', { name: 'Shifts' }).click()
  await page.getByTestId('shift-table').getByText('staff ali').click()
  const detail = page.getByTestId('shift-detail')
  await expect(detail).toContainText('Milk for tea')
  await detail.getByText(/#\d+ · Snooker 1/).click()
  await expect(detail).toContainText('Cola 345ml × 1')
  await expect(detail).toContainText('Hamza Khan')
  await shot('13-shift-detail')
  await page.keyboard.press('Escape')

  // The day cannot be closed while Ali's counter is open.
  await page.getByRole('tab', { name: 'Close day' }).click()
  await expect(page.getByTestId('days-to-close')).toContainText('1 counter still open')

  // The admin closes Ali's forgotten counter (handing over Snooker 2), then the day.
  await nav('Dashboard').click()
  await page.getByTestId('staff-row-ali').getByRole('button', { name: 'Close' }).click()
  await page.getByText(/Any table sessions this counter started/).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close counter' }).click()
  await expect(page.getByTestId('staff-row-ali')).toContainText('Closed')

  await nav('History').click()
  await page.getByRole('tab', { name: 'Close day' }).click()
  await page.getByTestId('days-to-close').getByRole('button', { name: 'Close day' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close day' }).click()
  await expect(page.getByText('Every day is closed')).toBeVisible()
  await expect(page.getByTestId('closed-days')).toContainText('PKR 470')
  await shot('14-close-day')

  const [summary] = await db<{ total_cash: string; total_bank: string; total_sales: string; expenses: string }>(
    `select total_cash, total_bank, total_sales, expenses from public.daily_summaries`
  )
  expect(summary).toEqual({ total_cash: '80.00', total_bank: '390.00', total_sales: '470.00', expenses: '50.00' })
  // Nothing was deleted: invoices, shifts, expenses and sessions all remain.
  const [kept] = await db<{ sales: number; shifts: number; expenses: number; sessions: number }>(
    `select (select count(*)::int from public.sales) sales, (select count(*)::int from public.counter_shifts) shifts,
            (select count(*)::int from public.expenses) expenses, (select count(*)::int from public.sessions where status = 'completed') sessions`
  )
  expect(kept).toEqual({ sales: 2, shifts: 2, expenses: 1, sessions: 1 })
})

test('dashboard and history animations stay smooth', async () => {
  type Perf = { frames: number[]; longtasks: number[] }
  /** Frame-to-frame intervals and long tasks while `go` opens an animated screen. */
  const measure = async (go: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as unknown as { __perf: Perf }
      w.__perf = { frames: [], longtasks: [] }
      let last = performance.now()
      const tick = (t: number) => {
        w.__perf.frames.push(t - last)
        last = t
        if (w.__perf.frames.length < 240) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__perf.longtasks.push(e.duration))).observe({ type: 'longtask' })
    })
    await go()
    await page.waitForTimeout(1600) // tickers (≤ 1 s) and chart entry (≤ 0.75 s) finish
    return page.evaluate(() => {
      const { frames, longtasks } = (window as unknown as { __perf: Perf }).__perf
      const f = frames.slice(1).sort((a, b) => a - b)
      const at = (q: number) => Math.round(f[Math.min(f.length - 1, Math.floor(f.length * q))]! * 10) / 10
      return { frames: f.length, p50: at(0.5), p95: at(0.95), max: at(1), longest_task: Math.round(Math.max(0, ...longtasks)) }
    })
  }
  const dashboard = await measure(async () => {
    await nav('Dashboard').click()
    await expect(page.getByTestId('staff-live-total')).toContainText('PKR 470')
  })
  const history = await measure(async () => {
    await nav('History').click()
    await page.getByRole('tab', { name: 'Overview' }).click()
    await expect(page.getByTestId('history-total')).toHaveText('PKR 470')
  })
  console.log('animation frame timing (ms):', JSON.stringify({ dashboard, history }))
  for (const m of [dashboard, history]) {
    expect(m.frames).toBeGreaterThan(30)
    expect(m.p95).toBeLessThan(50) // 95% of frames within 50 ms (no visible stutter)
    expect(m.longest_task).toBeLessThan(300)
  }
})

test('figures roll, bars grow, buttons ripple and dialogs spring — even with reduced motion on', async () => {
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  type Samples = { text: string[]; bar: string[] }
  const startSampling = () =>
    page.evaluate(() => {
      const w = window as unknown as { __samples: Samples }
      w.__samples = { text: [], bar: [] }
      const until = performance.now() + 1500
      const tick = () => {
        const t = document.querySelector('[data-testid="today-total"]')?.textContent
        if (t) w.__samples.text.push(t)
        const bar = document.querySelector('.recharts-bar-rectangle path, .recharts-bar-rectangles path')?.getAttribute('d')
        if (bar) w.__samples.bar.push(bar)
        if (performance.now() < until) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

  // The dashboard's Today's sales rolls up from PKR 0 to PKR 470; the hourly bars grow.
  await nav('History').click()
  await startSampling()
  await nav('Dashboard').click()
  await page.waitForTimeout(1600)
  const samples = await page.evaluate(() => (window as unknown as { __samples: Samples }).__samples)
  const amounts = [...new Set(samples.text)].map((t) => Number(t.replace(/[^\d]/g, '')))
  console.log(`Today's sales rolled through ${amounts.length} values: ${amounts.slice(0, 8).join(', ')} … ${amounts.at(-1)}; bar path changed ${new Set(samples.bar).size} times`)
  expect(amounts.at(-1)).toBe(470)
  expect(amounts.filter((a) => a > 0 && a < 470).length, `rolled through: ${amounts.join(', ')}`).toBeGreaterThan(5)
  expect(new Set(samples.bar).size, 'bar heights while growing').toBeGreaterThan(5)

  // Press ripple: a matte disc grows from the pointer inside the button.
  const button = page.getByRole('button', { name: /Pre-bookings/ }).first() // the page header's button
  const box = (await button.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  const ripple = button.locator('.ripple')
  await expect(ripple).toHaveCount(1)
  expect(await ripple.evaluate((el) => [getComputedStyle(el).display, getComputedStyle(el).animationName])).toEqual(['block', 'ripple'])
  await page.mouse.move(box.x + box.width + 200, box.y + 300) // release away from it: no click
  await page.mouse.up()
  await expect(ripple).toHaveCount(0) // removed when the ripple finishes

  // Dialogs spring in: their transform changes over several frames.
  await nav('Settings').click()
  await page.getByRole('button', { name: 'Categories & rates' }).click()
  await page.evaluate(() => {
    const w = window as unknown as { __transforms: string[] }
    w.__transforms = []
    const until = performance.now() + 700
    const tick = () => {
      const d = document.querySelector('[role="dialog"]')
      if (d) w.__transforms.push(getComputedStyle(d).transform)
      if (performance.now() < until) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.waitForTimeout(800)
  const transforms = await page.evaluate(() => (window as unknown as { __transforms: string[] }).__transforms)
  expect(new Set(transforms).size, 'dialog transform while opening').toBeGreaterThan(4)
  await expect(page.getByTestId('category-rate')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('inventory, customers, staff and settings screens render', async () => {
  await nav('Inventory').click()
  await expect(page.getByText('Lays Masala')).toBeVisible()
  await shot('15-inventory')
  await nav('Customers').click()
  await expect(page.getByTestId('customer-rankings')).toContainText('Hamza Khan')
  await shot('16-customers')
  await nav('Staff').click()
  await expect(page.getByText('@ali')).toBeVisible()
  await shot('17-staff')
  await nav('Settings').click()
  await page.getByRole('button', { name: 'Billing rules' }).click()
  await expect(page.getByText(/Billed per minute/)).toBeVisible()
  await page.getByRole('button', { name: 'Data retention' }).click()
  await expect(page.getByTestId('retention-status')).toContainText('30 days')
  await expect(page.getByRole('tab', { name: 'Monthly' })).toHaveAttribute('aria-selected', 'true')
  await shot('18-retention')
})

test('Reports, Expenses and product profit come from the closed counters; the PDF has the same figures', async () => {
  const [{ today } = { today: "" }] = await db<{ today: string }>(`select public.get_current_business_date()::text as today`)
  // Every counter is closed now, so today's figures are final.
  await nav('Reports').click()
  await expect(page.getByTestId('report-total')).toHaveText('PKR 470')
  await expect(page.getByTestId('report-cash')).toContainText('PKR 80')
  await expect(page.getByTestId('report-bank')).toContainText('PKR 390')
  await expect(page.getByTestId('report-expenses')).toContainText('PKR 50')
  await expect(page.getByTestId('report-net')).toHaveText('PKR 420')
  await expect(page.getByTestId('report-staff')).toContainText('staff ali')
  await expect(page.getByTestId('report-staff')).toContainText('staff sara')
  await expect(page.getByTestId('report-live')).toHaveCount(0)
  await shot('19-reports')

  // A business expense, and one added by mistake and voided.
  await nav('Expenses').click()
  await expect(page.getByTestId('expense-counter')).toHaveText('PKR 50')
  const addExpense = async (category: string, amount: string, description: string) => {
    await page.getByTestId('add-expense').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('save-expense').click()
    await expect(dialog.getByText('Choose a category.')).toBeVisible() // validated before sending
    await dialog.getByRole('combobox', { name: 'Category' }).click()
    await page.getByRole('option', { name: category }).click()
    await dialog.getByTestId('expense-amount').fill(amount)
    await dialog.getByTestId('expense-description').fill(description)
    await dialog.getByTestId('save-expense').click()
    await expect(dialog).toHaveCount(0)
  }
  await addExpense('Utilities', '1200', 'Electricity bill')
  await addExpense('Other', '300', 'Entered twice')
  await expect(page.getByTestId('expense-total')).toHaveText('PKR 1,550')
  await page.getByTestId('expense-list').getByRole('row', { name: /Entered twice/ }).getByRole('button', { name: 'Void expense' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Void expense' }).click()
  await expect(page.getByTestId('expense-total')).toHaveText('PKR 1,250')
  await expect(page.getByTestId('expense-business')).toHaveText('PKR 1,200')
  await expect(page.getByTestId('expense-list')).toContainText('Voided')
  await shot('20-expenses')

  // Business expenses count in Reports but never change a counter or History.
  await nav('History').click()
  await expect(page.getByTestId('history-total')).toHaveText('PKR 470')
  await nav('Reports').click()
  await expect(page.getByTestId('report-expenses')).toContainText('PKR 1,250')
  await expect(page.getByTestId('report-net')).toHaveText('PKR -780')

  const downloading = page.waitForEvent('download')
  await page.getByTestId('export-pdf').click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe(`FUSION-report-${today}.pdf`)
  const pdf = readFileSync(await download.path()).toString('latin1')
  expect(pdf.startsWith('%PDF-')).toBe(true)
  for (const text of ['FUSION Gaming Lounge', 'Financial report', 'Total sales', 'PKR 470', 'PKR 80', 'PKR 390', 'PKR 1,250', 'PKR -780', 'staff ali', 'staff sara']) {
    expect(pdf, text).toContain(text)
  }

  // Inventory → Sales & profit: product sales and gross profit straight from the ledger.
  await nav('Inventory').click()
  await page.getByRole('tab', { name: 'Sales & profit' }).click()
  await expect(page.getByTestId('product-row-Cola 345ml')).toBeVisible()
  const [ledger] = await db<{ net: string; profit: string }>(
    `select round(sum(revenue - discount), 2)::text net, round(sum(costed_revenue - costed_discount - cost), 2)::text profit
     from public.product_sales_daily`
  )
  const money = (v: string) => {
    const n = Number(v)
    return `PKR ${Number.isInteger(n) ? n.toLocaleString('en-PK') : n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  await expect(page.getByTestId('product-net')).toHaveText(money(ledger!.net))
  await expect(page.getByTestId('product-profit-total')).toHaveText(money(ledger!.profit))
  await shot('21-product-profit')

  // Laptop and tablet windows: the sidebar becomes an icon rail and nothing scrolls sideways.
  for (const [width, height, name] of [[1180, 760, 'laptop'], [820, 1180, 'tablet']] as const) {
    await page.setViewportSize({ width, height })
    await expect(page.locator('aside[data-layout="rail"]')).toBeVisible()
    for (const [link, testId, file] of [['Reports', 'report-total', 'reports'], ['Dashboard', 'today-sales', 'dashboard'], ['Expenses', 'expense-total', 'expenses']] as const) {
      await nav(link).click()
      await expect(page.getByTestId(testId)).toBeVisible()
      await shot(`22-${file}-${name}`)
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('#main')!
        return main.scrollWidth - main.clientWidth
      })
      expect(overflow, `${file} at ${width}px`).toBeLessThanOrEqual(0)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
})

test('a regular pays a custom rate per minute; the discount follows and every total agrees', async () => {
  await page.getByTestId('account-menu').click()
  await page.getByRole('menuitem', { name: 'Switch to Staff portal' }).click()
  await page.getByRole('button', { name: /staff ali/ }).click()
  await page.getByLabel('Password').fill('ali-pass-123')
  await page.getByRole('button', { name: 'Switch' }).click()
  const card = page.getByTestId('my-counter-card')
  await card.getByRole('button', { name: 'Open counter' }).click()
  await expect(card).toContainText('My counter · open')

  // 100 billed minutes of open play at PKR 10/min = PKR 1,000.
  await nav('Tables').click()
  const snooker1 = page.getByTestId('table-card-Snooker 1')
  await expect(snooker1).toContainText('PKR 10/min')
  await snooker1.getByRole('button', { name: 'Start' }).click()
  await page.getByTestId('confirm-start').click()
  await expect(snooker1).toContainText('Running')
  // Back-date the start; the server bills from the stored start time when the session ends.
  // 99 min 30 s played: any started minute is billed, so exactly 100 minutes.
  await db(`update public.sessions set started_at = started_at - interval '99 minutes 30 seconds' where table_id = $1 and status = 'running'`, [club.snooker])
  // The card's End opens checkout directly (the drawer route is covered above).
  await snooker1.getByRole('button', { name: 'End' }).click()

  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 1,000')
  await page.getByTestId('custom-rate').fill('9')
  await expect(page.getByTestId('checkout-table-charge')).toHaveText('PKR 900')
  await page.getByTestId('discount').fill('30')
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 870')
  await shot('19-custom-rate')
  await page.getByTestId('complete-checkout').click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toContainText('PKR 9/min (custom)')
  await expect(receipt).toContainText('Standard rate')
  await expect(receipt).toContainText('870')
  await shot('20-custom-rate-receipt')

  const [sale] = await db<Record<string, string>>(
    `select rate_per_minute::text rate, standard_rate_per_minute::text standard, standard_base_amount::text standard_base,
            base_amount::text base, discount::text, final_amount::text final
     from public.sales where final_amount = 870`
  )
  expect(sale).toEqual({ rate: '9.0000', standard: '10.0000', standard_base: '1000.00', base: '900.00', discount: '30.00', final: '870.00' })
  await page.getByRole('button', { name: 'Done' }).click()

  // The counter carries what was paid; the discount is recorded once.
  await nav('My counter').click()
  await expect(page.getByTestId('shift-total')).toHaveText('PKR 870')
  const [shift] = await db<{ cash: string; discounts: string }>(
    `select cash_sales::text cash, discounts::text from public.counter_shifts where status = 'open' and user_id = $1`,
    [ali.id]
  )
  expect(shift).toEqual({ cash: '870.00', discounts: '30.00' })
})

test('refreshing keeps the signed-in page; signing out ends the session', async () => {
  // Ali (staff) is signed in from the previous test.
  await nav('Tables').click()
  await expect(page).toHaveURL(E2E.appUrl + '/tables')
  await page.reload()
  await expect(page).toHaveURL(E2E.appUrl + '/tables')
  await expect(page.getByTestId('table-card-Snooker 1')).toBeVisible()
  await page.getByTestId('account-menu').click()
  await page.getByRole('menuitem', { name: /sign out/i }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('sb-fusion-auth'))).toBeNull()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})
