# FUSION database

Supabase PostgreSQL is the single source of truth. Migrations live in `supabase/migrations/` and must be applied in filename order:

| File | Contents |
|---|---|
| `…0100_schema.sql` | Tables, constraints, indexes |
| `…0200_security_and_billing.sql` | Authorization helpers, billing functions, business-date logic, Row Level Security policies |
| `…0300_operations.sql` | Sessions, table tabs, checkout, sale deletion, customers, product search, stock, receipts |
| `…0400_admin_reports_archive.sql` | User/club administration, dashboard, reports, **Close Day & Archive** |
| `…0500_grants_realtime.sql` | Least-privilege grants (revoke all, allow-list) and realtime publication |
| `…0600_preserve_sessions_and_review_fixes.sql` | Sessions are never deleted (`cancelled` / `voided` statuses); Close Day verifies the summary before deleting; staff session/customer visibility tightened |
| `…0700_counter_shifts_history_retention.sql` | Counter shifts, the permanent ledger, expenses, staff isolation, admin-cannot-sell, History, non-deleting Close Day, pre-bookings, customer statistics, safe deletes, scheduled sales-detail retention. Existing sales are attached to imported shifts; nothing is deleted |
| `…0800_per_minute_rates_custom_rate.sql` | Rates become rupees **per minute** (hourly columns renamed and divided by 60, to 4 decimals — prices unchanged); `complete_checkout(…, p_custom_rate_per_minute)` re-prices a table's time at a custom rate; invoices keep the standard rate/charge it replaced. Nothing is deleted |
| `…0900_reports_expenses_product_sales.sql` | Business expenses (`expenses.shift_id` optional + `category`), `sale_items.unit_cost` (cost at sale), permanent `product_sales_daily`, admin report functions (`get_financial_report`, `get_expenses`, `get_product_sales`, `admin_add_expense`, `admin_void_expense`). Checkout posts / sale deletion reverses the product ledger. Nothing is deleted |
| `…1000_times_up_snacks_table_sales.sql` | `sessions.allocation_alert_ack_at` / `allocation_extended_at`; a used-up booking holds its billable clock at the booked time (`fusion_billable_seconds`, used by `end_session` / `cancel_session`) until `continue_after_allocation`; `acknowledge_allocation_alert`; `get_snack_sales`; `get_table_sales` (reads `sales`, so retention removes old figures) |
| `…1100_hourly_special_pricing.sql` | Category `pricing_mode` (`per_minute` / `hourly_special30`) with `hourly_rate` and `special_30_rate`, snapshotted on each session; `fusion_slot_price` (30 min = special price, ≥ 1 h = hourly × hours); `start_session` books hourly categories in 30-minute steps; `extend_session` re-prices the total; `start_booking(…, p_minutes)`; `admin_save_category` takes the mode and prices; per-minute continue and custom rates refused for hourly sessions |
| `…1400_security_hardening.sql` | Stock log `stock_adjustments` (append-only, no API privileges) written by `adjust_stock` and `admin_save_product` (opening stock); `get_stock_adjustments` (admin); `list_switch_targets` returns only admin accounts to staff; billing helpers `fusion_amount_for_minutes` / `fusion_billed_minutes` / `fusion_session_charge` no longer callable from the API; default privileges revoked so new objects in `public` start closed to `anon` / `authenticated` |
| `…1500_early_end_billing.sql` | A fixed-time / fixed-amount booking **ended early** (fewer billable seconds than booked; paused time never counts) charges only the time played, priced by the table's existing pricing functions (unchanged) and never more than the booking: `fusion_session_charge` (per minute, also custom rates via `fusion_charge_at_rate`), `fusion_tiered_charge` (`fusion_tier_price` of the time played, exactly as open play), new `fusion_slot_charge` (`fusion_slot_price` of the time played). A booking used in full (time's up hold, Continue, extensions) is unchanged. `end_session` / `cancel_session` route hourly + 30 sessions through `fusion_slot_charge`. No table changes; sessions already ended keep their stored charge |
| `…1700_profile_pictures.sql` | `app_users.avatar_path` (nullable; NULL shows initials); public Storage bucket `avatars` (≤ 512 KB, JPEG/PNG/WebP) with policies letting a signed-in, active account write only its own folder (`<user id>/…`); `set_my_avatar(p_path)` (own folder only); `get_my_profile` returns `avatar_path` |
| `…1800_round_down_billing.sql` | `settings.billing_rounding` becomes `down` (and its default): only completed minutes are billed. No invoices or totals rewritten |
| `…1600_sales_by_hour.sql` | `get_sales_by_hour(p_date, p_closed_only)` (admin): one business day's invoices hour by hour (club time; cash / bank parts; invoices), with `covered_total` so History and Reports can compare it with the day's permanent ledger total before charting (old invoices are removed by retention). Read-only; no table changes |
| `…1300_split_payment_under_hour_rate.sql` | Split payments: `sales.payment_method` may be `split` with `split_cash_amount` (0 < cash < total; bank = total − cash, not stored), checked by `sales_split_cash`; `fusion_cash_part` / `fusion_bank_part`; `complete_checkout(…, p_split_cash)` posts each part to the counter ledger; voids, closing reconciliation, snack sales, table sales, shift detail and receipts split them. Pricing mode `tiered_hourly` with `under_hour_rate` (> `hourly_rate`) on categories and sessions; `fusion_tier_price`, `fusion_tiered_charge`, `fusion_tier_seconds` (mirrored in `src/shared/billing.ts`); `admin_save_category(…, p_under_hour_rate)`. Reset fix: the products update has a WHERE clause (the API's safeupdate guard refused it) |
| `…1200_business_data_reset.sql` | `settings.business_reset_at` / `business_reset_by`; `admin_business_data_summary`, `admin_export_business_data(p_password)` (optional backup) and `admin_reset_business_data(p_password, p_confirmation, p_reset_stock)` — admin only, password checked against Supabase Auth's bcrypt hash, phrase checked, advisory lock, one transaction; TRUNCATEs the 13 business tables, restarts receipt numbers, zeroes units sold (stock only when asked). Never scheduled |

## Tables

| Table | Purpose | Key rules |
|---|---|---|
| `app_users` | Profile + authorization for each Supabase Auth user (`id` → `auth.users`) | `role` ∈ admin/staff; `floor_id` (null = all floors); `permissions` ⊆ the 7 known keys; `is_active` |
| `floors` | Floors of the club | unique name |
| `table_categories` | Snooker / Pool / Table Tennis … with `rate_per_minute` (rupees per minute, up to 4 decimals), or `pricing_mode = hourly_special30` with `hourly_rate` and `special_30_rate` | 0 < rate ≤ 10,000; hourly prices required exactly when the mode is hourly |
| `club_tables` | Tables: name, category, floor, optional `rate_override` (per minute), `is_active` | unique active name |
| `sessions` | A table's play session — **never deleted** | status ∈ running/paused/billing/completed/cancelled/voided; **partial unique index: one open session per table**; consistency checks between status, `paused_at`, `ended_at`, `billable_seconds`, `base_amount`; `rate_per_minute` snapshotted at start; booking fields (`booked_seconds`, `booked_amount`); `custom_rate_per_minute` when checkout used a custom rate (`base_amount` is then the charge billed) |
| `session_items` | A session's tab | price snapshotted when served; stock taken when served |
| `inventory_products` | Products | `cost_price`, `selling_price`, `stock_quantity ≥ 0` (DB-level oversell guard), `track_stock`, `low_stock_threshold`, `units_sold` counter, soft delete via `is_active` |
| `customers` | Name + optional phone | phone normalised (PK numbers → `03…`), unique |
| `sales` | One paid transaction (an invoice) — removed by retention after the chosen period | `shift_id` (not null) → the cashier's counter shift; `payment_method` ∈ cash/bank_transfer only; `discount ≤ base + products`; `final = base + products − discount`; `client_ref` unique (idempotency); `business_date`; snapshots of table, customer and cashier; `rate_per_minute` charged, with `standard_rate_per_minute` / `standard_base_amount` when a custom rate replaced the table's rate |
| `sale_items` | Lines of a sale | `line_total = unit_price × quantity`; product name snapshot; `unit_cost` = cost price at the moment of sale (null before 0900) |
| `product_sales_daily` | **Permanent product ledger** — one row per product per business date | quantity, revenue (selling price × qty), `discount` (the products' pro-rata share of invoice discounts), and the same for units with a recorded cost plus that cost. Posted by checkout, reversed by sale deletion, never removed by retention |
| `daily_summaries` | A closed business day's final figures (Close Day) | unique `business_date`; `total_sales = total_cash + total_bank`; `snack_sales`, `expenses`, `invoice_count`, `closed_at`; `legacy_cash` / `legacy_bank` = amounts archived by the pre-0700 close day (their sales no longer exist) |
| `counter_shifts` | One staff counter opening → closing | `status` open/closed; one open shift per user (partial unique index); live totals `cash_sales`, `bank_sales`, `snack_sales`, `discounts`, `expenses`, `invoice_count`, `voided_*`; final once closed; `imported` for pre-0700 sales; `details_purged_at` once retention removed its invoices |
| `shift_daily_totals` | **The permanent ledger** — one row per shift per business date | same figures as the shift, per date; every report reads this, so totals survive invoice cleanup |
| `expenses` | Counter expenses (money paid out of a counter) and business expenses | a counter expense belongs to a shift and its owner; a business expense (admin) has no shift and a `category`; `client_ref` unique; voided (never deleted). Business expenses never touch the shift ledger |
| `bookings` | Admin pre-bookings | status booked/started/completed/cancelled/no_show; `session_id` unique (a booking starts at most one session) |
| `customer_visits` | Permanent customer statistics, one row per customer per business date | invoices, spent, play seconds — drives the rankings |
| `retention_runs` | Log of each sales-detail cleanup | source schedule/manual, status, cutoff, rows removed, error message |
| `settings` | Singleton club configuration | club/receipt text, timezone, day-start hour, billing rules (rounding down since 1800); `admin_idle_lock_minutes` is no longer used by the app |

All money columns are `numeric` (exact). Table status is **derived** from `sessions` rather than stored twice.

## Timing model

`billable = (coalesce(ended_at, paused_at, now()) − started_at) − paused_ms`. Every value is persisted, so the timer shown on any terminal (aligned to server time) and the final bill agree, across restarts. `end_session` computes the bill once, in the database, with `fusion_session_charge(...)`. `src/shared/billing.ts` is its TypeScript twin; `tests/db/billing-parity.test.ts` checks 2,000 random cases for equality.

## Functions (API)

Floor operations (any active user, floor-checked): `start_session`, `pause_session`, `resume_session`, `end_session`, `reopen_session`, `cancel_session` (permission), `add_session_item`, `set_session_item_quantity`, `search_products`, `adjust_stock` (permission), `search_customers`, `save_customer` (permission), `get_tables_overview`, `get_dashboard`, `get_my_profile`, `list_switch_targets`.

Staff counter (own data only; administrators are refused with hint `admin_no_sales`): `open_counter`, `close_counter` (an admin may close any open counter), `complete_checkout` (needs the caller's open shift), `delete_sale` (own sales, open shift only), `add_expense`, `void_expense`, `get_my_counter`, `get_shift_detail`, `get_receipt`.

Floor operations added in 1000: `acknowledge_allocation_alert`, `continue_after_allocation` (floor-checked), `get_snack_sales` (own sales; all for an admin).

Administration (admin only): `get_table_sales`, `get_financial_report`, `get_sales_by_hour`, `get_expenses`, `admin_add_expense`, `admin_void_expense`, `get_product_sales`, `admin_update_settings`, `admin_save_floor`, `admin_delete_floor`, `admin_save_category`, `admin_delete_category`, `admin_save_table`, `admin_set_table_active`, `admin_delete_table`, `admin_save_product`, `admin_set_product_active`, `admin_delete_product`, `admin_create_user_profile`, `admin_update_user`, `admin_set_user_active`, `admin_check_user_deletable`, `get_history`, `get_sales_report`, `list_open_business_dates`, `close_business_day`, `admin_save_booking`, `admin_set_booking_status`, `admin_delete_booking`, `start_booking`, `list_bookings`, `get_customer_rankings`, `get_retention_status`, `admin_run_retention`.

Scheduler only (not callable from the API): `fusion_retention_job()` — run hourly by pg_cron.

Errors are raised with an operator-friendly message and a machine-readable `hint` (e.g. `table_busy`, `insufficient_stock`, `forbidden`, `wrong_floor`, `price_changed`).

## Session lifecycle

`running ⇄ paused → billing → completed` (paid). `billing → running` via *Reopen*. Open sessions can become `cancelled` (no charge; the time played and the waived charge are recorded). Deleting a sale marks its session `voided`. No path deletes a session; only the retention job deletes invoices (sales and sale items), never sessions. Staff can read open sessions and those finished today on their floor; admins can read all.

## Concurrency

- Starting a session locks the table row; the partial unique index is the final backstop.
- Every stock change locks the product row (`FOR UPDATE`) and the `stock_quantity ≥ 0` constraint makes overselling impossible.
- Stock is only changed by deltas (`adjust_stock`), never overwritten from a form.
- Checkout locks the session; `client_ref` makes retries idempotent.
- **Posting:** every checkout, void and expense locks the staff member's open shift row (`FOR UPDATE`) and posts to the shift and to its `shift_daily_totals` row in the same transaction (update-then-insert, safe because the shift lock serialises postings; reversals are negative postings, which the `>= 0` checks make impossible unless the amount was posted). `client_ref` makes checkout and expenses idempotent.
- **Closing a counter** verifies the shift totals against the ledger, the non-voided expenses and — while they still exist — the invoices themselves, then freezes them. Closed shifts accept no further postings.
- `close_business_day` takes an advisory lock per date, refuses while a counter that traded that day is open, writes the day's figures from the ledger (plus any legacy amount), reads them back to verify, and **deletes nothing**. Repeating it refreshes the figures; it never adds twice.
- **Retention** (`fusion_run_retention`): a transaction-level advisory lock prevents overlapping runs (an overlapping run is logged as *skipped*); it locks invoices dated before `today − retention days` from **closed** shifts (at most 20,000 per run), checks each has its ledger row, deletes their sale items and sales, marks the shifts `details_purged_at`, and logs the run. A failure rolls back the deletions but keeps the log entry. Running it again finds nothing new, so it is idempotent. Rows freed by DELETE are reused by PostgreSQL (autovacuum); the database file does not shrink immediately.

## Adding migrations

`…0500_grants_realtime.sql` revokes everything from `anon`/`authenticated` and grants an allow-list. New functions in later migrations must be granted explicitly (`grant execute on function … to authenticated`) — and must check the caller with `fusion_require_user()`, `fusion_require_admin()` or `fusion_require_perm()`.
