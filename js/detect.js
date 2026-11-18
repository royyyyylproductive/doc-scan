/** Locate the largest light document region on a darker background.
 * Thresholding and connected components tolerate texture and shadows. The extreme
 * points of the region form a convex quadrilateral; ambiguous images fall back
 * to an inset that the user can adjust manually.
 */
export function detectQuad(image) {
  const { width, height, data } = image;
  const scale = Math.min(1, 500 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const gray = new Uint8Array(w * h);
  const histogram = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
      const value = Math.round(.299 * data[index] + .587 * data[index + 1] + .114 * data[index + 2]);
      gray[y * w + x] = value;
      histogram[value]++;
    }
  }
  // Otsu's threshold maximizes the separation between foreground and background.
  let totalValue = 0;
  for (let i = 0; i < 256; i++) totalValue += i * histogram[i];
  let backgroundCount = 0, backgroundValue = 0, best = 0, threshold = 127;
  for (let i = 0; i < 256; i++) {
    backgroundCount += histogram[i];
    backgroundValue += i * histogram[i];
    if (!backgroundCount || backgroundCount === w * h) continue;
    const difference = backgroundValue / backgroundCount - (totalValue - backgroundValue) / (w * h - backgroundCount);
    const score = backgroundCount * (w * h - backgroundCount) * difference * difference;
    if (score > best) { best = score; threshold = i; }
  }
  const edgeCandidate = gradientQuad(gray, w, h);
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
  let winner = [];
  for (let start = 0; start < gray.length; start++) {
    if (seen[start] || gray[start] <= threshold) continue;
    let head = 0, tail = 0;
    const points = [];
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      points.push(p);
      for (const next of [p - 1, p + 1, p - w, p + w]) {
        if (next < 0 || next >= gray.length || seen[next] || gray[next] <= threshold) continue;
        if (Math.abs(next % w - x) + Math.abs(Math.floor(next / w) - y) !== 1) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    if (points.length > winner.length) winner = points;
  }
  if (winner.length < w * h * .08 || winner.length > w * h * .98) {
    if (edgeCandidate) return edgeCandidate.map(p => ({ x: p.x / scale, y: p.y / scale }));
    return [{ x: width * .02, y: height * .02 }, { x: width * .98, y: height * .02 },
      { x: width * .98, y: height * .98 }, { x: width * .02, y: height * .98 }];
  }
  const corners = [null, null, null, null], extrema = [Infinity, -Infinity, -Infinity, Infinity];
  for (const p of winner) {
    const x = p % w, y = Math.floor(p / w), values = [x + y, x - y, x + y, x - y];
    for (let i = 0; i < 4; i++) {
      if ((i === 0 || i === 3) ? values[i] < extrema[i] : values[i] > extrema[i]) {
        extrema[i] = values[i];
        corners[i] = { x: x / scale, y: y / scale };
      }
    }
  }
  if (edgeCandidate) {
    const region = corners.map(p => ({ x: p.x * scale, y: p.y * scale }));
    // Keep strong region corners when the edge vote has latched onto a texture line.
    let chosen = edgeCandidate;
    if (Math.hypot(region[0].x-edgeCandidate[0].x, region[0].y-edgeCandidate[0].y) > 12 &&
        Math.hypot(region[3].x-edgeCandidate[3].x, region[3].y-edgeCandidate[3].y) < 12) {
      const mixed = [region[0], edgeCandidate[1], edgeCandidate[2], region[3]];
      if (edgeScore(mixed, gray, w, h) > edgeScore(chosen, gray, w, h)) chosen = mixed;
    }
    if (edgeScore(chosen, gray, w, h) > edgeScore(region, gray, w, h) * 1.25)
      return chosen.map(p => ({ x: p.x / scale, y: p.y / scale }));
  }
  return corners;
}

// Vote for long, coherent intensity transitions using their gradient direction.
function gradientQuad(gray, w, h) {
  const radius = Math.ceil(Math.hypot(w, h)), bins = 2 * radius + 1;
  const votes = new Float32Array(180 * bins);
  const cos = Array.from({length: 180}, (_, i) => Math.cos(i * Math.PI / 180));
  const sin = Array.from({length: 180}, (_, i) => Math.sin(i * Math.PI / 180));
  for (let y = 2; y < h - 2; y += 2) for (let x = 2; x < w - 2; x += 2) {
    const gx = gray[y*w+x+2] - gray[y*w+x-2], gy = gray[(y+2)*w+x] - gray[(y-2)*w+x];
    const magnitude = Math.hypot(gx, gy);
    if (magnitude < 16) continue;
    let angle = Math.round(Math.atan2(gy, gx) * 180 / Math.PI); angle = (angle + 180) % 180;
    for (let d = -2; d <= 2; d++) {
      const a = (angle+d+180)%180, rho = Math.round(x*cos[a]+y*sin[a])+radius;
      votes[a*bins+rho] += Math.min(magnitude, 80);
    }
  }
  const groups = [[], []];
  for (let a = 0; a < 180; a++) for (let r = 1; r < bins-1; r++) {
    const value = votes[a*bins+r];
    if (value < 120 || value < votes[a*bins+r-1] || value < votes[a*bins+r+1]) continue;
    const vertical = a < 45 || a >= 135;
    groups[vertical ? 0 : 1].push({a, rho:r-radius, value});
  }
  for (let i=0;i<2;i++) {
    groups[i].sort((a,b)=>b.value-a.value);
    const unique=[];
    for (const line of groups[i]) {
      const theta=line.a*Math.PI/180, x=cos[line.a], y=sin[line.a];
      if (unique.some(q => Math.abs(Math.sin(theta-q.a*Math.PI/180)) < .09 && Math.abs((line.rho-(w*x+h*y)/2) - (q.rho-(w*cos[q.a]+h*sin[q.a])/2)) < 10)) continue;
      unique.push(line); if(unique.length===14) break;
    }
    groups[i]=unique;
  }
  const intersect=(a,b)=>{ const det=cos[a.a]*sin[b.a]-sin[a.a]*cos[b.a]; if(Math.abs(det)<.3)return null; return {x:(a.rho*sin[b.a]-sin[a.a]*b.rho)/det,y:(cos[a.a]*b.rho-a.rho*cos[b.a])/det}; };
  let best=null, bestScore=0;
  const [v,horiz]=groups;
  for(let i=0;i<v.length;i++) for(let j=i+1;j<v.length;j++) for(let k=0;k<horiz.length;k++) for(let l=k+1;l<horiz.length;l++) {
    const pts=[intersect(v[i],horiz[k]),intersect(v[j],horiz[k]),intersect(v[j],horiz[l]),intersect(v[i],horiz[l])];
    if(pts.some(p=>!p || p.x < 0 || p.y < 0 || p.x >= w || p.y >= h))continue;
    const sorted=pts.slice().sort((a,b)=>a.y-b.y), top=sorted.slice(0,2).sort((a,b)=>a.x-b.x), bottom=sorted.slice(2).sort((a,b)=>a.x-b.x);
    const quad=[top[0],top[1],bottom[1],bottom[0]];
    const area=Math.abs(quad.reduce((sum,p,n)=>sum+p.x*quad[(n+1)%4].y-p.y*quad[(n+1)%4].x,0))/2;
    if(area < w*h*.08 || area > w*h*.95)continue;
    const score=edgeScore(quad,gray,w,h)*Math.sqrt(area/(w*h));
    if(score>bestScore){bestScore=score;best=quad;}
  }
  return best;
}
function edgeScore(quad,gray,w,h) {
  let score=0, weakest=Infinity;
  for(let i=0;i<4;i++) {
    const a=quad[i], b=quad[(i+1)%4], dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy), nx=-dy/len*3,ny=dx/len*3;
    let sum=0;
    for(let t=0.08;t<.93;t+=.04) {
      const x=a.x+dx*t,y=a.y+dy*t;
      const sample=(xx,yy)=>gray[Math.max(0,Math.min(h-1,Math.round(yy)))*w+Math.max(0,Math.min(w-1,Math.round(xx)))];
      sum+=Math.abs(sample(x+nx,y+ny)-sample(x-nx,y-ny));
    }
    score+=sum/22; weakest=Math.min(weakest,sum/22);
  }
  return score * Math.sqrt(weakest / Math.max(1, score / 4));
}
