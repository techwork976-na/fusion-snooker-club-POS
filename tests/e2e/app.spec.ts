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
let club: { snooker: string; snooker2: string; snooker3: string; pool: string; cola: string; chai: string; ground: number; first: number }
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
  club = { snooker: tables[0]!, snooker2: tables[1]!, snooker3: tables[2]!, pool: tables[3]!, cola: cola!.id, chai: chai!.id, ground: ground!.id, first: first!.id }
  await fake.exclusive(() => fake.addUser('owner', 'owner-pass-123', 'admin'))
  ali = await fake.exclusive(() =>
    fake.addUser('ali', 'ali-pass-123', 'staff', { floorId: ground!.id, permissions: ['view_own_sales', 'apply_discount', 'counter_sale', 'delete_sales'] })
  )
  sara = await fake.exclusive(() => fake.addUser('sara', 'sara-pass-123', 'staff', { floorId: first!.id, permissions: ['counter_sale'] }))

  browser = await chromium.launch({ channel: process.env.FUSION_E2E_CHANNEL || 'chrome' })
  // Like the club's PCs with Windows' "Show animations" off: the app must still animate.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  // Count the alarm's synthesised tones, to prove the alarm really plays.
  await context.addInitScript(() => {
    const w = window as unknown as { __fusionTones: number }
    w.__fusionTones = 0
    const original = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      w.__fusionTones++
      return original.call(this)
    }
  })
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
  await expect(page.getByTestId('table-card-Snooker 2')).toContainText('left of 40:00 booked')

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

test("a fixed-time booking stops at 0:00 and rings until silenced; a refresh never rings again; continuing bills only new time", async () => {
  // Ali (staff, Ground floor) is signed in with an open counter.
  await nav('Tables').click()
  const card = page.getByTestId('table-card-Snooker 3')
  await card.getByRole('button', { name: 'Start' }).click()
  await page.getByRole('button', { name: /Fixed time/ }).click()
  await page.getByLabel('Minutes').fill('30')
  await page.getByTestId('confirm-start').click()
  await expect(card).toContainText('left of 30:00 booked')

  // Half an hour later (moved back in the database): 3 seconds of booking left.
  await db(`update public.sessions set started_at = now() - interval '30 minutes' + interval '3 seconds' where table_id = $1 and status = 'running'`, [club.snooker3])
  await page.reload()
  const alert = page.getByTestId('time-up-alert')
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await expect(alert).toHaveAttribute('data-alarm', 'ringing')
  await expect(page.getByTestId('time-up-Snooker 3')).toContainText('Booked 30 min')
  await expect(card.getByTestId('table-timer')).toHaveText('0:00') // stops at zero, never negative
  await page.mouse.click(5, 5) // any click lets the browser play sound
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fusionTones: number }).__fusionTones)).toBeGreaterThan(0)
  await expect(page).toHaveTitle(/Time's up · Snooker 3/)
  await shot('23-time-up')

  // Silencing stops the alarm (for every terminal) and leaves the session open and held.
  await page.getByTestId('time-up-Snooker 3').getByTestId('silence-alarm').click()
  await expect(alert).toHaveCount(0)
  const [held] = await db<{ status: string; acked: boolean; extended: boolean }>(
    `select status, allocation_alert_ack_at is not null acked, allocation_extended_at is not null extended
     from public.sessions where table_id = $1 and status in ('running', 'paused')`,
    [club.snooker3]
  )
  expect(held).toEqual({ status: 'running', acked: true, extended: false })
  await page.reload()
  await expect(card).toContainText("Time's up")
  await page.waitForTimeout(2_500)
  await expect(page.getByTestId('time-up-alert')).toHaveCount(0)

  // Ten more minutes pass unnoticed: the charge stays at the booking.
  await db(`update public.sessions set started_at = started_at - interval '10 minutes' where table_id = $1 and status = 'running'`, [club.snooker3])
  await page.reload()
  await expect(card).toContainText('PKR 300')
  await card.getByTestId('table-continue').click()
  await expect(card).toContainText('Booking complete')
  // Five minutes of extra play are billed per minute: 300 + 50.
  await db(`update public.sessions set started_at = started_at - interval '5 minutes' where table_id = $1 and status = 'running'`, [club.snooker3])
  await page.reload()
  await card.getByRole('button', { name: 'End' }).click()
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 350')
  await page.getByTestId('complete-checkout').click()
  await expect(page.getByTestId('receipt')).toContainText('350')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(card).toContainText('Available')
})

test('a fixed-amount booking alerts on its own; ending it from the alert bills the amount paid', async () => {
  // Snooker 2 has been playing on PKR 400 (40 minutes) since earlier: 2 seconds left.
  await db(
    `update public.sessions set started_at = now() - make_interval(secs => booked_seconds + paused_ms / 1000.0 - 2)
     where table_id = $1 and status = 'running'`,
    [club.snooker2]
  )
  await page.reload()
  const alert = page.getByTestId('time-up-alert')
  await expect(page.getByTestId('time-up-Snooker 2')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('time-up-Snooker 3')).toHaveCount(0) // each table alerts separately
  await expect(alert).toHaveAttribute('data-alarm', 'ringing')
  await page.getByTestId('time-up-Snooker 2').getByRole('button', { name: 'End session' }).click()
  await expect(alert).toHaveCount(0)
  const card = page.getByTestId('table-card-Snooker 2')
  await expect(card).toContainText('Checkout · PKR 400')
  await card.getByRole('button', { name: /Checkout/ }).click()
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 400')
  await page.getByRole('radio', { name: 'Bank Transfer' }).click()
  await page.getByTestId('complete-checkout').click()
  await expect(page.getByTestId('receipt')).toContainText('400')
  await page.getByRole('button', { name: 'Done' }).click()
})

test('Snacks: staff sell without a table; stock, sales and product profit follow', async () => {
  const stockOf = async (id: string) => (await db<{ n: number }>(`select stock_quantity n from public.inventory_products where id = $1`, [id]))[0]!.n
  const colaBefore = await stockOf(club.cola)
  await nav('Snacks').click()
  await page.getByTestId('snack-Doodh Patti Chai').click()
  await page.getByTestId('snack-Doodh Patti Chai').click()
  await page.getByTestId('snack-Cola 345ml').click()
  await expect(page.getByTestId('cart-qty-Doodh Patti Chai')).toHaveText('2')
  await expect(page.getByTestId('cart-total')).toHaveText('PKR 260')
  await page.getByRole('button', { name: 'Remove Cola 345ml' }).click()
  await page.getByTestId('snack-Cola 345ml').click()
  await expect(page.getByTestId('cart-total')).toHaveText('PKR 260')
  await shot('24-snacks')
  await page.getByTestId('snack-checkout').click()
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 260')
  await page.getByTestId('complete-checkout').click()
  await expect(page.getByTestId('receipt')).toContainText('260')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('snack-cart')).toContainText('Tap a product')
  await expect(page.getByTestId('snack-sales-total')).toHaveText('PKR 260')
  await expect(page.getByTestId('snack-sales-today')).toContainText('Doodh Patti Chai × 2')

  expect(await stockOf(club.cola)).toBe(colaBefore - 1)
  const [sale] = await db<{ session_id: string | null; table_name: string | null; final_amount: string }>(
    `select session_id, table_name, final_amount from public.sales where final_amount = 260`
  )
  expect(sale).toEqual({ session_id: null, table_name: null, final_amount: '260.00' })
})

test('the admin sees snack sales and the Table Sales Report with every date filter', async () => {
  await page.getByTestId('account-menu').click()
  await page.getByRole('menuitem', { name: 'Switch to Admin portal' }).click()
  await page.getByLabel('Admin master password').fill('owner-pass-123')
  await page.getByRole('button', { name: 'Unlock Admin' }).click()
  await expect(page.getByTestId('today-sales')).toBeVisible()
  // Every snack-only sale today (the Snacks page and earlier counter sales), live on the dashboard.
  const [snacks] = await db<{ total: string; n: number }>(`select sum(final_amount)::text total, count(*)::int n from public.sales where session_id is null`)
  await expect(page.getByTestId('snack-only-today')).toContainText(`PKR ${Number(snacks!.total).toLocaleString('en-PK')} (${snacks!.n} sales)`)

  // Snacks for an administrator: stock and every staff member's snack sales, no till.
  await nav('Snacks').click()
  await expect(page.getByTestId('snack-sales-today')).toContainText('staff ali')
  await expect(page.getByTestId('snack-cart')).toHaveCount(0)
  await expect(page.getByText('Administrators manage the business and do not take payments')).toBeVisible()

  // Table Sales Report: straight from the paid table invoices.
  const [day] = await db<{ total: string; cash: string; bank: string; sessions: number }>(
    `select sum(final_amount)::text total, coalesce(sum(final_amount) filter (where payment_method = 'cash'), 0)::text cash,
            coalesce(sum(final_amount) filter (where payment_method = 'bank_transfer'), 0)::text bank, count(*)::int sessions
     from public.sales where session_id is not null`
  )
  const money = (v: string) => `PKR ${Number(v).toLocaleString('en-PK')}`
  await nav('Tables').click()
  await page.getByRole('tab', { name: 'Table Sales Report' }).click()
  await expect(page.getByTestId('table-sales-total')).toHaveText(money(day!.total))
  await expect(page.getByTestId('table-sales-cash')).toHaveText(money(day!.cash))
  await expect(page.getByTestId('table-sales-bank')).toHaveText(money(day!.bank))
  await expect(page.getByTestId('table-sales-totals')).toContainText(`${day!.sessions} paid sessions`)
  await expect(page.getByTestId('table-sales-row-Snooker 3')).toContainText('PKR 350')
  await expect(page.getByTestId('table-sales-row-Snooker 2')).toContainText('PKR 400')
  await shot('25-table-sales')
  for (const preset of ['Weekly', 'Monthly']) {
    await page.getByRole('tab', { name: preset }).click()
    await expect(page.getByTestId('table-sales-total')).toHaveText(money(day!.total))
  }
  await page.getByRole('tab', { name: 'Yesterday' }).click()
  await expect(page.getByTestId('table-sales-total')).toHaveText('PKR 0')
  await page.getByRole('tab', { name: 'Custom' }).click()
  await expect(page.getByLabel('From')).toBeVisible()
  await expect(page.getByTestId('table-sales-total')).toHaveText('PKR 0') // custom starts from the last period (yesterday)
  await page.getByRole('tab', { name: 'Today' }).click()
  await expect(page.getByTestId('table-sales-total')).toHaveText(money(day!.total))
})

test('hourly + special 30-minute pricing: priced by duration, extensions re-price the total, checkout at that price', async () => {
  // The admin prices PS5 by the hour: PKR 600/hour, 30 minutes PKR 400.
  await nav('Settings').click()
  await page.getByRole('button', { name: 'Categories & rates' }).click()
  await page.getByRole('button', { name: 'Add category' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('PS5')
  await dialog.getByRole('tab', { name: 'Hourly + special 30-minute rate' }).click()
  await dialog.getByTestId('category-hourly').fill('600')
  await dialog.getByTestId('category-special').fill('400')
  const table = dialog.getByTestId('category-price-table')
  for (const price of ['PKR 400', 'PKR 600', 'PKR 900', 'PKR 1,200', 'PKR 1,500', 'PKR 1,800']) await expect(table).toContainText(price)
  await shot('26-hourly-category')
  await dialog.getByTestId('save-category').click()
  await expect(page.getByTestId('category-price-PS5')).toHaveText('PKR 600/hour · 30 min PKR 400')
  await expect(page.getByTestId('category-price-Snooker')).toHaveText('PKR 10/min') // per-minute categories unchanged
  await db(
    `insert into public.club_tables (name, category_id, floor_id, sort_order)
     values ('PS5 Lounge', (select id from public.table_categories where name = 'PS5'), $1, 9)`,
    [club.ground]
  )

  // Ali (staff) starts an hour: the price is shown before confirming.
  await page.getByTestId('account-menu').click()
  await page.getByRole('menuitem', { name: 'Switch to Staff portal' }).click()
  await page.getByRole('button', { name: /staff ali/ }).click()
  await page.getByLabel('Password').fill('ali-pass-123')
  await page.getByRole('button', { name: 'Switch' }).click()
  await nav('Tables').click()
  const card = page.getByTestId('table-card-PS5 Lounge')
  await expect(card).toContainText('PKR 600/hour · 30 min PKR 400')
  await card.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('button', { name: /Open play/ })).toHaveCount(0)
  await page.getByTestId('duration-30').click()
  await expect(page.getByTestId('duration-price')).toHaveText('PKR 400')
  await page.getByTestId('duration-90').click()
  await expect(page.getByTestId('duration-price')).toHaveText('PKR 900')
  await page.getByTestId('duration-60').click()
  await expect(page.getByTestId('duration-price')).toHaveText('PKR 600')
  await shot('27-hourly-start')
  await page.getByTestId('confirm-start').click()
  await expect(card).toContainText('PKR 600')

  // Extending by 30 minutes re-prices the whole time: 1.5 hours = PKR 900, not 600 + 400.
  await card.click()
  await expect(page.getByTestId('extend-30')).toContainText('1.5 h · PKR 900')
  await page.getByTestId('extend-30').click()
  await expect(page.getByTestId('extend-30')).toContainText('2 h · PKR 1,200')
  await page.keyboard.press('Escape')
  await expect(card).toContainText('PKR 900')

  // Time's up (moved forward in the database): the alert offers extensions, not per-minute play.
  await db(`update public.sessions set started_at = now() - interval '90 minutes' + interval '2 seconds' where table_id = (select id from public.club_tables where name = 'PS5 Lounge') and status = 'running'`)
  await page.reload()
  await expect(page.getByTestId('time-up-PS5 Lounge')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('time-up-PS5 Lounge').getByRole('button', { name: 'Continue playing' })).toHaveCount(0)
  await page.getByTestId('time-up-PS5 Lounge').getByTestId('alert-extend-30').click()
  await expect(page.getByTestId('time-up-alert')).toHaveCount(0)
  await expect(card).toContainText('PKR 1,200')
  const [booked] = await db<{ seconds: number; amount: string; acked: boolean }>(
    `select booked_seconds seconds, booked_amount::text amount, allocation_alert_ack_at is not null acked from public.sessions
     where table_id = (select id from public.club_tables where name = 'PS5 Lounge') and status = 'running'`
  )
  expect(booked).toEqual({ seconds: 7200, amount: '1200.00', acked: false })

  // Checkout charges the booked price; there is no per-minute custom rate for this table.
  await card.getByRole('button', { name: 'End' }).click()
  await expect(page.getByTestId('checkout-total')).toHaveText('PKR 1,200')
  await expect(page.getByTestId('custom-rate')).toHaveCount(0)
  await page.getByTestId('complete-checkout').click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toContainText('PKR 600/hour')
  await expect(receipt).not.toContainText('PKR 400') // only the price that applied
  await expect(receipt).toContainText('1,200')
  await shot('28-hourly-receipt')
  await page.getByRole('button', { name: 'Done' }).click()
  const [sale] = await db<{ base: string }>(`select base_amount::text base from public.sales where table_name = 'PS5 Lounge'`)
  expect(sale!.base).toBe('1200.00')
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

// Last: it wipes the business data every earlier test created.
test('Reset business data: password, optional backup, typed confirmation; logins, prices and stock stay', async () => {
  const counts = async () =>
    (await db<{ sales: number; sessions: number; shifts: number; customers: number; expenses: number }>(
      `select (select count(*)::int from public.sales) sales, (select count(*)::int from public.sessions) sessions,
              (select count(*)::int from public.counter_shifts) shifts, (select count(*)::int from public.customers) customers,
              (select count(*)::int from public.expenses) expenses`
    ))[0]!
  const kept = async () =>
    db(`select (select count(*)::int from public.app_users) users, (select count(*)::int from public.club_tables) tables,
               (select json_agg(c order by c.id) from (select id, name, pricing_mode, rate_per_minute, hourly_rate, special_30_rate from public.table_categories) c) categories,
               (select json_agg(p order by p.name) from (select name, selling_price, cost_price, stock_quantity from public.inventory_products) p) products,
               (select club_name || '/' || business_timezone || '/' || sales_retention_days from public.settings) settings`)
  const before = await counts()
  expect(before.sales).toBeGreaterThan(0)
  const keptBefore = await kept()

  await page.getByTestId('login-username').fill('owner')
  await page.getByTestId('login-password').fill('owner-pass-123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await nav('Settings').click()
  await page.getByRole('button', { name: 'Data management' }).click()
  const panel = page.getByTestId('data-management')
  await expect(panel).toContainText('Reset business data')

  // Cancel at any step leaves everything as it was.
  await page.getByTestId('open-reset').click()
  await expect(page.getByTestId('reset-step-review')).toContainText('Invoices — table and snack sales')
  await page.getByTestId('reset-cancel').click()
  expect(await counts()).toEqual(before)

  await page.getByTestId('open-reset').click()
  await expect(page.getByTestId('reset-step-review')).toContainText('Admin and staff logins, roles and permissions')
  await shot('29-reset-review')
  await page.getByTestId('reset-continue').click()
  await page.getByTestId('reset-password').fill('not-my-password')
  await page.getByTestId('reset-continue').click()
  await expect(page.getByTestId('reset-step-password')).toContainText('incorrect')
  await page.getByTestId('reset-password').fill('owner-pass-123')
  await page.getByTestId('reset-continue').click()

  // The backup is optional; here the admin takes one.
  await expect(page.getByTestId('reset-skip-backup')).toHaveText('Skip backup & continue')
  const downloading = page.waitForEvent('download')
  await page.getByTestId('reset-export').click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^FUSION-business-data-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
  const backup = JSON.parse(readFileSync(await download.path(), 'utf8')) as { format: string; tables: Record<string, unknown[]> }
  expect(backup.format).toBe('fusion-business-data-backup')
  expect(backup.tables.sales).toHaveLength(before.sales)
  expect(backup.tables.customers).toHaveLength(before.customers)
  await expect(page.getByTestId('reset-backup-done')).toBeVisible()
  expect(await counts()).toEqual(before) // exporting changes nothing
  await page.getByTestId('reset-skip-backup').click() // now labelled Continue

  // The final button stays locked until the exact phrase is typed.
  const confirm = page.getByTestId('reset-confirm')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('reset-phrase').fill('reset business data')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('reset-phrase').fill('RESET BUSINESS DATA')
  await shot('30-reset-confirm')
  await confirm.click()
  await expect(page.getByTestId('reset-summary')).toContainText('All business data was reset')
  await shot('31-reset-done')
  await page.getByTestId('reset-done').click()

  expect(await counts()).toEqual({ sales: 0, sessions: 0, shifts: 0, customers: 0, expenses: 0 })
  expect(await kept()).toEqual(keptBefore) // logins, tables, prices, products and stock all stay
  await expect(page.getByTestId('last-reset')).toContainText('admin owner')
  await nav('Dashboard').click()
  await expect(page.getByTestId('today-total')).toHaveText('PKR 0')
  await nav('Reports').click()
  await expect(page.getByTestId('report-total')).toHaveText('PKR 0')
})

// --- Phones and tablets ------------------------------------------------------
// The same app on touch screens. These run after the reset, on the club it
// kept (tables, prices, stock, logins) — so every sale below is a fresh one.

const STAFF_PAGES = ['/', '/tables', '/snacks', '/counter', '/sales']
const ADMIN_PAGES = [
  '/', '/tables', '/tables?view=report', '/snacks', '/bookings', '/history', '/history?tab=shifts', '/history?tab=invoices',
  '/history?tab=close', '/reports', '/expenses', '/inventory', '/inventory?view=sales', '/customers', '/staff', '/settings'
]

/** A fresh browser tab at a device size (phones also report touch and a mobile user agent). */
async function device(width: number, height: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width < 768, hasTouch: width < 1024, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  return ctx.newPage()
}
async function signInAs(p: Page, username: string, password: string) {
  await p.goto(E2E.appUrl + '/')
  await p.getByTestId('login-username').fill(username)
  await p.getByTestId('login-password').fill(password)
  await p.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.locator('#main')).toBeVisible()
}
/** How far the page would scroll sideways (0 = everything fits the screen). */
const sideways = (p: Page) =>
  p.evaluate(() => {
    const main = document.getElementById('main')!
    return Math.max(document.documentElement.scrollWidth - window.innerWidth, main.scrollWidth - main.clientWidth)
  })
const shotOf = async (p: Page, name: string) => {
  await p.waitForTimeout(900)
  await p.screenshot({ path: join(SHOTS, `${name}.png`) })
}
/** Every page fits the screen without sideways scrolling. */
async function expectPagesFit(p: Page, paths: string[], label: string) {
  for (const path of paths) {
    await p.goto(E2E.appUrl + path)
    await expect(p.locator('#main h1').first()).toBeVisible()
    await p.waitForTimeout(400)
    expect(await sideways(p), `${label} ${path} scrolls sideways`).toBe(0)
  }
}

test('Phone: staff run a table from start to payment and sell snacks, all by touch', async () => {
  const p = await device(375, 812)
  await signInAs(p, 'ali', 'ali-pass-123')
  const tabs = p.getByRole('navigation', { name: 'Main' })
  // The tab bar replaces the sidebar; the role's own pages are on it.
  await expect(p.getByTestId('mobile-nav')).toBeVisible()
  await expect(p.locator('aside[data-layout]')).toBeHidden()
  for (const name of ['Dashboard', 'Tables', 'Snacks', 'My counter', 'More']) await expect(tabs.getByRole(name === 'More' ? 'button' : 'link', { name })).toBeVisible()

  await tabs.getByRole('link', { name: 'My counter' }).click()
  await p.getByTestId('counter-closed').getByRole('button', { name: 'Open counter' }).click()
  await expect(p.getByTestId('my-counter')).toBeVisible()

  // Start a table, pause and resume it from its card.
  await tabs.getByRole('link', { name: 'Tables' }).click()
  const card = p.getByTestId('table-card-Snooker 3')
  await card.getByRole('button', { name: 'Start' }).click()
  await expect(p.getByRole('dialog', { name: 'Start Snooker 3' })).toBeVisible()
  await p.getByTestId('confirm-start').click()
  await expect(card).toContainText('Running')
  await db(`update public.sessions set started_at = started_at - interval '20 minutes' where table_id = $1 and status = 'running'`, [club.snooker3])
  await card.getByRole('button', { name: 'Pause' }).click()
  await expect(card).toContainText('Paused')
  await card.getByRole('button', { name: 'Resume' }).click()
  await expect(card).toContainText('Running')

  // Its tab, in the bottom sheet: two colas.
  await card.getByRole('heading', { name: 'Snooker 3' }).click()
  const sheet = p.getByRole('dialog', { name: 'Snooker 3' })
  await sheet.getByTestId('product-search').fill('cola')
  await p.getByRole('button', { name: /Cola 345ml/ }).click()
  await expect(sheet).toContainText('Cola 345ml')
  await sheet.getByRole('button', { name: 'Increase' }).click()
  await expect(sheet.locator('li').filter({ hasText: 'Cola 345ml' })).toContainText('PKR 200')
  expect(await sideways(p)).toBe(0)
  await shotOf(p, '32-phone-session')
  await sheet.getByTestId('end-session').click()

  // Checkout: the database's own table charge plus the colas; paid in cash.
  const checkout = p.getByRole('dialog', { name: /Checkout · Snooker 3/ })
  await expect(checkout).toBeVisible()
  const [ended] = await db<{ base: string }>(`select base_amount::text base from public.sessions where table_id = $1 and status = 'billing'`, [club.snooker3])
  const expected = Number(ended!.base) + 200
  await expect(p.getByTestId('checkout-total')).toHaveText(`PKR ${expected.toLocaleString('en-US')}`)
  await shotOf(p, '33-phone-checkout')
  await p.getByTestId('complete-checkout').click()
  await expect(p.getByTestId('receipt')).toContainText('Snooker 3')
  await p.getByRole('button', { name: 'Done' }).click()
  await expect(card).toContainText('Available')
  const [tableSale] = await db<{ final: string; items: string; method: string }>(
    `select final_amount::text final, products_subtotal::text items, payment_method method from public.sales where table_name = 'Snooker 3'`
  )
  expect(tableSale).toEqual({ final: expected.toFixed(2), items: '200.00', method: 'cash' })

  // Snacks without a table: the cart bar follows the thumb.
  await tabs.getByRole('link', { name: 'Snacks' }).click()
  await p.getByTestId('snack-Doodh Patti Chai').click()
  await p.getByTestId('snack-Doodh Patti Chai').click()
  await p.getByTestId('snack-Cola 345ml').click()
  const bar = p.getByTestId('snack-cart-bar')
  await expect(bar).toContainText('3 items')
  await expect(bar).toContainText('PKR 260')
  await shotOf(p, '34-phone-snacks')
  await p.getByTestId('snack-cart-bar-checkout').click()
  await expect(p.getByTestId('checkout-total')).toHaveText('PKR 260')
  await p.getByRole('radio', { name: 'Bank Transfer' }).click()
  await p.getByTestId('complete-checkout').click()
  await expect(p.getByTestId('receipt')).toContainText('Bank Transfer')
  await p.getByRole('button', { name: 'Done' }).click()
  await expect(bar).toHaveCount(0)
  const [snackSale] = await db<{ session_id: string | null; final: string; method: string }>(
    `select session_id, final_amount::text final, payment_method method from public.sales where table_name is null`
  )
  expect(snackSale).toEqual({ session_id: null, final: '260.00', method: 'bank_transfer' })

  // More: the rest of the staff member's pages and the account — nothing of the admin's.
  await tabs.getByRole('button', { name: 'More' }).click()
  const more = p.getByTestId('more-sheet')
  await expect(more.getByRole('link', { name: 'My sales' })).toBeVisible()
  for (const adminOnly of ['Settings', 'Staff', 'Reports', 'Expenses', 'History']) await expect(more.getByRole('link', { name: adminOnly })).toHaveCount(0)
  await more.getByRole('link', { name: 'My sales' }).click()
  await expect(p.getByRole('heading', { name: 'My sales' })).toBeVisible()
  await p.goto(E2E.appUrl + '/settings')
  await expect(p).toHaveURL(E2E.appUrl + '/') // still admin-only

  await expectPagesFit(p, STAFF_PAGES, 'staff 375')
  await tabs.getByRole('button', { name: 'More' }).click()
  await p.getByTestId('mobile-sign-out').click()
  await expect(p.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await p.context().close()
})

test('Phone: the admin reaches every page from the tab bar and More, and records an expense', async () => {
  const p = await device(360, 740)
  await signInAs(p, 'owner', 'owner-pass-123')
  const tabs = p.getByRole('navigation', { name: 'Main' })
  for (const name of ['Dashboard', 'Tables', 'Reports', 'History']) await expect(tabs.getByRole('link', { name })).toBeVisible()
  await tabs.getByRole('button', { name: 'More' }).click()
  const more = p.getByTestId('more-sheet')
  for (const name of ['Snacks', 'Pre-bookings', 'Expenses', 'Inventory', 'Customers', 'Staff', 'Settings']) await expect(more.getByRole('link', { name })).toBeVisible()
  await expect(p.getByTestId('mobile-account')).toContainText('Admin portal')
  await shotOf(p, '35-phone-admin-more')
  await more.getByRole('link', { name: 'Expenses' }).click()
  await expect(p.getByRole('heading', { name: 'Expenses' })).toBeVisible()

  // A business expense from the bottom sheet.
  await p.getByTestId('add-expense').click()
  const dialog = p.getByRole('dialog', { name: 'Add a business expense' })
  await dialog.getByRole('combobox').click()
  await p.getByRole('option', { name: 'Utilities' }).click()
  await p.getByTestId('expense-amount').fill('1500')
  await p.getByTestId('expense-description').fill('Generator diesel')
  await p.getByTestId('save-expense').click()
  await expect(dialog).toHaveCount(0)
  await expect(p.getByTestId('expense-list')).toContainText('Generator diesel')
  const [expense] = await db<{ amount: string; category: string }>(`select amount::text, category from public.expenses where description = 'Generator diesel'`)
  expect(expense).toEqual({ amount: '1500.00', category: 'utilities' })

  // Settings: every section opens; Reset business data opens and cancels without touching anything.
  await p.goto(E2E.appUrl + '/settings')
  await p.getByRole('button', { name: 'Categories & rates' }).click()
  await expect(p.getByTestId('category-price-PS5')).toHaveText('PKR 600/hour · 30 min PKR 400')
  await p.getByRole('button', { name: 'Data management' }).click()
  await p.getByTestId('open-reset').click()
  await expect(p.getByTestId('reset-step-review')).toBeVisible()
  await shotOf(p, '36-phone-reset-review')
  await p.getByTestId('reset-cancel').click()
  const [{ n }] = (await db<{ n: number }>(`select count(*)::int n from public.sales`)) as [{ n: number }]
  expect(n).toBe(2) // the two phone sales above, untouched

  // Administrators still do not take payments on a phone.
  await p.goto(E2E.appUrl + '/snacks')
  await expect(p.getByText('Administrators manage the business and do not take payments.')).toBeVisible()

  await expectPagesFit(p, ADMIN_PAGES, 'admin 360')
  await shotOf(p, '37-phone-admin-settings')
  await p.context().close()
})

test('Every page fits a 320 px phone and both tablet orientations; the desktop keeps its sidebar', async () => {
  for (const [w, h] of [
    [320, 640],
    [768, 1024],
    [1024, 768]
  ] as const) {
    for (const [user, pass, paths] of [
      ['ali', 'ali-pass-123', STAFF_PAGES],
      ['owner', 'owner-pass-123', ADMIN_PAGES]
    ] as const) {
      const p = await device(w, h)
      await signInAs(p, user, pass)
      // Phones get the tab bar; tablets keep the sidebar rail.
      await expect(p.getByTestId('mobile-nav')).toBeVisible({ visible: w < 768 })
      await expect(p.locator('aside[data-layout]')).toBeVisible({ visible: w >= 768 })
      await expectPagesFit(p, [...paths], `${user} ${w}x${h}`)
      if (w === 768 && user === 'owner') await shotOf(p, '38-tablet-settings')
      await p.context().close()
    }
  }
  // The desktop window (the earlier tests' 1440 px tab) is unchanged: sidebar, no tab bar.
  await page.goto(E2E.appUrl + '/') // still signed in as the owner from the reset test
  await expect(page.locator('#main')).toBeVisible()
  await expect(page.locator('aside[data-layout="wide"]')).toBeVisible()
  await expect(page.getByTestId('mobile-nav')).toBeHidden()
  await expect(page.getByTestId('mobile-topbar')).toBeHidden()
})

test('an under-1-hour rate prices short play higher; a split payment records cash and bank', async () => {
  // The owner prices a category: PKR 600/hour from 1 hour, PKR 800/hour under 1 hour.
  await page.goto(E2E.appUrl + '/settings')
  await page.getByRole('button', { name: 'Categories & rates' }).click()
  await page.getByRole('button', { name: 'Add category' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('PS5 Pro')
  await dialog.getByRole('tab', { name: 'Hourly + under-1-hour rate' }).click()
  await dialog.getByTestId('category-hourly').fill('600')
  await dialog.getByTestId('category-under-hour').fill('500')
  await expect(dialog.getByText('Must be higher than the hourly rate.')).toBeVisible()
  await expect(dialog.getByTestId('save-category')).toBeDisabled()
  await dialog.getByTestId('category-under-hour').fill('800')
  const prices = dialog.getByTestId('category-price-table')
  for (const [length, price] of [['15 min', 'PKR 200'], ['45 min', 'PKR 600'], ['1 h', 'PKR 600'], ['1.5 h', 'PKR 900']]) {
    await expect(prices.locator('div').filter({ hasText: length! }).first()).toContainText(price!)
  }
  await shot('39-under-hour-category')
  await dialog.getByTestId('save-category').click()
  await expect(page.getByTestId('category-price-PS5 Pro')).toHaveText('PKR 600/hour · under 1 h PKR 800/hour')
  await db(
    `insert into public.club_tables (name, category_id, floor_id, sort_order)
     values ('PS5 Pro 1', (select id from public.table_categories where name = 'PS5 Pro'), $1, 10)`,
    [club.ground]
  )

  // Staff (their counter is still open): the start dialog prices by the new rule.
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage()
  await p.goto(E2E.appUrl + '/')
  await p.getByTestId('login-username').fill('ali')
  await p.getByTestId('login-password').fill('ali-pass-123')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tables' }).click()
  const card = p.getByTestId('table-card-PS5 Pro 1')
  await expect(card).toContainText('PKR 600/hour · under 1 h PKR 800/hour')
  await card.getByRole('button', { name: 'Start' }).click()
  const start = p.getByRole('dialog', { name: 'Start PS5 Pro 1' })
  await start.getByRole('button', { name: /Fixed time/ }).click()
  await start.getByLabel('Minutes').fill('30')
  await expect(start).toContainText('30 min for PKR 400')
  await start.getByLabel('Minutes').fill('90')
  await expect(start).toContainText('1 h 30 min for PKR 900')
  await start.getByRole('button', { name: /Fixed amount/ }).click()
  await start.getByLabel('Amount received').fill('400')
  await expect(start).toContainText('PKR 400 buys 30 min of play')
  await start.getByRole('button', { name: /Open play/ }).click()
  await p.getByTestId('confirm-start').click()
  await expect(card).toContainText('Running')

  // 15 minutes of play: billed at PKR 800/hour.
  await db(`update public.sessions set started_at = started_at - interval '15 minutes' where table_id = (select id from public.club_tables where name = 'PS5 Pro 1') and status = 'running'`)
  await card.getByRole('button', { name: 'End' }).click()
  const [ended] = await db<{ seconds: number; base: string }>(
    `select billable_seconds seconds, base_amount::text base from public.sessions where table_id = (select id from public.club_tables where name = 'PS5 Pro 1') and status = 'billing'`
  )
  const base = Number(ended!.base)
  expect(base).toBe(Math.round((Math.ceil(ended!.seconds / 60) * 800) / 60)) // under an hour: 800/hour
  await expect(p.getByTestId('checkout-total')).toHaveText(`PKR ${base}`)
  await expect(p.getByTestId('custom-rate')).toHaveCount(0) // no per-minute custom rate for this pricing

  // Split: PKR 50 in cash, the rest by bank transfer.
  await p.getByTestId('payment-split').click()
  await expect(p.getByTestId('complete-checkout')).toBeDisabled()
  await p.getByTestId('split-bank').fill(String(base - 50))
  await expect(p.getByTestId('split-cash')).toHaveValue('50')
  await p.getByTestId('split-cash').fill(String(base))
  await expect(p.getByTestId('split-payment')).toContainText('Both parts must be above zero')
  await expect(p.getByTestId('complete-checkout')).toBeDisabled()
  await p.getByTestId('split-cash').fill('50')
  await expect(p.getByTestId('split-bank')).toHaveValue(String(base - 50))
  await expect(p.getByTestId('split-summary')).toContainText(`Cash PKR 50 + Bank PKR ${base - 50}`)
  await shotOf(p, '40-split-payment')
  await p.getByTestId('complete-checkout').click()
  const receipt = p.getByTestId('receipt')
  await expect(receipt).toContainText('Cash + Bank')
  await expect(receipt).toContainText('PKR 600/hour · under 1 h PKR 800/hour')
  await expect(p.getByText(`Cash PKR 50 + Bank PKR ${base - 50}`)).toBeVisible()
  await shotOf(p, '41-split-receipt')
  await p.getByRole('button', { name: 'Done' }).click()

  const [sale] = await db<{ method: string; cash: string; final: string }>(
    `select payment_method method, split_cash_amount::text cash, final_amount::text final from public.sales where table_name = 'PS5 Pro 1'`
  )
  expect(sale).toEqual({ method: 'split', cash: '50.00', final: base.toFixed(2) })
  // The counter's cash and bank include each part.
  const [shift] = await db<{ cash: string; bank: string }>(
    `select cash_sales::text cash, bank_sales::text bank from public.counter_shifts where user_id = $1 and status = 'open'`,
    [ali.id]
  )
  const [parts] = await db<{ cash: string; bank: string }>(
    `select sum(public.fusion_cash_part(s))::text cash, sum(public.fusion_bank_part(s))::text bank from public.sales s
     where s.shift_id = (select id from public.counter_shifts where user_id = $1 and status = 'open')`,
    [ali.id]
  )
  expect(shift).toEqual(parts)

  // The admin's invoice list shows both parts.
  await page.goto(E2E.appUrl + '/history?tab=invoices')
  await expect(page.getByText(`Cash PKR 50 + Bank PKR ${base - 50}`)).toBeVisible()
  await p.context().close()
})

test('the app installs on a phone home screen as FUSION GAMES with the real logo', async () => {
  const res = await page.request.get(E2E.appUrl + '/manifest.json')
  expect(res.ok()).toBe(true)
  const manifest = (await res.json()) as { short_name: string; name: string; display: string; icons: { src: string; sizes: string; purpose: string }[] }
  expect(manifest).toMatchObject({ short_name: 'FUSION GAMES', name: 'FUSION Gaming Lounge', display: 'standalone' })
  expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable'])
  for (const icon of [...manifest.icons.map((i) => i.src), '/apple-touch-icon.png']) {
    const r = await page.request.get(E2E.appUrl + icon)
    expect(r.headers()['content-type'], icon).toContain('image/png')
    expect((await r.body()).length, icon).toBeGreaterThan(20_000) // the logo, not a placeholder
  }
  await page.goto(E2E.appUrl + '/')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.json')
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'FUSION GAMES')
})

test('the production build: developer tools cannot attach, the console stays silent, stock changes are logged', async () => {
  // A browser with the React DevTools extension: its hook exists before the page loads.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__devtoolsSaw = 0
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => {
        ;(w.__devtoolsSaw as number)++
        return 1
      },
      onCommitFiberRoot: () => {
        ;(w.__devtoolsSaw as number)++
      },
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      checkDCE: () => undefined
    }
  })
  const p = await ctx.newPage()
  const messages: string[] = []
  // Messages from the page's own scripts. The browser itself still reports failed network requests (a wrong
  // password's 400; this test server has no realtime socket) — those are not written by the app.
  p.on('console', (m) => {
    if (!/^(Failed to load resource|WebSocket connection to)/.test(m.text())) messages.push(`${m.type()}: ${m.text()}`)
  })
  await p.goto(E2E.appUrl + '/')
  // The guard is the first script, before the app's own code.
  await expect(p.locator('head script').first()).toHaveAttribute('src', '/runtime-guard.js')
  await p.getByTestId('login-username').fill('owner')
  await p.getByTestId('login-password').fill('not-the-password') // a failed sign-in logs nothing either
  await p.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.getByText('Incorrect username or password.')).toBeVisible()
  await p.getByTestId('login-password').fill('owner-pass-123')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
  await expect(p.getByTestId('report-total')).toBeVisible()
  expect(await p.evaluate(() => (window as unknown as { __devtoolsSaw: number }).__devtoolsSaw)).toBe(0)
  expect(messages).toEqual([])

  // Stock: a restock is logged with who made it; the log shows in the stock dialog.
  await p.goto(E2E.appUrl + '/inventory')
  const before = (await db<{ n: number }>(`select stock_quantity n from public.inventory_products where id = $1`, [club.cola]))[0]!.n
  await p.getByRole('row', { name: /Cola 345ml/ }).getByRole('button', { name: 'Restock / correct stock' }).click()
  const dialog = p.getByRole('dialog')
  await dialog.getByLabel('Quantity').fill('6')
  await dialog.getByRole('button', { name: 'Add stock' }).click()
  await expect(dialog).toHaveCount(0)
  await p.getByRole('row', { name: /Cola 345ml/ }).getByRole('button', { name: 'Restock / correct stock' }).click()
  const log = p.getByTestId('stock-log')
  await expect(log).toContainText('Received · admin owner')
  await expect(log).toContainText(`${before + 6} after`)
  const [entry] = await db<{ delta: number; stock_after: number; source: string }>(
    `select delta, stock_after, source from public.stock_adjustments where product_id = $1 order by id desc limit 1`,
    [club.cola]
  )
  expect(entry).toEqual({ delta: 6, stock_after: before + 6, source: 'adjust' })
  expect(messages).toEqual([])
  await ctx.close()
})
