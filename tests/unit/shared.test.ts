import { describe, expect, it } from 'vitest'
import { AUTH_EMAIL_DOMAIN, USERNAME_PATTERN, usernameToEmail } from '@shared/constants'
import {
  addDays,
  formatClock,
  formatDateTime,
  formatDuration,
  formatHour,
  formatMoney,
  formatRate,
  formatTime,
  fromClockParts,
  toClockParts
} from '@shared/format'
import { receiptSchema, renderReceiptHtml, type Receipt } from '@shared/receipt'
import { isServiceRoleJwt, validateServerConfig } from '../../src/main/validation'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const receipt: Receipt = {
  sale_id: '2b1c3f9e-6c7d-4e5f-8a9b-0c1d2e3f4a5b',
  receipt_no: 42,
  created_at: '2026-10-31T15:04:00Z',
  business_date: '2026-10-31',
  club: { name: 'FUSION', address: 'Main Blvd', phone: '0300', footer: 'Thanks' },
  table_name: 'Snooker 1',
  floor_name: 'Ground',
  customer_name: '<img src=x onerror=alert(1)>',
  customer_phone: null,
  cashier_name: 'Ali',
  payment_method: 'cash',
  session: { started_at: '2026-10-31T14:00:00Z', ended_at: '2026-10-31T15:00:00Z', billable_seconds: 3600, rate_per_minute: 10, booked_seconds: null, booked_amount: null },
  base_amount: 600,
  items: [{ name: 'Cola & "Chips"', unit_price: 100, quantity: 2, line_total: 200 }],
  products_subtotal: 200,
  discount: 10,
  final_amount: 790
}

describe('formatting', () => {
  it('formats money, clocks and durations', () => {
    expect(formatMoney(1250)).toBe('PKR 1,250')
    expect(formatMoney(99.5)).toBe('PKR 99.50')
    expect(formatClock(125)).toBe('2:05')
    expect(formatClock(3725)).toBe('1:02:05')
    expect(formatDuration(3720)).toBe('1 h 2 min')
    expect(formatRate(10)).toBe('PKR 10/min')
    expect(formatRate(7.5)).toBe('PKR 7.50/min')
    expect(formatRate('6.6667')).toBe('PKR 6.6667/min')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('shows every time of day in 12-hour form', () => {
    const tz = 'Asia/Karachi' // UTC+5
    expect(formatTime('2026-10-31T20:30:00Z', tz)).toBe('01:30 AM')
    expect(formatTime('2026-10-31T04:45:00Z', tz)).toBe('09:45 AM')
    expect(formatTime('2026-10-31T07:00:00Z', tz)).toBe('12:00 PM')
    expect(formatTime('2026-10-31T14:15:00Z', tz)).toBe('07:15 PM')
    expect(formatTime('2026-10-31T19:00:00Z', tz)).toBe('12:00 AM')
    expect(formatDateTime('2026-10-31T14:15:00Z', tz)).toBe('31 Oct 2026, 07:15 PM')
    expect([0, 1, 11, 12, 13, 23].map((h) => formatHour(h))).toEqual(['12 AM', '1 AM', '11 AM', '12 PM', '1 PM', '11 PM'])
    expect(formatHour(18, true)).toBe('06:00 PM')
    for (const text of [formatTime('2026-10-31T13:05:00Z', tz), formatDateTime('2026-10-31T13:05:00Z', tz), formatHour(13)]) {
      expect(text).toMatch(/\b(AM|PM)\b/)
      expect(text).not.toMatch(/\b(1[3-9]|2[0-3]):\d\d\b/)
    }
  })

  it('converts between 12-hour picker values and stored times', () => {
    expect(toClockParts('19:30')).toEqual({ hour: 7, minute: 30, period: 'PM' })
    expect(toClockParts('00:05')).toEqual({ hour: 12, minute: 5, period: 'AM' })
    expect(toClockParts('12:00')).toEqual({ hour: 12, minute: 0, period: 'PM' })
    expect(fromClockParts(12, 0, 'AM')).toBe('00:00')
    expect(fromClockParts(12, 15, 'PM')).toBe('12:15')
    expect(fromClockParts(7, 30, 'PM')).toBe('19:30')
    for (let h = 0; h < 24; h++) {
      const t = `${String(h).padStart(2, '0')}:45`
      const p = toClockParts(t)
      expect(fromClockParts(p.hour, p.minute, p.period)).toBe(t)
    }
  })
})

describe('receipt printing', () => {
  it('validates receipt data and escapes every value', () => {
    expect(receiptSchema.parse(receipt)).toEqual(receipt)
    const html = renderReceiptHtml(receipt, { paper: '80mm', timeZone: 'Asia/Karachi' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Cola &amp; &quot;Chips&quot;')
    expect(html).toContain('790')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('PKR 10/min')
    expect(html).not.toMatch(/hour|\/h\b/i)
  })

  it('shows a custom rate with the standard rate it replaced', () => {
    const custom: Receipt = {
      ...receipt,
      session: { ...receipt.session!, billable_seconds: 6000, rate_per_minute: 9, standard_rate_per_minute: 10, standard_base_amount: 1000 },
      base_amount: 900,
      items: [],
      products_subtotal: 0,
      discount: 30,
      final_amount: 870
    }
    expect(receiptSchema.parse(custom)).toEqual(custom)
    const html = renderReceiptHtml(custom, { paper: '80mm' })
    expect(html).toContain('PKR 9/min (custom)')
    expect(html).toContain('Standard rate')
    expect(html).toContain('PKR 10/min')
    expect(html).toContain('870')
  })

  it('rejects malformed receipts and unknown payment methods', () => {
    expect(receiptSchema.safeParse({ ...receipt, payment_method: 'credit' }).success).toBe(false)
    expect(receiptSchema.safeParse({ ...receipt, final_amount: -1 }).success).toBe(false)
  })
})

describe('server connection validation', () => {
  const anon = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') + '.sig'
  const service = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.sig'

  it('accepts https project URLs with a public key', () => {
    expect(validateServerConfig('https://abcd.supabase.co', anon)).toBeNull()
    expect(validateServerConfig('https://abcd.supabase.co', 'sb_publishable_abcdefghijklmnop')).toBeNull()
    expect(validateServerConfig('http://127.0.0.1:54321', anon)).toBeNull()
  })

  it('refuses insecure URLs and secret keys', () => {
    expect(validateServerConfig('http://abcd.supabase.co', anon)).toMatch(/https/)
    expect(validateServerConfig('https://abcd.supabase.co/rest/v1', anon)).toMatch(/without a path/)
    expect(validateServerConfig('https://abcd.supabase.co', service)).toMatch(/secret service key/)
    expect(validateServerConfig('https://abcd.supabase.co', 'sb_secret_abcdefghijklmnopqrst')).toMatch(/secret service key/)
    expect(isServiceRoleJwt(anon)).toBe(false)
  })
})

describe('auth identity mapping', () => {
  it('maps usernames to the shared synthetic email domain everywhere', () => {
    expect(usernameToEmail(' Ali.Khan ')).toBe('ali.khan@fusion.local')
    expect(USERNAME_PATTERN.test('ali')).toBe(true)
    expect(USERNAME_PATTERN.test('a')).toBe(false)
    expect(USERNAME_PATTERN.test('drop table;')).toBe(false)
    const root = join(__dirname, '..', '..')
    for (const file of ['supabase/functions/admin-users/index.ts', 'scripts/create-admin.mjs']) {
      expect(readFileSync(join(root, file), 'utf8')).toContain(`AUTH_EMAIL_DOMAIN = '${AUTH_EMAIL_DOMAIN}'`)
    }
  })
})
