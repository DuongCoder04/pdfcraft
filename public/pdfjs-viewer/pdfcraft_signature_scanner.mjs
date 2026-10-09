/* Copyright 2026 PDFCraft contributors
 *
 * Licensed under the GNU Affero General Public License v3.0 (see LICENSE).
 *
 * "Scan" tab for the PDF.js "Add a signature" dialog.
 *
 * Lets the user photograph a handwritten signature on paper, rotate the photo,
 * frame the signature and turn it into a clean signature. The cleaned crop is
 * handed back to PDF.js (`SignatureEditor#getFromImage`), so the result is the
 * same vector signature as the built-in tabs produce, and it can be saved to
 * the PDF.js signature storage for later reuse.
 *
 * The module is split into two parts:
 *  - pure image-processing helpers that work on plain pixel arrays (no DOM),
 *    so they can be unit tested;
 *  - `SignatureScanController`, which drives the tab's UI.
 */

const SCAN_PARAMETERS = Object.freeze({
  // Longest side of the decoded photo kept in memory.
  maxWorkingDim: 2048,
  // Longest side of the cropped area that is cleaned up.
  maxCropDim: 1600,
  // Longest side of the downscaled photo used to auto-detect the signature.
  detectionDim: 640,
  // Percentile of a block's luminance used as the paper brightness.
  backgroundPercentile: 0.9,
  // Darkness threshold (0-255, relative to the paper) for sensitivity 0..100.
  minThreshold: 12,
  maxThreshold: 120,
  // Ink blobs smaller than this fraction of the area are treated as noise.
  speckleAreaRatio: 0.00002,
  minSpeckleArea: 4,
  // Transparent padding kept around the trimmed signature, in pixels.
  trimPadding: 8,
  // Delay before re-processing while the user drags or slides.
  debounceMs: 120,
});

const DEFAULT_SENSITIVITY = 50;

/**
 * Convert RGBA pixels to perceived luminance (ITU BT.601).
 * Transparent pixels are treated as white paper.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray}
 */
function toGrayscale(rgba, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0, ii = gray.length; i < ii; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const lum = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    gray[i] = lum * a + 255 * (1 - a);
  }
  return gray;
}

/**
 * Estimate the brightness of the paper behind every pixel.
 *
 * Photos of paper are rarely evenly lit, so a single global threshold leaves
 * shadows behind. The image is split into blocks, the bright percentile of
 * each block is taken as the local paper brightness (ink strokes only cover a
 * small part of a block) and the block values are bilinearly interpolated.
 * @param {Uint8ClampedArray} gray
 * @param {number} width
 * @param {number} height
 * @param {number} [blockSize]
 * @returns {Uint8ClampedArray}
 */
function estimateBackground(gray, width, height, blockSize) {
  const size =
    blockSize ||
    Math.max(16, Math.round(Math.min(width, height) / 8));
  const gridW = Math.ceil(width / size);
  const gridH = Math.ceil(height / size);
  const grid = new Float32Array(gridW * gridH);
  const histogram = new Uint32Array(256);

  for (let gy = 0; gy < gridH; gy++) {
    const y0 = gy * size;
    const y1 = Math.min(height, y0 + size);
    for (let gx = 0; gx < gridW; gx++) {
      const x0 = gx * size;
      const x1 = Math.min(width, x0 + size);
      histogram.fill(0);
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          histogram[gray[row + x]]++;
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      const target = count * SCAN_PARAMETERS.backgroundPercentile;
      let sum = 0;
      let value = 255;
      for (let v = 0; v < 256; v++) {
        sum += histogram[v];
        if (sum >= target) {
          value = v;
          break;
        }
      }
      grid[gy * gridW + gx] = Math.max(1, value);
    }
  }

  // Bilinear interpolation between block centres.
  const background = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) / size - 0.5, 0), gridH - 1);
    const gy0 = Math.floor(fy);
    const gy1 = Math.min(gy0 + 1, gridH - 1);
    const ty = fy - gy0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) / size - 0.5, 0), gridW - 1);
      const gx0 = Math.floor(fx);
      const gx1 = Math.min(gx0 + 1, gridW - 1);
      const tx = fx - gx0;
      const top =
        grid[gy0 * gridW + gx0] * (1 - tx) + grid[gy0 * gridW + gx1] * tx;
      const bottom =
        grid[gy1 * gridW + gx0] * (1 - tx) + grid[gy1 * gridW + gx1] * tx;
      background[y * width + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return background;
}

/**
 * Map the sensitivity slider (0..100) to a darkness threshold (0..255).
 * Higher sensitivity picks up fainter strokes, e.g. pencil.
 * @param {number} sensitivity
 * @returns {number}
 */
function sensitivityToThreshold(sensitivity) {
  const s = Math.min(100, Math.max(0, Number(sensitivity) || 0)) / 100;
  const { minThreshold, maxThreshold } = SCAN_PARAMETERS;
  return Math.round(maxThreshold - s * (maxThreshold - minThreshold));
}

/**
 * Label 8-connected components of `mask` (non-zero = foreground).
 * @param {Uint8Array | Uint8ClampedArray} mask
 * @param {number} width
 * @param {number} height
 * @returns {{ labels: Int32Array, count: number }}
 */
function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  let count = 0;
  for (let start = 0, ii = mask.length; start < ii; start++) {
    if (!mask[start] || labels[start]) {
      continue;
    }
    count++;
    let top = 0;
    stack[top++] = start;
    labels[start] = count;
    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            continue;
          }
          const n = ny * width + nx;
          if (mask[n] && !labels[n]) {
            labels[n] = count;
            stack[top++] = n;
          }
        }
      }
    }
  }
  return { labels, count };
}

/**
 * Separate ink from paper.
 *
 * Returns an ink coverage map (0 = paper, 255 = solid ink) with soft,
 * anti-aliased edges, small specks removed, and the bounding box of the ink.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ sensitivity?: number, despeckle?: boolean }} [options]
 * @returns {{
 *   alpha: Uint8ClampedArray,
 *   bounds: { x: number, y: number, width: number, height: number } | null,
 *   inkPixels: number,
 * }}
 */
function extractInk(rgba, width, height, options = {}) {
  const { sensitivity = DEFAULT_SENSITIVITY, despeckle = true } = options;
  const gray = toGrayscale(rgba, width, height);
  const background = estimateBackground(gray, width, height);
  const threshold = sensitivityToThreshold(sensitivity);
  const softness = Math.max(8, threshold * 0.35);

  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0, ii = alpha.length; i < ii; i++) {
    const bg = background[i];
    // Darkness relative to the local paper brightness, 0..255.
    const darkness = gray[i] >= bg ? 0 : (255 * (bg - gray[i])) / bg;
    const t = (darkness - threshold + softness) / (2 * softness);
    if (t > 0) {
      const c = Math.min(1, t);
      alpha[i] = 255 * c * c * (3 - 2 * c);
    }
  }

  if (despeckle) {
    const minArea = Math.max(
      SCAN_PARAMETERS.minSpeckleArea,
      Math.round(width * height * SCAN_PARAMETERS.speckleAreaRatio)
    );
    const { labels, count } = labelComponents(alpha, width, height);
    // Count "solid" pixels per blob, so faint halos do not keep a speck alive.
    const solid = new Uint32Array(count + 1);
    for (let i = 0, ii = alpha.length; i < ii; i++) {
      if (alpha[i] >= 128) {
        solid[labels[i]]++;
      }
    }
    for (let i = 0, ii = alpha.length; i < ii; i++) {
      if (labels[i] && solid[labels[i]] < minArea) {
        alpha[i] = 0;
      }
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let inkPixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] >= 128) {
        inkPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bounds =
    maxX >= 0
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null;
  return { alpha, bounds, inkPixels };
}

/**
 * Guess where the signature is in a (downscaled) photo of the whole sheet.
 *
 * Nearby strokes are merged by dilating the ink mask, blobs touching the
 * border of the photo (paper edges, table, fingers) are ignored, and the blob
 * containing the most ink wins.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function detectSignatureRegion(rgba, width, height) {
  const { alpha, inkPixels } = extractInk(rgba, width, height);
  if (!inkPixels) {
    return null;
  }

  const radius = Math.max(2, Math.round(Math.max(width, height) * 0.03));
  const ink = new Uint8Array(width * height);
  for (let i = 0, ii = ink.length; i < ii; i++) {
    ink[i] = alpha[i] >= 128 ? 1 : 0;
  }
  // Separable box dilation using running sums.
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x < Math.min(radius, width); x++) {
      sum += ink[row + x];
    }
    for (let x = 0; x < width; x++) {
      if (x + radius < width) sum += ink[row + x + radius];
      if (x - radius - 1 >= 0) sum -= ink[row + x - radius - 1];
      horizontal[row + x] = sum > 0 ? 1 : 0;
    }
  }
  const dilated = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < Math.min(radius, height); y++) {
      sum += horizontal[y * width + x];
    }
    for (let y = 0; y < height; y++) {
      if (y + radius < height) sum += horizontal[(y + radius) * width + x];
      if (y - radius - 1 >= 0) sum -= horizontal[(y - radius - 1) * width + x];
      dilated[y * width + x] = sum > 0 ? 1 : 0;
    }
  }

  const { labels, count } = labelComponents(dilated, width, height);
  const blobs = Array.from({ length: count + 1 }, () => ({
    ink: 0,
    minX: width,
    minY: height,
    maxX: -1,
    maxY: -1,
    touchesBorder: false,
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const label = labels[i];
      if (!label) {
        continue;
      }
      const blob = blobs[label];
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        blob.touchesBorder = true;
      }
      if (ink[i]) {
        blob.ink++;
        if (x < blob.minX) blob.minX = x;
        if (x > blob.maxX) blob.maxX = x;
        if (y < blob.minY) blob.minY = y;
        if (y > blob.maxY) blob.maxY = y;
      }
    }
  }

  let best = null;
  for (let label = 1; label <= count; label++) {
    const blob = blobs[label];
    if (!blob.touchesBorder && blob.ink && (!best || blob.ink > best.ink)) {
      best = blob;
    }
  }
  if (!best) {
    return null;
  }

  const pad = Math.round(Math.max(width, height) * 0.03);
  const x = Math.max(0, best.minX - pad);
  const y = Math.max(0, best.minY - pad);
  return {
    x,
    y,
    width: Math.min(width, best.maxX + 1 + pad) - x,
    height: Math.min(height, best.maxY + 1 + pad) - y,
  };
}

/**
 * Rotate a rectangle in an image of size `width` x `height` by 90° clockwise,
 * returning it in the coordinate system of the rotated image.
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} height - Height of the image before rotation.
 */
function rotateRectClockwise(rect, height) {
  return {
    x: height - (rect.y + rect.height),
    y: rect.x,
    width: rect.height,
    height: rect.width,
  };
}

/**
 * Rotate a rectangle by 90° counter-clockwise (see `rotateRectClockwise`).
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} width - Width of the image before rotation.
 */
function rotateRectCounterClockwise(rect, width) {
  return {
    x: rect.y,
    y: width - (rect.x + rect.width),
    width: rect.height,
    height: rect.width,
  };
}

/**
 * Keep a rectangle inside the image and at least `minSize` pixels large.
 */
function clampRect(rect, width, height, minSize = 8) {
  const w = Math.min(width, Math.max(minSize, rect.width));
  const h = Math.min(height, Math.max(minSize, rect.height));
  return {
    x: Math.min(Math.max(0, rect.x), width - w),
    y: Math.min(Math.max(0, rect.y), height - h),
    width: w,
    height: h,
  };
}

/**
 * Build the image handed to PDF.js: black ink on white paper, trimmed to the
 * ink with a small padding.
 * @param {Uint8ClampedArray} alpha
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function renderInkOnPaper(alpha, width, height, bounds) {
  const pad = SCAN_PARAMETERS.trimPadding;
  const x0 = Math.max(0, bounds.x - pad);
  const y0 = Math.max(0, bounds.y - pad);
  const x1 = Math.min(width, bounds.x + bounds.width + pad);
  const y1 = Math.min(height, bounds.y + bounds.height + pad);
  const outW = x1 - x0;
  const outH = y1 - y0;
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const value = 255 - alpha[(y + y0) * width + x + x0];
      const j = (y * outW + x) * 4;
      data[j] = data[j + 1] = data[j + 2] = value;
      data[j + 3] = 255;
    }
  }
  return { data, width: outW, height: outH };
}

// ---------------------------------------------------------------------------
// UI controller
// ---------------------------------------------------------------------------

const RESIZE_HANDLES = ["nw", "ne", "sw", "se"];
const KEYBOARD_STEP_RATIO = 0.01;
const MIN_CROP_SCREEN_SIZE = 24;

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Draw `source` scaled so that its longest side is at most `maxDim`.
 */
function drawScaled(source, sx, sy, sw, sh, maxDim) {
  const ratio = Math.min(1, maxDim / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * ratio));
  const height = Math.max(1, Math.round(sh * ratio));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  return { canvas, ctx, width, height };
}

/**
 * Controls the "Scan" tab of the add-signature dialog.
 *
 * The controller owns the photo, the crop frame and the cleaned result. The
 * `SignatureManager` provides `extract(bitmap)` (PDF.js signature extraction
 * for the current editor) and is told about results through callbacks.
 */
class SignatureScanController {
  #elements;
  #photo = null; // Canvas holding the (rotated) working copy of the photo.
  #crop = null; // Crop frame in photo pixel coordinates.
  #displayScale = 1;
  #drag = null;
  #debounceTimer = null;
  #generation = 0;
  #session = null;
  #resizeObserver = null;

  /**
   * @param {Object} elements
   * @param {HTMLElement} elements.placeholder
   * @param {HTMLButtonElement} elements.browseButton
   * @param {HTMLButtonElement} elements.cameraButton
   * @param {HTMLInputElement} elements.cameraPicker
   * @param {HTMLInputElement} elements.filePicker
   * @param {HTMLElement} elements.editor
   * @param {HTMLElement} elements.stage
   * @param {HTMLCanvasElement} elements.canvas
   * @param {HTMLElement} elements.cropFrame
   * @param {SVGSVGElement} elements.preview
   * @param {HTMLButtonElement} elements.rotateLeftButton
   * @param {HTMLButtonElement} elements.rotateRightButton
   * @param {HTMLInputElement} elements.sensitivity
   * @param {HTMLButtonElement} elements.changePhotoButton
   */
  constructor(elements) {
    this.#elements = elements;
    elements.cropFrame.replaceChildren(
      ...RESIZE_HANDLES.map(handle => {
        const div = document.createElement("div");
        div.className = "pdfcraftScanHandle";
        div.dataset.handle = handle;
        return div;
      })
    );
  }

  get hasPhoto() {
    return !!this.#photo;
  }

  /**
   * Start listening to the UI. Called every time the tab is shown.
   * @param {Object} session
   * @param {AbortSignal} session.signal - Aborted when the tab is left.
   * @param {(bitmap: ImageBitmap) => Object | null} session.extract
   * @param {(data: Object | null, svgPath?: Object) => void} session.onResult
   * @param {(type: "Upload" | "NoData" | null) => void} session.onError
   * @param {(waiting: boolean) => void} session.onWaiting
   */
  activate(session) {
    this.#session = session;
    const { signal } = session;
    const el = this.#elements;
    const options = { signal };
    const passive = { passive: true, signal };

    for (const picker of [el.cameraPicker, el.filePicker]) {
      picker.addEventListener(
        "click",
        () => {
          picker.value = "";
          session.onWaiting(true);
        },
        passive
      );
      picker.addEventListener("cancel", () => session.onWaiting(false), passive);
      picker.addEventListener(
        "change",
        () => {
          const file = picker.files?.[0];
          if (file) {
            this.#loadFile(file);
          } else {
            session.onWaiting(false);
          }
        },
        passive
      );
    }

    el.browseButton.addEventListener("click", () => el.filePicker.click(), passive);
    el.cameraButton.addEventListener("click", () => el.cameraPicker.click(), passive);

    el.placeholder.addEventListener(
      "dragover",
      e => {
        const hasImage = Array.from(e.dataTransfer.items).some(item =>
          item.type.startsWith("image/")
        );
        e.dataTransfer.dropEffect = hasImage ? "copy" : "none";
        if (hasImage) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      options
    );
    el.placeholder.addEventListener(
      "drop",
      e => {
        const file = Array.from(e.dataTransfer?.files || []).find(f =>
          f.type.startsWith("image/")
        );
        e.preventDefault();
        e.stopPropagation();
        if (file) {
          session.onWaiting(true);
          this.#loadFile(file);
        }
      },
      options
    );

    // Most people photograph the paper with their phone and send the picture
    // to their computer, so pasting it from the clipboard is supported too.
    document.addEventListener(
      "paste",
      e => {
        const file = Array.from(e.clipboardData?.files || []).find(f =>
          f.type.startsWith("image/")
        );
        if (file) {
          e.preventDefault();
          session.onWaiting(true);
          this.#loadFile(file);
        }
      },
      options
    );

    el.rotateLeftButton.addEventListener("click", () => this.rotate(-1), passive);
    el.rotateRightButton.addEventListener("click", () => this.rotate(1), passive);
    el.sensitivity.addEventListener(
      "input",
      () => {
        el.sensitivity.setAttribute(
          "data-l10n-args",
          JSON.stringify({ sensitivity: Number(el.sensitivity.value) })
        );
        this.#scheduleProcessing();
      },
      passive
    );
    el.changePhotoButton.addEventListener(
      "click",
      () => el.filePicker.click(),
      passive
    );

    el.stage.addEventListener("pointerdown", this.#onPointerDown.bind(this), options);
    el.stage.addEventListener("pointermove", this.#onPointerMove.bind(this), options);
    el.stage.addEventListener("pointerup", this.#onPointerUp.bind(this), options);
    el.stage.addEventListener("pointercancel", this.#onPointerUp.bind(this), options);
    el.cropFrame.addEventListener("keydown", this.#onKeyDown.bind(this), options);

    this.#resizeObserver = new ResizeObserver(() => this.#layout());
    this.#resizeObserver.observe(el.stage);
    signal.addEventListener(
      "abort",
      () => {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        clearTimeout(this.#debounceTimer);
        this.#generation++;
        this.#session = null;
      },
      { once: true }
    );

    this.#updateVisibility();
    if (this.#photo) {
      this.#layout();
      this.#process();
    }
  }

  /** Forget the photo and the result. */
  reset() {
    clearTimeout(this.#debounceTimer);
    this.#generation++;
    this.#photo = null;
    this.#crop = null;
    this.#drag = null;
    const el = this.#elements;
    el.canvas.width = el.canvas.height = 0;
    el.preview.replaceChildren();
    el.preview.removeAttribute("viewBox");
    el.sensitivity.value = DEFAULT_SENSITIVITY;
    el.sensitivity.setAttribute(
      "data-l10n-args",
      JSON.stringify({ sensitivity: DEFAULT_SENSITIVITY })
    );
    el.cameraPicker.value = el.filePicker.value = "";
    this.#updateVisibility();
  }

  /**
   * Rotate the photo by a quarter turn.
   * @param {1 | -1} direction - 1 for clockwise, -1 for counter-clockwise.
   */
  rotate(direction) {
    const photo = this.#photo;
    if (!photo) {
      return;
    }
    const rotated = createCanvas(photo.height, photo.width);
    const ctx = rotated.getContext("2d", { willReadFrequently: true });
    ctx.translate(rotated.width / 2, rotated.height / 2);
    ctx.rotate((direction * Math.PI) / 2);
    ctx.drawImage(photo, -photo.width / 2, -photo.height / 2);
    if (this.#crop) {
      this.#crop =
        direction > 0
          ? rotateRectClockwise(this.#crop, photo.height)
          : rotateRectCounterClockwise(this.#crop, photo.width);
    }
    this.#photo = rotated;
    this.#layout();
    this.#process();
  }

  async #loadFile(file) {
    const session = this.#session;
    const generation = ++this.#generation;
    let bitmap;
    try {
      // `from-image` applies the EXIF orientation written by phone cameras.
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      console.error("SignatureScanController: cannot decode image.", e);
    }
    if (generation !== this.#generation || session !== this.#session) {
      bitmap?.close();
      return;
    }
    if (!bitmap) {
      session?.onWaiting(false);
      session?.onError("Upload");
      return;
    }

    const { canvas } = drawScaled(
      bitmap,
      0,
      0,
      bitmap.width,
      bitmap.height,
      SCAN_PARAMETERS.maxWorkingDim
    );
    bitmap.close();
    this.#photo = canvas;
    this.#crop = this.#detectCrop();
    this.#updateVisibility();
    this.#layout();
    session?.onWaiting(false);
    this.#process();
    this.#elements.cropFrame.focus({ preventScroll: true });
  }

  /** Suggest a crop frame around the signature, or a centred default. */
  #detectCrop() {
    const photo = this.#photo;
    const small = drawScaled(
      photo,
      0,
      0,
      photo.width,
      photo.height,
      SCAN_PARAMETERS.detectionDim
    );
    const { data } = small.ctx.getImageData(0, 0, small.width, small.height);
    const region = detectSignatureRegion(data, small.width, small.height);
    if (region) {
      const ratio = photo.width / small.width;
      return clampRect(
        {
          x: region.x * ratio,
          y: region.y * ratio,
          width: region.width * ratio,
          height: region.height * ratio,
        },
        photo.width,
        photo.height
      );
    }
    return {
      x: photo.width * 0.15,
      y: photo.height * 0.35,
      width: photo.width * 0.7,
      height: photo.height * 0.3,
    };
  }

  #updateVisibility() {
    const hasPhoto = !!this.#photo;
    this.#elements.placeholder.hidden = hasPhoto;
    this.#elements.editor.hidden = !hasPhoto;
  }

  /** Fit the photo into the stage and position the crop frame. */
  #layout() {
    const photo = this.#photo;
    const el = this.#elements;
    if (!photo) {
      return;
    }
    const { clientWidth, clientHeight } = el.stage;
    if (!clientWidth || !clientHeight) {
      return;
    }
    const scale = (this.#displayScale = Math.min(
      clientWidth / photo.width,
      clientHeight / photo.height
    ));
    const width = Math.round(photo.width * scale);
    const height = Math.round(photo.height * scale);
    const dpr = window.devicePixelRatio || 1;
    const canvas = el.canvas;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.left = `${Math.round((clientWidth - width) / 2)}px`;
    canvas.style.top = `${Math.round((clientHeight - height) / 2)}px`;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
    this.#updateCropFrame();
  }

  #updateCropFrame() {
    const crop = this.#crop;
    const el = this.#elements;
    if (!crop) {
      return;
    }
    const scale = this.#displayScale;
    const style = el.cropFrame.style;
    style.left = `${el.canvas.offsetLeft + crop.x * scale}px`;
    style.top = `${el.canvas.offsetTop + crop.y * scale}px`;
    style.width = `${crop.width * scale}px`;
    style.height = `${crop.height * scale}px`;
  }

  /** Convert a pointer event to photo pixel coordinates. */
  #toPhotoPoint(e) {
    const rect = this.#elements.canvas.getBoundingClientRect();
    const scale = this.#displayScale;
    return {
      x: Math.min(Math.max(0, (e.clientX - rect.left) / scale), this.#photo.width),
      y: Math.min(Math.max(0, (e.clientY - rect.top) / scale), this.#photo.height),
    };
  }

  #onPointerDown(e) {
    if (!this.#photo || !e.isPrimary || e.button > 0) {
      return;
    }
    e.preventDefault();
    const point = this.#toPhotoPoint(e);
    const handle = e.target.dataset?.handle;
    let mode;
    if (handle) {
      mode = handle;
    } else if (e.target === this.#elements.cropFrame) {
      mode = "move";
    } else {
      // Start a new frame from the pointer position.
      mode = "se";
      this.#crop = { x: point.x, y: point.y, width: 0, height: 0 };
    }
    this.#drag = { mode, start: point, crop: { ...this.#crop } };
    this.#elements.stage.setPointerCapture(e.pointerId);
    this.#elements.cropFrame.focus({ preventScroll: true });
  }

  #onPointerMove(e) {
    const drag = this.#drag;
    if (!drag) {
      return;
    }
    e.preventDefault();
    const point = this.#toPhotoPoint(e);
    const { width: maxW, height: maxH } = this.#photo;
    const { crop, start, mode } = drag;

    if (mode === "move") {
      this.#crop = clampRect(
        {
          ...crop,
          x: crop.x + point.x - start.x,
          y: crop.y + point.y - start.y,
        },
        maxW,
        maxH
      );
    } else {
      // Keep the opposite corner fixed; allow dragging across it.
      const fixedX = mode.includes("w") ? crop.x + crop.width : crop.x;
      const fixedY = mode.includes("n") ? crop.y + crop.height : crop.y;
      this.#crop = {
        x: Math.min(fixedX, point.x),
        y: Math.min(fixedY, point.y),
        width: Math.abs(point.x - fixedX),
        height: Math.abs(point.y - fixedY),
      };
    }
    this.#updateCropFrame();
    this.#scheduleProcessing();
  }

  #onPointerUp(e) {
    if (!this.#drag) {
      return;
    }
    this.#drag = null;
    this.#elements.stage.releasePointerCapture?.(e.pointerId);
    const minSize = MIN_CROP_SCREEN_SIZE / this.#displayScale;
    this.#crop = clampRect(this.#crop, this.#photo.width, this.#photo.height, minSize);
    this.#updateCropFrame();
    this.#scheduleProcessing();
  }

  /** Arrow keys move the frame; Shift + arrow keys resize it. */
  #onKeyDown(e) {
    const crop = this.#crop;
    if (!this.#photo || !crop) {
      return;
    }
    const step =
      Math.max(this.#photo.width, this.#photo.height) * KEYBOARD_STEP_RATIO;
    const dx = { ArrowLeft: -step, ArrowRight: step }[e.key] || 0;
    const dy = { ArrowUp: -step, ArrowDown: step }[e.key] || 0;
    if (!dx && !dy) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const next = e.shiftKey
      ? { ...crop, width: crop.width + dx, height: crop.height + dy }
      : { ...crop, x: crop.x + dx, y: crop.y + dy };
    const minSize = MIN_CROP_SCREEN_SIZE / this.#displayScale;
    this.#crop = clampRect(next, this.#photo.width, this.#photo.height, minSize);
    this.#updateCropFrame();
    this.#scheduleProcessing();
  }

  #scheduleProcessing() {
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(
      () => this.#process(),
      SCAN_PARAMETERS.debounceMs
    );
  }

  /** Clean the framed area and let PDF.js turn it into a signature. */
  async #process() {
    clearTimeout(this.#debounceTimer);
    const session = this.#session;
    const photo = this.#photo;
    const crop = this.#crop;
    if (!session || !photo || !crop || crop.width < 2 || crop.height < 2) {
      return;
    }
    const generation = ++this.#generation;

    const area = drawScaled(
      photo,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      SCAN_PARAMETERS.maxCropDim
    );
    const { data } = area.ctx.getImageData(0, 0, area.width, area.height);
    const { alpha, bounds } = extractInk(data, area.width, area.height, {
      sensitivity: Number(this.#elements.sensitivity.value),
    });

    let result = null;
    if (bounds) {
      const ink = renderInkOnPaper(alpha, area.width, area.height, bounds);
      const bitmap = await createImageBitmap(
        new ImageData(ink.data, ink.width, ink.height)
      );
      if (generation !== this.#generation) {
        bitmap.close();
        return;
      }
      try {
        result = session.extract(bitmap);
      } catch (e) {
        console.error("SignatureScanController: extraction failed.", e);
      } finally {
        bitmap.close();
      }
    }

    if (generation !== this.#generation) {
      return;
    }
    this.#renderPreview(result);
    session.onError(result ? null : "NoData");
    session.onResult(result);
  }

  #renderPreview(result) {
    const preview = this.#elements.preview;
    preview.replaceChildren();
    if (!result) {
      preview.removeAttribute("viewBox");
      return;
    }
    const { outline } = result;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", outline.toSVGPath());
    preview.setAttribute("viewBox", outline.viewBox);
    preview.setAttribute("preserveAspectRatio", "xMidYMid meet");
    preview.append(path);
  }
}

export {
  clampRect,
  DEFAULT_SENSITIVITY,
  detectSignatureRegion,
  estimateBackground,
  extractInk,
  labelComponents,
  renderInkOnPaper,
  rotateRectClockwise,
  rotateRectCounterClockwise,
  SCAN_PARAMETERS,
  sensitivityToThreshold,
  SignatureScanController,
  toGrayscale,
};
