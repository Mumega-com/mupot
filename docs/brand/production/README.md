# Mupot production icon set

These exports are derived directly from the approved two-line `mu` planter
artwork in `../mupot-logo-planter-mu-v1.png`. They intentionally preserve its
exact pot silhouette, rim, `mu`, movement lines, color variation, and warm
background. No reconstructed vector is used.

## Files

- `mupot-mark-exact-master.png`: exact 360 px crop from the approved artwork.
- `favicon.ico`: 16, 32, and 48 px frames.
- `favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png`: browser icons.
- `icon-{64,128,256,512,1024}x*.png`: exact general-purpose exports.
- `apple-touch-icon-{120,152,167,180}x*.png`: opaque Apple touch icons.
- `apple-touch-icon.png`: canonical 180 px Apple touch icon.
- `apple-app-icon-1024x1024.png`: opaque Retina/App Store master.
- `android-chrome-{192,512}x*.png`: opaque PWA icons.
- `maskable-icon-{192,512}x*.png`: PWA safe-zone variants.
- `mstile-150x150.png`: Microsoft tile asset.
- `site.webmanifest` and `browserconfig.xml`: integration metadata.

## Regenerate

Run `npm run brand:export`. The exporter reads the approved lockup artwork,
extracts the exact main pot at its original pixels, recreates every requested
size, and rebuilds the multi-resolution ICO.

## HTML integration

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#96780A">
```
