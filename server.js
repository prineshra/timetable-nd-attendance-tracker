const dotenvResult = require('dotenv').config({
  path: require('node:path').join(__dirname, '.env')
});
if (dotenvResult.error) {
  console.warn('Could not load .env:', dotenvResult.error.message);
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SECRET =
  process.env.JWT_SECRET ||
  'local-development-secret-change-before-deployment';

if (!process.env.JWT_SECRET) {
  console.warn('Warning: Set JWT_SECRET in .env before using real accounts.');
}
if (!process.env.FACULTY_CODE) {
  console.warn('Warning: Set FACULTY_CODE in .env, otherwise the built-in fallback code is used.');
}

// Behind a proxy (Nginx, Render, etc.) set TRUST_PROXY=1 so req.ip is the real client IP.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tracker.db'));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student','faculty'))
  );

  -- Faculty subjects are class subjects (students join them with a join code).
  -- Student subjects are personal. A code only has to be unique per owner.
  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    faculty TEXT DEFAULT '',
    target REAL DEFAULT 75,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(code, owner_id)
  );

  CREATE TABLE IF NOT EXISTS timetable (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    room TEXT DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );

  -- History of faculty timetable changes, shown to enrolled students.
  CREATE TABLE IF NOT EXISTS timetable_changes (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('added','updated','removed')),
    summary TEXT NOT NULL,
    changed_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Remembers the last change each student has seen.
  CREATE TABLE IF NOT EXISTS change_seen (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_id INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    class_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('present','absent')),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recorded_by INTEGER,
    UNIQUE(subject_id, class_date, user_id)
  );

  -- Students who joined a class subject.
  CREATE TABLE IF NOT EXISTS enrollments (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(subject_id, user_id)
  );

  -- Optional verified class list. If a subject has any rows here,
  -- only these emails can join it.
  CREATE TABLE IF NOT EXISTS roster (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    PRIMARY KEY(subject_id, email)
  );

  -- A live class. The rotating 6-digit code is derived from "secret".
  CREATE TABLE IF NOT EXISTS live_sessions (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    secret TEXT NOT NULL,
    class_date TEXT NOT NULL,
    lat REAL,
    lng REAL,
    ended INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    action TEXT,
    detail TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Upgrade older databases: add the join_code column.
try { db.exec('ALTER TABLE subjects ADD COLUMN join_code TEXT'); } catch { /* already there */ }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subject_join_code ON subjects(join_code)');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const query = sql => db.prepare(sql);
const clean = (value, max = 120) =>
  String(value ?? '').trim().slice(0, max);

function newJoinCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (query('SELECT 1 FROM subjects WHERE join_code = ?').get(code));
  return code;
}

// Give every existing faculty subject a join code.
for (const s of query(`
  SELECT s.id FROM subjects s JOIN users u ON u.id = s.owner_id
  WHERE s.join_code IS NULL AND u.role = 'faculty'
`).all()) {
  query('UPDATE subjects SET join_code = ? WHERE id = ?').run(newJoinCode(), s.id);
}

const days = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday'
];

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function validSlot(day, start, end) {
  return days.includes(day) &&
    timePattern.test(start || '') &&
    timePattern.test(end || '') &&
    start < end;
}

const describe = t =>
  `${t.day} ${t.start_time}–${t.end_time}${t.room ? ' · ' + t.room : ''}`;

function log(userId, action, detail = '') {
  query(
    'INSERT INTO audit(user_id, action, detail) VALUES (?, ?, ?)'
  ).run(userId, action, String(detail).slice(0, 200));
}

function recordChange(subjectId, action, summary, userId) {
  query(`
    INSERT INTO timetable_changes(subject_id, action, summary, changed_by)
    VALUES(?,?,?,?)
  `).run(subjectId, action, String(summary).slice(0, 300), userId);
}

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw new Error();

    req.user = jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in again.' });
  }
}

function role(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: 'This action is not allowed for your role.'
      });
    }
    next();
  };
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === date;
}

// Server-side local date, so students cannot choose the class date.
const localDate = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);

/* ---------------------------------------------------------------
   Live class helpers
   --------------------------------------------------------------- */

const SLOT = 20000; // the code changes every 20 seconds

function codeFor(secret, slot) {
  const h = crypto.createHmac('sha256', secret).update(String(slot)).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

const currentCode = s => codeFor(s.secret, Math.floor(Date.now() / SLOT));

// Accept the current slot and the previous one (typing delay).
function codeValid(s, code) {
  const n = Math.floor(Date.now() / SLOT);
  return [n, n - 1].some(k => codeFor(s.secret, k) === code);
}

// 5 wrong codes -> locked for 5 minutes.
const fails = new Map();
const isLocked = id => (fails.get(id)?.until || 0) > Date.now();
function noteFail(id) {
  const f = fails.get(id) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) {
    f.until = Date.now() + 5 * 60000;
    f.n = 0;
  }
  fails.set(id, f);
}

// Campus network check. In .env: CAMPUS_NETS=10.20.,192.168.4.
// Leave empty to disable. For local testing use CAMPUS_NETS=127.,::1
const CAMPUS_NETS = (process.env.CAMPUS_NETS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const onCampusNet = ip =>
  !CAMPUS_NETS.length ||
  CAMPUS_NETS.some(p => String(ip).replace('::ffff:', '').startsWith(p));

// Distance check (metres) between the teacher's phone/laptop and the student.
const MAX_METRES = Number(process.env.MAX_METRES) || 150;

function metres(lat1, lng1, lat2, lng2) {
  const r = x => x * Math.PI / 180;
  const h = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) *
    Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const hasNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

app.get('/api/status', (req, res) => {
  res.json({ message: 'CampusTrack API is running.' });
});

// ---------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 150).toLowerCase();
  const password = String(req.body.password || '');
  const userRole = req.body.role;

  if (
    !name ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8 ||
    !['student', 'faculty'].includes(userRole)
  ) {
    return res.status(400).json({
      error: 'Enter valid details and a password of at least 8 characters.'
    });
  }

  // Optional: only allow college emails, e.g. ALLOWED_EMAIL_DOMAIN=sathyabama.ac.in
  const domain = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
  if (domain && !email.endsWith('@' + domain)) {
    return res.status(400).json({
      error: `Use your college email (@${domain}).`
    });
  }

  // Only people who know the secret code can register as faculty.
  // The fallback keeps sign-up working if .env is not loaded; remove it before deployment.
  if (userRole === 'faculty') {
    const facultyKey = process.env.FACULTY_CODE || 'mySecret2026';
    if (clean(req.body.faculty_code, 60) !== facultyKey) {
      return res.status(403).json({
        error: 'Invalid faculty access code.'
      });
    }
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = query(
      'INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)'
    ).run(name, email, hash, userRole);

    const user = {
      id: Number(result.lastInsertRowid),
      name,
      email,
      role: userRole
    };

    // New students start with no "new" timetable updates.
    if (userRole === 'student') {
      query(`
        INSERT OR IGNORE INTO change_seen(user_id, last_id)
        VALUES(?, (SELECT COALESCE(MAX(id), 0) FROM timetable_changes))
      `).run(user.id);
    }

    log(user.id, 'register');
    res.status(201).json({
      user,
      token: jwt.sign(user, SECRET, { expiresIn: '8h' })
    });
  } catch {
    res.status(400).json({
      error: 'Email already exists or account could not be created.'
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = clean(req.body.email, 150).toLowerCase();
  const password = String(req.body.password || '');

  const userRecord = query(
    'SELECT * FROM users WHERE email = ?'
  ).get(email);

  if (
    !userRecord ||
    !await bcrypt.compare(password, userRecord.password_hash)
  ) {
    return res.status(401).json({
      error: 'Incorrect email or password.'
    });
  }

  const user = {
    id: userRecord.id,
    name: userRecord.name,
    email: userRecord.email,
    role: userRecord.role
  };

  log(user.id, 'login');
  res.json({
    user,
    token: jwt.sign(user, SECRET, { expiresIn: '8h' })
  });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------
// Subjects
// Faculty see their own subjects with class-wide totals and the join code.
// Students see their own subjects (mine = 1) plus the class subjects
// they have joined (mine = 0), with their own attendance.
// ---------------------------------------------------------------
app.get('/api/subjects', auth, (req, res) => {
  const faculty = req.user.role === 'faculty';

  const subjects = faculty
    ? query(`
        SELECT s.*, 1 AS mine,
          SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS attended,
          COUNT(a.id) AS conducted
        FROM subjects s
        LEFT JOIN attendance a ON a.subject_id = s.id
        WHERE s.owner_id = ?
        GROUP BY s.id
        ORDER BY s.name
      `).all(req.user.id)
    : query(`
        SELECT s.*, (s.owner_id = ?) AS mine,
          SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS attended,
          COUNT(a.id) AS conducted
        FROM subjects s
        LEFT JOIN attendance a
          ON a.subject_id = s.id AND a.user_id = ?
        WHERE s.owner_id = ?
           OR s.id IN (SELECT subject_id FROM enrollments WHERE user_id = ?)
        GROUP BY s.id
        ORDER BY s.name
      `).all(req.user.id, req.user.id, req.user.id, req.user.id);

  res.json(subjects.map(s => ({
    ...s,
    // Students never see the join code.
    join_code: faculty ? s.join_code : undefined,
    mine: Boolean(s.mine),
    attended: s.attended || 0,
    conducted: s.conducted || 0,
    percentage: s.conducted
      ? Math.round(s.attended / s.conducted * 100)
      : 0
  })));
});

// Add a subject (faculty or student). Timing is optional and only used for
// faculty: if a day and times are given, the first timetable entry is created too.
// Students cannot create timetable entries.
app.post('/api/subjects', auth, (req, res) => {
  const name = clean(req.body.name, 100);
  const code = clean(req.body.code, 20).toUpperCase();
  const target = Number(req.body.target || 75);
  const faculty = clean(req.body.faculty, 100);

  const day = clean(req.body.day, 12);
  const start_time = clean(req.body.start_time, 5);
  const end_time = clean(req.body.end_time, 5);
  const room = clean(req.body.room, 50);
  const hasSlot = req.user.role === 'faculty' && Boolean(day || start_time || end_time);

  if (!name || !code || !(target >= 1 && target <= 100)) {
    return res.status(400).json({
      error: 'Enter a subject, code and target between 1 and 100.'
    });
  }

  if (hasSlot && !validSlot(day, start_time, end_time)) {
    return res.status(400).json({
      error: 'Fill day, start time and end time correctly, or leave timing empty.'
    });
  }

  // Faculty codes must be unique among faculty.
  if (req.user.role === 'faculty') {
    const taken = query(`
      SELECT s.id FROM subjects s
      JOIN users u ON u.id = s.owner_id
      WHERE s.code = ? AND u.role = 'faculty'
    `).get(code);

    if (taken) {
      return res.status(400).json({ error: 'Subject code already exists.' });
    }
  }

  let subjectId;

  try {
    db.exec('BEGIN');

    const result = query(`
      INSERT INTO subjects(name,code,faculty,target,owner_id)
      VALUES(?,?,?,?,?)
    `).run(name, code, faculty, target, req.user.id);

    subjectId = Number(result.lastInsertRowid);

    // Class subjects get a join code for students.
    if (req.user.role === 'faculty') {
      query('UPDATE subjects SET join_code = ? WHERE id = ?')
        .run(newJoinCode(), subjectId);
    }

    if (hasSlot) {
      const clash = room && query(`
        SELECT id FROM timetable
        WHERE owner_id=? AND day=? AND start_time < ? AND end_time > ?
          AND room=?
      `).get(req.user.id, day, end_time, start_time, room);

      if (clash) throw new Error('CLASH');

      query(`
        INSERT INTO timetable
          (subject_id,day,start_time,end_time,room,owner_id)
        VALUES(?,?,?,?,?,?)
      `).run(subjectId, day, start_time, end_time, room, req.user.id);

      recordChange(
        subjectId, 'added',
        describe({ day, start_time, end_time, room }),
        req.user.id
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    if (err.message === 'CLASH') {
      return res.status(409).json({
        error: 'That room is already used at this time.'
      });
    }
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({
        error: 'You already have a subject with this code.'
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'Could not add the subject.' });
  }

  log(req.user.id, 'subject_created', code);

  res.status(201).json(query(
    'SELECT * FROM subjects WHERE id = ?'
  ).get(subjectId));
});

// Delete a subject you own.
app.delete('/api/subjects/:id', auth, (req, res) => {
  const result = query(
    'DELETE FROM subjects WHERE id=? AND owner_id=?'
  ).run(Number(req.params.id), req.user.id);

  result.changes
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'Subject not found.' });
});

// Student joins a class subject with the faculty's join code.
app.post('/api/subjects/join', auth, role('student'), (req, res) => {
  const joinCode = clean(req.body.join_code, 12).toUpperCase();

  const subject = query(`
    SELECT s.id FROM subjects s
    JOIN users u ON u.id = s.owner_id
    WHERE s.join_code = ? AND u.role = 'faculty'
  `).get(joinCode);

  if (!joinCode || !subject) {
    return res.status(400).json({ error: 'Invalid join code.' });
  }

  // If faculty uploaded a class list, only listed emails may join.
  const listed = query(
    'SELECT COUNT(*) AS n FROM roster WHERE subject_id = ?'
  ).get(subject.id).n;

  if (listed && !query(
    'SELECT 1 FROM roster WHERE subject_id = ? AND email = ?'
  ).get(subject.id, req.user.email)) {
    return res.status(403).json({
      error: 'Your email is not on the class list for this subject.'
    });
  }

  query(
    'INSERT OR IGNORE INTO enrollments(subject_id, user_id) VALUES(?, ?)'
  ).run(subject.id, req.user.id);

  log(req.user.id, 'joined_subject', subject.id);
  res.json({ ok: true });
});

// Faculty uploads the verified class list (emails).
app.post('/api/subjects/:id/roster', auth, role('faculty'), (req, res) => {
  const id = Number(req.params.id);

  if (!query(
    'SELECT id FROM subjects WHERE id=? AND owner_id=?'
  ).get(id, req.user.id)) {
    return res.status(404).json({ error: 'Subject not found.' });
  }

  const emails = (Array.isArray(req.body.emails) ? req.body.emails : [])
    .map(e => clean(e, 150).toLowerCase())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    .slice(0, 1000);

  if (!emails.length) {
    return res.status(400).json({ error: 'Enter at least one valid email.' });
  }

  const add = query(
    'INSERT OR IGNORE INTO roster(subject_id, email) VALUES(?, ?)'
  );

  try {
    db.exec('BEGIN');
    emails.forEach(e => add.run(id, e));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Could not save the class list.' });
  }

  log(req.user.id, 'roster_updated', `${id} (${emails.length})`);
  res.json({ ok: true, added: emails.length });
});

// Faculty: enrolled students with their percentage; flags those below target.
app.get('/api/subjects/:id/students', auth, role('faculty'), (req, res) => {
  const id = Number(req.params.id);
  const subject = query(
    'SELECT target FROM subjects WHERE id=? AND owner_id=?'
  ).get(id, req.user.id);

  if (!subject) {
    return res.status(404).json({ error: 'Subject not found.' });
  }

  const rows = query(`
    SELECT u.id, u.name, u.email,
      SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS attended,
      COUNT(a.id) AS conducted
    FROM enrollments e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN attendance a
      ON a.subject_id = e.subject_id AND a.user_id = u.id
    WHERE e.subject_id = ?
    GROUP BY u.id
    ORDER BY u.name
  `).all(id);

  res.json(rows.map(r => {
    const attended = r.attended || 0;
    const conducted = r.conducted || 0;
    const percentage = conducted ? Math.round(attended / conducted * 100) : 0;
    return {
      ...r,
      attended,
      conducted,
      percentage,
      below: conducted > 0 && percentage < subject.target
    };
  }));
});

// ---------------------------------------------------------------
// Timetable
// Only faculty can add, edit or delete timetable entries.
// Students see only the entries of class subjects they have joined.
// ---------------------------------------------------------------
const dayOrder = `
  CASE t.day
    WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2
    WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4
    WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
    ELSE 7
  END
`;

app.get('/api/timetable', auth, (req, res) => {
  const rows = req.user.role === 'faculty'
    ? query(`
        SELECT t.*, s.name AS subject_name, s.code, 1 AS mine
        FROM timetable t
        JOIN subjects s ON s.id = t.subject_id
        WHERE t.owner_id = ?
        ORDER BY ${dayOrder}, t.start_time
      `).all(req.user.id)
    : query(`
        SELECT t.*, s.name AS subject_name, s.code, 0 AS mine
        FROM timetable t
        JOIN subjects s ON s.id = t.subject_id
        WHERE t.subject_id IN (
          SELECT subject_id FROM enrollments WHERE user_id = ?
        )
        ORDER BY ${dayOrder}, t.start_time
      `).all(req.user.id);

  res.json(rows.map(r => ({ ...r, mine: Boolean(r.mine) })));
});

// Student: recent timetable changes for joined subjects.
app.get('/api/timetable/changes', auth, role('student'), (req, res) => {
  const rows = query(`
    SELECT c.id, c.action, c.summary, c.created_at,
           s.name AS subject_name, s.code,
           (c.id > COALESCE(
             (SELECT last_id FROM change_seen WHERE user_id = ?), 0
           )) AS is_new
    FROM timetable_changes c
    JOIN subjects s ON s.id = c.subject_id
    WHERE c.subject_id IN (
      SELECT subject_id FROM enrollments WHERE user_id = ?
    )
    ORDER BY c.id DESC
    LIMIT 50
  `).all(req.user.id, req.user.id);

  res.json(rows.map(r => ({ ...r, is_new: Boolean(r.is_new) })));
});

// Student: mark all changes as seen.
app.post('/api/timetable/changes/seen', auth, role('student'), (req, res) => {
  query(`
    INSERT INTO change_seen(user_id, last_id)
    VALUES(?, (SELECT COALESCE(MAX(id), 0) FROM timetable_changes))
    ON CONFLICT(user_id) DO UPDATE SET last_id = excluded.last_id
  `).run(req.user.id);

  res.json({ ok: true });
});

app.post('/api/timetable', auth, role('faculty'), (req, res) => {
  const subjectId = Number(req.body.subject_id);
  const { day, start_time, end_time } = req.body;
  const room = clean(req.body.room, 50);

  const subject = query(
    'SELECT id, name, code FROM subjects WHERE id=? AND owner_id=?'
  ).get(subjectId, req.user.id);

  if (!subject || !validSlot(day, start_time, end_time)) {
    return res.status(400).json({
      error: 'Check subject, day and time.'
    });
  }

  const clash = query(`
    SELECT id FROM timetable
    WHERE owner_id=? AND day=?
      AND start_time < ? AND end_time > ?
      AND (room=? OR subject_id=?)
  `).get(
    req.user.id, day, end_time, start_time, room, subjectId
  );

  if (clash) {
    return res.status(409).json({
      error: 'Room or subject timetable clash detected.'
    });
  }

  const result = query(`
    INSERT INTO timetable
      (subject_id,day,start_time,end_time,room,owner_id)
    VALUES(?,?,?,?,?,?)
  `).run(
    subjectId, day, start_time, end_time, room, req.user.id
  );

  recordChange(
    subject.id, 'added',
    describe({ day, start_time, end_time, room }),
    req.user.id
  );

  res.status(201).json(query(
    'SELECT * FROM timetable WHERE id=?'
  ).get(Number(result.lastInsertRowid)));
});

// Edit one of your timetable entries (faculty only).
app.put('/api/timetable/:id', auth, role('faculty'), (req, res) => {
  const id = Number(req.params.id);
  const { day, start_time, end_time } = req.body;
  const room = clean(req.body.room, 50);

  const entry = query(
    'SELECT * FROM timetable WHERE id=? AND owner_id=?'
  ).get(id, req.user.id);

  if (!entry) {
    return res.status(404).json({ error: 'Entry not found.' });
  }

  if (!validSlot(day, start_time, end_time)) {
    return res.status(400).json({ error: 'Check day and time.' });
  }

  const clash = query(`
    SELECT id FROM timetable
    WHERE owner_id=? AND day=? AND id<>?
      AND start_time < ? AND end_time > ?
      AND (room=? OR subject_id=?)
  `).get(
    req.user.id, day, id, end_time, start_time, room, entry.subject_id
  );

  if (clash) {
    return res.status(409).json({
      error: 'Room or subject timetable clash detected.'
    });
  }

  const before = describe(entry);
  const after = describe({ day, start_time, end_time, room });

  query(`
    UPDATE timetable
    SET day=?, start_time=?, end_time=?, room=?
    WHERE id=? AND owner_id=?
  `).run(day, start_time, end_time, room, id, req.user.id);

  if (before !== after) {
    recordChange(
      entry.subject_id, 'updated', `${before} → ${after}`, req.user.id
    );
  }

  res.json({ ok: true });
});

// Delete a timetable entry (faculty only).
app.delete('/api/timetable/:id', auth, role('faculty'), (req, res) => {
  const id = Number(req.params.id);

  const entry = query(
    'SELECT * FROM timetable WHERE id=? AND owner_id=?'
  ).get(id, req.user.id);

  if (!entry) {
    return res.status(404).json({ error: 'Entry not found.' });
  }

  query('DELETE FROM timetable WHERE id=? AND owner_id=?')
    .run(id, req.user.id);

  recordChange(entry.subject_id, 'removed', describe(entry), req.user.id);

  res.json({ ok: true });
});

// ---------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------
app.get('/api/attendance', auth, (req, res) => {
  if (req.user.role === 'faculty') {
    return res.json(query(`
      SELECT a.*, s.name AS subject_name, s.code,
             u.name AS student_name, u.email AS student_email
      FROM attendance a
      JOIN subjects s ON s.id = a.subject_id
      JOIN users u ON u.id = a.user_id
      WHERE s.owner_id = ?
      ORDER BY a.class_date DESC, u.name
    `).all(req.user.id));
  }

  res.json(query(`
    SELECT a.*, s.name AS subject_name, s.code
    FROM attendance a
    JOIN subjects s ON s.id = a.subject_id
    WHERE a.user_id = ?
    ORDER BY a.class_date DESC
  `).all(req.user.id));
});

// Faculty: students enrolled in any of their subjects.
app.get('/api/students', auth, role('faculty'), (req, res) => {
  res.json(query(`
    SELECT DISTINCT u.id, u.name, u.email
    FROM users u
    JOIN enrollments e ON e.user_id = u.id
    JOIN subjects s ON s.id = e.subject_id
    WHERE s.owner_id = ?
    ORDER BY u.name
  `).all(req.user.id));
});

// Faculty marks / corrects an enrolled student's status for one subject.
app.post('/api/attendance', auth, role('faculty'), (req, res) => {
  const subjectId = Number(req.body.subject_id);
  const date = clean(req.body.class_date, 10);

  const records = Array.isArray(req.body.records)
    ? req.body.records
    : [{ student_id: req.body.student_id, status: req.body.status }];

  if (
    !validDate(date) ||
    !records.length ||
    records.length > 500 ||
    !query(
      'SELECT id FROM subjects WHERE id=? AND owner_id=?'
    ).get(subjectId, req.user.id)
  ) {
    return res.status(400).json({
      error: 'Check subject, date and students.'
    });
  }

  const cleaned = records.map(r => ({
    studentId: Number(r.student_id),
    status: r.status
  }));

  const isEnrolled = query(
    'SELECT 1 FROM enrollments WHERE subject_id=? AND user_id=?'
  );

  if (cleaned.some(r =>
    !['present', 'absent'].includes(r.status) ||
    !isEnrolled.get(subjectId, r.studentId)
  )) {
    return res.status(400).json({
      error: 'Select a student enrolled in this subject and a present/absent status.'
    });
  }

  const save = query(`
    INSERT INTO attendance
      (subject_id,class_date,status,user_id,recorded_by)
    VALUES(?,?,?,?,?)
    ON CONFLICT(subject_id, class_date, user_id)
    DO UPDATE SET status = excluded.status,
                  recorded_by = excluded.recorded_by
  `);

  try {
    db.exec('BEGIN');
    for (const r of cleaned) {
      save.run(subjectId, date, r.status, r.studentId, req.user.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error(error);
    return res.status(500).json({
      error: 'Could not save attendance.'
    });
  }

  log(
    req.user.id,
    'attendance_recorded',
    `${subjectId} ${date} (${cleaned.length} student(s))`
  );
  res.status(201).json({ ok: true, saved: cleaned.length });
});

// Student logs attendance for one of their OWN (personal) subjects.
app.post('/api/attendance/own', auth, role('student'), (req, res) => {
  const subjectId = Number(req.body.subject_id);
  const date = clean(req.body.class_date, 10);
  const status = req.body.status;

  if (
    !validDate(date) ||
    !['present', 'absent'].includes(status) ||
    !query(
      'SELECT id FROM subjects WHERE id=? AND owner_id=?'
    ).get(subjectId, req.user.id)
  ) {
    return res.status(400).json({
      error: 'Choose one of your own subjects, a date and a status.'
    });
  }

  query(`
    INSERT INTO attendance
      (subject_id,class_date,status,user_id,recorded_by)
    VALUES(?,?,?,?,?)
    ON CONFLICT(subject_id, class_date, user_id)
    DO UPDATE SET status = excluded.status,
                  recorded_by = excluded.recorded_by
  `).run(subjectId, date, status, req.user.id, req.user.id);

  res.status(201).json({ ok: true });
});

// ---------------------------------------------------------------
// Live class: rotating code, check-in, auto-absent
// ---------------------------------------------------------------

// Faculty: live classes that are still running (so the page can resume after a refresh).
app.get('/api/live/active', auth, role('faculty'), (req, res) => {
  res.json(query(`
    SELECT id, subject_id FROM live_sessions
    WHERE owner_id = ? AND ended = 0
    ORDER BY id DESC
  `).all(req.user.id));
});

// Faculty starts a live class. lat/lng (optional) is the classroom position.
app.post('/api/live/start', auth, role('faculty'), (req, res) => {
  const subjectId = Number(req.body.subject_id);

  if (!query(
    'SELECT id FROM subjects WHERE id=? AND owner_id=?'
  ).get(subjectId, req.user.id)) {
    return res.status(404).json({ error: 'Subject not found.' });
  }

  if (query(
    'SELECT id FROM live_sessions WHERE subject_id=? AND ended=0'
  ).get(subjectId)) {
    return res.status(409).json({
      error: 'A class is already live for this subject. End it first.'
    });
  }

  const hasLoc = hasNum(req.body.lat) && hasNum(req.body.lng);

  const result = query(`
    INSERT INTO live_sessions(subject_id, owner_id, secret, class_date, lat, lng)
    VALUES(?,?,?,?,?,?)
  `).run(
    subjectId,
    req.user.id,
    crypto.randomBytes(16).toString('hex'),
    localDate(),
    hasLoc ? Number(req.body.lat) : null,
    hasLoc ? Number(req.body.lng) : null
  );

  log(req.user.id, 'live_started', subjectId);
  res.status(201).json({
    id: Number(result.lastInsertRowid),
    location: hasLoc
  });
});

// Faculty screen polls this to show the current code.
app.get('/api/live/:id/code', auth, role('faculty'), (req, res) => {
  const s = query(
    'SELECT * FROM live_sessions WHERE id=? AND owner_id=? AND ended=0'
  ).get(Number(req.params.id), req.user.id);

  if (!s) return res.status(404).json({ error: 'Class is not live.' });

  const checkedIn = query(`
    SELECT COUNT(*) AS n FROM attendance
    WHERE subject_id=? AND class_date=? AND status='present'
  `).get(s.subject_id, s.class_date).n;

  const enrolled = query(
    'SELECT COUNT(*) AS n FROM enrollments WHERE subject_id=?'
  ).get(s.subject_id).n;

  res.json({
    code: currentCode(s),
    secondsLeft: Math.ceil((SLOT - Date.now() % SLOT) / 1000),
    checkedIn,
    enrolled
  });
});

// Faculty ends the class: enrolled students without a record become absent.
app.post('/api/live/:id/end', auth, role('faculty'), (req, res) => {
  const s = query(
    'SELECT * FROM live_sessions WHERE id=? AND owner_id=? AND ended=0'
  ).get(Number(req.params.id), req.user.id);

  if (!s) return res.status(404).json({ error: 'Class is not live.' });

  let absent = 0;

  try {
    db.exec('BEGIN');

    absent = Number(query(`
      INSERT OR IGNORE INTO attendance
        (subject_id, class_date, status, user_id, recorded_by)
      SELECT e.subject_id, ?, 'absent', e.user_id, ?
      FROM enrollments e
      WHERE e.subject_id = ?
    `).run(s.class_date, req.user.id, s.subject_id).changes);

    query('UPDATE live_sessions SET ended = 1 WHERE id = ?').run(s.id);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Could not end the class.' });
  }

  log(req.user.id, 'live_ended', `${s.subject_id} absent=${absent}`);
  res.json({ ok: true, absent });
});

// Student types the live code. The date comes from the server.
app.post('/api/live/check-in', auth, role('student'), (req, res) => {
  if (isLocked(req.user.id)) {
    return res.status(429).json({
      error: 'Too many wrong codes. Try again in 5 minutes.'
    });
  }

  const code = clean(req.body.code, 6);

  // Only live classes of subjects this student has joined.
  const live = query(`
    SELECT l.* FROM live_sessions l
    JOIN enrollments e ON e.subject_id = l.subject_id
    WHERE l.ended = 0 AND e.user_id = ?
  `).all(req.user.id);

  const hit = live.find(l => codeValid(l, code));

  if (!hit) {
    noteFail(req.user.id);
    return res.status(400).json({ error: 'Wrong or expired code.' });
  }

  if (!onCampusNet(req.ip)) {
    return res.status(403).json({
      error: 'Connect to the campus network to mark attendance.'
    });
  }

  if (hit.lat !== null && hit.lng !== null) {
    if (!hasNum(req.body.lat) || !hasNum(req.body.lng)) {
      return res.status(400).json({
        error: 'Allow location access to mark attendance.'
      });
    }
    const away = metres(
      hit.lat, hit.lng, Number(req.body.lat), Number(req.body.lng)
    );
    if (away > MAX_METRES) {
      return res.status(403).json({
        error: 'You are not in the classroom area.'
      });
    }
  }

  query(`
    INSERT INTO attendance
      (subject_id, class_date, status, user_id, recorded_by)
    VALUES (?, ?, 'present', ?, ?)
    ON CONFLICT(subject_id, class_date, user_id) DO NOTHING
  `).run(hit.subject_id, hit.class_date, req.user.id, hit.owner_id);

  log(req.user.id, 'live_checkin', hit.subject_id);
  res.json({ ok: true });
});

// Audit log
app.get('/api/audit', auth, role('faculty'), (req, res) => {
  res.json(query(`
    SELECT action,detail,created_at
    FROM audit
    WHERE user_id=?
    ORDER BY id DESC
    LIMIT 100
  `).all(req.user.id));
});

// Unknown API routes should return JSON, not the frontend page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Frontend fallback (Express 5 compatible)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handles bad JSON bodies and unexpected errors.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`CampusTrack running at http://localhost:${PORT}`);
});