// AI Team backend: one file, two routes (/api/chat and /api/upload, see vercel.json).
// Every AI below speaks the same OpenAI-style API, so one function talks to all of them.
// An AI is ON only if its API key is set in the environment.

import zlib from 'node:zlib';

const PROVIDERS = [
  { id: 'gemini', name: 'Gemini', keyEnv: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', vision: true },
  { id: 'groq', name: 'Groq', keyEnv: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', vision: false },
  { id: 'mistral', name: 'Mistral', keyEnv: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions', model: process.env.MISTRAL_MODEL || 'mistral-small-latest', vision: true },
  { id: 'openrouter', name: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions', model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', vision: false },
  { id: 'cerebras', name: 'Cerebras', keyEnv: 'CEREBRAS_API_KEY', url: 'https://api.cerebras.ai/v1/chat/completions', model: process.env.CEREBRAS_MODEL || 'llama-3.3-70b', vision: false },
];

// Small limits = fewer credits used. Raise them if answers feel cut off.
const TEAM_SIZE = Number(process.env.TEAM_SIZE) || 3; // AIs answering together in Team mode
const DRAFT_TOKENS = 700; // each teammate's draft
const FINAL_TOKENS = 1200; // the answer you read
const TIMEOUT_MS = 20000; // per AI call

const MAX_FILE = 1024 ** 3; // 1 GB upload limit
const MAX_PROXY = 4 * 1024 * 1024; // small files can also go through the server (backup path)
const FILE_CHARS = Number(process.env.FILE_CHARS) || 12000; // how much file text the AIs see per question
const READ_MS = 12000; // time allowed for reading files before the AIs are called
const MAX_IMAGE = 5 * 1024 * 1024; // biggest picture sent to an AI
const MAX_PDF = 50 * 1024 * 1024; // biggest PDF we open (PDFs must be loaded whole)
const MAX_PART = 50 * 1024 * 1024; // biggest piece inside a Word/Excel/PowerPoint file

const SOLO_SYS = 'You are a helpful assistant. Keep answers clear and not longer than needed.';

const authed = (req) => !process.env.ACCESS_CODE || req.headers['x-access-code'] === process.env.ACCESS_CODE;
const enabled = () => PROVIDERS.filter((p) => process.env[p.keyEnv]);

// ===================== FILE STORAGE (R2 first, then B2) =====================

let storeList;
async function stores() {
  if (storeList) return storeList;
  const { S3Client } = await import('@aws-sdk/client-s3');
  const e = process.env;
  // R2 and B2 don't support the SDK's newer checksum headers, so keep them off.
  const opts = { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' };
  storeList = [];

  if (e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_BUCKET) {
    storeList.push({
      id: 'r2',
      bucket: e.R2_BUCKET,
      client: new S3Client({
        ...opts,
        region: 'auto',
        endpoint: `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
      }),
    });
  }
  if (e.B2_ENDPOINT && e.B2_KEY_ID && e.B2_APP_KEY && e.B2_BUCKET) {
    const host = e.B2_ENDPOINT.replace(/^https?:\/\//, '');
    storeList.push({
      id: 'b2',
      bucket: e.B2_BUCKET,
      client: new S3Client({
        ...opts,
        region: host.split('.')[1] || 'us-west-004',
        endpoint: `https://${host}`,
        credentials: { accessKeyId: e.B2_KEY_ID, secretAccessKey: e.B2_APP_KEY },
      }),
    });
  }
  return storeList;
}

const cleanName = (n) => String(n).replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
const makeKey = (name) => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;

// A one-time link so the phone can upload straight to the bucket (this is how 1 GB works).
async function presignPut(name, skip) {
  const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ]);
  const key = makeKey(name);
  for (const s of await stores()) {
    if (skip.includes(s.id)) continue;
    const url = await getSignedUrl(s.client, new PutObjectCommand({ Bucket: s.bucket, Key: key }), { expiresIn: 7200 });
    return { id: `${s.id}:${key}`, url, store: s.id };
  }
  return null;
}

// Small-file backup path: the file passes through the server.
async function saveFile(name, body) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const key = makeKey(name);
  for (const s of await stores()) {
    try {
      await s.client.send(new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: body }));
      return `${s.id}:${key}`;
    } catch (err) {
      console.error(`${s.id} upload failed:`, err.message);
    }
  }
  throw new Error('No storage available');
}

// Reading from storage. All reading goes through "io" so it can be swapped in tests.
async function locate(id) {
  const i = id.indexOf(':');
  const s = (await stores()).find((x) => x.id === id.slice(0, i));
  if (!s) throw new Error('Unknown storage');
  return { s, Key: id.slice(i + 1) };
}
async function sizeOf(id) {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { s, Key } = await locate(id);
  return (await s.client.send(new HeadObjectCommand({ Bucket: s.bucket, Key }))).ContentLength;
}
async function getBody(id, range) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { s, Key } = await locate(id);
  return (await s.client.send(new GetObjectCommand({ Bucket: s.bucket, Key, Range: range }))).Body;
}
const readRange = async (id, start, end) => Buffer.from(await (await io.getBody(id, `bytes=${start}-${end}`)).transformToByteArray());
const readAll = async (id) => Buffer.from(await (await io.getBody(id)).transformToByteArray());
const io = { sizeOf, getBody, readRange, readAll };
export const _io = io; // used by tests only

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ===================== /api/upload =====================

async function upload(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!authed(req)) return res.status(401).json({ error: 'Wrong access code' });

  try {
    // Normal path: give the phone a link to upload straight to storage (up to 1 GB).
    if (String(req.headers['content-type'] || '').includes('application/json')) {
      const { name = 'file', size = 0, skip = [] } = req.body || {};
      if (!(size > 0) || size > MAX_FILE) return res.status(413).json({ error: 'File is over 1 GB' });
      const out = await presignPut(cleanName(name), Array.isArray(skip) ? skip : []);
      return out ? res.json(out) : res.status(404).json({ error: 'No storage left to try' });
    }

    // Backup path: small files sent through the server.
    const buf = await readBody(req);
    if (!buf.length) return res.status(400).json({ error: 'No file received' });
    if (buf.length > MAX_PROXY) return res.status(413).json({ error: 'File is too big for this path' });
    const id = await saveFile(cleanName(decodeURIComponent(String(req.headers['x-filename'] || 'file'))), buf);
    return res.json({ id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "File storage isn't set up yet" });
  }
}

// ===================== READING FILES =====================
// Big files can't be pasted into an AI whole. So we read the file from storage and give the AIs
// the opening plus the parts that best match your question (like a search). Small files go in whole.

class Nice extends Error {} // an error whose message is safe to show the user

const STOP = new Set('the and for are was were with that this from what which who how why when where about into have has had not you your can could would should will does did all any file document please tell give show explain summarize summary describe read also than then them they their there here more some such only over out one two'.split(' '));
const fmtSize = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

// Collects text piece by piece (so it works on streams) and keeps the best parts.
function makeSelector(question, budget) {
  const terms = [...new Set((String(question).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w)))].slice(0, 12);
  const CH = 1000;
  const headLen = Math.min(2000, Math.floor(budget / 4));
  const slots = Math.max(1, Math.floor((budget - headLen) / CH));
  let all = '', total = 0, carry = '', n = 0, seen0 = 0;
  const top = []; // chunks that match your question
  const pool = []; // random sample of other chunks (used when few chunks match)

  const consider = (t) => {
    const idx = n++;
    let score = 0;
    if (terms.length) {
      const low = t.toLowerCase();
      let hit = 0, cnt = 0;
      for (const w of terms) {
        let c = 0, i = low.indexOf(w);
        while (i !== -1 && c < 5) { c++; i = low.indexOf(w, i + w.length); }
        if (c) { hit++; cnt += c; }
      }
      score = hit * 10 + cnt;
    }
    if (score > 0) {
      top.push({ n: idx, t, score });
      if (top.length > slots) { top.sort((a, b) => b.score - a.score); top.length = slots; }
    } else if (idx * CH >= headLen) {
      seen0++;
      if (pool.length < slots) pool.push({ n: idx, t });
      else { const j = Math.floor(Math.random() * seen0); if (j < slots) pool[j] = { n: idx, t }; }
    }
  };

  return {
    add(text) {
      total += text.length;
      if (all.length <= budget) all += text;
      carry += text;
      while (carry.length >= CH) { consider(carry.slice(0, CH)); carry = carry.slice(CH); }
    },
    done() {
      if (carry) { consider(carry); carry = ''; }
      if (total <= budget) return { text: all, total, whole: true };
      const picked = top.filter((c) => c.n * CH >= headLen);
      const fill = pool.slice(0, Math.max(0, slots - picked.length));
      const body = [...picked, ...fill].sort((a, b) => a.n - b.n).map((c) => c.t).join('\n[...]\n');
      return { text: all.slice(0, headLen) + '\n[...]\n' + body, total, whole: false };
    },
  };
}

// ---- Word / Excel / PowerPoint / OpenDocument files are zip files. We read only the parts we need,
// straight from storage with range requests, so even a huge file is fine. ----

async function zipList(id, size) {
  if (size < 22) throw new Nice('this file looks damaged');
  const tailLen = Math.min(size, 65557);
  const tail = await io.readRange(id, size - tailLen, size - 1);
  const p = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (p < 0) throw new Nice('this file looks damaged');
  const cdSize = tail.readUInt32LE(p + 12), cdOff = tail.readUInt32LE(p + 16);
  if (cdOff === 0xffffffff) throw new Nice('this file type is too large for me to open');
  const cd = await io.readRange(id, cdOff, cdOff + cdSize - 1);
  const map = new Map();
  for (let o = 0; o + 46 <= cd.length && cd.readUInt32LE(o) === 0x02014b50; ) {
    const nl = cd.readUInt16LE(o + 28), el = cd.readUInt16LE(o + 30), cl = cd.readUInt16LE(o + 32);
    map.set(cd.toString('utf8', o + 46, o + 46 + nl), {
      method: cd.readUInt16LE(o + 10), csize: cd.readUInt32LE(o + 20), usize: cd.readUInt32LE(o + 24), off: cd.readUInt32LE(o + 42),
    });
    o += 46 + nl + el + cl;
  }
  return map;
}

async function zipGet(id, e) {
  if (!e) return '';
  if (e.usize > MAX_PART) throw new Nice('one part of this file is too big to open');
  const h = await io.readRange(id, e.off, e.off + 29);
  const start = e.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const raw = e.csize ? await io.readRange(id, start, start + e.csize - 1) : Buffer.alloc(0);
  return (e.method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const strip = (s) => unxml(s.replace(/<[^>]+>/g, ''));
const num = (s) => Number(s.match(/(\d+)\.xml$/)?.[1] || 0);
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;

async function officeText(kind, id, size) {
  const parts = await zipList(id, size);
  const get = (name) => zipGet(id, parts.get(name));
  const names = (re) => [...parts.keys()].filter((k) => re.test(k)).sort((a, b) => num(a) - num(b));

  if (kind === 'docx') {
    const x = await get('word/document.xml');
    return strip(x.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '').replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n'));
  }

  if (kind === 'pptx') {
    const out = [];
    for (const f of names(/^ppt\/slides\/slide\d+\.xml$/)) {
      out.push(`--- Slide ${num(f)} ---\n` + strip((await get(f)).replace(/<\/a:p>/g, '\n')));
      const notes = parts.get(`ppt/notesSlides/notesSlide${num(f)}.xml`);
      if (notes) out.push('(Speaker notes) ' + strip((await zipGet(id, notes)).replace(/<\/a:p>/g, '\n')));
    }
    return out.join('\n');
  }

  if (kind === 'xlsx') {
    const ss = await get('xl/sharedStrings.xml');
    const strings = (ss.match(/<si\b[\s\S]*?<\/si>/g) || []).map((si) => strip((si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).join('')));
    const sheetNames = [...(await get('xl/workbook.xml')).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unxml(m[1]));
    const out = [];
    for (const [k, f] of names(/^xl\/worksheets\/sheet\d+\.xml$/).entries()) {
      out.push(`## Sheet: ${sheetNames[k] || 'Sheet ' + (k + 1)}`);
      const rows = ((await get(f)).match(/<row\b[\s\S]*?<\/row>/g) || []).slice(0, 200000);
      for (const row of rows) {
        const cells = [];
        for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
          const ref = c.match(/\br="([A-Z]+\d+)"/)?.[1];
          const type = c.match(/\bt="(\w+)"/)?.[1];
          let v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
          if (type === 's') v = strings[Number(v)] ?? '';
          else if (type === 'inlineStr') v = strip(c.match(/<is>[\s\S]*?<\/is>/)?.[0] || '');
          else v = unxml(v);
          if (ref && v !== '') cells[colIndex(ref)] = v;
        }
        out.push(Array.from(cells, (v) => v ?? '').join('\t'));
      }
    }
    return out.join('\n');
  }

  // odt / ods / odp
  const x = await get('content.xml');
  return strip(x.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n'));
}

async function pdfText(id) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await io.readAll(id)));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}

const ext = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const TEXT_EXT = /\.(txt|md|csv|tsv|json|jsonl|xml|html?|css|jsx?|tsx?|py|java|c|cpp|h|go|rs|rb|php|sql|ya?ml|toml|ini|log|sh|tex|srt|vtt)$/i;

function kindOf({ name, type }) {
  const e = ext(name);
  if (/^image\/(png|jpe?g|webp|gif)$/.test(type)) return 'image';
  if (e === 'pdf' || type === 'application/pdf') return 'pdf';
  if (['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp'].includes(e)) return e;
  if (TEXT_EXT.test(name) || /^text\//.test(type) || /json|csv|javascript/.test(type)) return 'text';
  return null;
}

function whyNot({ name, type }) {
  const e = ext(name);
  if (['doc', 'xls', 'ppt'].includes(e)) return `${name} is an old Word/Excel/PowerPoint format. Save it as docx, xlsx, pptx or PDF to let the AIs read it.`;
  if (/^(audio|video)\//.test(type) || ['mp3', 'wav', 'm4a', 'mp4', 'mov', 'mkv', 'webm', 'avi'].includes(e)) return `${name} is saved, but the AIs can't listen to audio or watch video yet.`;
  return `${name} is saved, but the AIs can't open this kind of file yet.`;
}

async function readDocument(kind, name, id, question, chars, deadline) {
  const size = await io.sizeOf(id);
  const sel = makeSelector(question, chars);
  let scanned = '';

  if (kind === 'text') {
    const body = await io.getBody(id);
    const dec = new TextDecoder('utf-8');
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      sel.add(dec.decode(chunk, { stream: true }));
      if (Date.now() > deadline) {
        body.destroy?.();
        scanned = `, scanned the first ${fmtSize(bytes)} of ${fmtSize(size)} before time ran out`;
        break;
      }
    }
  } else if (kind === 'pdf') {
    if (size > MAX_PDF) return { note: `${name} is too big to open (PDFs up to ${fmtSize(MAX_PDF)} work).` };
    sel.add(await pdfText(id));
  } else {
    sel.add(await officeText(kind, id, size));
  }

  const r = sel.done();
  if (!r.total) return { note: `${name} has no readable text${kind === 'pdf' ? ' (is it a scanned PDF?)' : ''}.` };
  if (r.whole) return { text: `[File: ${name}]\n${r.text}` };
  return {
    text: `[File: ${name}, ${fmtSize(size)}. Too big to show in full, so this is the opening plus the parts that best match the question. Say so if the answer may need other parts.]\n${r.text}`,
    note: `${name} is big, so the AIs saw the opening plus the parts matching your question${scanned}.`,
  };
}

async function loadFiles(files, question, notes) {
  const out = { images: [], text: [] };
  if (!Array.isArray(files) || !files.length) return out;
  if (files.length > 3) notes.push('Only the first 3 files were used.');
  const list = files.slice(0, 3);
  const deadline = Date.now() + READ_MS;
  const share = Math.floor(FILE_CHARS / list.length);

  for (const f of list) {
    const name = String(f?.name || 'file');
    const file = { name, type: String(f?.type || '') };
    try {
      if (!/^(r2|b2):[\w.\-]+$/.test(f?.id || '')) throw new Error('bad id');
      const kind = kindOf(file);
      if (!kind) { notes.push(whyNot(file)); continue; }
      if (kind === 'image') {
        if ((await io.sizeOf(f.id)) > MAX_IMAGE) { notes.push(`${name} is too big for the AIs to see (pictures up to ${fmtSize(MAX_IMAGE)}).`); continue; }
        out.images.push(`data:${file.type};base64,${(await io.readAll(f.id)).toString('base64')}`);
        continue;
      }
      const r = await readDocument(kind, name, f.id, question, share, deadline);
      if (r.text) out.text.push(r.text);
      if (r.note) notes.push(r.note);
    } catch (e) {
      notes.push(e instanceof Nice ? `${name}: ${e.message}.` : `Couldn't read ${name} (files are deleted after 24 hours).`);
    }
  }
  return out;
}

// ===================== AI CALLS =====================

// If an AI says "out of credits / rate limited", skip it for a while so we don't waste calls.
const cooling = new Map();

async function callModel(p, messages, max_tokens) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(p.url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[p.keyEnv]}` },
      body: JSON.stringify({ model: p.model, messages, max_tokens }),
    });
    if (!r.ok) {
      if (r.status === 429) cooling.set(p.id, Date.now() + 60_000);
      if (r.status === 402 || r.status === 403) cooling.set(p.id, Date.now() + 600_000);
      throw new Error(r.status === 429 || r.status === 402 ? 'out of credits or rate limited' : `error ${r.status}`);
    }
    const j = await r.json();
    let text = j.choices?.[0]?.message?.
