// Builds the application icons from the original FUSION logo (unaltered
// artwork, only resized): the desktop window, installer and taskbar icons in
// build/, and the web app's home-screen icons in src/renderer/public/.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src/renderer/src/assets/fusion-logo.jpg')
const web = join(root, 'src/renderer/public')
mkdirSync(join(root, 'build'), { recursive: true })
mkdirSync(join(web, 'icons'), { recursive: true })

await sharp(source).resize(512, 512).png().toFile(join(root, 'build/icon.png'))
await sharp(source).resize(256, 256).png().toFile(join(root, 'build/icon-256.png'))
console.log('Icons written to build/')

// Home screen (manifest.json) and iPhone/iPad (apple-touch-icon.png).
await sharp(source).resize(192, 192).png().toFile(join(web, 'icons/icon-192.png'))
await sharp(source).resize(512, 512).png().toFile(join(web, 'icons/icon-512.png'))
await sharp(source).resize(180, 180).png().toFile(join(web, 'apple-touch-icon.png'))

// Maskable: launchers may crop to a circle, so the logo sits inside the safe
// zone (the middle 80%) on the logo's own background colour.
const { data } = await sharp(source).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
const background = { r: data[0], g: data[1], b: data[2], alpha: 1 }
const inner = await sharp(source).resize(400, 400).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background } })
  .composite([{ input: inner, left: 56, top: 56 }])
  .png()
  .toFile(join(web, 'icons/maskable-512.png'))
console.log('Web app icons written to src/renderer/public/')
