import { describe, expect, it } from 'vitest'
import { everyDay, hourRange } from '../../src/renderer/src/features/reports/salesTrendModel'

const day = (hours: number[], dayStart = 6) => ({
  hours: hours.map((hour) => ({ hour, cash: 100, bank: 0, total: 100, invoices: 1 })),
  day_start_hour: dayStart,
  timezone: 'Asia/Karachi'
})
// 2026-11-05 21:30 in Karachi (UTC+5).
const nineThirtyPm = Date.parse('2026-11-05T16:30:00Z')
const hours = (...args: Parameters<typeof hourRange>) => hourRange(...args).map((s) => s.hour)

describe('the chart of one business day (Today, Yesterday, one custom day)', () => {
  it('draws the trading hours with a quiet hour either side, at least six hours', () => {
    expect(hours(day([18, 19, 21]), false)).toEqual([17, 18, 19, 20, 21, 22])
    expect(hours(day([12]), false)).toEqual([9, 10, 11, 12, 13, 14]) // a lone hour sits in the middle
  })

  it('follows the business day across midnight (a day that starts at 06:00 ends at 05:59)', () => {
    expect(hours(day([23, 0, 2]), false)).toEqual([22, 23, 0, 1, 2, 3])
    expect(hours(day([5]), false)).toEqual([0, 1, 2, 3, 4, 5]) // never past the day's last hour
  })

  it('today runs up to the current hour and never into the future', () => {
    expect(hours(day([18]), true, nineThirtyPm)).toEqual([16, 17, 18, 19, 20, 21])
    expect(hours(day([]), true, nineThirtyPm)).toEqual([16, 17, 18, 19, 20, 21])
    expect(hourRange(day([18]), true, nineThirtyPm).some((s) => s.future)).toBe(false)
  })

  it('in the first hour of the day the next hours are empty slots to come, never zero sales', () => {
    // The day starts at midnight; it is 00:40 with one sale so far.
    const slots = hourRange(day([0], 0), true, Date.parse('2026-11-04T19:40:00Z'))
    expect(slots.map((s) => [s.hour, s.future])).toEqual([
      [0, false],
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true]
    ])
  })

  it('a quiet past day still has a course to draw (the chart says there were no sales)', () => {
    expect(hourRange(day([]), false)).toHaveLength(6)
    expect(hourRange(day([]), false).some((s) => s.future)).toBe(false)
  })
})

describe('the chart of several days (Week, Month, a custom range)', () => {
  it('includes the quiet days, so gaps show as zero', () => {
    const days = everyDay('2026-11-01', '2026-11-04', [
      { date: '2026-11-02', cash: 100, bank: 50 },
      { date: '2026-11-04', cash: 70, bank: 0 }
    ])
    expect(days.map((d) => [d.date, d.cash + d.bank])).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 150],
      ['2026-11-03', 0],
      ['2026-11-04', 70]
    ])
  })

  it('keeps long periods as reported', () => {
    const days = [{ date: '2026-01-15', cash: 1, bank: 0 }]
    expect(everyDay('2026-01-01', '2026-12-31', days)).toBe(days)
  })
})
