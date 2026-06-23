/*
 * Logo Lift — content script
 *
 * Injected on demand by the popup via chrome.scripting.executeScript. It scans
 * the current page for logo/brand candidates and brand-guideline links, then
 * sends a serializable result payload back to the popup with
 * chrome.runtime.sendMessage.
 *
 * Everything is wrapped in an IIFE so re-injection (each time the popup opens)
 * never collides with top-level declarations from a previous run.
 */
(() => {
  'use strict';

  const TOP_ZONE_PX = 500; // "first 500px of the page" threshold

  // --- helpers --------------------------------------------------------------

  const lc = (v) => (v || '').toString().toLowerCase();

  function absUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  // Cheap, stable string hash (FNV-1a-ish) for SVG-content dedup.
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function domainFromHost() {
    let host = location.hostname || 'page';
    host = host.replace(/^www\./, '');
    const parts = host.split('.');
    // Use the second-level label as the friendly brand name (e.g. beehiiv).
    if (parts.length >= 2) return parts[parts.length - 2];
    return parts[0] || 'page';
  }

  function isInTopZone(el) {
    if (el.closest('header, nav')) return true;
    try {
      const rect = el.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      return top < TOP_ZONE_PX;
    } catch {
      return false;
    }
  }

  function zoneLabel(el) {
    if (el.closest('header')) return 'Header';
    if (el.closest('nav')) return 'Nav';
    return 'Top of page';
  }

  function extFromUrl(url) {
    const clean = absUrl(url).split('#')[0].split('?')[0];
    const m = clean.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  // Map an extension / mime hint to a friendly type label.
  function typeLabelFromExt(ext) {
    switch (ext) {
      case 'svg':
        return 'SVG';
      case 'png':
        return 'PNG';
      case 'jpg':
      case 'jpeg':
        return 'JPG';
      case 'gif':
        return 'GIF';
      case 'webp':
        return 'WEBP';
      case 'ico':
        return 'ICO';
      default:
        return ext ? ext.toUpperCase() : 'IMG';
    }
  }

  // --- dedup tracking -------------------------------------------------------

  const seen = new Set();
  const candidates = [];
  let nextId = 1;

  function serializeSvg(svgEl) {
    const clone = svgEl.cloneNode(true);
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if (!clone.getAttribute('xmlns:xlink') && /xlink:/.test(svgEl.outerHTML)) {
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }
    return new XMLSerializer().serializeToString(clone);
  }

  function svgDimensions(svgEl, markup) {
    let w = 0;
    let h = 0;
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) {
        w = p[2];
        h = p[3];
      }
    }
    if (!w || !h) {
      try {
        const r = svgEl.getBoundingClientRect();
        if (r.width && r.height) {
          w = r.width;
          h = r.height;
        }
      } catch {
        /* ignore */
      }
    }
    return { width: Math.round(w) || 0, height: Math.round(h) || 0 };
  }

  function addSvg(svgEl, location) {
    // Skip trivial / icon-sprite-only svgs with no real content.
    const markup = serializeSvg(svgEl);
    if (!markup || markup.length < 32) return;
    const key = 'svg:' + hashString(markup.replace(/\s+/g, ''));
    if (seen.has(key)) return;
    seen.add(key);
    const dims = svgDimensions(svgEl, markup);
    candidates.push({
      id: nextId++,
      kind: 'svg',
      type: 'SVG',
      location,
      svg: markup,
      width: dims.width,
      height: dims.height,
    });
  }

  function addRaster(url, location, typeOverride) {
    const abs = absUrl(url);
    if (!abs || abs.startsWith('javascript:')) return;
    const key = 'src:' + abs;
    if (seen.has(key)) return;
    seen.add(key);
    const ext = extFromUrl(abs);
    const kind = location === 'Favicon' || location === 'Apple Touch Icon' ? 'favicon' : 'raster';
    candidates.push({
      id: nextId++,
      kind,
      type: typeOverride || typeLabelFromExt(ext),
      location,
      src: abs,
      width: 0,
      height: 0,
    });
  }

  function addImg(imgEl, location) {
    const src = imgEl.currentSrc || imgEl.getAttribute('src') || imgEl.src;
    if (!src) return;
    const abs = absUrl(src);
    const key = 'src:' + abs;
    if (seen.has(key)) return;
    // Inline data: SVG images are treated as svg when possible.
    if (/^data:image\/svg\+xml/i.test(abs)) {
      addRaster(abs, location, 'SVG');
      return;
    }
    seen.add(key);
    const ext = extFromUrl(abs);
    candidates.push({
      id: nextId++,
      kind: 'raster',
      type: typeLabelFromExt(ext) === 'IMG' ? 'PNG' : typeLabelFromExt(ext),
      location,
      src: abs,
      width: imgEl.naturalWidth || 0,
      height: imgEl.naturalHeight || 0,
    });
  }

  // --- SVG size filtering ----------------------------------------------------

  const ICON_MAX = 32; // viewBox or rendered size at or below this = UI icon

  function isSvgIconSized(svgEl) {
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) {
        if (p[2] <= ICON_MAX && p[3] <= ICON_MAX) return true;
      }
    }
    try {
      const r = svgEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= ICON_MAX && r.height <= ICON_MAX) return true;
    } catch { /* ignore */ }
    return false;
  }

  function svgHasTextOrComplexContent(svgEl) {
    if (svgEl.querySelector('text, tspan')) return true;
    const paths = svgEl.querySelectorAll('path');
    if (paths.length >= 4) return true;
    return false;
  }

  function shouldSkipIconSvg(svgEl) {
    if (!isSvgIconSized(svgEl)) return false;
    if (svgHasTextOrComplexContent(svgEl)) return false;
    return true;
  }

  // --- homepage-link detection -----------------------------------------------

  function isHomepageLink(a) {
    const href = a.getAttribute('href') || '';
    if (href === '/' || href === '#' || href === '') return true;
    try {
      const url = new URL(href, location.href);
      if (url.origin === location.origin && (url.pathname === '/' || url.pathname === '')) return true;
    } catch { /* ignore */ }
    return false;
  }

  // --- extended keyword matching for images ----------------------------------

  const LOGO_KEYWORDS = ['logo', 'brand', 'wordmark', 'logotype', 'site-mark', 'site-logo', 'navbar-brand'];

  function hasLogoKeyword(str) {
    const s = lc(str);
    return LOGO_KEYWORDS.some((kw) => s.includes(kw));
  }

  // --- signal scanning (priority order) ------------------------------------

  // 0) Homepage-link logos (highest priority — the site logo is almost always
  //    an <a href="/"> in the header/nav wrapping an <img> or <svg>).
  document.querySelectorAll('header a, nav a, [role="banner"] a').forEach((a) => {
    if (!isHomepageLink(a)) return;
    const svg = a.querySelector('svg');
    if (svg) addSvg(svg, 'Site Logo');
    a.querySelectorAll('img').forEach((img) => addImg(img, 'Site Logo'));
  });

  // 1) <svg> in header/nav/top-of-page — but skip icon-sized SVGs.
  document.querySelectorAll('svg').forEach((svg) => {
    if (svg.closest('header a, nav a, [role="banner"] a')) return; // handled by signal 0
    if (shouldSkipIconSvg(svg)) return;
    if (isInTopZone(svg)) addSvg(svg, zoneLabel(svg) + ' SVG');
  });

  // 2) <img> whose src/alt/class/id mentions logo keywords.
  document.querySelectorAll('img').forEach((img) => {
    const hay = [
      img.getAttribute('src'),
      img.getAttribute('alt'),
      img.className,
      img.id,
    ].join(' ');
    if (hasLogoKeyword(hay)) addImg(img, 'Logo Image');
  });

  // 3) <a> wrapping an svg/img in the header/nav area (non-homepage links).
  document.querySelectorAll('header a, nav a, [role="banner"] a').forEach((a) => {
    if (isHomepageLink(a)) return; // already handled by signal 0
    const svg = a.querySelector('svg');
    if (svg && !shouldSkipIconSvg(svg)) addSvg(svg, zoneLabel(a) + ' Link SVG');
    const img = a.querySelector('img');
    if (img) addImg(img, zoneLabel(a) + ' Link Image');
  });

  // 4) Favicons.
  document.querySelectorAll('link[rel]').forEach((link) => {
    const rel = lc(link.getAttribute('rel'));
    const href = link.getAttribute('href');
    if (!href) return;
    if (rel.includes('apple-touch-icon')) {
      addRaster(href, 'Apple Touch Icon');
    } else if (rel.split(/\s+/).includes('icon') || rel.includes('shortcut icon')) {
      addRaster(href, 'Favicon');
    }
  });
  // Fall back to the default /favicon.ico if no <link> icon was declared.
  if (!candidates.some((c) => c.kind === 'favicon')) {
    addRaster('/favicon.ico', 'Favicon', 'ICO');
  }

  // 5) <meta property="og:image">.
  document
    .querySelectorAll('meta[property="og:image"], meta[name="og:image"], meta[property="og:image:url"]')
    .forEach((meta) => {
      const content = meta.getAttribute('content');
      if (content) addRaster(content, 'Meta OG Image');
    });

  // 6) Inline SVG with aria-label mentioning "logo" or "brand" (anywhere).
  document.querySelectorAll('svg[aria-label]').forEach((svg) => {
    const label = lc(svg.getAttribute('aria-label'));
    if (label.includes('logo') || label.includes('brand')) {
      addSvg(svg, 'ARIA Logo SVG');
    }
  });

  // 7) CSS background-image logos in header/nav elements.
  document.querySelectorAll('header, header *, nav, nav *, [role="banner"], [role="banner"] *').forEach((el) => {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !m[1]) return;
      const url = m[1];
      if (/logo|brand|wordmark/i.test(url) || /logo|brand|wordmark/i.test(el.className + ' ' + el.id)) {
        addRaster(url, 'CSS Background Logo');
      }
    } catch { /* ignore */ }
  });

  // --- brand guideline links ------------------------------------------------

  const BRAND_TERMS = ['brand', 'guidelines', 'press kit', 'media kit', 'assets'];
  const brandLinks = [];
  const seenBrand = new Set();
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const text = a.textContent || '';
    const hay = lc(href + ' ' + text);
    if (!BRAND_TERMS.some((t) => hay.includes(t))) return;
    const abs = absUrl(href);
    if (!abs || abs.startsWith('javascript:') || seenBrand.has(abs)) return;
    seenBrand.add(abs);
    const label = (text.trim() || abs).replace(/\s+/g, ' ').slice(0, 80);
    brandLinks.push({ label, href: abs });
  });

  // --- send results back to the popup --------------------------------------

  const payload = {
    type: 'LOGO_LIFT_RESULTS',
    domain: domainFromHost(),
    pageUrl: location.href,
    logos: candidates,
    brandLinks: brandLinks.slice(0, 25),
  };

  try {
    chrome.runtime.sendMessage(payload);
  } catch (e) {
    // Popup may have closed; ignore.
  }

  // Also return the payload so executeScript callers can read it directly.
  return payload;
})();
