import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DropdownMenu } from 'radix-ui'
import { motion } from 'framer-motion'
import { Camera, Check, ChevronsUpDown, KeyRound, Lock, LogOut, UserPlus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { StoredAccount } from '@/lib/accounts'
import { Avatar } from '@/components/ui/Avatar'
import { ConfirmDialog } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from './AuthProvider'
import { AddAccountDialog } from './AddAccountDialog'
import { ChangePasswordDialog } from './ChangePasswordDialog'
import { ProfilePictureDialog } from './ProfilePictureDialog'

export { initials } from '@/components/ui/Avatar'

const itemClass =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-fg outline-none select-none data-[highlighted]:bg-forest-950/[0.06] data-[disabled]:cursor-default'

export const portalLabel = (a: Pick<StoredAccount, 'role' | 'floorName'>) =>
  a.role === 'admin' ? 'Admin portal' : `Staff · ${a.floorName ?? 'All floors'}`
const firstName = (name: string) => name.split(/\s+/)[0] ?? name

/** One click from one account on this device to another — no password. */
export function useSwitchAccount() {
  const { switchTo } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  return async (a: StoredAccount) => {
    try {
      const p = await switchTo(a.userId)
      navigate('/')
      toast.success(`Switched to ${p.full_name}.`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
}

/** End of the night: every account on this device is signed out; passwords are needed again. */
export function LogoutAllDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { accounts, signOutAll } = useAuth()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title="Log out of all accounts?"
      confirmLabel="Log out of all"
      description={`All ${accounts.length} account${accounts.length === 1 ? '' : 's'} on this device will be signed out. Each needs its password to sign in again.`}
      onConfirm={() => signOutAll('Logged out of all accounts on this device.')}
    />
  )
}

/** The signed-in account at the foot of the sidebar: switch accounts, add one, profile picture, sign out. */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { profile, accounts, signOut } = useAuth()
  const switchAccount = useSwitchAccount()
  const [addOpen, setAddOpen] = useState(false)
  const [pictureOpen, setPictureOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  if (!profile) return null
  const portal = profile.role === 'admin' ? 'Admin portal' : `Staff · ${profile.floor_name ?? 'All floors'}`

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label="Account"
            data-testid="account-menu"
            className={cn(
              'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-cream/[0.05] data-[state=open]:bg-cream/[0.07]',
              compact && 'justify-center'
            )}
          >
            <Avatar name={profile.full_name} path={profile.avatar_path} role={profile.role} size={36} />
            <span className={cn('min-w-0 flex-1', compact && 'hidden')}>
              <span className="block truncate text-[13px] font-semibold text-side-fg">{profile.full_name}</span>
              <span className="block truncate text-[11.5px] text-side-muted">{portal}</span>
            </span>
            <ChevronsUpDown className={cn('size-4 shrink-0 text-side-muted', compact && 'hidden')} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content asChild side="top" align="start" sideOffset={8}>
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16 }}
              className="popover z-[70] max-h-[min(80vh,640px)] w-72 overflow-y-auto p-1.5"
            >
              <DropdownMenu.Label className="label px-3 pt-2.5 pb-1.5">On this device</DropdownMenu.Label>
              {accounts.map((a) => {
                const current = a.userId === profile.id
                return (
                  <DropdownMenu.Item
                    key={a.userId}
                    className={itemClass}
                    disabled={current}
                    onSelect={() => void switchAccount(a)}
                    data-testid={`account-${a.username}`}
                    aria-current={current ? 'true' : undefined}
                  >
                    <Avatar name={a.fullName} path={current ? profile.avatar_path : a.avatarPath} role={a.role} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{a.fullName}</span>
                      <span className="block truncate text-xs font-normal text-fg-4">{portalLabel(a)}</span>
                    </span>
                    {current && <Check className="size-4 text-baize-600" aria-label="Current account" />}
                  </DropdownMenu.Item>
                )
              })}
              <DropdownMenu.Item className={itemClass} onSelect={() => setAddOpen(true)} data-testid="add-account">
                <span className="flex size-[30px] items-center justify-center rounded-full bg-forest-950/[0.06]">
                  <UserPlus className="size-4 text-fg-3" />
                </span>
                Add account
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="mx-2 my-1 h-px bg-line" />
              <DropdownMenu.Item className={itemClass} onSelect={() => setPictureOpen(true)} data-testid="profile-picture">
                <Camera className="size-4 text-fg-3" />
                Profile picture
              </DropdownMenu.Item>
              <DropdownMenu.Item className={itemClass} onSelect={() => setPasswordOpen(true)}>
                <KeyRound className="size-4 text-fg-3" />
                Change my password
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="mx-2 my-1 h-px bg-line" />
              <DropdownMenu.Item className={itemClass} onSelect={() => void signOut()} data-testid="sign-out-current">
                <Lock className="size-4 text-fg-3" />
                Sign out of {firstName(profile.full_name)}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={itemClass} onSelect={() => setLogoutOpen(true)} data-testid="sign-out-all">
                <LogOut className="size-4 text-fg-3" />
                Log out of all accounts
              </DropdownMenu.Item>
            </motion.div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
      <ProfilePictureDialog open={pictureOpen} onOpenChange={setPictureOpen} />
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <LogoutAllDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  )
}
