// Builds the application icon from the original FUSION logo (unaltered
// artwork, only resized) for the window, the installer and the taskbar.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src/renderer/src/assets/fusion-logo.jpg')
mkdirSync(join(root, 'build'), { recursive: true })

await sharp(source).resize(512, 512).png().toFile(join(root, 'build/icon.png'))
await sharp(source).resize(256, 256).png().toFile(join(root, 'build/icon-256.png'))
console.log('Icons written to build/')
