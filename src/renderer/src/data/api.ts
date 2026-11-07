/**
 * Data access layer. Every read goes through Row Level Security and every
 * write through a validated database function — the renderer holds no
 * privileges of its own.
 */
import type { Permission, PaymentMethod } from '@shared/constants'
import type { Receipt } from '@shared/receipt'
import { AppError, toAppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type {
  AppUser,
  BusinessDataSummary,
  BusinessResetResult,
  Booking as PreBooking,
  BookingStatus,
  Category,
  ClubTable,
  Customer,
  CustomerRankings,
  DailySummary,
  Dashboard,
  Expense,
  ExpenseCategory,
  PricingMode,
  ExpensesReport,
  FinancialReport,
  SalesByHour,
  Floor,
  HistoryReport,
  MyCounter,
  OpenBusinessDay,
  Product,
  ProductSalesReport,
  ProductSearchResult,
  Profile,
  RankingMetric,
  RetentionRun,
  RetentionStatus,
  Role,
  Sale,
  SalesReport,
  SnackSalesReport,
  Settings,
  Shift,
  ShiftDetail,
  StockAdjustment,
  SwitchTarget,
  TableSalesReport,
  TablesOverview
} from '@/lib/types'

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(fn, args)
  if (error) throw toAppError(error)
  return data as T
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query
  if (error) throw toAppError(error)
  return (data ?? []) as T[]
}

// --- profile, settings, structure -----------------------------------------
export const getMyProfile = () => rpc<Profile>('get_my_profile')
/** Sets (or, with null, clears) the signed-in account's profile picture path in the "avatars" bucket. */
export const setMyAvatar = (path: string | null) => rpc<Profile>('set_my_avatar', { p_path: path })
export const listSwitchTargets = () => rpc<SwitchTarget[]>('list_switch_targets')
export const getServerTime = () => rpc<string>('get_server_time')
export const getCurrentBusinessDate = () => rpc<string>('get_current_business_date')

export async function getSettings(): Promise<Settings> {
  const [row] = await rows<Settings>(supabase().from('settings').select('*').eq('id', 1))
  if (!row) throw new AppError('Club settings are missing. Run the database migrations.')
  return row
}
export const getFloors = () => rows<Floor>(supabase().from('floors').select('id,name,sort_order').order('sort_order').order('name'))
export const getCategories = () =>
  rows<Category>(supabase().from('table_categories').select('*').order('sort_order').order('name'))
export const getClubTables = () =>
  rows<ClubTable>(supabase().from('club_tables').select('*').order('sort_order').order('name'))

// --- tables & sessions ----------------------------------------------------
export const getTablesOverview = () => rpc<TablesOverview>('get_tables_overview')

export type Booking = { kind: 'open' } | { kind: 'minutes'; minutes: number } | { kind: 'amount'; amount: number }

export interface CustomerRef {
  id: string | null
  name: string | null
  phone: string | null
}

export const startSession = (tableId: string, booking: Booking, customer: CustomerRef) =>
  rpc('start_session', {
    p_table_id: tableId,
    p_booking: booking.kind,
    p_minutes: booking.kind === 'minutes' ? booking.minutes : null,
    p_amount: booking.kind === 'amount' ? booking.amount : null,
    p_customer_id: customer.id,
    p_customer_name: customer.id ? null : customer.name,
    p_customer_phone: customer.id ? null : customer.phone
  })
export const pauseSession = (id: string) => rpc('pause_session', { p_session_id: id })
export const resumeSession = (id: string) => rpc('resume_session', { p_session_id: id })
export const endSession = (id: string) => rpc('end_session', { p_session_id: id })
export const reopenSession = (id: string) => rpc('reopen_session', { p_session_id: id })
/** A booking ran out: silence its alarm on every terminal (the session is unchanged). */
export const acknowledgeAllocationAlert = (id: string) => rpc('acknowledge_allocation_alert', { p_session_id: id })
/**
 * Hourly-priced session: add 30-minute steps; the whole time is re-priced.
 * `fromBookedSeconds` is the booked time on screen, so a second click never extends twice.
 */
export const extendSession = (a: { id: string; minutes: number; fromBookedSeconds: number }) =>
  rpc('extend_session', { p_session_id: a.id, p_minutes: a.minutes, p_from_booked_seconds: a.fromBookedSeconds })
/** A booking ran out: keep playing; extra time is billed per minute from now. */
export const continueAfterAllocation = (id: string) => rpc('continue_after_allocation', { p_session_id: id })
export const cancelSession = (id: string) => rpc('cancel_session', { p_session_id: id })
export const addSessionItem = (sessionId: string, productId: string, quantity = 1) =>
  rpc('add_session_item', { p_session_id: sessionId, p_product_id: productId, p_quantity: quantity })
export const setSessionItemQuantity = (itemId: string, quantity: number) =>
  rpc('set_session_item_quantity', { p_item_id: itemId, p_quantity: quantity })

// --- products & customers -------------------------------------------------
export const searchProducts = (query: string, limit = 40) =>
  rpc<ProductSearchResult[]>('search_products', { p_query: query, p_limit: limit })
export const listProducts = (includeInactive: boolean) => {
  let q = supabase().from('inventory_products').select('*').order('name')
  if (!includeInactive) q = q.eq('is_active', true)
  return rows<Product>(q)
}
export interface ProductInput {
  id: string | null
  name: string
  category: string
  cost_price: number
  selling_price: number
  track_stock: boolean
  low_stock_threshold: number
  initial_stock: number
}
export const saveProduct = (p: ProductInput) =>
  rpc<Product>('admin_save_product', {
    p_id: p.id,
    p_name: p.name,
    p_category: p.category,
    p_cost_price: p.cost_price,
    p_selling_price: p.selling_price,
    p_track_stock: p.track_stock,
    p_low_stock_threshold: p.low_stock_threshold,
    p_initial_stock: p.initial_stock
  })
export const setProductActive = (id: string, active: boolean) =>
  rpc<Product>('admin_set_product_active', { p_id: id, p_active: active })
/** Permanent delete; the database refuses (hint in_use) once a product has history. */
export const deleteProduct = (id: string) => rpc('admin_delete_product', { p_id: id })
/** Administrators: a product's recent stock changes, newest first. */
export const getStockAdjustments = (productId: string, limit = 5) =>
  rpc<StockAdjustment[]>('get_stock_adjustments', { p_product_id: productId, p_limit: limit })
export const adjustStock = (productId: string, delta: number) =>
  rpc<{ id: string; name: string; stock_quantity: number }[]>('adjust_stock', { p_product_id: productId, p_delta: delta })

export const searchCustomers = (query: string, limit = 8) =>
  rpc<Customer[]>('search_customers', { p_query: query, p_limit: limit })
export const saveCustomer = (id: string | null, name: string, phone: string | null) =>
  rpc<Customer>('save_customer', { p_id: id, p_name: name, p_phone: phone })

// --- checkout & sales -----------------------------------------------------
export interface CheckoutInput {
  clientRef: string
  paymentMethod: PaymentMethod
  sessionId: string | null
  items: { product_id: string; quantity: number; unit_price: number }[] | null
  discount: number
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  /** Table checkouts only: re-price the time at this rate (null = the table's rate). */
  customRatePerMinute?: number | null
  /** Split payments: the part paid in cash (the rest is paid by bank transfer). */
  splitCash?: number | null
}
export const completeCheckout = (c: CheckoutInput) =>
  rpc<Receipt>('complete_checkout', {
    p_client_ref: c.clientRef,
    p_payment_method: c.paymentMethod,
    p_session_id: c.sessionId,
    p_items: c.items,
    p_discount: c.discount,
    p_customer_id: c.customerId,
    p_customer_name: c.customerName,
    p_customer_phone: c.customerPhone,
    p_custom_rate_per_minute: c.customRatePerMinute ?? null,
    p_split_cash: c.paymentMethod === 'split' ? (c.splitCash ?? null) : null
  })
export const getReceipt = (saleId: string) => rpc<Receipt>('get_receipt', { p_sale_id: saleId })
export const deleteSale = (saleId: string) => rpc('delete_sale', { p_sale_id: saleId })

export interface SalesFilter {
  from: string
  to: string
  cashierId?: string | null
  paymentMethod?: PaymentMethod | null
  limit?: number
}
export function listSales(f: SalesFilter) {
  let q = supabase()
    .from('sales')
    .select(
      'id,receipt_no,session_id,shift_id,table_name,floor_id,customer_name,customer_phone,cashier_id,cashier_name,payment_method,split_cash_amount,session_seconds,rate_per_minute,standard_rate_per_minute,standard_base_amount,base_amount,products_subtotal,discount,final_amount,business_date,created_at'
    )
    .gte('business_date', f.from)
    .lte('business_date', f.to)
    .order('created_at', { ascending: false })
    .limit(f.limit ?? 500)
  if (f.cashierId) q = q.eq('cashier_id', f.cashierId)
  if (f.paymentMethod) q = q.eq('payment_method', f.paymentMethod)
  return rows<Sale>(q)
}

// --- counter shifts & expenses -------------------------------------------
export const getMyCounter = () => rpc<MyCounter>('get_my_counter')
export const openCounter = () => rpc<Shift>('open_counter')
/** Closes the caller's counter, or (admin) the given one. */
export const closeCounter = (shiftId: string | null, handover: boolean) =>
  rpc<Shift>('close_counter', { p_shift_id: shiftId, p_handover: handover })
export const addExpense = (clientRef: string, amount: number, description: string) =>
  rpc<Expense>('add_expense', { p_client_ref: clientRef, p_amount: amount, p_description: description })
export const voidExpense = (id: string) => rpc<Expense>('void_expense', { p_expense_id: id })
export const getShiftDetail = (id: string) => rpc<ShiftDetail>('get_shift_detail', { p_shift_id: id })

// --- dashboard, history, day closing -------------------------------------
export const getDashboard = () => rpc<Dashboard>('get_dashboard')
export const getHistory = (from: string, to: string) => rpc<HistoryReport>('get_history', { p_from: from, p_to: to })
export const getSalesReport = (from: string, to: string, cashierId: string | null) =>
  rpc<SalesReport>('get_sales_report', { p_from: from, p_to: to, p_cashier_id: cashierId })
export const listOpenBusinessDays = () => rpc<OpenBusinessDay[]>('list_open_business_dates')
export const listDailySummaries = (limit = 60) =>
  rows<DailySummary>(supabase().from('daily_summaries').select('*').order('business_date', { ascending: false }).limit(limit))
export const closeBusinessDay = (date: string) =>
  rpc<{ business_date: string; summary: DailySummary & { net_amount: number } }>('close_business_day', { p_business_date: date })

// --- sales retention ------------------------------------------------------
// --- reports, business expenses, product sales (admin) -----------------------
export const getFinancialReport = (from: string, to: string) => rpc<FinancialReport>('get_financial_report', { p_from: from, p_to: to })
/** One business day hour by hour, from its invoices (closedOnly: counters already closed, as Reports' final figures). */
export const getSalesByHour = (date: string, closedOnly: boolean) =>
  rpc<SalesByHour>('get_sales_by_hour', { p_date: date, p_closed_only: closedOnly })
export const getExpenses = (from: string, to: string) => rpc<ExpensesReport>('get_expenses', { p_from: from, p_to: to })
export const getProductSales = (from: string, to: string) => rpc<ProductSalesReport>('get_product_sales', { p_from: from, p_to: to })
export const addBusinessExpense = (e: { clientRef: string; date: string; category: ExpenseCategory; amount: number; description: string }) =>
  rpc<Expense>('admin_add_expense', {
    p_client_ref: e.clientRef,
    p_business_date: e.date,
    p_category: e.category,
    p_amount: e.amount,
    p_description: e.description
  })
export const voidBusinessExpense = (id: string) => rpc<Expense>('admin_void_expense', { p_expense_id: id })
export const getSnackSales = (from: string, to: string) => rpc<SnackSalesReport>('get_snack_sales', { p_from: from, p_to: to })
export const getTableSales = (from: string, to: string) => rpc<TableSalesReport>('get_table_sales', { p_from: from, p_to: to })

// --- reset business data (admin; export and reset re-check the password) ----
export const getBusinessDataSummary = () => rpc<BusinessDataSummary>('admin_business_data_summary')
export const exportBusinessData = (password: string) => rpc<Record<string, unknown>>('admin_export_business_data', { p_password: password })
export const resetBusinessData = (a: { password: string; confirmation: string; resetStock: boolean }) =>
  rpc<BusinessResetResult>('admin_reset_business_data', { p_password: a.password, p_confirmation: a.confirmation, p_reset_stock: a.resetStock })

export const getRetentionStatus = () => rpc<RetentionStatus>('get_retention_status')
export const runRetention = () => rpc<RetentionRun>('admin_run_retention')

// --- pre-bookings ---------------------------------------------------------
export const listBookings = (from: string, to: string) => rpc<PreBooking[]>('list_bookings', { p_from: from, p_to: to })
export interface BookingInput {
  id: string | null
  customerName: string
  customerPhone: string | null
  /** Club-local date (YYYY-MM-DD) and 24-hour time (HH:MM) — the UI picks it in 12-hour form. */
  date: string
  time: string
  tableId: string | null
  notes: string
}
export const saveBooking = (b: BookingInput) =>
  rpc('admin_save_booking', {
    p_id: b.id,
    p_customer_name: b.customerName,
    p_customer_phone: b.customerPhone,
    p_date: b.date,
    p_time: b.time,
    p_table_id: b.tableId,
    p_notes: b.notes
  })
export const setBookingStatus = (id: string, status: Extract<BookingStatus, 'booked' | 'cancelled' | 'no_show'>) =>
  rpc('admin_set_booking_status', { p_id: id, p_status: status })
export const deleteBooking = (id: string) => rpc('admin_delete_booking', { p_id: id })
/** `minutes` is required for a table priced by the hour (30-minute steps). */
export const startBooking = (id: string, tableId: string | null, minutes: number | null = null) =>
  rpc('start_booking', { p_booking_id: id, p_table_id: tableId, p_minutes: minutes })

// --- customers ------------------------------------------------------------
export const getCustomerRankings = (metric: RankingMetric, limit = 25) =>
  rpc<CustomerRankings>('get_customer_rankings', { p_metric: metric, p_limit: limit })

// --- administration -------------------------------------------------------
export const updateSettings = (patch: Partial<Settings>) => rpc<Settings>('admin_update_settings', { p_settings: patch })
export const saveFloor = (id: number | null, name: string, sortOrder: number) =>
  rpc<Floor>('admin_save_floor', { p_id: id, p_name: name, p_sort_order: sortOrder })
export const deleteFloor = (id: number) => rpc('admin_delete_floor', { p_id: id })
export const saveCategory = (c: {
  id: number | null
  name: string
  pricing_mode: PricingMode
  rate_per_minute: number | null
  hourly_rate: number | null
  special_30_rate: number | null
  under_hour_rate: number | null
  sort_order: number
  is_active: boolean
}) =>
  rpc<Category>('admin_save_category', {
    p_id: c.id,
    p_name: c.name,
    p_rate_per_minute: c.rate_per_minute,
    p_sort_order: c.sort_order,
    p_is_active: c.is_active,
    p_pricing_mode: c.pricing_mode,
    p_hourly_rate: c.hourly_rate,
    p_special_30_rate: c.special_30_rate,
    p_under_hour_rate: c.under_hour_rate
  })
export const saveTable = (t: {
  id: string | null
  name: string
  category_id: number
  floor_id: number
  rate_override: number | null
  sort_order: number
}) =>
  rpc<ClubTable>('admin_save_table', {
    p_id: t.id,
    p_name: t.name,
    p_category_id: t.category_id,
    p_floor_id: t.floor_id,
    p_rate_per_minute: t.rate_override,
    p_sort_order: t.sort_order
  })
export const setTableActive = (id: string, active: boolean) => rpc<ClubTable>('admin_set_table_active', { p_id: id, p_active: active })
export const deleteTable = (id: string) => rpc('admin_delete_table', { p_id: id })
export const deleteCategory = (id: number) => rpc('admin_delete_category', { p_id: id })

export const listUsers = () =>
  rows<AppUser>(
    supabase().from('app_users').select('id,username,full_name,role,floor_id,permissions,is_active,created_at').order('role').order('full_name')
  )
export const updateUser = (u: { id: string; full_name: string; role: Role; floor_id: number | null; permissions: Permission[] }) =>
  rpc<AppUser>('admin_update_user', {
    p_user_id: u.id,
    p_full_name: u.full_name,
    p_role: u.role,
    p_floor_id: u.floor_id,
    p_permissions: u.permissions
  })

/** Calls the admin-users Edge Function (the only holder of the service key). */
async function adminUsersFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().functions.invoke('admin-users', { body })
  if (error) {
    let message = error.message
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const payload = (await context.json()) as { error?: string }
        if (payload.error) message = payload.error
      } catch {
        // Keep the generic message.
      }
    }
    if (/failed to send|fetch/i.test(message)) {
      message = 'Could not reach the admin-users service. Make sure the Edge Function is deployed (see README).'
    }
    throw new AppError(message)
  }
  return data as T
}
export const createUser = (u: {
  username: string
  full_name: string
  role: Role
  floor_id: number | null
  permissions: Permission[]
  password: string
}) => adminUsersFunction<{ user: AppUser }>({ action: 'create', ...u })
export const setUserPassword = (userId: string, password: string) =>
  adminUsersFunction<{ ok: true }>({ action: 'set_password', user_id: userId, password })
export const setUserActive = (userId: string, active: boolean) =>
  adminUsersFunction<{ user: AppUser; warning: string | null }>({ action: 'set_active', user_id: userId, active })
/** Only accounts without history; others are deactivated instead (the database decides). */
export const deleteUser = (userId: string) => adminUsersFunction<{ ok: true }>({ action: 'delete', user_id: userId })
