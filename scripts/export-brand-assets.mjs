import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(projectRoot, 'docs', 'brand', 'production')
const approvedArtworkPath = path.join(
  projectRoot,
  'docs',
  'brand',
  'mupot-logo-planter-mu-v1.png',
)
const exactMasterPath = path.join(outputDir, 'mupot-mark-exact-master.png')
const background = '#F5F3F0'
const exactCrop = { left: 310, top: 206, width: 360, height: 360 }

await mkdir(outputDir, { recursive: true })
const approvedArtwork = await readFile(approvedArtworkPath)
const exactMaster = await sharp(approvedArtwork)
  .extract(exactCrop)
  .png()
  .toBuffer()
await sharp(exactMaster).toFile(exactMasterPath)

async function exactIcon(size, filename) {
  await sharp(exactMaster)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(outputDir, filename))
}

async function paddedIcon(size, filename, safeFraction) {
  const markSize = Math.round(size * safeFraction)
  const mark = await sharp(exactMaster)
    .resize(markSize, markSize, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()

  const offset = Math.floor((size - markSize) / 2)
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background,
    },
  })
    .composite([{ input: mark, left: offset, top: offset }])
    .png()
    .toFile(path.join(outputDir, filename))
}

for (const size of [16, 32, 48]) {
  await exactIcon(size, `favicon-${size}x${size}.png`)
}

for (const size of [64, 128, 256, 512, 1024]) {
  await exactIcon(size, `icon-${size}x${size}.png`)
}

for (const size of [120, 152, 167, 180]) {
  await paddedIcon(size, `apple-touch-icon-${size}x${size}.png`, 0.72)
}
await copyFile(
  path.join(outputDir, 'apple-touch-icon-180x180.png'),
  path.join(outputDir, 'apple-touch-icon.png'),
)
await paddedIcon(1024, 'apple-app-icon-1024x1024.png', 0.72)

for (const size of [192, 512]) {
  await paddedIcon(size, `android-chrome-${size}x${size}.png`, 0.72)
  await paddedIcon(size, `maskable-icon-${size}x${size}.png`, 0.60)
}

await paddedIcon(150, 'mstile-150x150.png', 0.72)

const icoScript = [
  'from PIL import Image',
  `base = ${JSON.stringify(outputDir)}`,
  "images = [Image.open(f'{base}/favicon-{s}x{s}.png').convert('RGBA') for s in (16, 32, 48)]",
  "images[-1].save(f'{base}/favicon.ico', format='ICO', append_images=images[:-1], sizes=[(16, 16), (32, 32), (48, 48)])",
].join('\n')

execFileSync('python3', ['-c', icoScript], { stdio: 'inherit' })

console.log(`Exported Mupot brand assets to ${outputDir}`)
