const $ = id => document.getElementById(id);

const DAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday'
];

const S = {
  token: localStorage.getItem('ct_token') || '',
  user: JSON.parse(localStorage.getItem('ct_user') || 'null'),
  subjects: [],
  students: [],
  tt: [],
  changes: [],
  chart: null,
  mode: 'login',
  dayFilter: 'All',
  editId: null
};

/* ---------------- Extra panels (created here if index.html lacks them) ---------------- */

function ensureUI() {
  const page = $('subjects');
  if (!page) return;

  // Student: join a class subject with the faculty's join code
  if (!$('enrollForm')) {
    page.insertAdjacentHTML('afterbegin', `
      <section class="panel hidden" id="enrollPanel">
        <h3>Join a class subject</h3>
        <p class="muted">Enter the join code given by your faculty.</p>
        <form id="enrollForm">
          <input id="joinCode" placeholder="Join code" maxlength="12" autocomplete="off" required>
          <button type="submit">Join subject</button>
        </form>
      </section>`);
  }

  // Faculty: class list (verified emails) + student percentages
  if (!$('rosterForm')) {
    page.insertAdjacentHTML('afterbegin', `
      <section class="panel hidden" id="rosterPanel">
        <h3>Class list (optional)</h3>
        <p class="muted">Paste student emails. Once a list exists, only these emails can join the subject.</p>
        <form id="rosterForm">
          <select id="rosterSubject" required></select>
          <textarea id="rosterEmails" rows="4" placeholder="one email per line, or separated by commas" required></textarea>
          <button type="submit">Save class list</button>
        </form>
      </section>
      <section class="panel hidden" id="studentsPanel">
        <h3>Enrolled students</h3>
        <div id="studentStats"><p class="muted">Press "Students" on a subject card to see each student's percentage.</p></div>
      </section>`);
  }

  // Faculty: end the live class
  if (!$('endLive') && $('generated')) {
    $('generated').insertAdjacentHTML('afterend',
      '<button type="button" id="endLive" class="del hidden">End class &amp; mark absentees</button>');
  }
}

ensureUI();

// Local date (not UTC) so the date is right late at night / early morning.
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);
['attDate', 'joinDate', 'logDate'].forEach(id => { if ($(id)) $(id).value = today; });

const isFaculty = () => S.user && S.user.role === 'faculty';
const todayName = () => DAYS[(new Date().getDay() + 6) % 7];
const byStart = (a, b) => a.start_time.localeCompare(b.start_time);

function esc(x) {
  return String(x ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function notice(msg, err = false) {
  $('notice').textContent = msg;
  $('notice').classList.remove('hidden', 'error');
  if (err) $('notice').classList.add('error');
  setTimeout(() => $('notice').classList.add('hidden'), 4500);
}

async function api(url, opts = {}) {
  let h = { ...(opts.headers || {}) };
  if (S.token) h.Authorization = 'Bearer ' + S.token;
  if (opts.body) h['Content-Type'] = 'application/json';
  let r = await fetch(url, { ...opts, headers: h });
  let d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}

const post = (url, data) =>
  api(url, { method: 'POST', body: JSON.stringify(data) });

// Current position (used for the classroom distance check). Resolves {} if denied.
const getPos = () => new Promise(done =>
  navigator.geolocation
    ? navigator.geolocation.getCurrentPosition(
        p => done({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => done({}),
        { enableHighAccuracy: true, timeout: 8000 })
    : done({}));

/* ---------------- Sign in / sign up ---------------- */

function updateCode() {
  $('codeWrap').classList.toggle(
    'hidden',
    !(S.mode === 'register' && $('role').value === 'faculty')
  );
}

function mode(m) {
  S.mode = m;
  $('nameWrap').classList.toggle('hidden', m !== 'register');
  $('roleWrap').classList.toggle('hidden', m !== 'register');
  $('name').required = m === 'register';
  $('loginTab').classList.toggle('active', m === 'login');
  $('regTab').classList.toggle('active', m === 'register');
  $('authMsg').textContent = '';
  updateCode();
}

$('role').onchange = updateCode;
$('loginTab').onclick = () => mode('login');
$('regTab').onclick = () => mode('register');

$('authForm').onsubmit = async e => {
  e.preventDefault();
  try {
    let d = await post('/api/auth/' + (S.mode === 'login' ? 'login' : 'register'), {
      name: $('name').value,
      email: $('email').value,
      password: $('password').value,
      role: $('role').value,
      faculty_code: $('facultyCode').value
    });
    S.token = d.token;
    S.user = d.user;
    localStorage.setItem('ct_token', S.token);
    localStorage.setItem('ct_user', JSON.stringify(S.user));
    await enter();
  } catch (x) {
    $('authMsg').textContent = x.message;
  }
};

$('logout').onclick = () => {
  stopLive();
  S.token = '';
  S.user = null;
  S.subjects = [];
  S.students = [];
  S.tt = [];
  S.changes = [];
  S.dayFilter = 'All';
  resetTTForm();
  localStorage.removeItem('ct_token');
  localStorage.removeItem('ct_user');
  if (S.chart) S.chart.destroy();
  $('generated').innerHTML = '';
  $('studentStats').innerHTML = '';
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  mode('login');
};

/* ---------------- Enter the app ---------------- */

async function enter() {
  if (!S.token) {
    $('auth').classList.remove('hidden');
    return;
  }
  try {
    let d = await api('/api/me');
    S.user = d.user;

    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('welcome').textContent = 'Welcome back, ' + S.user.name.split(' ')[0] + '!';
    $('who').textContent = S.user.name + ' · ' + S.user.email;
    $('rolePill').textContent = S.user.role.toUpperCase();

    // Faculty-only panels
    ['recordPanel', 'sessionPanel', 'rosterPanel', 'studentsPanel', 'ttAddPanel']
  .forEach(id => $(id).classList.toggle('hidden', !isFaculty()));

    // Student-only panels
    ['joinPanel', 'logPanel', 'changesPanel', 'ovChanges', 'enrollPanel']
      .forEach(id => $(id).classList.toggle('hidden', isFaculty()));

    // Planner is for students
    document.querySelector('[data-page="planner"]').style.display =
      isFaculty() ? 'none' : '';

    $('subHint').textContent = isFaculty()
      ? 'Create a class subject with its code and timing. Students join it with the join code shown on its card.'
      : 'Add your own subject to track, or join a class subject with the join code from your faculty.';
    $('ttHint').textContent = isFaculty()
      ? 'Any change you make here is shown to the students who joined the subject, under Timetable updates.'
      : 'Add classes for your own subjects. The class timetable is managed by your faculty.';

    await load();
    await resumeLive();
  } catch {
    $('auth').classList.remove('hidden');
    $('app').classList.add('hidden');
    S.token = '';
    localStorage.removeItem('ct_token');
  }
}

async function load() {
  const jobs = [
    api('/api/subjects'),
    api('/api/timetable'),
    isFaculty() ? api('/api/students') : api('/api/timetable/changes')
  ];
  const [subjects, tt, extra] = await Promise.all(jobs);
  S.subjects = subjects;
  S.tt = tt;
  if (isFaculty()) S.students = extra;
  else S.changes = extra;
  render();
}

/* ---------------- Dropdowns ---------------- */

function fill(id, list = S.subjects) {
  let el = $(id);
  if (!el) return;
  let v = el.value;
  el.innerHTML =
    '<option value="">Select subject</option>' +
    list.map(s =>
      `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`
    ).join('');
  if (list.some(s => String(s.id) === v)) el.value = v;
}

function fillStudents() {
  let el = $('attStudent'), v = el.value;
  el.innerHTML =
    '<option value="">Select student</option>' +
    S.students.map(s =>
      `<option value="${s.id}">${esc(s.name)} (${esc(s.email)})</option>`
    ).join('');
  if (S.students.some(s => String(s.id) === v)) el.value = v;
}

/* ---------------- Render ---------------- */

function render() {
  const mine = S.subjects.filter(s => s.mine);
  fill('ttSubject', mine);
  fill('logSubject', mine);
  fill('attSubject');
  fill('calcSubject');
  fill('sessionSubject');
  fill('rosterSubject');
  fillStudents();

  let p = S.subjects.reduce((n, s) => n + s.attended, 0);
  let c = S.subjects.reduce((n, s) => n + s.conducted, 0);

  $('nSubjects').textContent = S.subjects.length;
  $('nPresent').textContent = p;
  $('overall').textContent = c ? Math.round(p / c * 100) + '%' : '—';
  $('low').textContent =
    S.subjects.filter(s => s.conducted && s.percentage < s.target).length;

  renderSubjects();
  renderTT();
  renderToday();
  renderChanges();
  renderWatch();
  renderChart();
}

function renderSubjects() {
  $('subList').innerHTML = S.subjects.length
    ? S.subjects.map(s => `
        <div class="subcard">
          <h4>${esc(s.name)} <small>${esc(s.code)}</small>
            ${isFaculty() ? '' : `<span class="tag">${s.mine ? 'My subject' : 'Class'}</span>`}
          </h4>
          <b>${s.conducted ? s.percentage + '%' : 'No records'}</b>
          <div class="bar"><span class="${s.conducted && s.percentage < s.target ? 'low' : ''}" style="width:${s.percentage}%"></span></div>
          <p class="mutedline">${s.attended}/${s.conducted} classes · target ${s.target}%${s.faculty ? ' · ' + esc(s.faculty) : ''}</p>
          ${isFaculty() && s.join_code
            ? `<p class="mutedline">Join code: <b>${esc(s.join_code)}</b></p>`
            : ''}
          ${isFaculty()
            ? `<button class="edit" data-students="${s.id}">Students</button>`
            : ''}
          ${s.mine ? `<button class="del" data-subdel="${s.id}">Delete subject</button>` : ''}
        </div>`).join('')
    : `<p class="muted">${isFaculty()
        ? 'Add your first subject above.'
        : 'No subjects yet. Add your own, or join a class subject with the join code from your faculty.'}</p>`;

  $('subList').querySelectorAll('[data-students]').forEach(b =>
    b.onclick = () => showStudents(Number(b.dataset.students))
  );

  $('subList').querySelectorAll('[data-subdel]').forEach(b => b.onclick = async () => {
    if (confirm('Delete subject, its timetable and its records?')) {
      try {
        await api('/api/subjects/' + b.dataset.subdel, { method: 'DELETE' });
        await load();
        notice('Subject deleted.');
      } catch (e) {
        notice(e.message, true);
      }
    }
  });
}

// Faculty: every enrolled student with percentage, flagged if below target
async function showStudents(id) {
  const sub = S.subjects.find(s => s.id === id);
  try {
    const rows = await api('/api/subjects/' + id + '/students');
    $('studentStats').innerHTML =
      `<p class="mutedline"><b>${esc(sub ? sub.name : '')}</b> · target ${sub ? sub.target : 75}%</p>` +
      (rows.length
        ? `<div class="tablewrap"><table><thead><tr><th>Student</th><th>Attended</th><th>%</th><th></th></tr></thead><tbody>${
            rows.map(r => `
              <tr>
                <td>${esc(r.name)}<br><small>${esc(r.email)}</small></td>
                <td>${r.attended}/${r.conducted}</td>
                <td>${r.conducted ? r.percentage + '%' : '—'}</td>
                <td>${r.below ? '<span class="tag removed">Below target</span>' : ''}</td>
              </tr>`).join('')
          }</tbody></table></div>`
        : '<p class="muted">No students have joined this subject yet.</p>');
    $('studentsPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    notice(e.message, true);
  }
}

/* ---------- Timetable page ---------- */

function renderTT() {
  $('dayTabs').innerHTML = ['All', 'Today', ...DAYS].map(d => `
    <button type="button" class="chip ${S.dayFilter === d ? 'active' : ''}" data-day="${d}">
      ${d === 'All' || d === 'Today' ? d : d.slice(0, 3)}
    </button>`).join('');

  $('dayTabs').querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    S.dayFilter = b.dataset.day;
    renderTT();
  });

  const f = S.dayFilter;
  const rows = S.tt.filter(t =>
    f === 'All' || (f === 'Today' ? t.day === todayName() : t.day === f)
  );

  $('ttList').innerHTML = rows.length
    ? `<div class="tablewrap"><table><thead><tr><th>Day</th><th>Time</th><th>Subject</th><th>Room</th><th></th></tr></thead><tbody>${
        rows.map(t => `
          <tr class="${t.day === todayName() ? 'today' : ''}">
            <td>${esc(t.day)}</td>
            <td>${esc(t.start_time)}–${esc(t.end_time)}</td>
            <td>${esc(t.subject_name)}
              ${isFaculty() ? '' : `<span class="tag">${t.mine ? 'Personal' : 'Class'}</span>`}
            </td>
            <td>${esc(t.room)}</td>
            <td>${t.mine
              ? `<button class="edit" data-ttedit="${t.id}">Edit</button><button class="del" data-ttdel="${t.id}">Delete</button>`
              : ''}</td>
          </tr>`).join('')
      }</tbody></table></div>`
    : `<p class="muted">${S.tt.length ? 'No classes for this selection.' : 'No classes added yet.'}</p>`;

  $('ttList').querySelectorAll('[data-ttedit]').forEach(b =>
    b.onclick = () => startEdit(Number(b.dataset.ttedit))
  );

  $('ttList').querySelectorAll('[data-ttdel]').forEach(b => b.onclick = async () => {
    if (confirm('Delete timetable entry?')) {
      try {
        await api('/api/timetable/' + b.dataset.ttdel, { method: 'DELETE' });
        if (S.editId === Number(b.dataset.ttdel)) resetTTForm();
        await load();
        notice('Entry deleted.');
      } catch (e) {
        notice(e.message, true);
      }
    }
  });
}

function startEdit(id) {
  const t = S.tt.find(x => x.id === id);
  if (!t) return;
  S.editId = id;
  $('ttSubject').value = String(t.subject_id);
  $('ttSubject').disabled = true;
  $('day').value = t.day;
  $('start').value = t.start_time;
  $('end').value = t.end_time;
  $('room').value = t.room || '';
  $('ttFormTitle').textContent = 'Edit timetable entry';
  $('ttSubmit').textContent = 'Save changes';
  $('ttCancel').classList.remove('hidden');
  $('ttAddPanel').scrollIntoView({ behavior: 'smooth' });
}

function resetTTForm() {
  S.editId = null;
  $('ttForm').reset();
  $('ttSubject').disabled = false;
  $('ttFormTitle').textContent = 'Add timetable entry';
  $('ttSubmit').textContent = 'Add class';
  $('ttCancel').classList.add('hidden');
}

$('ttCancel').onclick = resetTTForm;

/* ---------- Overview: today's classes + next class ---------- */

function renderToday() {
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0');
  const idx = (now.getDay() + 6) % 7;

  let nextHtml = '';
  for (let o = 0; o <= 7; o++) {
    const day = DAYS[(idx + o) % 7];
    const list = S.tt
      .filter(t => t.day === day && (o > 0 || t.end_time > hhmm))
      .sort(byStart);

    if (list.length) {
      const t = list[0];
      const label = o === 0 && t.start_time <= hhmm
        ? 'Happening now'
        : 'Next class · ' + (o === 0 ? 'today' : o === 1 ? 'tomorrow' : o === 7 ? 'next ' + day : day);
      nextHtml = `<div class="entry nextclass"><small>${esc(label)}</small><br><b>${esc(t.subject_name)}</b><br>${esc(t.start_time)}–${esc(t.end_time)} · ${esc(t.room)}</div>`;
      break;
    }
  }

  const todays = S.tt.filter(t => t.day === todayName()).sort(byStart);

  $('next').innerHTML =
    (nextHtml || '<p class="muted">No upcoming classes.</p>') +
    `<p class="mutedline"><b>${esc(todayName())} (${todays.length} class${todays.length === 1 ? '' : 'es'})</b></p>` +
    (todays.length
      ? todays.map(t => `<div class="entry"><b>${esc(t.start_time)}–${esc(t.end_time)} · ${esc(t.subject_name)}</b><br>${esc(t.room)}</div>`).join('')
      : '<p class="muted">No classes today.</p>');
}

/* ---------- Timetable updates (students) ---------- */

function changeItem(c) {
  const when = new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleString();
  const label = { added: 'Added', updated: 'Updated', removed: 'Removed' }[c.action];
  return `
    <div class="entry change ${c.is_new ? 'new' : ''}">
      <span class="tag ${esc(c.action)}">${label}</span>
      ${c.is_new ? '<span class="tag newtag">NEW</span>' : ''}
      <b>${esc(c.subject_name)} (${esc(c.code)})</b><br>
      ${esc(c.summary)}<br>
      <small>${esc(when)}</small>
    </div>`;
}

function renderChanges() {
  if (isFaculty()) {
    $('ttBadge').classList.add('hidden');
    return;
  }

  const fresh = S.changes.filter(c => c.is_new).length;

  $('ttBadge').textContent = fresh;
  $('ttBadge').classList.toggle('hidden', fresh === 0);
  $('seenBtn').classList.toggle('hidden', fresh === 0);

  const empty = '<p class="muted">No timetable changes yet. You will see updates here when your faculty changes a class.</p>';

  $('changesList').innerHTML =
    S.changes.length ? S.changes.map(changeItem).join('') : empty;
  $('ovChangesList').innerHTML =
    S.changes.length ? S.changes.slice(0, 3).map(changeItem).join('') : empty;
}

$('seenBtn').onclick = async () => {
  try {
    await post('/api/timetable/changes/seen', {});
    await load();
  } catch (e) {
    notice(e.message, true);
  }
};

/* ---------- Watchlist + chart ---------- */

function renderWatch() {
  let low = S.subjects.filter(s => s.conducted && s.percentage < s.target);
  $('watch').innerHTML = low.length
    ? low.map(s => `
        <div class="entry"><b>${esc(s.name)} — ${s.percentage}%</b><br>Target: ${s.target}%. Plan to attend upcoming classes.</div>`).join('')
    : '<p class="muted">No recorded subjects below target.</p>';
}

function renderChart() {
  $('noChart').classList.toggle('hidden', S.subjects.length > 0);
  if (S.chart) S.chart.destroy();
  if (typeof Chart !== 'undefined' && S.subjects.length) {
    S.chart = new Chart($('chart'), {
      type: 'bar',
      data: {
        labels: S.subjects.map(s => s.code),
        datasets: [
          { label: 'Attendance %', data: S.subjects.map(s => s.percentage), backgroundColor: '#7166e8' },
          { label: 'Target %', data: S.subjects.map(s => s.target), backgroundColor: '#d6d2fb' }
        ]
      },
      options: { responsive: true, scales: { y: { beginAtZero: true, max: 100 } } }
    });
  }
}

/* ---------------- Forms ---------------- */

// Add subject (students and faculty), with optional timing
$('subForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await post('/api/subjects', {
      name: $('subName').value,
      code: $('subCode').value,
      faculty: $('subFaculty').value,
      target: $('target').value,
      day: $('subDay').value,
      start_time: $('subStart').value,
      end_time: $('subEnd').value,
      room: $('subRoom').value
    });
    e.target.reset();
    $('target').value = 75;
    await load();
    notice('Subject added.');
  } catch (x) {
    notice(x.message, true);
  }
};

// Student: join a class subject with the faculty's join code
$('enrollForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await post('/api/subjects/join', { join_code: $('joinCode').value });
    e.target.reset();
    await load();
    notice('Subject joined.');
  } catch (x) {
    notice(x.message, true);
  }
};

// Faculty: save the class list (verified emails)
$('rosterForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const emails = $('rosterEmails').value.split(/[\s,;]+/).filter(Boolean);
    const d = await post('/api/subjects/' + $('rosterSubject').value + '/roster', { emails });
    $('rosterEmails').value = '';
    notice(d.added + ' email(s) added to the class list.');
  } catch (x) {
    notice(x.message, true);
  }
};

// Add or edit a timetable entry
$('ttForm').onsubmit = async e => {
  e.preventDefault();
  const body = {
    day: $('day').value,
    start_time: $('start').value,
    end_time: $('end').value,
    room: $('room').value
  };
  try {
    if (S.editId) {
      await api('/api/timetable/' + S.editId, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      resetTTForm();
      await load();
      notice('Timetable entry updated.');
    } else {
      await post('/api/timetable', { ...body, subject_id: $('ttSubject').value });
      e.target.reset();
      await load();
      notice('Timetable entry added.');
    }
  } catch (x) {
    notice(x.message, true);
  }
};

// Faculty: correct a student's attendance
$('attForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await post('/api/attendance', {
      subject_id: $('attSubject').value,
      student_id: $('attStudent').value,
      class_date: $('attDate').value,
      status: $('status').value
    });
    await load();
    notice('Attendance recorded.');
  } catch (x) {
    notice(x.message, true);
  }
};

// Student: log attendance for own subject
$('logForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await post('/api/attendance/own', {
      subject_id: $('logSubject').value,
      class_date: $('logDate').value,
      status: $('logStatus').value
    });
    await load();
    notice('Attendance saved.');
  } catch (x) {
    notice(x.message, true);
  }
};

// Student: what-if calculator
$('calcForm').onsubmit = e => {
  e.preventDefault();
  let s = S.subjects.find(x => String(x.id) === $('calcSubject').value);
  let t = Number($('calcTarget').value);
  let r = $('calcResult');

  if (!s || t < 1 || t > 100) return;

  if (!s.conducted) {
    r.textContent = 'Record attendance before calculating.';
    return;
  }

  if (s.percentage >= t) {
    let miss = Math.max(0, Math.floor(s.attended / (t / 100) - s.conducted));
    r.innerHTML = `<div class="big">On track</div>Approx. ${miss} consecutive class${miss === 1 ? '' : 'es'} could be missed before falling below ${t}%, assuming no other changes.`;
  } else {
    let n = Math.ceil((t * s.conducted - s.attended * 100) / (100 - t));
    r.innerHTML = `<div class="big">${Math.max(0, n)}</div>consecutive classes to attend to reach about ${t}%, assuming no future absences.`;
  }
};

/* ---------------- Live class (faculty) ---------------- */

let liveId = null;
let liveTimer = null;

function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
  liveId = null;
  if ($('endLive')) $('endLive').classList.add('hidden');
}

async function pollCode() {
  if (!liveId) return;
  try {
    const d = await api('/api/live/' + liveId + '/code');
    $('generated').innerHTML = `<div class="result">Live code
      <div class="big">${esc(d.code)}</div>
      <small>Changes in ${d.secondsLeft}s · ${d.checkedIn}/${d.enrolled} checked in</small></div>`;
  } catch {
    stopLive();
    $('generated').innerHTML = '';
  }
}

// After a refresh/login, pick up a class that is still live on the server.
async function resumeLive() {
  if (!isFaculty() || liveId) return;
  try {
    const list = await api('/api/live/active');
    if (!list.length) return;
    liveId = list[0].id;
    $('endLive').classList.remove('hidden');
    await pollCode();
    clearInterval(liveTimer);
    liveTimer = setInterval(pollCode, 2000);
  } catch { /* ignore */ }
}

// Start a live class (the code appears and rotates every 20 seconds)
$('sessionForm').onsubmit = async e => {
  e.preventDefault();
  if (liveId) {
    notice('A class is already live. End it first.', true);
    return;
  }
  try {
    const pos = await getPos();
    const d = await post('/api/live/start', {
      subject_id: $('sessionSubject').value,
      ...pos
    });
    liveId = d.id;
    $('endLive').classList.remove('hidden');
    await pollCode();
    liveTimer = setInterval(pollCode, 2000);
    notice(d.location
      ? 'Class is live. Students must be near you and on the campus network.'
      : 'Class is live. Location was not shared, so only the code is checked.');
  } catch (x) {
    notice(x.message, true);
  }
};

// End the class: students who did not check in are marked absent
$('endLive').onclick = async () => {
  if (!liveId) return;
  if (!confirm('End class? Students who have not checked in will be marked absent.')) return;
  try {
    const d = await post('/api/live/' + liveId + '/end', {});
    stopLive();
    $('generated').innerHTML = '';
    await load();
    await resumeLive();
    notice('Class ended. ' + d.absent + ' student(s) marked absent.');
  } catch (x) {
    notice(x.message, true);
  }
};

/* ---------------- Live class (student) ---------------- */

// Student: type the live code shown by the faculty
$('joinForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const pos = await getPos();
    await post('/api/live/check-in', { code: $('code').value.trim(), ...pos });
    $('code').value = '';
    await load();
    notice('Attendance marked.');
  } catch (x) {
    notice(x.message, true);
  }
};

/* ---------------- Page navigation ---------------- */

const titles = {
  overview: 'Overview',
  timetable: 'Timetable',
  subjects: 'Subjects & attendance',
  planner: 'Attendance planner',
  qr: 'Attendance code'
};

document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  $(b.dataset.page).classList.remove('hidden');
  document.querySelectorAll('[data-page]').forEach(n =>
    n.classList.toggle('active', n === b)
  );
  $('title').textContent = titles[b.dataset.page];
});

// Refresh every 30 seconds so students see faculty changes without reloading.
setInterval(() => {
  if (S.token && S.user && !S.editId && document.visibilityState === 'visible') {
    load().catch(() => {});
  }
}, 30000);

enter();