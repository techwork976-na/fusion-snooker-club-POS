import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Search, UserPlus, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { Customer } from '@/lib/types'
import { saveCustomer, searchCustomers } from '@/data/api'
import { keys, useAction, useDebounced, useSettings } from '@/data/hooks'
import { Button, IconButton } from '@/components/ui/Button'
import { inputClass, TextField } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader, Segmented } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { CustomerRankingsView } from './Rankings'

export function CustomersPage() {
  const { can, isAdmin } = useAuth()
  const { data: settings } = useSettings()
  const canEdit = can('manage_customers')
  const [tab, setTab] = useState<'rankings' | 'all'>(isAdmin ? 'rankings' : 'all')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 200)
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.customers(`list:${debounced}`),
    queryFn: () => searchCustomers(debounced, 50),
    enabled: tab === 'all'
  })

  return (
    <Page>
      <PageHeader
        title="Customers"
        subtitle="One profile per phone number. Regulars are suggested automatically at checkout."
        actions={
          <>
            {isAdmin && (
              <Segmented
                layoutId="customers-tab"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'rankings', label: 'Rankings' },
                  { value: 'all', label: 'All customers' }
                ]}
              />
            )}
            {canEdit && (
              <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>
                Add customer
              </Button>
            )}
          </>
        }
      >
        {tab === 'all' && (
          <div className="relative w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg-4" />
            <input className={cn(inputClass, 'pl-10')} placeholder="Search by name or phone…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
      </PageHeader>
      {tab === 'rankings' ? (
        <CustomerRankingsView />
      ) : (
      <div className="card overflow-hidden">
        {error ? (
          <div className="p-6">
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <LoadingBlock />
        ) : !data?.length ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title={debounced ? 'No matching customers' : 'No customers yet'}
            description="A customer profile is created when a phone number is entered at checkout or on a booking."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-5 py-3 font-semibold">Name</th>
                <th className="px-5 py-3 font-semibold">Phone</th>
                <th className="px-5 py-3 font-semibold">Customer since</th>
                <th className="w-16 px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((c) => (
                <tr key={c.id}>
                  <td className="px-5 py-3 font-semibold text-fg">{c.name}</td>
                  <td className="px-5 py-3 text-fg-2 tabular">{c.phone ?? <span className="text-fg-5">—</span>}</td>
                  <td className="px-5 py-3 text-fg-4">
                    {new Date(c.created_at).toLocaleDateString('en-GB', { timeZone: settings?.business_timezone, day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canEdit && (
                      <IconButton size="sm" label="Edit customer" onClick={() => setEditing(c)}>
                        <Pencil className="size-4" />
                      </IconButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}
      <CustomerDialog customer={editing} onClose={() => setEditing(null)} />
    </Page>
  )
}

function CustomerDialog({ customer, onClose }: { customer: Customer | 'new' | null; onClose: () => void }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const save = useAction((a: { id: string | null; name: string; phone: string | null }) => saveCustomer(a.id, a.name, a.phone), {
    invalidate: [['customers']],
    success: (c) => `${c.name} saved.`
  })
  useEffect(() => {
    if (customer === 'new') {
      setName('')
      setPhone('')
    } else if (customer) {
      setName(customer.name)
      setPhone(customer.phone ?? '')
    }
  }, [customer])
  const submit = () => {
    if (!customer || !name.trim()) return
    save.mutate({ id: customer === 'new' ? null : customer.id, name: name.trim(), phone: phone.trim() || null }, { onSuccess: onClose })
  }
  return (
    <Modal
      open={customer !== null}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      size="sm"
      title={customer === 'new' ? 'Add customer' : 'Edit customer'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <TextField label="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} hint="Optional. +92 and 03… numbers are matched as the same customer." />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
