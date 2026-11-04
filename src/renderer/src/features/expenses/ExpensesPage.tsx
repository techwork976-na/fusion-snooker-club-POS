import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Ban, Plus, Receipt } from 'lucide-react'
import { addDays, formatBusinessDate, formatMoney, formatTime } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ExpenseRecord, type ExpensesReport } from '@/lib/types'
import { addBusinessExpense, getExpenses, voidBusinessExpense } from '@/data/api'
import { accountingKeys, keys, useAction, useBusinessDate, useSettings } from '@/data/hooks'
import { BarChart, compactMoney, HorizontalBarChart, Legend, SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { Button, IconButton } from '@/components/ui/Button'
import { inputClass, parseAmount, Select, TextField } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { PeriodPicker, periodError, periodFor, type Period } from '@/features/reports/PeriodPicker'

export const CATEGORY_LABELS: Record<ExpenseCategory | 'counter', string> = {
  counter: 'Counter (petty cash)',
  supplies: 'Supplies',
  utilities: 'Utilities',
  rent: 'Rent',
  maintenance: 'Maintenance & repairs',
  equipment: 'Equipment',
  stock: 'Stock purchases',
  other: 'Other'
}

/** Short names for chart labels. */
const CATEGORY_SHORT: Record<ExpenseCategory | 'counter', string> = { ...CATEGORY_LABELS, counter: 'Counter', maintenance: 'Repairs', stock: 'Stock' }

/** Expenses wear claret everywhere; counter petty cash in its lighter step. */
const SERIES = [
  { key: 'business', label: 'Business', color: SERIES_COLORS.expenses },
  { key: 'counter', label: 'Counter', color: SERIES_COLORS.counterExpenses }
]

export function ExpensesPage() {
  const { data: today } = useBusinessDate()
  const [period, setPeriod] = useState<Period | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    if (today && !period) setPeriod(periodFor('month', today))
  }, [today, period])
  const invalid = today && period ? periodError(period, today) : null
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.expenses(period?.from ?? '', period?.to ?? ''),
    queryFn: () => getExpenses(period!.from, period!.to),
    enabled: Boolean(period) && !invalid,
    placeholderData: (prev) => prev
  })

  return (
    <Page>
      <PageHeader
        title="Expenses"
        subtitle="Business expenses recorded here, and the petty cash staff paid from their counters."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={!today} data-testid="add-expense">
            Add expense
          </Button>
        }
      >
        {today && period && <PeriodPicker value={period} onChange={setPeriod} today={today} layoutId="expense-period" />}
      </PageHeader>
      {invalid ? (
        <EmptyState title="Choose a valid period" description={invalid} />
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <ExpensesBody data={data} />
      )}
      {today && <AddExpenseDialog open={adding} onOpenChange={setAdding} today={today} />}
    </Page>
  )
}

function ExpensesBody({ data }: { data: ExpensesReport }) {
  const { data: settings } = useSettings()
  const [voiding, setVoiding] = useState<ExpenseRecord | null>(null)
  const voidExpense = useAction(voidBusinessExpense, { invalidate: accountingKeys, success: 'Expense voided. It stays in the list, marked voided.' })
  const t = data.totals
  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-8" data-testid="expense-totals">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <span className="label">Total expenses</span>
            <AnimatedMoney value={t.total} duration={0.8} className="mt-5 block figure-display text-[clamp(42px,12vw,48px)] leading-[0.9] text-forest-950 sm:text-[clamp(48px,4.8vw,66px)]" data-testid="expense-total" />
            <p className="mt-4 text-sm text-fg-3">
              {t.count} expense{t.count === 1 ? '' : 's'}
              {t.voided_count > 0 ? ` · ${t.voided_count} voided (not counted)` : ''}
            </p>
          </div>
          <div className="flex gap-8 sm:gap-10">
            <div className="border-l border-line pl-5">
              <p className="label flex items-center gap-2">
                <span className="h-[3px] w-3 rounded-full" style={{ background: SERIES[0]!.color }} />
                Business
              </p>
              <p className="mt-3 figure-display text-[26px] leading-none text-fg" data-testid="expense-business">
                {formatMoney(t.business)}
              </p>
            </div>
            <div className="border-l border-line pl-5">
              <p className="label flex items-center gap-2">
                <span className="h-[3px] w-3 rounded-full" style={{ background: SERIES[1]!.color }} />
                Counter
              </p>
              <p className="mt-3 figure-display text-[26px] leading-none text-fg" data-testid="expense-counter">
                {formatMoney(t.counter)}
              </p>
            </div>
          </div>
        </div>
      </section>

      {t.count === 0 && t.voided_count === 0 ? (
        <section className="card">
          <EmptyState icon={<Receipt className="size-5" />} title="No expenses in this period" description="Add a business expense, or choose another period." />
        </section>
      ) : (
        <>
          <div className="grid grid-cols-12 gap-6">
            <section className="card col-span-12 p-5 sm:p-7 xl:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="label">Expenses by day</span>
                <Legend series={SERIES} />
              </div>
              <BarChart
                className="mt-6"
                height={240}
                series={SERIES}
                data={data.days.map((d) => ({
                  key: d.date,
                  label: formatBusinessDate(d.date, { weekday: false, year: false }),
                  title: formatBusinessDate(d.date),
                  values: { business: d.business, counter: d.counter }
                }))}
                formatValue={(v) => formatMoney(v)}
                formatAxis={compactMoney}
              />
            </section>
            <section className="card col-span-12 p-5 sm:p-7 xl:col-span-5" data-testid="expense-categories">
              <span className="label">By category</span>
              <HorizontalBarChart
                className="mt-5"
                series={[{ key: 'total', label: 'Amount', color: SERIES_COLORS.expenses }]}
                data={data.by_category.map((c) => ({
                  key: c.category,
                  label: CATEGORY_SHORT[c.category],
                  title: CATEGORY_LABELS[c.category],
                  values: { total: c.total },
                  note: `${c.count} expense${c.count === 1 ? '' : 's'}`
                }))}
                formatValue={(v) => formatMoney(v)}
                formatAxis={compactMoney}
              />
            </section>
          </div>

          <section className="card overflow-hidden" data-testid="expense-list">
            <div className="px-5 pt-6 pb-3 sm:px-8 sm:pt-7">
              <span className="label">Expense records</span>
              {data.truncated && <p className="mt-1 text-xs text-fg-4">Showing the newest 2,000 records. Choose a shorter period to see the rest.</p>}
            </div>
            <div className="overflow-x-auto">
              <table className="table-stack w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="thead-row">
                    <th className="px-8 py-3">Date</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Recorded by</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="w-16 px-6 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((e) => (
                    <tr key={e.id} className={cn(e.voided_at && 'text-fg-4')} data-testid={`expense-row-${e.id}`}>
                      <td className="px-8 py-3.5" data-stack="top">
                        <span className={cn('font-semibold', e.voided_at ? 'text-fg-4' : 'text-fg')}>{formatBusinessDate(e.business_date)}</span>
                        <span className="ml-2 text-xs text-fg-4">{formatTime(e.created_at, settings?.business_timezone)}</span>
                      </td>
                      <td className="px-4 py-3.5" data-stack="full">
                        <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', e.kind === 'business' ? 'bg-brass-100 text-brass-800' : 'bg-sage-100 text-sage-800')}>
                          {CATEGORY_LABELS[e.category]}
                        </span>
                      </td>
                      <td className={cn('px-4 py-3.5', e.voided_at ? 'line-through' : 'text-fg-2')} data-stack="full">{e.description}</td>
                      <td className="px-4 py-3.5 text-fg-3" data-label="Recorded by">{e.recorded_by ?? '—'}</td>
                      <td className={cn('px-4 py-3.5 text-right font-semibold tabular', e.voided_at ? 'line-through' : 'text-fg')} data-stack="top end">{formatMoney(e.amount)}</td>
                      <td className="px-6 py-2 text-right" data-stack="end">
                        {e.voided_at ? (
                          <span className="text-xs font-semibold text-fg-4">Voided</span>
                        ) : e.kind === 'business' ? (
                          <IconButton label="Void expense" size="sm" variant="ghost" onClick={() => setVoiding(e)}>
                            <Ban className="size-4" />
                          </IconButton>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-5 text-xs text-fg-4 sm:px-8">Counter expenses are voided by the staff member from their counter while it is open.</p>
          </section>
        </>
      )}
      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Void this expense?"
        description={voiding ? `${CATEGORY_LABELS[voiding.category]} · ${voiding.description} · ${formatMoney(voiding.amount)}. The record is kept, marked voided, and no longer counts in totals.` : undefined}
        confirmLabel="Void expense"
        onConfirm={async () => {
          if (voiding) await voidExpense.mutateAsync(voiding.id)
          setVoiding(null)
        }}
      />
    </div>
  )
}

function AddExpenseDialog({ open, onOpenChange, today }: { open: boolean; onOpenChange: (o: boolean) => void; today: string }) {
  const [date, setDate] = useState(today)
  const [category, setCategory] = useState<ExpenseCategory | null>(null)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [ref, setRef] = useState(() => crypto.randomUUID())
  const [tried, setTried] = useState(false)
  const add = useAction(addBusinessExpense, { invalidate: accountingKeys, success: 'Expense added.' })
  const minDate = addDays(today, -366)

  const value = parseAmount(amount)
  const errors = {
    date: !date || date > today || date < minDate ? 'Choose a date in the last year, not in the future.' : null,
    category: category ? null : 'Choose a category.',
    amount: value === null || value <= 0 ? 'Enter an amount above zero (up to 2 decimals).' : value > 10_000_000 ? 'That amount is too large.' : null,
    description: description.trim().length === 0 ? 'Describe the expense.' : null
  }
  const valid = !errors.date && !errors.category && !errors.amount && !errors.description

  const reset = () => {
    setDate(today)
    setCategory(null)
    setAmount('')
    setDescription('')
    setTried(false)
    setRef(crypto.randomUUID())
  }
  const submit = async () => {
    setTried(true)
    if (!valid || !category || value === null) return
    await add.mutateAsync({ clientRef: ref, date, category, amount: value, description: description.trim() })
    reset()
    onOpenChange(false)
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (add.isPending) return
        if (!o) reset()
        onOpenChange(o)
      }}
      title="Add a business expense"
      description="For costs not paid from a counter, such as rent, utilities or repairs. It counts in Reports and never changes a counter's cash."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={() => void submit().catch(() => undefined)} data-testid="save-expense">
            Add expense
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit().catch(() => undefined)
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-semibold text-fg-2">Date</span>
          <input
            type="date"
            className={cn(inputClass, 'h-11 w-full')}
            value={date}
            min={minDate}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={tried && Boolean(errors.date)}
            data-testid="expense-date"
          />
          {tried && errors.date && <span className="mt-1.5 block text-xs font-semibold text-claret-700">{errors.date}</span>}
        </label>
        <Select
          label="Category"
          value={category}
          onChange={setCategory}
          options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          error={tried ? errors.category : null}
        />
        <TextField
          containerClassName="sm:col-span-2"
          label="Amount"
          prefix="PKR"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={tried ? errors.amount : null}
          data-testid="expense-amount"
        />
        <TextField
          containerClassName="sm:col-span-2"
          label="Description"
          maxLength={120}
          placeholder="e.g. Electricity bill for October"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={tried ? errors.description : null}
          data-testid="expense-description"
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
