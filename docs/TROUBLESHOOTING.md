# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Can't reach the server" | No internet, or the Supabase project is paused (free projects pause after a week without use — resume it in the Supabase dashboard). |
| "FUSION isn't connected" screen | The deployment is missing `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`, or they are wrong. Fix them in Vercel → Settings → Environment Variables and redeploy (locally: `.env`). |
| Vercel build fails: "must be set for a web build" / "Supabase settings rejected" | The two environment variables are missing, or a **secret** key was entered. Use the publishable/anon key. The previous deployment stays online meanwhile. |
| A page shows old screens after an update | Refresh the browser (Ctrl+F5). New versions load on the next page load. |
| "Incorrect username or password" | Usernames are lowercase. An admin can reset a password in **Staff**. |
| "This account is not active" | The account was deactivated in **Staff**. |
| Creating staff fails with "Could not reach the admin-users service" | Deploy the Edge Function: `npx supabase functions deploy admin-users --use-api --no-verify-jwt`. |
| Creating staff fails with "Server is not configured." | The project has legacy API keys disabled. Run `npx supabase secrets set FUSION_SECRET_KEY=sb_secret_…`. |
| `npm run setup:admin` says the email address is invalid | Supabase rejected the internal sign-in address `<username>@fusion.local`. Change `AUTH_EMAIL_DOMAIN` (same value) in `src/shared/constants.ts`, `supabase/functions/admin-users/index.ts` and `scripts/create-admin.mjs` to a domain you own, rebuild and redeploy. |
| "Too many attempts" when switching portals often | Raise Authentication → Rate Limits → sign-ins in Supabase (all terminals share the club's internet IP). |
| Docker errors from `supabase functions deploy` | Add `--use-api`. |
| "Only an administrator can do this" / "not on your assigned floor" | Working as intended: the database refused an action the signed-in account isn't allowed to do. Switch portal or change the staff member's floor/permissions. |
| "Table … is already in use" | Another terminal started it. The floor refreshes automatically; if not, wait a few seconds (fallback refresh every 20 s). |
| "The price of … changed" (counter sale) | An admin edited the price while the item was in the cart. Remove and re-add it. |
| "Only N × … left in stock" | Restock it in **Inventory**, or turn off stock tracking for that product. |
| Live updates between terminals are slow | Realtime may be disabled for the project; FUSION falls back to polling (≤ 20 s). Check that the migration added the tables to the `supabase_realtime` publication. |
| Receipt doesn't print | **Settings → This computer**: choose the paper, then *Print test page* — the browser's print dialog chooses the printer. To print without the dialog, start Chrome with `--kiosk-printing` (prints to the default printer). |
| Reports show "Open counters · live, not final" | Those counters are still open. Their figures become final once each staff member closes their counter. |
| Product profit shows "—" or a note about units sold before cost prices were recorded | Those items were sold before migration 0900 recorded cost prices with each sale. They count in sales, not in profit; FUSION does not guess past costs. |
| "Counter expenses are voided from the counter while it is open." | Counter expenses belong to a staff member's shift; void them in **My counter** while it is open. The Expenses page voids business expenses only. |
| The "Time's up" alarm makes no sound | Browsers allow sound only after someone clicks on the page; the popup says so until then. Check the computer's volume. The popup and the table card still show "Time's up". |
| "… is priced by the hour: choose a duration" | Categories with hourly + special 30-minute pricing have no open play or prepaid amount: choose a duration in 30-minute steps. |
| "Extend in steps of 30 minutes." / "This session was just changed on another terminal." | Extensions are 30, 60, 90 … minutes. If another computer extended it a moment ago, check the new time and extend again only if needed. |
| "Custom rates per minute do not apply to tables priced by the hour." | Use a discount for regulars on hourly-priced tables. |
| "This booking still has time left." | *Continue* is only possible once the booking is used up. |
| A booked table shows 0:00 and the charge doesn't grow | Working as intended: billing holds at the booked amount until staff press **Continue** (extra time billed from then) or **End**. |
| Table Sales Report shows less than History for an old period | The report reads invoices, and the retention policy removes old invoices (History keeps permanent totals). |
| "Enter a rate per minute above zero." | Rates are rupees per minute (e.g. 10, 7.50 or 6.6667), above zero and at most 10,000. |
| "You do not have permission to set a custom rate." | Custom rates use the *Discounts & custom rates* permission (Staff → edit the account). Entering the table's own rate needs no permission. |
| Saving a category or table fails on a computer | It runs an old copy of the desktop app that sends hourly rates; use the web app instead. |
| Today's Sales shows "Includes archived total" | Amounts saved by the old (pre-0700) Close Day & Archive are included as legacy totals; they have no staff breakdown. |
| "Open your counter first." | Staff take payments and record expenses on their own counter. Open it from **My counter** (or the Dashboard card). |
| "Administrators manage the business and do not take payments." | By design. Switch to the staff member's portal (their password) to take the payment. |
| "Close these counters first: …" when closing a day | A counter that traded that day is still open. The staff member closes it in **My counter**, or the admin uses **Close** on the Dashboard's *Staff today* table. |
| "… table session(s) started on this counter are still open" | Closing a counter with tables still running needs the handover box ticked; the next counter that checks them out takes the payment. |
| "This sale belongs to a closed counter shift; its totals are final." | Closed shifts are permanent records. Correct it with a new transaction on an open counter. |
| "… can only be deactivated" / "can only be removed" when deleting | The record has history (sales, shifts, sessions, bookings). Deactivate / remove it instead — reports keep its name. |
| Settings → Data retention says *not scheduled* | Enable **pg_cron** in Supabase and run once in the SQL Editor: `select cron.schedule('fusion-sales-retention', '17 * * * *', 'select public.fusion_retention_job()');`. Meanwhile *Run cleanup now* works. |
| Invoices from an old shift show "expired under the retention policy" | Working as intended: the invoice details were removed after the retention period; the shift's figures stay correct. |
| Wrong business date around midnight | Set **Settings → Business day** (timezone and the hour the business day starts). Applies to new sales only. Pre-bookings are listed by business day too, so a 01:00 AM booking appears under the evening before when the day starts later. |
| `npm run dist:win` (optional desktop build) fails downloading Electron/NSIS | Network/proxy issue — retry, or set `ELECTRON_MIRROR`. |
| `npm install` didn't download Electron (desktop build / desktop end-to-end test only) | Run `node node_modules/electron/install.js`. The web app doesn't need Electron. |
