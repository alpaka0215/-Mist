'use strict';
/*
 * MIST server
 * - 접속 기록(IP·로그)을 저장하지 않는다. 요청 로거를 쓰지 않고, DB에도 넣지 않는다.
 * - 도배 방지용 제한은 메모리에서 1분간만 유지되는 무작위 해시값으로 처리하며 디스크에 쓰지 않는다.
 * - 비밀번호는 scrypt + 개별 salt로 해시해서 저장한다.
 * - 사진의 위치정보(EXIF GPS 등) 메타데이터는 저장 전에 제거한다.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');

// ── 설정 ────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const LIMITS = { title: 100, content: 5000, author: 20, comment: 1000, roName: 20, pwMin: 4, pwMax: 64, images: 4, imageMB: 8 };
const PAGE_SIZE = 20;
// 인기로: 최근 HOT_DAYS일 안의 글 중 점수(조회 + 좋아요×10 + 댓글×5)가 HOT_MIN 이상인 글
const HOT_DAYS = 7;
const HOT_MIN = 20;
const HOT_SCORE = '(p.views + p.likes * 10 + p.comment_count * 5)';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!ADMIN_PASSWORD) console.warn('[MIST] ADMIN_PASSWORD가 없어 공지로 글쓰기가 비활성화됩니다.');

// ── DB ──────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'mist.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  pw_hash TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);
`);

const now = () => Math.floor(Date.now() / 1000);
const seed = db.prepare('INSERT OR IGNORE INTO boards (slug, name, system, created_at) VALUES (?, ?, 1, ?)');
seed.run('free', '자유로', now());
seed.run('notice', '공지로', now());
const RESERVED = new Set(['자유로', '공지로', '인기로', '유저로']);

const q = {
  boardBySlug: db.prepare('SELECT * FROM boards WHERE slug = ?'),
  boards: db.prepare(`
    SELECT b.slug, b.name, b.system, b.created_at, COUNT(p.id) AS post_count, MAX(p.created_at) AS last_post_at
    FROM boards b LEFT JOIN posts p ON p.board_id = b.id
    GROUP BY b.id
    ORDER BY b.system DESC, COALESCE(MAX(p.created_at), b.created_at) DESC`),
  insertBoard: db.prepare('INSERT INTO boards (slug, name, system, created_at) VALUES (?, ?, 0, ?)'),
  deleteBoard: db.prepare('DELETE FROM boards WHERE id = ? AND system = 0'),
  boardImages: db.prepare('SELECT images FROM posts WHERE board_id = ?'),
  listByBoard: db.prepare(`
    SELECT p.*, b.slug AS board_slug, b.name AS board_name FROM posts p JOIN boards b ON b.id = p.board_id
    WHERE p.board_id = ? AND p.id < ? ORDER BY p.id DESC LIMIT ?`),
  listHot: db.prepare(`
    SELECT p.*, b.slug AS board_slug, b.name AS board_name FROM posts p JOIN boards b ON b.id = p.board_id
    WHERE b.slug != 'notice' AND p.created_at >= ? AND ${HOT_SCORE} >= ?
    ORDER BY ${HOT_SCORE} DESC, p.id DESC LIMIT ? OFFSET ?`),
  post: db.prepare(`
    SELECT p.*, b.slug AS board_slug, b.name AS board_name FROM posts p JOIN boards b ON b.id = p.board_id
    WHERE p.id = ?`),
  insertPost: db.prepare(`
    INSERT INTO posts (board_id, title, content, author, images, pw_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  deletePost: db.prepare('DELETE FROM posts WHERE id = ?'),
  addView: db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?'),
  like: db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?'),
  unlike: db.prepare('UPDATE posts SET likes = MAX(likes - 1, 0) WHERE id = ?'),
  likes: db.prepare('SELECT likes FROM posts WHERE id = ?'),
  comments: db.prepare('SELECT id, author, content, created_at FROM comments WHERE post_id = ? ORDER BY id'),
  comment: db.prepare('SELECT * FROM comments WHERE id = ?'),
  insertComment: db.prepare('INSERT INTO comments (post_id, author, content, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
  deleteComment: db.prepare('DELETE FROM comments WHERE id = ?'),
  incComments: db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?'),
  decComments: db.prepare('UPDATE posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = ?'),
};

// ── 공통 도구 ────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function clean(v, max, { required, label, fallback = '' }) {
  let s = typeof v === 'string' ? v : '';
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202E\uFEFF]/g, '').trim();
  if (!s && required) throw bad(`${label} 입력해 주세요.`);
  if (s.length > max) throw bad(`${label} ${max}자까지 쓸 수 있어요.`);
  return s || fallback;
}
function password(v) {
  const s = typeof v === 'string' ? v : '';
  if (s.length < LIMITS.pwMin || s.length > LIMITS.pwMax) throw bad(`삭제 비밀번호는 ${LIMITS.pwMin}~${LIMITS.pwMax}자로 정해 주세요.`);
  return s;
}

const scrypt = promisify(crypto.scrypt);
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
async function checkPw(pw, stored) {
  if (typeof pw !== 'string' || !pw) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = await scrypt(pw, Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(pw) {
  if (!ADMIN_PASSWORD || typeof pw !== 'string' || !pw) return false;
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
async function canDelete(pw, stored) {
  return isAdmin(pw) || (await checkPw(pw, stored));
}

// 도배 방지: 메모리에만 1분간 유지. 원본 IP는 보관하지 않고, 재시작마다 바뀌는 salt로 해시한 값만 잠깐 쓴다.
const RATE_SALT = crypto.randomBytes(32);
const hits = new Map();
function clientKey(req) {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || req.socket.remoteAddress || '';
  return crypto.createHmac('sha256', RATE_SALT).update(ip).digest('base64url').slice(0, 22);
}
function limit(bucket, max) {
  return (req, res, next) => {
    const key = `${bucket}:${clientKey(req)}`;
    const t = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < t) { e = { n: 0, reset: t + 60_000 }; hits.set(key, e); }
    if (++e.n > max) return res.status(429).json({ error: '너무 빠르게 요청하고 있어요. 잠시 후 다시 시도해 주세요.' });
    next();
  };
}
setInterval(() => {
  const t = Date.now();
  for (const [k, e] of hits) if (e.reset < t) hits.delete(k);
}, 60_000).unref();

// ── 사진 처리 ────────────────────────────────────────────────────────
const IMG_ERR = '사진 파일을 읽을 수 없어요. JPG, PNG, GIF, WEBP만 올릴 수 있어요.';
const FILE_RE = /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/;

function detectType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function readOrientation(d) {
  try {
    if (d.toString('latin1', 0, 6) !== 'Exif\0\0') return 0;
    const t = d.subarray(6);
    const le = t.toString('latin1', 0, 2) === 'II';
    const r16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const r32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ifd = r32(4);
    const n = r16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 0; }
    }
  } catch { /* 메타데이터가 깨진 경우 무시 */ }
  return 0;
}
// 사진 회전 정보(Orientation) 하나만 담은 최소 EXIF. 휴대폰 사진이 눕지 않도록 이것만 남긴다.
function orientationSegment(v) {
  const b = Buffer.alloc(36);
  b.writeUInt16BE(0xffe1, 0); b.writeUInt16BE(34, 2); b.write('Exif\0\0', 4, 'latin1');
  b.write('MM', 10, 'latin1'); b.writeUInt16BE(42, 12); b.writeUInt32BE(8, 14);
  b.writeUInt16BE(1, 18); b.writeUInt16BE(0x0112, 20); b.writeUInt16BE(3, 22); b.writeUInt32BE(1, 24); b.writeUInt16BE(v, 28);
  return b;
}
function stripJpeg(buf) {
  const out = [];
  let i = 2, orientation = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw bad(IMG_ERR);
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xda) {
      // 이미지 데이터. 첫 EOI에서 자른다(뒤에 붙은 보조 이미지·메타데이터 제거).
      let end = buf.indexOf(Buffer.from([0xff, 0xd9]), i + 2);
      end = end === -1 ? buf.length : end + 2;
      out.push(buf.subarray(i, end));
      const head = [buf.subarray(0, 2)];
      if (orientation > 1) head.push(orientationSegment(orientation));
      return Buffer.concat([...head, ...out]);
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) throw bad(IMG_ERR);
    const seg = buf.subarray(i, end);
    const isIcc = m === 0xe2 && buf.toString('latin1', i + 4, i + 16) === 'ICC_PROFILE\0';
    if (m === 0xe1) { if (!orientation) orientation = readOrientation(buf.subarray(i + 4, end)); }
    else if (m === 0xfe || (m >= 0xe1 && m <= 0xef && m !== 0xee && !isIcc)) { /* 메타데이터 버림 */ }
    else out.push(seg);
    i = end;
  }
  throw bad(IMG_ERR);
}
function stripPng(buf) {
  const drop = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
  const out = [buf.subarray(0, 8)];
  let i = 8, ended = false;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw bad(IMG_ERR);
    if (!drop.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw bad(IMG_ERR);
  return Buffer.concat(out);
}
function stripWebp(buf) {
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    if (i + 8 + len > buf.length) throw bad(IMG_ERR);
    const end = Math.min(i + 8 + len + (len & 1), buf.length);
    if (type !== 'EXIF' && type !== 'XMP ') chunks.push(Buffer.from(buf.subarray(i, end)));
    i = end;
  }
  if (!chunks.length) throw bad(IMG_ERR);
  const vp8x = chunks.find((c) => c.toString('latin1', 0, 4) === 'VP8X');
  if (vp8x && vp8x.length > 8) vp8x[8] &= ~0x0c;
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function saveImages(files = []) {
  const saved = [];
  try {
    for (const f of files) {
      const type = detectType(f.buffer);
      if (!type) throw bad(IMG_ERR);
      const data = type === 'jpg' ? stripJpeg(f.buffer) : type === 'png' ? stripPng(f.buffer) : type === 'webp' ? stripWebp(f.buffer) : f.buffer;
      const name = `${crypto.randomBytes(16).toString('hex')}.${type}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), data);
      saved.push(name);
    }
    return saved;
  } catch (err) {
    removeImages(saved);
    throw err;
  }
}
function removeImages(names) {
  for (const n of names) if (FILE_RE.test(n)) fs.rm(path.join(UPLOAD_DIR, n), { force: true }, () => {});
}
const parseImages = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.imageMB * 1024 * 1024, files: LIMITS.images, fields: 10, fieldSize: 32 * 1024 },
});

// ── 응답 형태 ────────────────────────────────────────────────────────
function listItem(p) {
  const imgs = parseImages(p.images);
  return {
    id: p.id, title: p.title, excerpt: p.content.slice(0, 140).replace(/\s+/g, ' '),
    author: p.author, thumb: imgs[0] ? `/uploads/${imgs[0]}` : null, image_count: imgs.length,
    views: p.views, likes: p.likes, comment_count: p.comment_count, created_at: p.created_at,
    board_slug: p.board_slug, board_name: p.board_name,
  };
}
function fullPost(p) {
  return {
    id: p.id, title: p.title, content: p.content, author: p.author,
    images: parseImages(p.images).map((n) => `/uploads/${n}`),
    views: p.views, likes: p.likes, comment_count: p.comment_count, created_at: p.created_at,
    board_slug: p.board_slug, board_name: p.board_name,
  };
}
const boardInfo = (b) => ({ slug: b.slug, name: b.name, system: !!b.system });
function getBoard(slug) {
  const b = q.boardBySlug.get(String(slug));
  if (!b) throw new HttpError(404, '없는 로예요.');
  return b;
}
function getPost(id) {
  const p = q.post.get(Number(id) || 0);
  if (!p) throw new HttpError(404, '삭제되었거나 없는 글이에요.');
  return p;
}
const randomSlug = () => Array.from({ length: 6 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[crypto.randomInt(32)]).join('');

// ── 앱 ─────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  });
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny', immutable: true, maxAge: '365d' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '32kb' }));

// 로 목록
app.get('/api/boards', (req, res) => {
  res.json({ boards: q.boards.all().map((b) => ({ ...boardInfo(b), post_count: b.post_count, last_post_at: b.last_post_at, created_at: b.created_at })) });
});

// 로 만들기 (유저로)
app.post('/api/boards', limit('board', 3), (req, res) => {
  const name = clean(req.body?.name, LIMITS.roName, { required: true, label: '로 이름을' }).replace(/\s+/g, ' ');
  if (name.length < 2) throw bad('로 이름은 2자 이상이어야 해요.');
  if (RESERVED.has(name)) throw bad('이미 있는 로 이름이에요.');
  for (let tries = 0; tries < 5; tries++) {
    const slug = randomSlug();
    try {
      q.insertBoard.run(slug, name, now());
      return res.status(201).json({ board: { slug, name, system: false } });
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
      if (q.boards.all().some((b) => b.name.toLowerCase() === name.toLowerCase())) throw bad('이미 있는 로 이름이에요.');
    }
  }
  throw new HttpError(500, '로를 만들지 못했어요. 다시 시도해 주세요.');
});

// 로 삭제 (운영자 비밀번호 필요, 기본 로는 삭제 불가)
app.delete('/api/boards/:slug', limit('delete', 20), (req, res) => {
  const b = getBoard(req.params.slug);
  if (b.system) throw new HttpError(403, '기본 로는 삭제할 수 없어요.');
  if (!isAdmin(req.body?.adminPassword)) throw new HttpError(403, '운영자 비밀번호가 맞지 않아요.');
  const images = q.boardImages.all(b.id).flatMap((r) => parseImages(r.images));
  q.deleteBoard.run(b.id);
  removeImages(images);
  res.json({ ok: true });
});

// 로의 글 목록
app.get('/api/boards/:slug/posts', (req, res) => {
  const b = getBoard(req.params.slug);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.listByBoard.all(b.id, before, PAGE_SIZE + 1);
  res.json({ board: boardInfo(b), posts: rows.slice(0, PAGE_SIZE).map(listItem), more: rows.length > PAGE_SIZE });
});

// 인기로
app.get('/api/hot', (req, res) => {
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = q.listHot.all(now() - HOT_DAYS * 86400, HOT_MIN, PAGE_SIZE + 1, offset);
  res.json({ posts: rows.slice(0, PAGE_SIZE).map(listItem), more: rows.length > PAGE_SIZE });
});

// 글 쓰기
app.post('/api/boards/:slug/posts', limit('post', 5), upload.array('images', LIMITS.images), async (req, res) => {
  const b = getBoard(req.params.slug);
  const body = req.body || {};
  const title = clean(body.title, LIMITS.title, { required: true, label: '제목을' });
  const content = clean(body.content, LIMITS.content, { required: true, label: '내용을' });
  const author = clean(body.author, LIMITS.author, { label: '작성자명은', fallback: '익명' });
  let pwHash;
  if (b.slug === 'notice') {
    if (!ADMIN_PASSWORD) throw new HttpError(403, '공지로 글쓰기가 설정되지 않았어요.');
    if (!isAdmin(body.adminPassword)) throw new HttpError(403, '운영자 비밀번호가 맞지 않아요.');
    pwHash = await hashPw(crypto.randomBytes(24).toString('hex')); // 공지는 운영자 비밀번호로만 삭제
  } else {
    pwHash = await hashPw(password(body.password));
  }
  const images = saveImages(req.files);
  try {
    const r = q.insertPost.run(b.id, title, content, author, JSON.stringify(images), pwHash, now());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (err) {
    removeImages(images);
    throw err;
  }
});

// 글 보기 (?view=1 이면 조회수 +1)
app.get('/api/posts/:id', (req, res) => {
  const id = Number(req.params.id) || 0;
  if (req.query.view === '1') q.addView.run(id);
  const p = getPost(id);
  res.json({ post: fullPost(p), comments: q.comments.all(p.id) });
});

// 글 삭제
app.delete('/api/posts/:id', limit('delete', 20), async (req, res) => {
  const p = getPost(req.params.id);
  if (!(await canDelete(req.body?.password, p.pw_hash))) throw new HttpError(403, '비밀번호가 맞지 않아요.');
  q.deletePost.run(p.id);
  removeImages(parseImages(p.images));
  res.json({ ok: true });
});

// 좋아요 / 취소 (중복 방지는 사용자 기기(localStorage)에서 처리 — 서버는 누가 눌렀는지 저장하지 않음)
app.post('/api/posts/:id/like', limit('like', 30), (req, res) => {
  const p = getPost(req.params.id);
  (req.body?.liked === false ? q.unlike : q.like).run(p.id);
  res.json({ likes: q.likes.get(p.id).likes });
});

// 댓글 쓰기
const addComment = db.transaction((postId, author, content, pwHash) => {
  const r = q.insertComment.run(postId, author, content, pwHash, now());
  q.incComments.run(postId);
  return Number(r.lastInsertRowid);
});
app.post('/api/posts/:id/comments', limit('comment', 10), async (req, res) => {
  const p = getPost(req.params.id);
  const body = req.body || {};
  const content = clean(body.content, LIMITS.comment, { required: true, label: '댓글을' });
  const author = clean(body.author, LIMITS.author, { label: '작성자명은', fallback: '익명' });
  const pwHash = await hashPw(password(body.password));
  const id = addComment(p.id, author, content, pwHash);
  const c = q.comment.get(id);
  res.status(201).json({ comment: { id: c.id, author: c.author, content: c.content, created_at: c.created_at } });
});

// 댓글 삭제
const removeComment = db.transaction((c) => { q.deleteComment.run(c.id); q.decComments.run(c.post_id); });
app.delete('/api/comments/:id', limit('delete', 20), async (req, res) => {
  const c = q.comment.get(Number(req.params.id) || 0);
  if (!c) throw new HttpError(404, '이미 삭제된 댓글이에요.');
  if (!(await canDelete(req.body?.password, c.pw_hash))) throw new HttpError(403, '비밀번호가 맞지 않아요.');
  removeComment(c);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소예요.' }));

// 오류 응답 (요청자 정보는 기록하지 않음)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `사진은 한 장에 ${LIMITS.imageMB}MB까지 올릴 수 있어요.`
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `사진은 ${LIMITS.images}장까지 올릴 수 있어요.`
      : '보낸 내용이 너무 커요.';
    return res.status(400).json({ error: msg });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '보낸 내용이 너무 커요.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' });
  const status = err.status || 500;
  if (status >= 500) console.error('[MIST] error:', err.message);
  res.status(status).json({ error: status >= 500 ? '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' : err.message });
});

const server = app.listen(PORT, () => console.log(`[MIST] http://localhost:${PORT}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
