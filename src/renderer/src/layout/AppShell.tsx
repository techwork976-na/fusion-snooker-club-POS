import { useRef, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLiveUpdates, useServerClockSync } from '@/data/hooks'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { TablesPage } from '@/features/tables/TablesPage'
import { AllocationAlerts } from '@/features/tables/AllocationAlerts'
import { SnacksPage } from '@/features/snacks/SnacksPage'
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
import { MobileNav } from './MobileNav'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

/** UX guard only — every operation is authorised again by the database. */
function Guard({ allow, children }: { allow: boolean; children: ReactNode }) {
  return allow ? <>{children}</> : <Navigate to="/" replace />
}

export function AppShell() {
  const location = useLocation()
  const { isAdmin, can, profile } = useAuth()
  const main = useRef<HTMLElement>(null)
  useServerClockSync()
  // Accounts stay signed in until "Log out of all accounts" (no idle lock); live updates follow the active account.
  useLiveUpdates(true, profile?.id)

  return (
    <div className="flex h-full bg-canvas">
      <AllocationAlerts />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <main ref={main} className="relative min-h-0 flex-1 overflow-y-auto" id="main">
        {/* A new page opens at its top (the scroll area is shared by every page); tabs within a page keep their place. */}
        <AnimatePresence mode="wait" initial={false} onExitComplete={() => main.current?.scrollTo({ top: 0 })}>
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/tables" element={<TablesPage />} />
            <Route path="/snacks" element={<SnacksPage />} />
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
      <MobileNav />
      </div>
    </div>
  )
}
