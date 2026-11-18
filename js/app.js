import { detectQuad } from './detect.js';
import { warp } from './warp.js';
import { applyFilter } from './filters.js';
import { cleanText } from './text.js';
import { pageBox, recognizePage } from './ocr.js';
import * as db from './db.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const state = { document: null, page: null, quad: [], view: 'home', worker: null };
let stream, dragging = -1, drawing = null, signature = null, selected = null, toastTimer, loupe = null;
const scratch = document.createElement('canvas');
const context = scratch.getContext('2d', { willReadFrequently: true });

function status(message, progress = false) {
  clearTimeout(toastTimer);
  $('#status').textContent = message;
  if (message && !progress) toastTimer = setTimeout(() => { $('#status').textContent = ''; }, 2500);
}
function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function pixels(source, maxSide = 3000) {
  const image = await loadImage(source);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  scratch.width = Math.max(1, Math.round(image.width * scale));
  scratch.height = Math.max(1, Math.round(image.height * scale));
  context.drawImage(image, 0, 0, scratch.width, scratch.height);
  return context.getImageData(0, 0, scratch.width, scratch.height);
}
function encode(image, type = 'image/jpeg') {
  scratch.width = image.width;
  scratch.height = image.height;
  context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return scratch.toDataURL(type, .9);
}
async function save() {
  if (!state.document) return;
  state.document.updated = Date.now();
  // Keep binary copies in IndexedDB as well as display-ready URLs.
  for (const page of state.document.pages) {
    if (page._originalStored !== page.original) { page.originalBlob = await (await fetch(page.original)).blob(); page._originalStored = page.original; }
    if (page._processedStored !== page.processed) { page.processedBlob = await (await fetch(page.processed)).blob(); page._processedStored = page.processed; }
  }
  await db.save(state.document);
}
async function show(view) {
  state.view = view;
  document.body.dataset.view = view;
  for (const id of ['home', 'document', 'editor']) $('#' + id).hidden = id !== view;
  $('#back').hidden = view === 'home';
  window.scrollTo(0, 0);
  if (view === 'home') await renderHistory();
  if (view === 'document') renderPages();
}
async function renderHistory() {
  const documents = (await db.all()).sort ( (a, b) => b.updated - a.updated);
  $('#history').replaceChildren();
  if (!documents.length) $('#history').innerHTML = '<p class="empty">📄<br>未有文件<br>開始新掃描，將文件保存在這裏。</p>';
  for (const document of documents) {
    const card = window.document.createElement('div');
    card.className = 'card';
    const image = window.document.createElement('img');
    image.src = document.pages[0]?.processed || './icons/icon-192.png';
    const info = window.document.createElement('div');
    info.className = 'info';
    info.textContent = `${document.title} · ${document.pages.length} 頁 · ${new Date(document.updated).toLocaleDateString('zh-HK')}`;
    const open = button('開啟', () => { state.document = document; $('#title').value = document.title; show('document'); });
    const rename = button('改名', async () => {
      const title = prompt('文件名稱', document.title);
      if (title !== null && title.trim()) { document.title = title.trim(); await db.save(document); renderHistory(); }
    });
    const remove = button('刪除', async () => {
      if (confirm('確定刪除此文件？')) { await db.remove(document.id); renderHistory(); }
    });
    card.append(image, info, open, rename, remove);
    $('#history').append(card);
  }
}
function button(label, handler) {
  const element = document.createElement('button');
  element.textContent = label;
  element.onclick = handler;
  return element;
}
let saveTimer;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), 350); }
async function newDocument() {
  state.document = { id: crypto.randomUUID(), title: '未命名文件', pages: [], updated: Date.now() };
  $('#title').value = state.document.title;
  await save();
  show('document');
}
$('#new').onclick = newDocument;
$('#back').onclick = async () => {
  const back = $('#back'), destination = state.view === 'editor' ? 'document' : 'home';
  if (back.disabled) return;
  back.disabled = true;
  clearTimeout(saveTimer);
  try { await save(); await show(destination); }
  catch (error) { status('儲存失敗：' + error.message); }
  finally { back.disabled = false; }
};
$('#title').oninput = () => { state.document.title = $('#title').value; scheduleSave(); };
$('#settings').onclick = async () => {
  $('#settingsDialog').showModal();
  const estimate = await navigator.storage?.estimate?.();
  $('#storageInfo').textContent = estimate ? `已使用 ${((estimate.usage || 0) / 1048576).toFixed(1)} MB` : '未能取得儲存空間資料';
  navigator.serviceWorker?.controller?.postMessage('checkOffline');
};
$('#closeSettings').onclick = () => $('#settingsDialog').close();
$('#deleteAll').onclick = async () => {
  if (confirm('要刪除所有儲存的文件嗎？此動作無法復原。')) { await db.clear(); state.document = null; $('#settingsDialog').close(); show('home'); }
};

async function addImage(source) {
  const original = encode(await pixels(source));
  state.document.pages.push({ id: crypto.randomUUID(), original, processed: original, base: original,
    quad: null, filter: 'original', rotation: 0, text: '', html: '', lines: [], words: [], annotations: [] });
  await save();
  renderPages();
}
async function importFiles(files) {
  if (!state.document) await newDocument();
  for (const file of files) {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        await addImage(canvas.toDataURL('image/jpeg', .9));
      }
    } else if (file.type.startsWith('image/')) await addImage(await readFile(file));
  }
}
for (const id of ['importInput', 'capture']) {
  $('#' + id).onchange = async event => {
    try { await importFiles(event.target.files); } catch (error) { status('匯入失敗：' + error.message); }
    event.target.value = '';
  };
}
function renderPages() {
  $('#pages').replaceChildren();
  state.document.pages.forEach((page, index) => {
    const card = document.createElement('div'); card.className = 'card';
    const image = document.createElement('img'); image.src = page.processed;
    const info = document.createElement('div'); info.className = 'info'; info.textContent = `第 ${index + 1} 頁`;
    const move = async delta => {
      const target = index + delta;
      if (target < 0 || target >= state.document.pages.length) return;
      [state.document.pages[index], state.document.pages[target]] = [state.document.pages[target], state.document.pages[index]];
      await save(); renderPages();
    };
    image.onclick = () => editPage(index);
    card.append(image, info, button('編輯', () => editPage(index)), button('↑', () => move(-1)),
      button('↓', () => move(1)), button('刪除', async () => {
        if (confirm('刪除此頁？')) { state.document.pages.splice(index, 1); await save(); renderPages(); }
      }));
    $('#pages').append(card);
  });
}
async function editPage(index) {
  state.page = state.document.pages[index]; selected = null;
  state.quad = state.page.quad?.map(point => ({ ...point })) || detectQuad(await pixels(state.page.original));
  $('#textEditor').innerHTML = state.page.html || '';
  show('editor');
  await tab('crop');
}
async function tab(id) {
  for (const panel of $$('.panel')) panel.hidden = panel.id !== id;
  if (id === 'crop') await drawCrop();
  if (id === 'filter') { $('#preview').src = state.page.processed; renderFilterPreviews(); }
  if (id === 'annotate') await drawAnnotations();
}
$$('[data-tab]').forEach(element => { element.onclick = () => tab(element.dataset.tab); });
async function drawCrop() {
  const image = await loadImage(state.page.original), canvas = $('#cropCanvas');
  state.page._w = image.width; state.page._h = image.height;
  const scale = Math.min(1, 800 / image.width);
  canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#00d8c3'; ctx.lineWidth = 3; ctx.beginPath();
  state.quad.forEach((p, i) => i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale));
  ctx.closePath(); ctx.stroke();
  if (loupe) {
    const x = Math.max(50, Math.min(canvas.width - 50, loupe.x * scale)), y = Math.max(50, loupe.y * scale - 75);
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, 45, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(image, Math.max(0, loupe.x - 35), Math.max(0, loupe.y - 35), 70, 70, x - 45, y - 45, 90, 90); ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, 45, 0, Math.PI * 2); ctx.strokeStyle = '#255a64'; ctx.stroke();
  }
  for (const point of state.quad) {
    ctx.beginPath(); ctx.arc(point.x * scale, point.y * scale, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
  }
}
const cropCanvas = $('#cropCanvas');
function cropPoint(event) {
  const rect = cropCanvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(state.page._w - 1, (event.clientX - rect.left) / rect.width * state.page._w)),
    y: Math.max(0, Math.min(state.page._h - 1, (event.clientY - rect.top) / rect.height * state.page._h)) };
}
cropCanvas.onpointerdown = event => {
  const p = cropPoint(event), threshold = state.page._w * 35 / cropCanvas.getBoundingClientRect().width;
  dragging = state.quad.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < threshold);
  if (dragging >= 0) cropCanvas.setPointerCapture(event.pointerId);
};
cropCanvas.onpointermove = event => { if (dragging >= 0) { state.quad[dragging] = cropPoint(event); loupe = state.quad[dragging]; drawCrop(); } };
cropCanvas.onpointerup = () => { dragging = -1; loupe = null; drawCrop(); };
$('#detect').onclick = async () => { state.quad = detectQuad(await pixels(state.page.original)); await drawCrop(); };
$('#full').onclick = async () => {
  const image = await loadImage(state.page.original);
  state.quad = [{ x: 0, y: 0 }, { x: image.width - 1, y: 0 },
    { x: image.width - 1, y: image.height - 1 }, { x: 0, y: image.height - 1 }];
  await drawCrop();
};
async function applyCrop() {
  const page = state.page;
  const quad = state.quad.map(point => ({ ...point }));
  page.base = encode(warp(await pixels(page.original), quad));
  page.processed = encode(applyFilter(await pixels(page.base), page.filter));
  page.lines = []; page.words = []; page.quad = quad;
  await save(); status('已套用裁切');
}
$('#applyCrop').onclick = applyCrop;
async function rotate(direction) {
  const page = state.page, image = await loadImage(page.original);
  scratch.width = image.height; scratch.height = image.width;
  context.translate(scratch.width / 2, scratch.height / 2); context.rotate(direction * Math.PI / 2);
  context.drawImage(image, -image.width / 2, -image.height / 2); context.setTransform(1, 0, 0, 1, 0, 0);
  page.original = scratch.toDataURL('image/jpeg', .9); page.base = page.processed = page.original;
  page.rotation = (page.rotation + direction * 90 + 360) % 360; page.quad = null; page.lines = []; page.words = [];
  state.quad = detectQuad(await pixels(page.original)); await save(); await drawCrop();
}
$('#left').onclick = () => rotate(-1);
$('#right').onclick = () => rotate(1);
async function renderFilterPreviews() {
  const base = await pixels(state.page.base || state.page.original, 160);
  for (const button of $$('[data-filter]')) {
    const data = applyFilter(base, button.dataset.filter), canvas = document.createElement('canvas');
    canvas.width = data.width; canvas.height = data.height;
    canvas.getContext('2d').putImageData(new ImageData(data.data, data.width, data.height), 0, 0);
    let preview = button.querySelector('img');
    if (!preview) { preview = document.createElement('img'); preview.alt = ''; button.prepend(preview); }
    preview.src = canvas.toDataURL('image/jpeg', .7);
  }
}
async function filter(mode) {
  const page = state.page;
  page.processed = encode(applyFilter(await pixels(page.base || page.original), mode));
  page.filter = mode; $('#preview').src = page.processed; await save();
}
$$('[data-filter]').forEach(element => { element.onclick = () => filter(element.dataset.filter); });

const scripts = new Map();
function script(source) {
  if (!scripts.has(source)) scripts.set(source, new Promise((resolve, reject) => {
    const element = document.createElement('script'); element.src = source;
    element.onload = resolve; element.onerror = reject; document.head.append(element);
  }));
  return scripts.get(source);
}
async function recognize(page) {
  if (!state.worker) {
    await script('./vendor/tesseract/tesseract.min.js');
    state.worker = await Tesseract.createWorker(['chi_tra', 'eng'], 1, {
      workerPath: new URL('vendor/tesseract/worker.min.js', location.href).href,
      corePath: new URL('vendor/tesseract/', location.href).href,
      langPath: new URL('vendor/tessdata', location.href).href,
      gzip: true, cacheMethod: 'write', workerBlobURL: false,
      logger: message => status(`文字辨識：${Math.round((message.progress || 0) * 100)}%`, true)
    });
  }
  // Rectify again from the source so fine receipt strokes do not pass through
  // the extra JPEG encoding used for the stored display preview.
  const base = page.quad ? warp(await pixels(page.original), page.quad) : await pixels(page.base || page.original);
  const { result, ocrImage } = await recognizePage(state.worker, base, image => {
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return canvas;
  });
  page.text = cleanText(result.data.text || '');
  const escaped = page.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  page.html = escaped.replaceAll('\n', '<br>');
  const lines = (result.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []);
  const pageImage = await loadImage(page.processed);
  page.lines = lines.map(line => ({ text: cleanText(line.text || ''), bbox: pageBox(line.bbox, ocrImage, pageImage) }));
  page.words = lines.flatMap(line => line.words || []).map(word => ({ text: word.text, bbox: pageBox(word.bbox, ocrImage, pageImage) }));
  await save(); status('辨識完成');
  return page.text;
}
async function runOcr(index) {
  const page = state.document.pages[index];
  const result = await recognize(page);
  if (page === state.page) $('#textEditor').innerHTML = page.html;
  return result;
}
$('#ocr').onclick = async () => {
  try { await runOcr(state.document.pages.indexOf(state.page)); } catch (error) { status('辨識失敗：' + error.message); }
};
$('#ocrAll').onclick = async () => {
  try { for (let i = 0; i < state.document.pages.length; i++) await runOcr(i); }
  catch (error) { status('辨識失敗：' + error.message); }
};
$('#textEditor').oninput = () => {
  state.page.html = $('#textEditor').innerHTML; state.page.text = $('#textEditor').innerText; scheduleSave();
};
$('#textEditor').onpaste = event => {
  event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
};
$$('[data-command]').forEach(element => {
  element.onmousedown = event => event.preventDefault();
  element.onclick = () => {
    document.execCommand(element.dataset.command, false, element.dataset.value || null);
    $('#textEditor').dispatchEvent(new Event('input'));
  };
});
$('#copy').onclick = async () => {
  try { await navigator.clipboard.writeText(state.document.pages.map(page => page.text).join('\n\n')); status('已複製'); }
  catch { status('無法複製，請檢查瀏覽器權限'); }
};

// Annotations use coordinates in the processed image, so they remain independent
// of the canvas display size and can be flattened at full resolution on export.
async function paintAnnotations(canvas, page) {
  const image = await loadImage(page.processed);
  const signatures = new Map();
  await Promise.all(page.annotations.filter(a => a.tool === 'signature').map(async a => signatures.set(a, await loadImage(a.src))));
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  for (const annotation of page.annotations) {
    ctx.save();
    ctx.globalAlpha = annotation.tool === 'highlight' ? .35 : 1;
    ctx.strokeStyle = annotation.color || '#000'; ctx.fillStyle = annotation.color || '#000';
    ctx.lineWidth = annotation.width || 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (annotation.tool === 'white' || annotation.tool === 'black') {
      ctx.fillStyle = annotation.tool === 'white' ? '#fff' : '#000';
      const [start, end] = [annotation.points[0], annotation.points.at(-1)];
      ctx.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
    } else if (annotation.tool === 'text') {
      ctx.font = `${annotation.fontSize}px sans-serif`; ctx.textBaseline = 'top';
      ctx.fillText(annotation.text, annotation.x, annotation.y);
    } else if (annotation.tool === 'signature') {
      ctx.drawImage(signatures.get(annotation), annotation.x, annotation.y, annotation.w, annotation.h);
    } else {
      ctx.beginPath();
      annotation.points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      if (annotation.points.length === 1) ctx.lineTo(annotation.points[0].x + .01, annotation.points[0].y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
async function drawAnnotations() {
  const page = state.page, canvas = $('#annotationCanvas');
  await paintAnnotations(canvas, page);
  if (selected && page.annotations.includes(selected)) {
    const b = bounds(selected), ctx = canvas.getContext('2d');
    ctx.save(); ctx.strokeStyle = '#008f87'; ctx.lineWidth = Math.max(2, canvas.width / 400 * 2);
    ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]); ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]);
    if (selected.tool === 'signature') { ctx.fillStyle = '#008f87'; ctx.fillRect(b.x + b.w - 8, b.y + b.h - 8, 16, 16); }
    ctx.restore();
  }
  canvas.dataset.ready = page.id;
}
const annotationCanvas = $('#annotationCanvas');
function annotationPoint(event) {
  const rect = annotationCanvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * annotationCanvas.width / rect.width,
    y: (event.clientY - rect.top) * annotationCanvas.height / rect.height };
}
function bounds(item) {
  if (item.points) {
    const xs = item.points.map(p => p.x), ys = item.points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: item.x, y: item.y, w: item.w || item.fontSize * item.text.length, h: item.h || item.fontSize * 1.5 };
}
annotationCanvas.onpointerdown = event => {
  const p = annotationPoint(event), tool = $('#tool').value;
  annotationCanvas.setPointerCapture(event.pointerId);
  const tolerance = 22 * annotationCanvas.width / annotationCanvas.getBoundingClientRect().width;
  const existing = [...state.page.annotations].reverse().find(item => {
    const b = bounds(item);
    return p.x >= b.x - tolerance && p.y >= b.y - tolerance && p.x <= b.x + b.w + tolerance && p.y <= b.y + b.h + tolerance;
  });
  if (tool === 'select' || ((tool === 'text' || tool === 'signature') && existing?.tool === tool)) {
    selected = existing || null;
    if (selected) {
      const b = bounds(selected);
      drawing = { moving: selected, start: p, last: p, resizing: selected.tool === 'signature' && Math.hypot(p.x - b.x - b.w, p.y - b.y - b.h) < tolerance * 1.5 };
    }
  } else if (tool === 'text') {
    const text = prompt('輸入文字');
    if (text) { selected = { tool, text, x: p.x, y: p.y, fontSize: Math.max(20, +$('#width').value * 6), color: $('#color').value }; state.page.annotations.push(selected); drawAnnotations(); save(); }
  } else if (tool === 'signature') {
    if (signature) { const w = annotationCanvas.width * .25; selected = { tool, src: signature, x: p.x, y: p.y, w, h: w * .4 }; state.page.annotations.push(selected); drawAnnotations(); save(); }
    else $('#signatureDialog').showModal();
  } else {
    drawing = { tool, color: $('#color').value, width: +$('#width').value, points: [p] };
    selected = drawing; state.page.annotations.push(drawing);
  }
};
annotationCanvas.onpointermove = event => {
  if (!drawing) return;
  const p = annotationPoint(event);
  if (drawing.moving) {
    const item = drawing.moving, dx = p.x - drawing.last.x, dy = p.y - drawing.last.y;
    if (drawing.resizing) { item.w = Math.max(20, p.x - item.x); item.h = Math.max(10, p.y - item.y); }
    else if (item.points) item.points.forEach(point => { point.x += dx; point.y += dy; });
    else { item.x += dx; item.y += dy; }
    drawing.last = p;
  } else drawing.points.push(p);
  drawAnnotations();
};
annotationCanvas.onpointerup = async event => {
  if (!drawing) return;
  if (drawing.moving?.tool === 'text' && Math.hypot(annotationPoint(event).x - drawing.start.x, annotationPoint(event).y - drawing.start.y) < 8 * annotationCanvas.width / annotationCanvas.getBoundingClientRect().width) {
    const text = prompt('編輯文字', drawing.moving.text);
    if (text !== null) drawing.moving.text = text;
  }
  drawing = null; await drawAnnotations(); await save();
};
$('#deleteAnnotation').onclick = async () => { if (selected) { state.page.annotations = state.page.annotations.filter(item => item !== selected); selected = null; await drawAnnotations(); await save(); } };
$('#undoAnnotation').onclick = async () => { state.page.annotations.pop(); await drawAnnotations(); await save(); };
$('#clearAnnotation').onclick = async () => { state.page.annotations = []; await drawAnnotations(); await save(); };
$('#tool').onchange = () => { if ($('#tool').value === 'signature' && !signature) $('#signatureDialog').showModal(); };
const pad = $('#signaturePad'), padContext = pad.getContext('2d');
let signing = false;
function padPoint(event) {
  const rect = pad.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * pad.width / rect.width, y: (event.clientY - rect.top) * pad.height / rect.height };
}
pad.onpointerdown = event => { signing = true; pad.setPointerCapture(event.pointerId); const p = padPoint(event); padContext.beginPath(); padContext.moveTo(p.x, p.y); };
pad.onpointermove = event => {
  if (!signing) return;
  const p = padPoint(event); padContext.strokeStyle = '#111'; padContext.lineWidth = 3; padContext.lineCap = 'round';
  padContext.lineTo(p.x, p.y); padContext.stroke();
};
pad.onpointerup = () => { signing = false; };
$('#clearSignature').onclick = () => padContext.clearRect(0, 0, pad.width, pad.height);
$('#useSignature').onclick = () => { signature = pad.toDataURL('image/png'); $('#signatureDialog').close(); status('在頁面上點一下以放置簽名'); };
$('#cancelSignature').onclick = () => $('#signatureDialog').close();

$('#camera').onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    $('#cameraDialog video').srcObject = stream; $('#cameraCount').textContent = `${state.document.pages.length} 頁`; $('#cameraDialog').showModal();
  } catch (error) { status('無法使用相機，請使用「影相」按鈕'); }
};
$('#shoot').onclick = async () => {
  const video = $('#cameraDialog video'); scratch.width = video.videoWidth; scratch.height = video.videoHeight;
  context.drawImage(video, 0, 0); await addImage(scratch.toDataURL('image/jpeg', .9)); $('#cameraCount').textContent = `${state.document.pages.length} 頁`; status('已加入一頁');
};
function stopCamera() { stream?.getTracks().forEach(track => track.stop()); stream = null; }
$('#closeCamera').onclick = () => $('#cameraDialog').close();
$('#cameraDialog').addEventListener('close', stopCamera);

async function flatten(page, type = 'image/jpeg') {
  const canvas = document.createElement('canvas');
  await paintAnnotations(canvas, page);
  return new Promise(resolve => canvas.toBlob(resolve, type, .85));
}
// Convert editor markup to paragraphs and styled runs for both document formats.
function paragraphs(page) {
  const root = document.createElement('div'); root.innerHTML = page.html || '';
  if (!root.childNodes.length) return (page.text || '').split('\n').map(text => ({ runs: [{ text }] }));
  const result = []; let current = { runs: [] };
  function flush(force = false) {
    if (current.runs.length || force) result.push(current);
    current = { runs: [] };
  }
  function walk(node, style = {}) {
    if (node.nodeType === Node.TEXT_NODE) { if (node.nodeValue) current.runs.push({ text: node.nodeValue, ...style }); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { flush(true); return; }
    const block = ['p', 'div', 'h1', 'h2', 'h3', 'li'].includes(tag);
    if (block && current.runs.length) flush();
    if (tag.startsWith('h') && /^h[123]$/.test(tag)) current.heading = true;
    if (tag === 'li') current.list = true;
    const next = { ...style, bold: style.bold || ['b', 'strong'].includes(tag), italic: style.italic || ['i', 'em'].includes(tag), underline: style.underline || tag === 'u' };
    for (const child of node.childNodes) walk(child, next);
    if (block) flush(true);
  }
  for (const node of root.childNodes) walk(node);
  flush();
  return result.length ? result : [{ runs: [] }];
}
async function exportBlob(kind, pageIndex = 0) {
  const pages = state.document.pages;
  if (kind === 'txt') return new Blob([pages.map(page => page.text).join('\n\n')], { type: 'text/plain;charset=utf-8' });
  if (kind === 'png' || kind === 'jpg') return flatten(pages[pageIndex], kind === 'png' ? 'image/png' : 'image/jpeg');
  if (kind === 'docx') {
    await script('./vendor/docx/docx.iife.js');
    const sections = pages.map(page => ({ children: paragraphs(page).map(paragraph => new docx.Paragraph({
      heading: paragraph.heading ? docx.HeadingLevel.HEADING_2 : undefined,
      bullet: paragraph.list ? { level: 0 } : undefined,
      children: paragraph.runs.map(run => new docx.TextRun({ text: run.text, bold: run.bold, italics: run.italic, underline: run.underline ? {} : undefined }))
    })) }));
    return docx.Packer.toBlob(new docx.Document({ sections }));
  }
  if (!['pdf-search', 'pdf-text'].includes(kind)) throw new Error('未知匯出格式');
  await script('./vendor/pdf-lib/pdf-lib.min.js'); await script('./vendor/pdf-lib/fontkit.umd.min.js');
  const pdf = await PDFLib.PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await (await fetch('./vendor/fonts/NotoSansTC-Regular.ttf')).arrayBuffer(), { subset: true });
  if (kind === 'pdf-search') {
    for (const page of pages) {
      const image = await pdf.embedJpg(await (await flatten(page)).arrayBuffer());
      const sheet = pdf.addPage([image.width, image.height]);
      sheet.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      for (const line of page.lines || []) {
        const box = line.bbox, text = (line.text || '').trim();
        if (!box || !text) continue;
        // A redacted line must not remain selectable underneath the black box.
        const covered = page.annotations.some(annotation => {
          if (annotation.tool !== 'black') return false;
          const [a, b] = [annotation.points[0], annotation.points.at(-1)];
          return Math.min(a.x, b.x) < box.x1 && Math.max(a.x, b.x) > box.x0 &&
            Math.min(a.y, b.y) < box.y1 && Math.max(a.y, b.y) > box.y0;
        });
        if (covered) continue;
        let size = Math.max(1, box.y1 - box.y0);
        size *= Math.min(1, Math.max(1, box.x1 - box.x0) / Math.max(1, font.widthOfTextAtSize(text, size)));
        sheet.drawText(text, { x: box.x0, y: image.height - box.y1, size, font, opacity: 0 });
      }
    }
  } else {
    let sheet, y;
    function newSheet() { sheet = pdf.addPage([595, 842]); y = 800; }
    newSheet();
    for (const page of pages) {
      for (const paragraph of paragraphs(page)) {
        const size = paragraph.heading ? 17 : 12, leading = size * 1.6;
        // CJK is breakable per character; English words remain intact where possible.
        const text = (paragraph.list ? '• ' : '') + paragraph.runs.map(run => run.text).join('');
        const tokens = text.match(/[\u3400-\u9fff\uf900-\ufaff]|[^\s\u3400-\u9fff\uf900-\ufaff]+|\s+/gu) || [''];
        let line = '';
        const emit = () => {
          if (y < 50) newSheet();
          sheet.drawText(line, { x: 40, y, size, font });
          if (paragraph.heading || paragraph.runs.some(run => run.bold)) sheet.drawText(line, { x: 40.3, y, size, font });
          y -= leading; line = '';
        };
        for (const token of tokens) {
          if (line && font.widthOfTextAtSize(line + token, size) > 515) emit();
          for (const character of token) {
            if (line && font.widthOfTextAtSize(line + character, size) > 515) emit();
            line += character;
          }
        }
        emit(); y -= 4;
      }
      y -= 12;
    }
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}
let resultFiles = [];
async function deliver(kind) {
  const title = (state.document.title || '文件').replace(/[\\/:*?"<>|]/g, '_');
  const image = kind === 'png' || kind === 'jpg';
  const extension = kind.startsWith('pdf-') ? 'pdf' : kind;
  const blobs = image ? await Promise.all(state.document.pages.map((_, index) => exportBlob(kind, index))) : [await exportBlob(kind)];
  resultFiles = blobs.map((blob, index) => new File([blob], `${title}${image ? '-' + (index + 1) : ''}.${extension}`, { type: blob.type }));
  $('#resultInfo').textContent = resultFiles.map(file => `${file.name}（${(file.size / 1024).toFixed(1)} KB）`).join('、');
  $('#shareResult').hidden = !navigator.canShare?.({ files: resultFiles });
  $('#exportDialog').close(); $('#resultDialog').showModal();
}
$('#shareResult').onclick = () => {
  // Call share directly in this click handler, before any asynchronous work.
  navigator.share({ files: resultFiles }).catch(error => { if (error.name !== 'AbortError') status('分享失敗，請選擇下載'); });
};
$('#downloadResult').onclick = () => {
  for (const file of resultFiles) {
    const url = URL.createObjectURL(file), anchor = document.createElement('a');
    anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
};
$('#closeResult').onclick = () => $('#resultDialog').close();
$('#export').onclick = () => $('#exportDialog').showModal();
$('#closeExport').onclick = () => $('#exportDialog').close();
$$('[data-export]').forEach(element => {
  element.onclick = async () => {
    try { status('正在匯出…', true); await deliver(element.dataset.export); status(''); }
    catch (error) { status('匯出失敗：' + error.message); }
  };
});
$('#offline').onclick = () => {
  if (!navigator.serviceWorker?.controller) { status('請重新載入後再準備離線檔案'); return; }
  navigator.serviceWorker.controller.postMessage('prepare'); status('正在準備離線檔案…', true);
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(registration => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller && confirm('有新版本，重新載入？')) worker.postMessage('skipWaiting');
      });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'offline-progress') { $('#offlineInfo').textContent = `離線準備 ${data.count}/${data.total} 檔案`; status($('#offlineInfo').textContent, true); }
    if (data.type === 'offline-ready') { $('#offlineInfo').textContent = data.ready ? '已可離線使用' : `離線檔案 ${data.count}/${data.total}`; if (data.ready) status('已可離線使用'); }
    if (data.type === 'offline-error') status('離線準備失敗，請重試');
  });
}
navigator.storage?.persist?.();
window.__docScan = { state, api: { newDocument, importFiles, editPage, getQuad: () => state.quad.map(point => ({ ...point })),
  detect: async () => { state.quad = detectQuad(await pixels(state.page.original)); await drawCrop(); return state.quad; },
  applyCrop, filter, runOcr, exportBlob, show, tab } };
show('home');
