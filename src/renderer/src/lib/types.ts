import type { Permission, PaymentMethod } from '@shared/constants'
import type { RoundingMode } from '@shared/billing'

export type Role = 'admin' | 'staff'

export interface Profile {
  id: string
  username: string
  full_name: string
  role: Role
  floor_id: number | null
  floor_name: string | null
  permissions: Permission[]
  /** Path of the profile picture in the "avatars" storage bucket; null shows the initials. */
  avatar_path?: string | null
}

export interface Settings {
  id: number
  club_name: string
  club_address: string
  club_phone: string
  receipt_footer: string
  business_timezone: string
  day_start_hour: number
  billing_increment_minutes: number
  billing_rounding: RoundingMode
  minimum_charge_minutes: number
  admin_idle_lock_minutes: number
  sales_retention_days: RetentionDays
  updated_at: string
}

export interface Floor {
  id: number
  name: string
  sort_order: number
}

/**
 * Per minute; hourly with a special 30-minute price (sold in 30-minute
 * steps); or hourly with a higher rate for play under 1 hour.
 */
export type PricingMode = 'per_minute' | 'hourly_special30' | 'tiered_hourly'

/** The prices of an hourly-priced category or session. */
export interface HourlyPricing {
  pricing_mode: PricingMode
  /** Rupees per hour (hourly_special30 and tiered_hourly). */
  hourly_rate: number | null
  /** Price of exactly 30 minutes (hourly_special30 only). */
  special_30_rate: number | null
  /** Rupees per hour for play under 1 hour (tiered_hourly only). */
  under_hour_rate?: number | null
}

export interface Category extends HourlyPricing {
  id: number
  name: string
  /** Rupees per minute (for hourly pricing: the hourly rate ÷ 60, for display only). */
  rate_per_minute: number
  sort_order: number
  is_active: boolean
}

export interface ClubTable {
  id: string
  name: string
  category_id: number
  floor_id: number
  /** Rupees per minute for this table; null = the category rate. */
  rate_override: number | null
  sort_order: number
  is_active: boolean
}

export type SessionStatus = 'running' | 'paused' | 'billing' | 'completed' | 'cancelled' | 'voided'

export interface TabItem {
  id: string
  product_id: string
  name: string
  unit_price: number
  quantity: number
}

export interface ActiveSession extends HourlyPricing {
  id: string
  status: SessionStatus
  /** Rupees per minute, snapshotted when the session started. */
  rate_per_minute: number
  booked_seconds: number | null
  booked_amount: number | null
  started_at: string
  paused_at: string | null
  paused_ms: number
  ended_at: string | null
  billable_seconds: number | null
  base_amount: number | null
  /** Bookings: when staff dismissed the "time's up" alarm (any terminal). */
  allocation_alert_ack_at: string | null
  /** Bookings: when staff chose to continue past the allocation (billing held until then). */
  allocation_extended_at: string | null
  /** id is null for a name-only customer (no profile without a phone number). */
  customer: { id: string | null; name: string; phone: string | null } | null
  booking_id: string | null
  items: TabItem[]
}

export interface TableOverview extends HourlyPricing {
  id: string
  name: string
  sort_order: number
  category_id: number
  category_name: string
  floor_id: number
  floor_name: string
  rate_per_minute: number
  session: ActiveSession | null
}

export interface TablesOverview {
  server_time: string
  tables: TableOverview[]
}

export interface ProductSearchResult {
  id: string
  name: string
  category: string
  selling_price: number
  track_stock: boolean
  stock_quantity: number
}

export interface Product extends ProductSearchResult {
  /** Image in the "product-images" bucket; null shows the name only. */
  image_path?: string | null
  cost_price: number
  low_stock_threshold: number
  units_sold: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** A product with an image (get_product_images): found by id, or by name for invoices that keep only the name. */
export interface ProductImageRef {
  id: string
  name: string
  image_path: string
}

export interface Customer {
  id: string
  name: string
  phone: string | null
  created_at: string
}

export interface Sale {
  id: string
  receipt_no: number
  session_id: string | null
  table_name: string | null
  floor_id: number | null
  customer_name: string | null
  customer_phone: string | null
  cashier_id: string
  cashier_name: string
  payment_method: PaymentMethod
  /** Split payments: the cash part; the rest was paid by bank transfer. */
  split_cash_amount: number | null
  session_seconds: number | null
  rate_per_minute: number | null
  /** Set when a custom rate replaced the table's standard rate. */
  standard_rate_per_minute: number | null
  standard_base_amount: number | null
  base_amount: number
  products_subtotal: number
  discount: number
  final_amount: number
  business_date: string
  shift_id: string
  created_at: string
}

export interface DayTotals {
  cash: number
  bank: number
  total: number
  count: number
  discounts: number
  snack: number
  expenses: number
  net: number
  archived: boolean
  closed: boolean
}

export interface Dashboard {
  business_date: string
  server_time: string
  tables: { total: number; available: number; running: number; paused: number; billing: number }
  today?: DayTotals
  yesterday_total?: number
  lifetime_total?: number
  hourly?: { hour: number; total: number }[]
  staff?: StaffDayRow[]
  top_products?: { name: string; quantity: number; revenue: number }[]
  low_stock?: { id: string; name: string; stock_quantity: number; low_stock_threshold: number }[]
  open_days?: number
  bookings_today?: number
  my_counter?: Shift | null
}

export interface ReportDay {
  date: string
  cash: number
  bank: number
  total: number
  discounts: number
  live_count: number
  archived: boolean
}

export interface SalesReport {
  from: string
  to: string
  cashier_id: string | null
  days: ReportDay[]
  totals: { cash: number; bank: number; total: number; discounts: number; live_count: number; archived_days: number }
  by_staff: { cashier_id: string; cashier_name: string; cash: number; bank: number; total: number; count: number }[]
  top_products: { name: string; quantity: number; revenue: number }[]
}

export interface OpenBusinessDay {
  business_date: string
  invoice_count: number
  total_cash: number
  total_bank: number
  total_sales: number
  expenses: number
  open_counters: number
  closed_at: string | null
  changed_since_close: boolean
}

export interface DailySummary {
  id: string
  business_date: string
  total_cash: number
  total_bank: number
  total_sales: number
  snack_sales: number
  discounts: number
  expenses: number
  invoice_count: number
  /** Amounts archived (and deleted) by the old close-day, before staff accounting. */
  legacy_cash: number
  legacy_bank: number
  closed_at: string | null
  created_at: string
  updated_at: string
}

export interface AppUser {
  id: string
  username: string
  full_name: string
  role: Role
  floor_id: number | null
  permissions: Permission[]
  is_active: boolean
  created_at: string
}

export interface SwitchTarget {
  id: string
  username: string
  full_name: string
  role: Role
}

export type RetentionDays = 1 | 7 | 30

/** One business day's invoices hour by hour (get_sales_by_hour); hours in business-day order, club time. */
export interface SalesByHour {
  date: string
  closed_only: boolean
  hours: { hour: number; cash: number; bank: number; total: number; invoices: number }[]
  day_start_hour: number
  timezone: string
  /** Sum of the hours — compare with the day's permanent total (old invoices are removed by retention). */
  covered_total: number
  retention_days: RetentionDays
}

/** A counter shift; totals are live while open and final once closed. */
export interface Shift {
  id: string
  user_id: string
  staff_name: string
  status: 'open' | 'closed'
  business_date: string
  opened_at: string
  closed_at: string | null
  closed_by_name: string | null
  closed_by_self: boolean | null
  cash: number
  bank: number
  snack: number
  discounts: number
  total: number
  expenses: number
  net: number
  invoices: number
  voided_count: number
  voided_amount: number
  handover_sessions: number
  imported: boolean
  details_purged_at: string | null
  open_sessions: number
  retained_invoices?: number
}

export interface Expense {
  id: string
  /** Null for a business expense recorded by an administrator. */
  shift_id: string | null
  user_id: string
  business_date: string
  amount: number
  description: string
  created_at: string
  voided_at: string | null
}

export interface MyCounter {
  can_operate: boolean
  shift: Shift | null
  expenses: Expense[]
  recent: Shift[]
}

export interface ShiftInvoice {
  id: string
  receipt_no: number
  created_at: string
  business_date: string
  table_name: string | null
  customer_name: string | null
  customer_phone: string | null
  payment_method: PaymentMethod
  split_cash_amount?: number | null
  session_seconds: number | null
  rate_per_minute: number | null
  standard_rate_per_minute: number | null
  standard_base_amount: number | null
  base_amount: number
  products_subtotal: number
  discount: number
  final_amount: number
  items: { name: string; unit_price: number; quantity: number; line_total: number }[]
}

export interface ShiftDetail extends Shift {
  days: { business_date: string; cash: number; bank: number; snack: number; expenses: number; invoices: number; total: number }[]
  expense_list: { id: string; amount: number; description: string; created_at: string; voided_at: string | null }[]
  invoices_visible: boolean
  retained_invoices: number
  retention_days: RetentionDays
  invoice_list: ShiftInvoice[]
}

export interface StaffDayRow {
  user_id: string
  name: string
  username: string
  status: 'open' | 'closed'
  open_shift_id: string | null
  open_since: string | null
  last_closed_at: string | null
  shifts: number
  cash: number
  bank: number
  snack: number
  total: number
  expenses: number
  net: number
  invoices: number
  voided: number
}

export interface HistoryTotals {
  cash: number
  bank: number
  total: number
  snack: number
  discounts: number
  expenses: number
  net: number
  invoices: number
  voided: number
  legacy: number
  days: number
}

export interface HistoryDay {
  date: string
  cash: number
  bank: number
  total: number
  snack: number
  discounts: number
  expenses: number
  net: number
  invoices: number
  voided: number
  legacy: number
  closed: boolean
}

export interface HistoryStaff {
  user_id: string
  name: string
  cash: number
  bank: number
  total: number
  snack: number
  expenses: number
  net: number
  invoices: number
  shifts: number
}

export interface HistoryReport {
  from: string
  to: string
  totals: HistoryTotals
  days: HistoryDay[]
  by_staff: HistoryStaff[]
  shifts: Shift[]
  retention_days: RetentionDays
  oldest_invoice_date: string | null
}

export type BookingStatus = 'booked' | 'started' | 'completed' | 'cancelled' | 'no_show'

export interface Booking {
  id: string
  customer_id: string | null
  customer_name: string
  customer_phone: string | null
  table_id: string | null
  table_name: string | null
  floor_name: string | null
  booking_at: string
  business_date: string
  notes: string
  status: BookingStatus
  session_id: string | null
  session_status: SessionStatus | null
  started_at: string | null
  created_at: string
}

export type RankingMetric = 'visits' | 'play_time' | 'spending'

export interface CustomerRanking {
  rank: number
  id: string
  name: string
  phone: string | null
  visits: number
  invoices: number
  play_seconds: number
  spent: number
  last_visit_at: string
  first_visit_date: string
}

export interface CustomerRankings {
  summary: { customers: number; with_visits: number; repeat: number }
  rows: CustomerRanking[]
}

export interface RetentionRun {
  id: number
  source: 'schedule' | 'manual'
  started_at: string
  finished_at: string | null
  status: 'running' | 'success' | 'failed' | 'skipped'
  retention_days: number
  cutoff_date: string
  sales_deleted: number
  items_deleted: number
  shifts_affected: number
  message: string | null
}

export interface RetentionStatus {
  retention_days: RetentionDays
  cutoff_date: string
  scheduled: boolean
  eligible_sales: number
  eligible_items: number
  waiting_on_open_shifts: number
  retained_sales: number
  oldest_invoice_date: string | null
  database_bytes: number | null
  detail_bytes: number | null
  last_success: RetentionRun | null
  recent_runs: RetentionRun[]
}

// --- Reports, business expenses, product sales (migration 0900) ------------
export interface ReportFinal {
  cash: number
  bank: number
  total: number
  snack: number
  discounts: number
  counter_expenses: number
  business_expenses: number
  expenses: number
  net: number
  invoices: number
  voided: number
  shifts: number
  /** Archived by the pre-0700 Close Day (no staff breakdown). */
  legacy: number
}

export interface ReportLive {
  cash: number
  bank: number
  total: number
  snack: number
  discounts: number
  expenses: number
  net: number
  invoices: number
  shifts: number
}

export interface ReportShift {
  id: string
  staff_name: string
  status: 'open' | 'closed'
  business_date: string
  opened_at: string
  closed_at: string | null
  imported: boolean
  cash: number
  bank: number
  total: number
  snack: number
  discounts: number
  expenses: number
  net: number
  invoices: number
  voided: number
  /** The shift also traded on dates outside the selected range. */
  partial: boolean
}

export interface ReportStaff {
  user_id: string
  name: string
  shifts: number
  cash: number
  bank: number
  total: number
  snack: number
  discounts: number
  expenses: number
  net: number
  invoices: number
}

export interface FinancialReport {
  from: string
  to: string
  generated_at: string
  club_name: string
  timezone: string
  final: ReportFinal
  live: ReportLive
  days: { date: string; cash: number; bank: number; total: number; expenses: number; net: number }[]
  by_staff: ReportStaff[]
  closed_shifts: ReportShift[]
  open_shifts: ReportShift[]
}

export const EXPENSE_CATEGORIES = ['supplies', 'utilities', 'rent', 'maintenance', 'equipment', 'stock', 'other'] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export interface ExpenseRecord {
  id: string
  business_date: string
  created_at: string
  kind: 'counter' | 'business'
  /** 'counter' for expenses paid from a counter. */
  category: ExpenseCategory | 'counter'
  amount: number
  description: string
  recorded_by: string | null
  shift_id: string | null
  voided_at: string | null
  voided_by: string | null
}

export interface ExpensesReport {
  from: string
  to: string
  totals: { total: number; counter: number; business: number; count: number; voided_count: number }
  by_category: { category: ExpenseCategory | 'counter'; total: number; count: number }[]
  days: { date: string; counter: number; business: number; total: number }[]
  items: ExpenseRecord[]
  truncated: boolean
}

export interface ProductSalesRow {
  product_key: string
  product_id: string | null
  name: string
  category: string | null
  current_cost_price: number | null
  current_selling_price: number | null
  quantity: number
  revenue: number
  discount: number
  net_revenue: number
  avg_price: number
  costed_quantity: number
  uncosted_quantity: number
  cost: number
  avg_cost: number | null
  gross_profit: number | null
  margin: number | null
}

export interface ProductSalesReport {
  from: string
  to: string
  products: ProductSalesRow[]
  totals: {
    quantity: number
    revenue: number
    discount: number
    net_revenue: number
    costed_quantity: number
    uncosted_quantity: number
    costed_net_revenue: number
    cost: number
    gross_profit: number
    products: number
  }
  days: { date: string; quantity: number; net_revenue: number; gross_profit: number }[]
  tracking_since: string | null
  cost_tracking_since: string | null
}

/** One entry of a product's stock log (migration 1400). */
export interface StockAdjustment {
  id: number
  delta: number
  stock_after: number
  /** opening = a new product's first stock; adjust = restock or correction. */
  source: 'opening' | 'adjust'
  user_name: string | null
  created_at: string
}

// --- Snack sales and table sales (migration 1000) ---------------------------
export interface SnackSale {
  id: string
  receipt_no: number
  created_at: string
  business_date: string
  cashier_name: string
  payment_method: PaymentMethod
  split_cash_amount?: number | null
  discount: number
  final_amount: number
  items: { name: string; quantity: number }[]
}

export interface SnackSalesReport {
  from: string
  to: string
  /** "all" for an administrator; a staff member sees their own sales. */
  scope: 'all' | 'mine'
  totals: { total: number; cash: number; bank: number; count: number; items: number }
  sales: SnackSale[]
}

export interface TableSalesRow {
  table_id: string
  name: string
  active: boolean
  floor_name: string
  category_name: string
  sessions: number
  total: number
  cash: number
  bank: number
  table_time: number
  snacks: number
  discounts: number
}

export interface TableSalesReport {
  from: string
  to: string
  tables: TableSalesRow[]
  totals: { sessions: number; total: number; cash: number; bank: number; table_time: number; snacks: number; discounts: number }
  retention_days: number
  /** Invoices of closed counters dated before this may already be removed. */
  retention_cutoff: string
  oldest_invoice_date: string | null
}

// --- Reset business data (migration 1200) -----------------------------------
export interface BusinessDataSummary {
  /** Rows a reset would delete, per table (plus open_sessions / open_counters). */
  counts: Record<string, number>
  last_reset_at: string | null
  last_reset_by: string | null
}

export interface BusinessResetResult {
  reset_at: string
  reset_by: string
  removed: Record<string, number>
  stock_reset: boolean
}
