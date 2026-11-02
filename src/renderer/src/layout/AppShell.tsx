import { useEffect, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLiveUpdates, useServerClockSync, useSettings } from '@/data/hooks'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { TablesPage } from '@/features/tables/TablesPage'
import { SalesPage } from '@/features/sales/SalesPage'
import { MyCounterPage } from '@/features/counter/MyCounterPage'
import { HistoryPage } from '@/features/history/HistoryPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { ExpensesPage } from '@/features/expenses/ExpensesPage'
import { BookingsPage } from '@/features/bookings/BookingsPage'
import { InventoryPage } from '@/features/inventory/InventoryPage'
import { CustomersPage } from '@/features/customers/CustomersPage'
import { StaffPage } from '@/features/staff/StaffPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

/** UX guard only — every operation is authorised again by the database. */
function Guard({ allow, children }: { allow: boolean; children: ReactNode }) {
  return allow ? <>{children}</> : <Navigate to="/" replace />
}

/** Signs an idle admin out so an unattended terminal drops back to staff use. */
function useAdminIdleLock() {
  const { isAdmin, signOut } = useAuth()
  const { data: settings } = useSettings()
  const minutes = settings?.admin_idle_lock_minutes ?? 15
  useEffect(() => {
    if (!isAdmin || minutes <= 0) return
    let last = Date.now()
    const bump = () => {
      last = Date.now()
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    const id = setInterval(() => {
      if (Date.now() - last > minutes * 60_000) {
        void signOut(`The admin portal was locked after ${minutes} minutes without activity.`)
      }
    }, 10_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump))
      clearInterval(id)
    }
  }, [isAdmin, minutes, signOut])
}

export function AppShell() {
  const location = useLocation()
  const { isAdmin, can } = useAuth()
  useServerClockSync()
  useLiveUpdates(true)
  useAdminIdleLock()

  return (
    <div className="flex h-full bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <main className="relative min-h-0 flex-1 overflow-y-auto" id="main">
        <AnimatePresence mode="wait" initial={false}>
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/tables" element={<TablesPage />} />
            <Route
              path="/counter"
              element={
                <Guard allow={!isAdmin}>
                  <MyCounterPage />
                </Guard>
              }
            />
            <Route
              path="/sales"
              element={
                isAdmin ? (
                  <Navigate to="/history?tab=invoices" replace />
                ) : (
                  <Guard allow={can('view_own_sales') || can('delete_sales')}>
                    <SalesPage />
                  </Guard>
                )
              }
            />
            <Route
              path="/history"
              element={
                <Guard allow={isAdmin}>
                  <HistoryPage />
                </Guard>
              }
            />
            <Route
              path="/reports"
              element={
                <Guard allow={isAdmin}>
                  <ReportsPage />
                </Guard>
              }
            />
            <Route
              path="/expenses"
              element={
                <Guard allow={isAdmin}>
                  <ExpensesPage />
                </Guard>
              }
            />
            <Route
              path="/bookings"
              element={
                <Guard allow={isAdmin}>
                  <BookingsPage />
                </Guard>
              }
            />
            <Route
              path="/inventory"
              element={
                <Guard allow={isAdmin || can('adjust_stock')}>
                  <InventoryPage />
                </Guard>
              }
            />
            <Route
              path="/customers"
              element={
                <Guard allow={isAdmin || can('manage_customers')}>
                  <CustomersPage />
                </Guard>
              }
            />
            <Route
              path="/staff"
              element={
                <Guard allow={isAdmin}>
                  <StaffPage />
                </Guard>
              }
            />
            <Route
              path="/settings"
              element={
                <Guard allow={isAdmin}>
                  <SettingsPage />
                </Guard>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnimatePresence>
      </main>
      </div>
    </div>
  )
}
