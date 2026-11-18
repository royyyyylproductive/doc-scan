/** Rectify a quadrilateral with a projective transform and bilinear sampling. */
export function warp(image, quad, maxSide = 2400) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let width = Math.max(1, Math.round(Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]))));
  let height = Math.max(1, Math.round(Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]))));
  const scale = Math.min(1, maxSide / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  const [a, b, c, d] = quad;
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  let g = 0, h = 0;
  if (Math.abs(denominator) > 1e-9) {
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
  }
  const ax = b.x - a.x + g * b.x, bx = d.x - a.x + h * d.x;
  const ay = b.y - a.y + g * b.y, by = d.y - a.y + h * d.y;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inset = Math.min(width, height) > 10 ? .006 : 0;
      const u = inset + (1 - 2 * inset) * x / Math.max(1, width - 1), v = inset + (1 - 2 * inset) * y / Math.max(1, height - 1);
      const divisor = 1 + g * u + h * v;
      const sx = Math.max(0, Math.min(image.width - 1, (ax * u + bx * v + a.x) / divisor));
      const sy = Math.max(0, Math.min(image.height - 1, (ay * u + by * v + a.y) / divisor));
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const x1 = Math.min(image.width - 1, ix + 1), y1 = Math.min(image.height - 1, iy + 1);
      for (let channel = 0; channel < 4; channel++) {
        const sample = (px, py) => image.data[(py * image.width + px) * 4 + channel];
        output[(y * width + x) * 4 + channel] =
          (1 - fy) * ((1 - fx) * sample(ix, iy) + fx * sample(x1, iy)) +
          fy * ((1 - fx) * sample(ix, y1) + fx * sample(x1, y1));
      }
    }
  }
  return { width, height, data: output };
}
