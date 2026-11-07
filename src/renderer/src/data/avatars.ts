import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'
import { setMyAvatar } from './api'

/**
 * Profile pictures live in the Supabase Storage bucket "avatars", one folder
 * per account (`<user id>/<random>.jpg`). Storage policies let each signed-in
 * account write only its own folder; the database keeps the path of the
 * current picture (app_users.avatar_path, set through set_my_avatar).
 */
export const AVATAR_BUCKET = 'avatars'
/** Pictures are stored square at this size (plenty for every avatar spot, a few KB each). */
export const AVATAR_PIXELS = 256
/** Larger originals are refused before resizing (a phone photo is usually 2–8 MB). */
export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024

export function avatarUrl(path: string | null | undefined): string | null {
  if (!path) return null
  return supabase().storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl
}

/** Crops the image to a centred square and scales it to AVATAR_PIXELS, as a JPEG. */
export async function squareAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture this browser can open.')
  })
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_PIXELS
  canvas.height = AVATAR_PIXELS
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be prepared.'))), 'image/jpeg', 0.86))
}

/** Uploads a new picture for the signed-in account and makes it their profile picture; the old one is deleted. */
export async function setProfilePicture(userId: string, picture: Blob, previous: string | null | undefined): Promise<Profile> {
  const path = `${userId}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase().storage.from(AVATAR_BUCKET).upload(path, picture, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false })
  if (error) throw new Error(`The picture could not be uploaded: ${error.message}`)
  try {
    const profile = await setMyAvatar(path)
    if (previous) await supabase().storage.from(AVATAR_BUCKET).remove([previous])
    return profile
  } catch (e) {
    await supabase().storage.from(AVATAR_BUCKET).remove([path])
    throw e
  }
}

/** Removes the signed-in account's profile picture (back to initials). */
export async function removeProfilePicture(previous: string | null | undefined): Promise<Profile> {
  const profile = await setMyAvatar(null)
  if (previous) await supabase().storage.from(AVATAR_BUCKET).remove([previous])
  return profile
}
