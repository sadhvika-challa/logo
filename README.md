# Logo Lift

**Logo Lift** is a Chrome extension (Manifest V3) that detects and downloads logo and brand assets from any webpage. Click the toolbar icon and Logo Lift scans the current page for SVG logos, logo images, favicons, Open Graph images, and brand-guideline links, then shows previews with one-click downloads. You can grab the original SVG, render an SVG to a crisp 1024px PNG, download raster logos as PNG, or even trace a PNG/JPG into clean vector SVG — all locally in your browser, with no servers involved.

The extension lives in the [`logo-lift/`](./logo-lift) folder of this repository.

## Features

- Detects logos from multiple signals, in priority order:
  - Inline `<svg>` in the header / nav / top of the page
  - `<img>` elements whose `src`, `alt`, `class`, or `id` mention "logo"
  - Logos wrapped in header/nav `<a>` links
  - Favicons (`rel="icon"`, `rel="apple-touch-icon"`)
  - `og:image` from page metadata
  - Inline SVGs with an `aria-label` containing "logo" or "brand"
- Finds **brand-guideline links** (brand, guidelines, press kit, media kit, assets)
- Deduplicates results by URL and SVG-content hash
- Download options per asset:
  - **SVG** → Download SVG · Download as PNG (rendered at 1024px wide)
  - **Raster (PNG/JPG)** → Download PNG · Trace to SVG (vectorizes with [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs), `posterized2` preset)
- Gracefully handles cross-origin images: conversion is disabled with a tooltip when the browser blocks canvas access
- Files download as `{domain}-logo.{ext}` (e.g. `beehiiv-logo.svg`)

## Install (load unpacked in Chrome)

No build step is required — the extension ships ready to load.

1. Download or clone this repository to your computer.
2. Open **Google Chrome** and go to `chrome://extensions` (type it in the address bar and press Enter).
3. In the top-right corner, turn on **Developer mode**.
4. Click **Load unpacked**.
5. In the file picker, select the **`logo-lift`** folder (the one that contains `manifest.json`).
6. Logo Lift now appears in your extensions list. Click the puzzle-piece icon in the toolbar and pin it for easy access.

> The icons are pre-generated and included. If you ever want to regenerate them, run `node build-icons.js` inside the `logo-lift` folder.

## How to use

1. Open any website (for example a company homepage).
2. Click the **Logo Lift** icon in your Chrome toolbar.
3. The popup lists every logo it found, with a preview, a type badge, and where it was found.
4. Click a download button:
   - **Download SVG / Download PNG** saves the asset.
   - **Download as PNG** (for SVGs) renders a 1024px-wide PNG.
   - **Trace to SVG** (for raster images) converts the image into vector paths.
5. If the site links to brand guidelines or a press kit, you'll see a **Brand Guidelines** section at the bottom — click to open in a new tab.

If nothing logo-like is found, you'll see a friendly "No logos detected on this page."

## Permissions

Logo Lift requests only what it needs:

- `activeTab` — read the page you're currently on, only when you click the icon
- `scripting` — inject the detection script on demand (not on every page load)
- `downloads` — save the assets you choose to your computer

## Project structure

```
logo-lift/
  manifest.json      Manifest V3 config
  popup.html         Popup markup
  popup.js           Popup logic: render, download, SVG<->PNG, raster->SVG
  content.js         Injected page scanner (logo detection + dedup)
  styles.css         Popup styling
  build-icons.js     Generates the PNG toolbar icons (no dependencies)
  lib/
    imagetracer.js   Bundled raster-to-SVG tracer (Unlicense / public domain)
  icons/
    icon16.png  icon48.png  icon128.png
```

## Built by Sadhvika Challa

Logo Lift was built by **Sadhvika Challa**.

The bundled [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) library by András Jankovics is released into the public domain under the Unlicense.

## License

Released under the [MIT License](./LICENSE).
