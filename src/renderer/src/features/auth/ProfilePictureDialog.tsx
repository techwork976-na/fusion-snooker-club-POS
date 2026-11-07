import { useRef, useState } from 'react'
import { Camera, Trash2 } from 'lucide-react'
import { errorMessage } from '@/lib/errors'
import { MAX_ORIGINAL_BYTES, removeProfilePicture, setProfilePicture, squareAvatar } from '@/data/avatars'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from './AuthProvider'

/** Any account (admin or staff) sets or removes its own profile picture; without one the initials show. */
export function ProfilePictureDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { profile, refreshProfile } = useAuth()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!profile) return null

  const choose = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!file.type.startsWith('image/')) return setError('Choose a picture (JPG, PNG, WebP or HEIC from a phone).')
    if (file.size > MAX_ORIGINAL_BYTES) return setError('That picture is too large (over 15 MB). Choose a smaller one.')
    setBusy('upload')
    try {
      await setProfilePicture(profile.id, await squareAvatar(file), profile.avatar_path)
      await refreshProfile()
      toast.success('Profile picture updated.')
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
      if (input.current) input.current.value = ''
    }
  }

  const remove = async () => {
    setBusy('remove')
    setError(null)
    try {
      await removeProfilePicture(profile.avatar_path)
      await refreshProfile()
      toast.success('Profile picture removed.')
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size="sm"
      title="Profile picture"
      description="Shown on your account in the sidebar and the account switcher. Without one, your initials show."
      footer={
        <>
          {profile.avatar_path && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()} data-testid="remove-picture">
              Remove
            </Button>
          )}
          <Button variant="primary" icon={<Camera className="size-4" />} loading={busy === 'upload'} disabled={busy !== null} onClick={() => input.current?.click()} data-testid="choose-picture">
            {profile.avatar_path ? 'Choose another' : 'Choose a picture'}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-5">
        <Avatar name={profile.full_name} path={profile.avatar_path} role={profile.role} size={88} />
        <div className="min-w-0">
          <p className="font-display-tight text-[20px] text-forest-950">{profile.full_name}</p>
          <p className="mt-1 text-sm text-fg-4">@{profile.username}</p>
          <p className="mt-3 text-xs text-fg-4">The picture is cropped to a square and made small (a few KB) before it is uploaded.</p>
        </div>
      </div>
      {error && <p className="mt-4 rounded-xl bg-claret-50 px-4 py-3 text-sm text-claret-700">{error}</p>}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void choose(e.target.files?.[0])} data-testid="picture-input" />
    </Modal>
  )
}
