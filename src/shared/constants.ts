export const APP_NAME = 'FUSION'

/**
 * Staff sign in with a username; Supabase Auth needs an email, so each
 * username maps to `<username>@fusion.local`. No email is ever sent.
 * Keep in sync with supabase/functions/admin-users and scripts/create-admin.mjs.
 */
export const AUTH_EMAIL_DOMAIN = 'fusion.local'

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}

export const PERMISSIONS = [
  { key: 'apply_discount', label: 'Discounts & custom rates', description: 'Give discounts and set a custom rate per minute at checkout.' },
  { key: 'delete_sales', label: 'Delete sales', description: "Void today's sales on their floor; stock is returned." },
  { key: 'cancel_session', label: 'Cancel sessions', description: 'Discard a session without charging.' },
  { key: 'counter_sale', label: 'Counter sales', description: 'Sell products without a table session.' },
  { key: 'manage_customers', label: 'Edit customers', description: 'Edit customer names and phone numbers.' },
  { key: 'adjust_stock', label: 'Restock products', description: 'Add or correct stock (cost prices stay hidden).' },
  { key: 'view_own_sales', label: 'See own sales', description: 'See their own sales and shift totals.' }
] as const

export type Permission = (typeof PERMISSIONS)[number]['key']

export const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'bank_transfer', label: 'Bank Transfer' }
] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['key']
