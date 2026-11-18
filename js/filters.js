/** Apply a non-destructive document filter to RGBA pixels. */
export function applyFilter(image, mode = 'original') {
  const { width, height } = image;
  const pixels = new Uint8ClampedArray(image.data);
  if (mode === 'original') return { width, height, data: pixels };

  const count = width * height;
  const gray = new Uint8Array(count);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < count; i++) {
    gray[i] = Math.round(.299 * pixels[i * 4] + .587 * pixels[i * 4 + 1] + .114 * pixels[i * 4 + 2]);
    histogram[gray[i]]++;
  }
  let low = 0, high = 255, sum = 0;
  while (low < 255 && (sum += histogram[low]) < count * .01) low++;
  sum = 0;
  while (high > 0 && (sum += histogram[high]) < count * .01) high--;
  const integral = mode === 'bw' ? new Float64Array((width + 1) * (height + 1)) : null;
  if (integral) {
    for (let y = 1; y <= height; y++) {
      let row = 0;
      for (let x = 1; x <= width; x++) {
        row += gray[(y - 1) * width + x - 1];
        integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + row;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let value = gray[i];
      if (mode === 'bw') {
        const r = Math.max(15, Math.round(Math.min(width, height) / 40));
        const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1);
        const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
        const stride = width + 1;
        const total = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
        value = value < total / ((x1 - x0) * (y1 - y0)) * .85 ? 0 : 255;
      } else if (mode === 'enhance') {
        // A small unsharp mask helps fine print without amplifying noise excessively.
        const left = gray[y * width + Math.max(0, x - 1)];
        const right = gray[y * width + Math.min(width - 1, x + 1)];
        const above = gray[Math.max(0, y - 1) * width + x];
        const below = gray[Math.min(height - 1, y + 1) * width + x];
        value = (value + .25 * (value - (left + right + above + below) / 4) - low) * 255 / Math.max(1, high - low);
      }
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = value;
    }
  }
  return { width, height, data: pixels };
}
