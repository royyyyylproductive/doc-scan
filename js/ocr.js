/** OCR uses continuous grayscale from the warped page, independent of display filters. */
export function prepareOcr(image, correctAspect = false) {
  const { width, height } = image;
  const gray = new Uint8Array(width * height), histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(.299 * image.data[4 * i] + .587 * image.data[4 * i + 1] + .114 * image.data[4 * i + 2]);
    histogram[gray[i]]++;
  }
  const percentile = fraction => {
    let sum = 0;
    for (let value = 0; value < 256; value++) if ((sum += histogram[value]) >= gray.length * fraction) return value;
    return 255;
  };
  const low = percentile(.005), high = percentile(.99), range = Math.max(1, high - low);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round((gray[i] - low) * 255 / range)));

  // Estimate text height from horizontal ink bands, excluding the paper border.
  // Thresholding is only used for measurement; OCR retains antialiased strokes.
  const bands = [];
  let start = -1;
  const margin = Math.ceil(width * .02);
  for (let y = Math.ceil(height * .02); y < height * .98; y++) {
    let ink = 0;
    for (let x = margin; x < width - margin; x++) if (gray[y * width + x] < 100) ink++;
    const active = ink >= Math.max(3, width * .008);
    if (active && start < 0) start = y;
    if (!active && start >= 0) {
      const size = y - start;
      if (size >= 4 && size <= height * .05) bands.push({ y0: start, y1: y, size });
      start = -1;
    }
  }
  bands.sort((a, b) => a.size - b.size);
  const xHeight = bands.length ? bands[Math.floor(bands.length / 2)].size : 25;
  // A narrow crop can contain horizontally compressed full-width glyphs. Use
  // the widest recurring strokes in several text bands to propose a correction.
  // It is tried only for low-confidence receipts and kept only if OCR improves.
  const ratios = [];
  if (height / width > 2) for (const band of bands) {
    const widths = [];
    let run = 0;
    for (let x = margin; x <= width - margin; x++) {
      let ink = 0;
      for (let y = band.y0; y < band.y1; y++) if (gray[y * width + x] < 100) ink++;
      if (x < width - margin && ink >= Math.max(2, band.size * .08)) run++;
      else { if (run > 1) widths.push(run); run = 0; }
    }
    if (widths.length >= 6) {
      widths.sort((a, b) => a - b);
      ratios.push(band.size / widths[Math.floor((widths.length - 1) * .9)]);
    }
  }
  const suggestedStretch = ratios.length >= 3 ? Math.min(2.5, ...ratios) : 1;
  const stretch = correctAspect && suggestedStretch > 1.6 ? suggestedStretch : 1;
  const scale = Math.max(1, 2000 / Math.max(width * stretch, height), 25 / xHeight,
    height / width > 2 ? 1200 / (width * stretch) : 1);
  const outputWidth = Math.ceil(width * stretch * scale), outputHeight = Math.ceil(height * scale);
  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y++) {
    const sy = Math.max(0, Math.min(height - 1, (y + .5) * height / outputHeight - .5));
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < outputWidth; x++) {
      const sx = Math.max(0, Math.min(width - 1, (x + .5) * width / outputWidth - .5));
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      const value = (1 - fy) * ((1 - fx) * gray[y0 * width + x0] + fx * gray[y0 * width + x1]) +
        fy * ((1 - fx) * gray[y1 * width + x0] + fx * gray[y1 * width + x1]);
      const i = (y * outputWidth + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
    }
  }
  return { width: outputWidth, height: outputHeight, data, xHeight: xHeight * outputHeight / height, suggestedStretch };
}

/** Convert recognition coordinates to the image used for annotations and PDF export. */
export function pageBox(bbox, ocrImage, pageImage) {
  return { x0: bbox.x0 * pageImage.width / ocrImage.width, y0: bbox.y0 * pageImage.height / ocrImage.height,
    x1: bbox.x1 * pageImage.width / ocrImage.width, y1: bbox.y1 * pageImage.height / ocrImage.height };
}

export async function recognizeOcr(worker, source) {
  const parameters = { user_defined_dpi: '300', tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' };
  await worker.setParameters(parameters);
  let result = await worker.recognize(source, {}, { blocks: true, text: true });
  if ((result.data.confidence || 0) < 60) {
    await worker.setParameters({ ...parameters, tessedit_pageseg_mode: '6' });
    const fallback = await worker.recognize(source, {}, { blocks: true, text: true });
    if ((fallback.data.confidence || 0) > (result.data.confidence || 0)) result = fallback;
  }
  return result;
}

export async function recognizePage(worker, image, toSource) {
  let ocrImage = prepareOcr(image);
  let result = await recognizeOcr(worker, toSource(ocrImage));
  if (result.data.confidence < 80 && ocrImage.suggestedStretch > 1.6) {
    const candidateImage = prepareOcr(image, true);
    const candidate = await recognizeOcr(worker, toSource(candidateImage));
    if (candidate.data.confidence > result.data.confidence) { result = candidate; ocrImage = candidateImage; }
  }
  return { result, ocrImage };
}
