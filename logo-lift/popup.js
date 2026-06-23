/*
 * Logo Lift — popup
 *
 * Injects content.js into the active tab, renders the detected logo candidates
 * and brand-guideline links, and wires up the download / conversion actions.
 */
(() => {
  'use strict';

  const PNG_EXPORT_WIDTH = 1024; // SVG -> PNG target width
  const TRACE_MAX_WIDTH = 512; // cap for raster -> SVG tracing (performance)
  const CORS_TOOLTIP = 'Cross-origin image, conversion unavailable.';

  const statusEl = document.getElementById('ll-status');
  const resultsEl = document.getElementById('ll-results');

  let rendered = false;
  let domain = 'page';

  // --- download helpers -----------------------------------------------------

  function triggerDownload(url, filename, revoke) {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Download failed:', chrome.runtime.lastError.message);
      }
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }

  function downloadBlob(blob, ext) {
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${domain}-logo.${ext}`, true);
  }

  function downloadText(text, mime, ext) {
    downloadBlob(new Blob([text], { type: mime }), ext);
  }

  function downloadDataUrl(dataUrl, ext) {
    triggerDownload(dataUrl, `${domain}-logo.${ext}`, false);
  }

  // --- image / svg rendering ------------------------------------------------

  function svgDataUrl(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // Load an image, optionally requesting CORS so the canvas stays untainted.
  function loadImage(src, crossOrigin) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load error'));
      img.src = src;
    });
  }

  // Probe whether a raster source can be read back from a canvas (CORS-safe).
  async function probeCanvasSafe(src) {
    try {
      const img = await loadImage(src, true);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.min(img.naturalWidth || 1, 8));
      canvas.height = Math.max(1, Math.min(img.naturalHeight || 1, 8));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.getImageData(0, 0, 1, 1); // throws if tainted
      return { ok: true, img };
    } catch {
      return { ok: false, img: null };
    }
  }

  // Render an SVG string to a PNG canvas at the target width.
  async function svgToPngCanvas(svg, hintW, hintH) {
    const img = await loadImage(svgDataUrl(svg), false);
    let w = hintW || img.naturalWidth || 0;
    let h = hintH || img.naturalHeight || 0;
    if (!w || !h) {
      w = w || PNG_EXPORT_WIDTH;
      h = h || PNG_EXPORT_WIDTH;
    }
    const aspect = h / w;
    const outW = PNG_EXPORT_WIDTH;
    const outH = Math.max(1, Math.round(PNG_EXPORT_WIDTH * aspect));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, outW, outH);
    return canvas;
  }

  async function svgToPngDataUrl(svg, hintW, hintH) {
    return (await svgToPngCanvas(svg, hintW, hintH)).toDataURL('image/png');
  }

  // Promise wrapper around canvas.toBlob.
  function canvasToBlob(canvas, type) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
        type || 'image/png'
      );
    });
  }

  // Copy a PNG image to the system clipboard.
  async function copyPngBlob(blob) {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('Clipboard image write unsupported');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  // Draw a (canvas-safe) image to a full-resolution PNG canvas.
  function imageToCanvas(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas;
  }

  // Flash a transient confirmation label on a button.
  function flashLabel(btn, text, ms) {
    const original = btn.dataset.label || btn.textContent;
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = original;
    }, ms || 1200);
  }

  // Trace a (canvas-safe) raster image to an SVG string with imagetracerjs.
  function traceImageToSvg(img) {
    let w = img.naturalWidth || TRACE_MAX_WIDTH;
    let h = img.naturalHeight || TRACE_MAX_WIDTH;
    if (w > TRACE_MAX_WIDTH) {
      h = Math.round((h * TRACE_MAX_WIDTH) / w);
      w = TRACE_MAX_WIDTH;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // "posterized2" preset gives clean, flat-color logo output.
    return window.ImageTracer.imagedataToSVG(imgd, 'posterized2');
  }

  // --- UI building ----------------------------------------------------------

  function makeButton(label, opts = {}) {
    const btn = document.createElement('button');
    btn.className = 'll-btn' + (opts.primary ? ' ll-primary' : '');
    btn.textContent = label;
    if (opts.disabled) btn.disabled = true;
    if (opts.title) btn.title = opts.title;
    return btn;
  }

  function withBusy(btn, label, fn) {
    return async () => {
      if (btn.disabled) return;
      const original = btn.textContent;
      btn.classList.add('ll-busy');
      btn.disabled = true;
      btn.textContent = label;
      try {
        await fn();
      } catch (e) {
        console.error('Logo Lift action failed:', e);
        btn.textContent = 'Failed — retry';
        btn.classList.remove('ll-busy');
        btn.disabled = false;
        return;
      }
      btn.classList.remove('ll-busy');
      btn.textContent = original;
      btn.disabled = false;
    };
  }

  function buildThumb(logo) {
    const thumb = document.createElement('div');
    thumb.className = 'll-thumb';
    const img = document.createElement('img');
    img.alt = logo.location;
    img.src = logo.kind === 'svg' ? svgDataUrl(logo.svg) : logo.src;
    img.onerror = () => {
      thumb.textContent = 'No preview';
      thumb.style.color = 'var(--ll-muted)';
      thumb.style.fontSize = '11px';
    };
    thumb.appendChild(img);
    return thumb;
  }

  function buildCard(logo) {
    const card = document.createElement('div');
    card.className = 'll-card';

    const top = document.createElement('div');
    top.className = 'll-card-top';

    top.appendChild(buildThumb(logo));

    const meta = document.createElement('div');
    meta.className = 'll-meta';

    const badge = document.createElement('span');
    badge.className = 'll-badge';
    badge.textContent = logo.type;
    meta.appendChild(badge);

    const loc = document.createElement('div');
    loc.className = 'll-location';
    loc.textContent = logo.location;
    meta.appendChild(loc);

    if (logo.width && logo.height) {
      const dims = document.createElement('div');
      dims.className = 'll-dims';
      dims.textContent = `${logo.width} × ${logo.height}`;
      meta.appendChild(dims);
    }

    top.appendChild(meta);
    card.appendChild(top);

    const actions = document.createElement('div');
    actions.className = 'll-actions';
    card.appendChild(actions);

    if (logo.kind === 'svg') {
      buildSvgActions(actions, logo);
    } else {
      buildRasterActions(actions, logo);
    }

    return card;
  }

  function buildSvgActions(actions, logo) {
    const dl = makeButton('Download SVG', { primary: true });
    dl.addEventListener(
      'click',
      withBusy(dl, 'Saving…', () =>
        downloadText(logo.svg, 'image/svg+xml', 'svg')
      )
    );
    actions.appendChild(dl);

    const png = makeButton('Download as PNG');
    png.addEventListener(
      'click',
      withBusy(png, 'Rendering…', async () => {
        const dataUrl = await svgToPngDataUrl(logo.svg, logo.width, logo.height);
        downloadDataUrl(dataUrl, 'png');
      })
    );
    actions.appendChild(png);

    const copy = makeButton('Copy PNG');
    copy.dataset.label = 'Copy PNG';
    copy.addEventListener(
      'click',
      withBusy(copy, 'Copying…', async () => {
        const canvas = await svgToPngCanvas(logo.svg, logo.width, logo.height);
        await copyPngBlob(await canvasToBlob(canvas));
        flashLabel(copy, 'Copied ✓');
      })
    );
    actions.appendChild(copy);
  }

  // Derive a sane file extension for a direct download of the original asset.
  function nativeExtFor(src) {
    const m = src.split('#')[0].split('?')[0].match(/\.([a-z0-9]{1,5})$/i);
    const ext = m ? m[1].toLowerCase() : '';
    return /^(png|jpg|jpeg|gif|webp|ico|svg|bmp|avif)$/.test(ext) ? ext : 'png';
  }

  function buildRasterActions(actions, logo) {
    const dl = makeButton('Download PNG', { primary: true });
    dl.addEventListener(
      'click',
      withBusy(dl, 'Saving…', async () => {
        // Re-encode to PNG when the canvas is readable; otherwise fall back to
        // a direct download of the original asset (chrome.downloads ignores
        // canvas CORS tainting).
        const probe = await probeCanvasSafe(logo.src);
        if (probe.ok) {
          const canvas = document.createElement('canvas');
          canvas.width = probe.img.naturalWidth || 1;
          canvas.height = probe.img.naturalHeight || 1;
          canvas.getContext('2d').drawImage(probe.img, 0, 0);
          downloadDataUrl(canvas.toDataURL('image/png'), 'png');
        } else {
          triggerDownload(logo.src, `${domain}-logo.${nativeExtFor(logo.src)}`, false);
        }
      })
    );
    actions.appendChild(dl);

    const copy = makeButton('Copy PNG', { disabled: true, title: 'Checking…' });
    copy.dataset.label = 'Copy PNG';
    actions.appendChild(copy);

    const trace = makeButton('Trace to SVG', { disabled: true, title: 'Checking…' });
    actions.appendChild(trace);

    // Probe CORS up front to decide whether tracing / copying is possible
    // (both need pixel access, which cross-origin images deny).
    probeCanvasSafe(logo.src).then((probe) => {
      if (!probe.ok) {
        trace.disabled = true;
        trace.title = CORS_TOOLTIP;
        copy.disabled = true;
        copy.title = CORS_TOOLTIP;
        return;
      }
      trace.disabled = false;
      trace.title = 'Convert this image to vector SVG';
      trace.addEventListener(
        'click',
        withBusy(trace, 'Tracing…', async () => {
          // Reload fresh to be safe, then trace.
          const img = probe.img || (await loadImage(logo.src, true));
          const svg = traceImageToSvg(img);
          downloadText(svg, 'image/svg+xml', 'svg');
        })
      );

      copy.disabled = false;
      copy.title = 'Copy this logo as a PNG image';
      copy.addEventListener(
        'click',
        withBusy(copy, 'Copying…', async () => {
          const img = probe.img || (await loadImage(logo.src, true));
          await copyPngBlob(await canvasToBlob(imageToCanvas(img)));
          flashLabel(copy, 'Copied ✓');
        })
      );
    });
  }

  // --- results handling -----------------------------------------------------

  function showEmpty(message) {
    statusEl.textContent = message || 'No logos detected on this page.';
    statusEl.classList.add('ll-empty');
    statusEl.hidden = false;
  }

  function render(payload) {
    if (rendered) return;
    rendered = true;

    domain = (payload && payload.domain) || 'page';
    const logos = (payload && payload.logos) || [];

    if (!logos.length) {
      showEmpty('No logos detected on this page.');
    } else {
      statusEl.hidden = true;
      logos.forEach((logo) => resultsEl.appendChild(buildCard(logo)));
    }
  }

  // --- drop / paste / browse ------------------------------------------------

  // Add a card for an image the user supplied (dropped, pasted, or browsed),
  // newest first. Reuses the same card UI as detected logos.
  function addExternalCard(logo) {
    statusEl.hidden = true;
    resultsEl.insertBefore(buildCard(logo), resultsEl.firstChild);
  }

  function rasterTypeFromMime(mime) {
    const sub = (mime || '').split('/')[1] || 'png';
    return sub.replace('jpeg', 'jpg').replace('svg+xml', 'svg').toUpperCase();
  }

  async function addImageFile(file, label) {
    if (!file || !/^image\//i.test(file.type)) return;
    if (/svg/i.test(file.type)) {
      const svg = await file.text();
      addExternalCard({ kind: 'svg', type: 'SVG', location: label, svg, width: 0, height: 0 });
    } else {
      const src = URL.createObjectURL(file);
      addExternalCard({ kind: 'raster', type: rasterTypeFromMime(file.type), location: label, src, width: 0, height: 0 });
    }
  }

  function addImageUrl(url, label) {
    const abs = (url || '').trim();
    if (!abs || !/^(https?:|data:image\/|blob:)/i.test(abs)) return;
    const isSvg = /^data:image\/svg\+xml/i.test(abs) || /\.svg(\?|#|$)/i.test(abs);
    addExternalCard({ kind: 'raster', type: isSvg ? 'SVG' : 'IMG', location: label, src: abs, width: 0, height: 0 });
  }

  const dropEl = document.getElementById('ll-drop');
  const fileEl = document.getElementById('ll-file');

  ['dragenter', 'dragover'].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropEl.classList.add('ll-dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((ev) =>
    dropEl.addEventListener(ev, () => dropEl.classList.remove('ll-dragover'))
  );
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropEl.classList.remove('ll-dragover');
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      Array.from(dt.files).forEach((f) => addImageFile(f, 'Dropped image'));
    } else {
      addImageUrl(dt.getData('text/uri-list') || dt.getData('text/plain'), 'Dropped image');
    }
  });

  // Click the zone to browse for a file.
  dropEl.addEventListener('click', () => fileEl.click());
  dropEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileEl.click();
    }
  });
  fileEl.addEventListener('change', () => {
    Array.from(fileEl.files || []).forEach((f) => addImageFile(f, 'Selected image'));
    fileEl.value = '';
  });

  // Paste an image (or image URL) anywhere in the popup.
  window.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    for (const item of data.items || []) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          addImageFile(file, 'Pasted image');
          return;
        }
      }
    }
    const text = data.getData('text');
    if (text) addImageUrl(text, 'Pasted image');
  });

  // Prevent the popup from navigating if an image is dropped outside the zone.
  ['dragover', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (!dropEl.contains(e.target)) e.preventDefault();
    })
  );

  // Backup channel: content.js also sends results via runtime messaging.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'LOGO_LIFT_RESULTS') render(msg);
  });

  // --- bootstrap ------------------------------------------------------------

  async function init() {
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      showEmpty('Unable to access the current tab.');
      return;
    }

    const url = tab && tab.url ? tab.url : '';
    if (
      !tab ||
      !/^https?:|^file:/.test(url) ||
      /^https?:\/\/chrome\.google\.com\/webstore/.test(url) ||
      /^https?:\/\/chromewebstore\.google\.com/.test(url)
    ) {
      showEmpty('Logo Lift can’t scan this page. Open a normal website and try again.');
      return;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      const payload = results && results[0] && results[0].result;
      if (payload) render(payload);
      // If executeScript returned nothing, the messaging listener will catch it.
      else
        setTimeout(() => {
          if (!rendered) showEmpty('No logos detected on this page.');
        }, 1200);
    } catch (e) {
      console.error('Logo Lift injection failed:', e);
      showEmpty('Logo Lift couldn’t run on this page.');
    }
  }

  init();
})();
