/* ============================================================
   جارویس — دستیار صوتی فارسی
   تشخیص گفتار فارسی، پاسخ صوتی، هشدار، تماس، ارز دیجیتال،
   جستجو در ویکی‌پدیا و (اختیاری) هوش مصنوعی با کلید API
   ============================================================ */
'use strict';

/* ---------- ابزارهای پایه ---------- */

const $ = (sel) => document.querySelector(sel);

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toFaDigits = (s) => String(s).replace(/\d/g, (d) => FA_DIGITS[+d]);
const toEnDigits = (s) => String(s)
  .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
  .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

const faFmt = new Intl.NumberFormat('fa-IR');
const faPrice = (n) => {
  if (n >= 1000) return faFmt.format(Math.round(n));
  if (n >= 1) return faFmt.format(+n.toFixed(2));
  return faFmt.format(+n.toFixed(6));
};

const WAKE_RE = /جارو\s*ویس|جارویس|جارو|jarvis/i;
const stripWake = (t) => t.replace(WAKE_RE, '').replace(/^[\s،,.!؟]+/, '').trim();

/* ---------- وضعیت برنامه ---------- */

const state = {
  settings: {
    aiEnabled: false,
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    contacts: [],
    voiceURI: '',
    wakeMode: false,
  },
  alarms: [],           // { id, time, label }
  history: [],          // گفتگو با هوش مصنوعی
  rec: null,            // موتور تشخیص گفتار
  wakeListening: false,
  awaitingCommand: false,
  oneshot: false,
  errorStreak: 0,
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('jarvis_settings'));
    if (s) Object.assign(state.settings, s);
    if (!Array.isArray(state.settings.contacts)) state.settings.contacts = [];
  } catch { /* بی‌خیال */ }
  try {
    const a = JSON.parse(localStorage.getItem('jarvis_alarms'));
    if (Array.isArray(a)) state.alarms = a.filter((x) => x && typeof x.time === 'number');
  } catch { /* بی‌خیال */ }
}
const saveSettings = () => localStorage.setItem('jarvis_settings', JSON.stringify(state.settings));
const saveAlarms = () => localStorage.setItem('jarvis_alarms', JSON.stringify(state.alarms));

/* ---------- رابط کاربری ---------- */

const chatEl = $('#chat');
const liveEl = $('#live');
const coreBtn = $('#coreBtn');
const statusEl = $('#statusText');
const coreHint = $('#coreHint');

const STATUS_TEXT = {
  idle: 'آماده',
  listening: 'دارم گوش میدم...',
  speaking: 'دارم حرف میزنم...',
  thinking: 'دارم فکر میکنم...',
};

function setCoreState(s) {
  coreBtn.className = 'core ' + s;
  statusEl.textContent = STATUS_TEXT[s] || '';
  coreHint.textContent = s === 'idle' ? 'برای حرف زدن لمس کن'
    : s === 'listening' ? 'می‌شنوم... بگو «جارویس» یا مستقیم دستورت رو بگو'
    : s === 'speaking' ? 'دارم جواب میدم...'
    : 'یک لحظه...';
}

function addBubble(role, text, link) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'jarvis');
  div.textContent = text;
  if (link && link.url) {
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label || 'باز کن';
    div.appendChild(document.createElement('br'));
    div.appendChild(a);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

/* ---------- گفتار (متن به صدا) ---------- */

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (state.settings.voiceURI) {
    const v = voices.find((x) => x.voiceURI === state.settings.voiceURI);
    if (v) return v;
  }
  return voices.find((v) => /^fa/i.test(v.lang))
    || voices.find((v) => /persian|farsi/i.test(v.name))
    || null;
}

function speak(text, opts = {}) {
  return new Promise((resolve) => {
    if (!opts.silentBubble) addBubble('jarvis', text);
    const reset = () => setCoreState(state.wakeListening ? 'listening' : 'idle');
    if (!('speechSynthesis' in window) || !text) { reset(); resolve(); return; }
    const voices = speechSynthesis.getVoices();
    const v = pickVoice();
    // اگه لیست صداها لود شده ولی هیچ صدای فارسی نیست، به جای سکوت، فقط متن نشون بده
    if (voices.length && !v && !state.warnedNoVoice) {
      state.warnedNoVoice = true;
      addBubble('jarvis', '⚠️ صدای فارسی روی این دستگاه پیدا نشد؛ جواب‌ها رو فقط متنی می‌نویسم. (برای صدا: تنظیمات گوشی ← Google Text-to-Speech ← نصب زبان فارسی)');
      reset();
      resolve();
      return;
    }
    try { speechSynthesis.cancel(); } catch { /* */ }
    const u = new SpeechSynthesisUtterance(text);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || 'fa-IR';
    u.rate = 1;
    u.pitch = 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setCoreState(state.wakeListening ? 'listening' : 'idle');
      resolve();
    };
    u.onstart = () => setCoreState('speaking');
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
    // شبکه اطمینان: بعضی موتورها onend نمی‌دن
    setTimeout(finish, Math.min(30000, 3000 + text.length * 120));
  });
}

if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => fillVoiceSelect();
}

/* ---------- تشخیص گفتار (صدا به متن) ---------- */

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'fa-IR';
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    state.errorStreak = 0;
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) { liveEl.hidden = false; liveEl.textContent = '«' + interim + '»'; }
    if (final) {
      liveEl.hidden = true;
      liveEl.textContent = '';
      processFinal(final.trim());
    }
  };

  rec.onerror = (e) => {
    const err = e.error;
    console.warn('recognition error:', err);
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      stopWake();
      addBubble('jarvis', 'دسترسی میکروفن داده نشده. از تنظیمات گوشی/مرورگر اجازه میکروفن رو بده و دوباره امتحان کن. (برای میکروفن اینترنت لازمه و صفحه باید با https باز شده باشه)');
      return;
    }
    state.errorStreak++;
    if (state.errorStreak >= 5) {
      stopWake();
      addBubble('jarvis', 'نمی‌تونم درست بشنوم. بعدا دوباره امتحان می‌کنی؟');
    }
  };

  rec.onend = () => {
    if (state.wakeListening) {
      setTimeout(() => { try { rec.start(); } catch { /* */ } }, 350);
    } else {
      state.oneshot = false;
      if (coreBtn.className.includes('listening')) setCoreState('idle');
    }
  };

  return rec;
}

function processFinal(t) {
  if (!t) return;
  if (state.wakeListening) {
    if (WAKE_RE.test(t)) {
      const rest = stripWake(toEnDigits(t));
      state.awaitingCommand = false;
      if (rest) handleCommand(rest);
      else handleCommand('');
    } else if (state.awaitingCommand) {
      state.awaitingCommand = false;
      handleCommand(t);
    }
    // حرف‌های نامرتبط در حالت گوش دادن نادیده گرفته می‌شن
  } else {
    handleCommand(t);
  }
}

function startOneShot() {
  if (!state.rec) return;
  try {
    state.rec.continuous = false;
    setCoreState('listening');
    state.rec.start();
    state.oneshot = true;
  } catch (e) { console.warn(e); }
}

function startWake() {
  if (!state.rec) return;
  state.wakeListening = true;
  state.settings.wakeMode = true;
  saveSettings();
  $('#wakeToggle').checked = true;
  state.rec.continuous = true;
  try { state.rec.start(); } catch (e) { console.warn(e); }
  setCoreState('listening');
  addBubble('jarvis', 'حالت گوش دادن روشن شد ✅ هر وقت بگی «جارویس» در خدمتم.');
}

function stopWake() {
  state.wakeListening = false;
  state.awaitingCommand = false;
  state.settings.wakeMode = false;
  saveSettings();
  $('#wakeToggle').checked = false;
  try { state.rec && state.rec.stop(); } catch { /* */ }
  setCoreState('idle');
}

/* ---------- مسیریابی دستورها ---------- */

async function handleCommand(raw) {
  const cleaned = stripWake(toEnDigits(raw || ''))
    .replace(/[؟?!.،]+$/g, '').trim();
  if (raw && raw.trim()) addBubble('user', raw.trim());

  if (!cleaned) {
    state.awaitingCommand = true;
    await speak('بله، چه کاری باید انجام بدم؟');
    return;
  }

  try {
    if (await routeGreeting(cleaned)) return;
    if (await routeHelp(cleaned)) return;
    if (await routeTime(cleaned)) return;
    if (await routeAlarm(cleaned)) return;
    if (await routeCall(cleaned)) return;
    if (await routeCrypto(cleaned)) return;
    if (await routeCalc(cleaned)) return;
    if (await routeGoogleOpen(cleaned)) return;
    if (await routeAI(cleaned)) return;
    if (await routeWiki(cleaned)) return;
    await speak('متوجه منظورت نشدم. بگو «راهنما» تا لیست کارهایی که بلدم رو بشنی.');
  } catch (err) {
    console.error(err);
    await speak('یه مشکلی پیش کرد. دوباره امتحان می‌کنی؟');
  }
}

/* ---------- سلام و احوالپرسی ---------- */

const GREETINGS = [
  [/^(سلام|درود|هی)$/i, 'سلام! چه کاری برات انجام بدم؟'],
  [/حالت\s*(چطوره|خوبه)|خوبی/, 'عالی‌ام! ممنون که پرسیدی. تو چطوری؟'],
  [/^(ممنون|مرسی|دمت\s*گرم|سپاس|تشکر)$/i, 'خواهش می‌کنم! کار دیگه‌ای هم بود؟'],
  [/^(خداحافظ|بای|بای\s*بای|فعلا|خدانگهدار)$/i, 'خداحافظ! هر وقت خواستی من اینجام 👋'],
  [/اسمت\s*(چیه|چیه؟)|تو\s*کی\s*هستی/, 'من جارویس‌ام، دستیار شخصی تو 🤖'],
];

async function routeGreeting(cmd) {
  for (const [re, reply] of GREETINGS) {
    if (re.test(cmd)) { await speak(reply); return true; }
  }
  return false;
}

async function routeHelp(cmd) {
  if (!/راهنما|کمک|چیکار\s*میتونی|چه\s*کاری\s*میتونی|چیکار\s*بلدی|قابلیت/.test(cmd)) return false;
  await speak('این کارها رو بلدم:\n• «ساعت چنده» و «امروز چندمه»\n• هشدار: «هشدار ساعت ۲ بعد از ظهر» یا «۲۰ دقیقه دیگه هشدار بذار»\n• تماس: «با علی تماس بگیر» (اول از مخاطبین اضافه‌ش کن)\n• ارز دیجیتال: «قیمت بیت کوین» یا «اخبار ارز دیجیتال»\n• ماشین حساب: «۳ به علاوه ۵ چنده»\n• جستجو: «سرچ کن ...» یا «درباره ... بگو» که از ویکی‌پدیا برات می‌خونم\nاگه توی تنظیمات هوش مصنوعی رو فعال کنی، به هر سوالی هم جواب میدم.');
  return true;
}

/* ---------- ساعت و تاریخ (شمسی) ---------- */

const FA_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const FA_WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

function toJalali(date) {
  const gy = date.getFullYear(), gm = date.getMonth() + 1, gd = date.getDate();
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return { jy, jm, jd };
}

async function routeTime(cmd) {
  const now = new Date();
  if (/^(الان\s*)?ساعت\s*(الان\s*)?(چنده|چند\s*است|چیه)?$/.test(cmd) || /^چندمه.*ساعت/.test(cmd)) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    await speak(`الان ساعت ${toFaDigits(hh + ':' + mm)} است.`);
    return true;
  }
  if (/^(تاریخ|امروز)\s*(چنده|چیه|چی\s*هست)?$/.test(cmd) || /چندمه|تاریخ\s*امروز|امروز\s*چند/.test(cmd)) {
    const j = toJalali(now);
    const wd = FA_WEEKDAYS[now.getDay()];
    await speak(`امروز ${wd}، ${toFaDigits(j.jd)} ${FA_MONTHS[j.jm - 1]} ${toFaDigits(j.jy)} است.`);
    return true;
  }
  return false;
}

/* ---------- هشدار ---------- */

const NUM_WORDS = {
  'یک': 1, 'دو': 2, 'سه': 3, 'چهار': 4, 'پنج': 5, 'شش': 6, 'هفت': 7, 'هشت': 8, 'نه': 9,
  'ده': 10, 'یازده': 11, 'دوازده': 12, 'سیزده': 13, 'چهارده': 14, 'پانزده': 15, 'پونزده': 15,
  'شانزده': 16, 'هفده': 17, 'هجده': 18, 'نوزده': 19, 'بیست': 20, 'سی': 30, 'چهل': 40, 'پنجاه': 50,
};

function numWordsToDigits(text) {
  let padded = ' ' + toEnDigits(text) + ' ';
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    padded = padded.split(' ' + w + ' ').join(' ' + n + ' ');
  }
  return padded.replace(/^ | $/g, '');
}

function fmtAlarmTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const isTomorrow = d.toDateString() !== today.toDateString();
  return toFaDigits(`${hh}:${mm}`) + (isTomorrow ? ' فردا' : '');
}

function parseAlarmTime(cmd) {
  const text = numWordsToDigits(cmd);
  // نسبت به الان: «نیم ساعت دیگه»
  if (/نیم\s*ساعت\s*(?:دیگه|بعد|دیگر)/.test(text)) {
    return { time: Date.now() + 30 * 60000, human: 'نیم ساعت دیگه' };
  }
  // نسبت به الان: «۲۰ دقیقه دیگه» / «بعد از ۲ ساعت»
  let m = text.match(/(\d+)\s*(دقیقه|ساعت)\s*(?:دیگه|بعد|دیگر)/)
       || text.match(/(?:دیگه|بعد|دیگر)\s*(\d+)\s*(دقیقه|ساعت)/);
  if (m) {
    const n = +m[1];
    const ms = m[2].startsWith('ساعت') ? n * 3600000 : n * 60000;
    return { time: Date.now() + ms, human: m[2].startsWith('ساعت') ? `${n} ساعت دیگه` : `${n} دقیقه دیگه` };
  }
  // مطلق: «ساعت ۲ و نیم بعد از ظهر»
  m = text.match(/ساعت\s*(\d{1,2})(?:\s*و\s*(نیم|ربع|سوم|(\d{1,2})\s*(?:دقیقه)?))?/);
  if (m) {
    let h = +m[1];
    const min = m[2] === 'نیم' ? 30 : m[2] === 'ربع' ? 15 : m[2] === 'سوم' ? 20 : (m[3] ? +m[3] : 0);
    if (/بعد\s*از\s*ظهر|بعدازظهر|عصر/.test(text) && h < 12) h += 12;
    else if (/شب/.test(text) && h >= 1 && h < 12) h += 12;
    if (/نیمه\s*شب|نصفه\s*شب/.test(text) && h === 12) h = 0;
    if (h > 23 || min > 59) return { invalid: true };
    const t = new Date();
    t.setHours(h, min, 0, 0);
    if (t.getTime() <= Date.now()) t.setTime(t.getTime() + (h < 12 ? 12 * 3600000 : 24 * 3600000));
    return { time: t.getTime(), human: 'ساعت ' + fmtAlarmTime(t.getTime()) };
  }
  return null;
}

async function routeAlarm(cmd) {
  if (!/(هشدار|آلارم|یادآور|زنگ|بیدار)/.test(cmd)) return false;
  const parsed = parseAlarmTime(cmd);
  if (!parsed) {
    await speak('متوجه زمان هشدار نشدم. مثلا بگو: «هشدار ساعت ۲ بعد از ظهر» یا «۲۰ دقیقه دیگه هشدار بذار».');
    return true;
  }
  if (parsed.invalid) {
    await speak('این ساعت معتبر نیست. یه ساعت بین ۰ تا ۲۳ بگو.');
    return true;
  }
  addAlarm(parsed.time, cmd);
  await speak(`باشه ✅ هشدار رو برای ${parsed.human} تنظیم کردم.`);
  return true;
}

function addAlarm(time, label) {
  const alarm = {
    id: (crypto.randomUUID && crypto.randomUUID()) || ('a' + Date.now() + Math.random()),
    time, label: label || 'هشدار',
  };
  state.alarms.push(alarm);
  saveAlarms();
  scheduleAlarm(alarm);
  renderAlarmsList();
  ensureNotificationPermission();
}

function scheduleAlarm(alarm) {
  clearTimeout(alarm.timerId);
  const delay = alarm.time - Date.now();
  if (delay <= 0) { fireAlarm(alarm); return; }
  alarm.timerId = setTimeout(() => fireAlarm(alarm), delay);
}

async function fireAlarm(alarm) {
  const idx = state.alarms.findIndex((a) => a.id === alarm.id);
  if (idx >= 0 && state.alarms[idx].fired) return;
  if (idx >= 0) { state.alarms.splice(idx, 1); saveAlarms(); renderAlarmsList(); }
  stopAlarmSound();
  playAlarmSound();
  if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500, 200, 500]);
  $('#alarmLabel').textContent = alarm.label || 'زمان رسید!';
  $('#alarmOverlay').hidden = false;
  notify('⏰ هشدار جارویس', alarm.label || 'زمان رسید!');
}

function checkAlarms() {
  const now = Date.now();
  const overdue = state.alarms.filter((a) => a.time <= now);
  for (const a of overdue) fireAlarm(a);
  // هشدارهایی که موقع نبودن برنامه زمانشون گذشته
}

/* صدای هشدار (بدون نیاز به فایل صوتی) */
let audioCtx = null;
let beepTimer = null;
function playAlarmSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    let count = 0;
    const beep = () => {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      g.gain.value = 0.3;
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);
      if (++count < 25) beepTimer = setTimeout(beep, 750);
    };
    beep();
  } catch { /* */ }
}
function stopAlarmSound() {
  clearTimeout(beepTimer);
  if (navigator.vibrate) navigator.vibrate(0);
}

async function ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

async function notify(title, body) {
  if (!(await ensureNotificationPermission())) return;
  try {
    const reg = await (navigator.serviceWorker && navigator.serviceWorker.getRegistration());
    if (reg && reg.showNotification) {
      await reg.showNotification(title, {
        body, dir: 'rtl', lang: 'fa',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'jarvis-alarm',
        renotify: true,
        vibrate: [300, 100, 300],
        requireInteraction: true,
      });
      return;
    }
  } catch { /* */ }
  try { new Notification(title, { body, dir: 'rtl' }); } catch { /* */ }
}

/* ---------- تماس ---------- */

function findContact(name) {
  const norm = (s) => s.replace(/[\u200c\s]+/g, ' ').trim().toLowerCase();
  const n = norm(name);
  const cs = state.settings.contacts;
  let hit = cs.find((c) => norm(c.name) === n);
  if (hit) return hit;
  hit = cs.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name)));
  if (hit) return hit;
  const digits = name.replace(/[^\d]/g, '');
  if (digits.length >= 4) hit = cs.find((c) => c.number.replace(/[^\d]/g, '').includes(digits));
  return hit || null;
}

function dial(number) {
  const a = document.createElement('a');
  a.href = 'tel:' + String(number).replace(/[\s-]/g, '');
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function routeCall(cmd) {
  let m = cmd.match(/(?:با|به)\s+(.+?)\s*(?:تماس\s*بگیر|تماس\s*بده|زنگ\s*بزن)/)
       || cmd.match(/(?:تماس\s*با|زنگ\s*به)\s+(.+)$/)
       || cmd.match(/(.+?)\s*(?:رو|را)\s*(?:تماس\s*بگیر|زنگ\s*بزن)/);
  if (!m) return false;
  const target = m[1].replace(/^(?:آقای|خانم)\s+/, '').replace(/\s*(?:لطفا|ممنون)$/,'').trim();

  const digits = target.replace(/[^\d+]/g, '');
  if (digits.length >= 8) {
    dial(digits);
    await speak(`در حال تماس با ${toFaDigits(digits)}...`);
    return true;
  }
  const contact = findContact(target);
  if (contact) {
    dial(contact.number);
    await speak(`در حال تماس با ${contact.name}... 📞`);
    return true;
  }
  await speak(`${target} توی لیست مخاطبین جارویس نیست. از دکمه 👤 بالای صفحه اضافه‌ش کن، یا شماره‌اش رو مستقیم بگو.`);
  return true;
}

/* ---------- ارز دیجیتال ---------- */

const COINS = [
  { keys: ['بیت کوین', 'بیتکوین', 'بت کوین', 'بیتکوئن'], id: 'bitcoin', fa: 'بیت‌کوین' },
  { keys: ['اتریوم'], id: 'ethereum', fa: 'اتریوم' },
  { keys: ['تتر'], id: 'tether', fa: 'تتر' },
  { keys: ['بایننس کوین', 'بایننسکوین'], id: 'binancecoin', fa: 'بایننس کوین' },
  { keys: ['ریپل', 'ایکس آر پی'], id: 'ripple', fa: 'ریپل' },
  { keys: ['کاردانو'], id: 'cardano', fa: 'کاردانو' },
  { keys: ['سولانا'], id: 'solana', fa: 'سولانا' },
  { keys: ['دوج کوین', 'دوجکوین', 'دوج'], id: 'dogecoin', fa: 'دوج‌کوین' },
  { keys: ['شیبا', 'شیا'], id: 'shiba-inu', fa: 'شیبا اینو' },
  { keys: ['ترون'], id: 'tron', fa: 'ترون' },
  { keys: ['پالیگان', 'متیک'], id: 'matic-network', fa: 'پالیگان' },
  { keys: ['لایت کوین', 'لایتکوین'], id: 'litecoin', fa: 'لایت‌کوین' },
  { keys: ['چین لینک', 'چینلینک'], id: 'chainlink', fa: 'چین‌لینک' },
  { keys: ['پولکادات', 'پولکا دات'], id: 'polkadot', fa: 'پولکادات' },
  { keys: ['آوالانچ', 'اوالانچ'], id: 'avalanche-2', fa: 'آوالانچ' },
  { keys: ['نیر'], id: 'near', fa: 'نیر' },
  { keys: ['فایل کوین', 'فایلکوین'], id: 'filecoin', fa: 'فایل‌کوین' },
  { keys: ['آپتوس', 'اپتوس'], id: 'aptos', fa: 'آپتوس' },
  { keys: ['تون کوین', 'تن کوین'], id: 'the-open-network', fa: 'تون‌کوین' },
  { keys: ['کاسپا'], id: 'kaspa', fa: 'کاسپا' },
  { keys: ['آربیتروم'], id: 'arbitrum', fa: 'آربیتروم' },
];

function matchCoin(cmd) {
  const padded = ' ' + cmd.replace(/[\u200c]/g, ' ') + ' ';
  for (const c of COINS) {
    if (c.keys.some((k) => padded.includes(' ' + k + ' '))) return c;
  }
  return null;
}

async function routeCrypto(cmd) {
  if (/(اخبار|تازه|جدید|وضعیت).*(ارز|کریپتو|بازار)|ارز دیجیتال|کریپتو|بازار ارز|بازار چطوره/.test(cmd)) {
    await cryptoTrending();
    return true;
  }
  const coin = matchCoin(cmd);
  if (coin) {
    await cryptoPrice(coin);
    return true;
  }
  return false;
}

async function cryptoPrice(coin) {
  setCoreState('thinking');
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const d = data[coin.id];
    if (!d) throw new Error('no data');
    const ch = d.usd_24h_change || 0;
    const dir = ch >= 0 ? 'رشد' : 'افت';
    const line = `قیمت ${coin.fa} الان ${faPrice(d.usd)} دلاره، با ${dir} ${faFmt.format(Math.abs(+ch.toFixed(1)))} درصد در ۲۴ ساعت گذشته.`;
    await speak(line);
  } catch (e) {
    console.error(e);
    await speak('الان نمی‌تونم به اطلاعات بازار ارز دیجیتال وصل بشم. یه چند دقیقه دیگه امتحان کن.');
  }
}

async function cryptoTrending() {
  setCoreState('thinking');
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const items = (data.coins || []).slice(0, 5).map((x) => x.item);
    if (!items.length) throw new Error('empty');
    const lines = items.map((it, i) => {
      const price = it.data && it.data.price != null ? it.data.price : null;
      const ch = it.data && it.data.price_change_percentage_24h ? (it.data.price_change_percentage_24h.usd || 0) : 0;
      const pStr = price != null ? faPrice(price) + ' دلار' : 'قیمت نامشخص';
      return `${toFaDigits(String(i + 1))}. ${it.name} (${it.symbol}): ${pStr} — ${ch >= 0 ? 'رشد' : 'افت'} ${faFmt.format(Math.abs(+ch.toFixed(1)))}٪ در ۲۴ ساعت`;
    });
    addBubble('jarvis', '🔥 ۵ ارز داغ بازار همین الان:\n' + lines.join('\n'));
    const speech = 'پنج ارز داغ بازار: ' + items.map((it) => {
      const ch = it.data && it.data.price_change_percentage_24h ? (it.data.price_change_percentage_24h.usd || 0) : 0;
      return `${it.name} با ${ch >= 0 ? 'رشد' : 'افت'} ${faFmt.format(Math.abs(+ch.toFixed(0)))} درصد`;
    }).join('، ') + '.';
    await speak(speech, { silentBubble: true });
  } catch (e) {
    console.error(e);
    await speak('الان نمی‌تونم اخبار بازار ارز دیجیتال رو بیارم. یه چند دقیقه دیگه امتحان کن.');
  }
}

/* ---------- ماشین حساب ---------- */

async function routeCalc(cmd) {
  if (!/حساب\s*کن|محاسبه\s*کن|چند\s*میشه|چنده|جمع|منها|ضرب|تقسیم|توان/.test(cmd)) return false;
  let expr = ' ' + cmd + ' ';
  expr = expr
    .replace(/به\s*علاوه|به‌علاوه|بعلاوه|به\s*اضافه/g, '+')
    .replace(/منها|منهای|منهاى/g, '-')
    .replace(/ضرب\s*در|ضربدر|ضرب/g, '*')
    .replace(/تقسیم\s*بر|تقسیم/g, '/')
    .replace(/به\s*توان/g, '**');
  expr = expr.replace(/[^\d+\-*/.() ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\d/.test(expr) || !/[+\-*/]/.test(expr)) return false;
  try {
    const val = Function('"use strict"; return (' + expr + ')')();
    if (typeof val !== 'number' || !isFinite(val)) throw new Error('bad');
    await speak(`${toFaDigits(expr)} میشه ${faFmt.format(val)}`);
    return true;
  } catch {
    await speak('این حساب رو نتونستم بکنم. ساده‌تر بگو، مثلا: «۳ به علاوه ۵ چنده»');
    return true;
  }
}

/* ---------- باز کردن در گوگل ---------- */

async function routeGoogleOpen(cmd) {
  if (!/(سرچ|جستجو|گوگل)/.test(cmd)) return false;
  let m = cmd.match(/(?:سرچ\s*کن|جستجو\s*کن|جو\s*کن|گوگل\s*کن|گوگل\s*باز\s*کن)\s*(.*)$/);
  let q = m ? m[1] : '';
  if (!q) {
    m = cmd.match(/^(.*?)\s*(?:رو|را)?\s*(?:توی|در|روی)\s*گوگل/);
    q = m ? m[1] : '';
  }
  q = q.replace(/^(?:رو|را)\s*/, '').replace(/\s*(?:رو|را)$/, '').replace(/باز\s*کن/g, '').trim();
  if (!q) {
    await speak('چی رو توی گوگل باز کنم؟');
    return true;
  }
  window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank', 'noopener');
  await speak(`«${q}» رو توی گوگل باز کردم 🔍`);
  return true;
}

/* ---------- ویکی‌پدیا ---------- */

function truncateSpeech(t) {
  const parts = t.split(/(?<=[.!؟])\s+/);
  let out = '';
  for (const p of parts) {
    if ((out + ' ' + p).length > 380) break;
    out = out ? out + ' ' + p : p;
  }
  return out || t.slice(0, 380);
}

async function wikiLookup(topic) {
  try {
    let res = await fetch(`https://fa.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&srlimit=1&format=json&origin=*`);
    if (!res.ok) return null;
    const data = await res.json();
    const title = data && data.query && data.query.search && data.query.search[0] && data.query.search[0].title;
    if (!title) return null;
    res = await fetch('https://fa.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
    if (!res.ok) return null;
    const s = await res.json();
    if (!s.extract) return null;
    const url = (s.content_urls && s.content_urls.mobile && s.content_urls.mobile.page)
      || ('https://fa.wikipedia.org/wiki/' + encodeURIComponent(title));
    return { title: s.title, extract: s.extract, url, speech: truncateSpeech(s.extract) };
  } catch (e) {
    console.error(e);
    return null;
  }
}

async function routeWiki(cmd) {
  let topic = null;
  let m;
  if ((m = cmd.match(/^(?:درباره|از|مورد)\s+(.+)$/))) topic = m[1];
  else if ((m = cmd.match(/^(.+?)\s*(?:چیه|چیست|کیه)$/))) topic = m[1];
  else if ((m = cmd.match(/^(?:ویکیپدیا|ویکی\s*پدیا)\s+(.+)$/))) topic = m[1];
  else if ((m = cmd.match(/^(.+?)\s*(?:رو|را)\s*(?:برام)?\s*(?:بخون|توضیح\s*بده|تعریف\s*کن)/))) topic = m[1];
  if (!topic) return false;
  // پاک‌سازی پسوند دستور از آخر موضوع (بگو، بخون، توضیح بده و...)
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of ['بگو', 'بخون', 'بخونم', 'توضیح بده', 'تعریف کن', 'چند تا چیز', 'چندتا چیز', 'برام', 'برات', 'لطفا', 'ممنون', 'می‌خوام', 'میخوام']) {
      const re = new RegExp('\\s*' + suf.replace(/\s+/g, '\\s*') + '\\s*$');
      const nt = topic.replace(re, '').trim();
      if (nt !== topic) { topic = nt; changed = true; }
    }
  }
  topic = topic.replace(/[؟?]/g, '').trim();
  if (!topic || topic.length < 2) return false;

  setCoreState('thinking');
  const info = await wikiLookup(topic);
  if (info) {
    addBubble('jarvis', `📖 ${info.title}:\n${info.extract}`, { url: info.url, label: 'منبع: ویکی‌پدیا' });
    await speak(info.speech, { silentBubble: true });
    return true;
  }
  await speak(`چیزی درباره «${topic}» توی ویکی‌پدیا پیدا نکردم. می‌تونی بگی «سرچ کن ${topic}» تا توی گوگل بگردمش.`);
  return true;
}

/* ---------- هوش مصنوعی (اختیاری با کلید API) ---------- */

const AI_SYSTEM_PROMPT = 'تو «جارویس» هستی، دستیار صوتی فارسی‌زبان کاربر. جواب‌هات کوتاه، دوستانه و محاوره‌ای باشه چون با صدا خونده میشن. از لیست و لینک زیاد استفاده نکن. اگر سوالی درباره زمان فعلی، تماس تلفنی یا هشدار بود، بگو که کاربر باید از دستورهای صوتی برنامه استفاده کنه.';

async function callAI(userText, messagesOverride) {
  const s = state.settings;
  const messages = messagesOverride || [
    { role: 'system', content: AI_SYSTEM_PROMPT },
    ...state.history.slice(-9),
    { role: 'user', content: userText },
  ];
  const res = await fetch(s.apiBase.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + s.apiKey,
    },
    body: JSON.stringify({
      model: s.model || 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!reply) throw new Error('empty response');
  return reply.trim();
}

async function routeAI(cmd) {
  const s = state.settings;
  if (!s.aiEnabled || !s.apiKey) return false;
  setCoreState('thinking');
  try {
    const reply = await callAI(cmd);
    state.history.push({ role: 'user', content: cmd }, { role: 'assistant', content: reply });
    if (state.history.length > 24) state.history = state.history.slice(-24);
    await speak(reply);
    return true;
  } catch (e) {
    console.error(e);
    await speak('اتصال به هوش مصنوعی برقرار نشد. بذار از ویکی‌پدیا برات بگردم...');
    return false; // بره سراغ ویکی‌پدیا
  }
}

async function testAI() {
  const s = state.settings;
  if (!s.apiKey) { addBubble('jarvis', 'اول کلید API رو وارد کن و ذخیره کن، بعد تست کن.'); return; }
  setCoreState('thinking');
  try {
    const reply = await callAI('سلام', [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: 'سلام' },
    ]);
    addBubble('jarvis', '✅ اتصال موفق! جواب هوش مصنوعی: ' + reply);
  } catch (e) {
    console.error(e);
    addBubble('jarvis', '❌ اتصال نشد: ' + e.message + '\nآدرس API، کلید و مدل رو چک کن.');
  }
  setCoreState('idle');
}

/* ---------- دیالوگ‌ها ---------- */

function renderAlarmsList() {
  const el = $('#alarmsList');
  el.innerHTML = '';
  const alarms = [...state.alarms].sort((a, b) => a.time - b.time);
  if (!alarms.length) {
    el.innerHTML = '<div class="empty">هشدار فعالی نیست. بگو: «هشدار ساعت ۲ بعد از ظهر»</div>';
    return;
  }
  for (const a of alarms) {
    const row = document.createElement('div');
    row.className = 'list-item';
    const main = document.createElement('div');
    main.textContent = '⏰ ' + fmtAlarmTime(a.time);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = a.label;
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'حذف';
    del.onclick = () => {
      clearTimeout(a.timerId);
      state.alarms = state.alarms.filter((x) => x.id !== a.id);
      saveAlarms();
      renderAlarmsList();
    };
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    row.append(main, del);
    el.appendChild(row);
  }
}

function renderContactsList() {
  const el = $('#contactsList');
  el.innerHTML = '';
  const cs = state.settings.contacts;
  if (!cs.length) {
    el.innerHTML = '<div class="empty">هنوز مخاطبی اضافه نکردی.</div>';
    return;
  }
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const row = document.createElement('div');
    row.className = 'list-item';
    const main = document.createElement('div');
    main.textContent = '👤 ' + c.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = toFaDigits(c.number);
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'حذف';
    del.onclick = () => {
      state.settings.contacts.splice(i, 1);
      saveSettings();
      renderContactsList();
    };
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    row.append(main, del);
    el.appendChild(row);
  }
}

function fillVoiceSelect() {
  if (!('speechSynthesis' in window)) return;
  const sel = $('#setVoice');
  const current = state.settings.voiceURI;
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = 'خودکار (اولین صدای فارسی موجود)';
  sel.appendChild(opt);
  for (const v of speechSynthesis.getVoices()) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    if (/^fa/i.test(v.lang)) o.textContent += ' ⭐';
    if (v.voiceURI === current) o.selected = true;
    sel.appendChild(o);
  }
}

/* ---------- راه‌اندازی ---------- */

function wireUI() {
  coreBtn.addEventListener('click', () => {
    if (!state.rec) {
      addBubble('jarvis', 'این مرورگر از تشخیص گفتار پشتیبانی نمی‌کنه. با کروم اندروید و آدرس https باز کن. (موزی هم دستور رو بنویس، جواب میدم!)');
      return;
    }
    if (state.wakeListening) { stopWake(); addBubble('jarvis', 'حالت گوش دادن خاموش شد.'); return; }
    startOneShot();
  });

  $('#wakeToggle').addEventListener('change', (e) => {
    if (!state.rec) { e.target.checked = false; return; }
    if (e.target.checked) startWake();
    else stopWake();
  });

  $('#sendBtn').addEventListener('click', sendText);
  $('#cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendText(); }
  });
  function sendText() {
    const v = $('#cmdInput').value.trim();
    if (!v) return;
    $('#cmdInput').value = '';
    handleCommand(v);
  }

  $('#btnAlarms').addEventListener('click', () => { renderAlarmsList(); $('#dlgAlarms').showModal(); });
  $('#alarmsClose').addEventListener('click', () => $('#dlgAlarms').close());

  $('#btnContacts').addEventListener('click', () => { renderContactsList(); $('#dlgContacts').showModal(); });
  $('#contactClose').addEventListener('click', () => $('#dlgContacts').close());
  $('#contactAdd').addEventListener('click', () => {
    const name = $('#contactName').value.trim();
    let number = toEnDigits($('#contactNumber').value).replace(/[\s-]/g, '');
    if (!name) { alert('اسم مخاطب رو بنویس'); return; }
    if (!/^\+?\d{8,15}$/.test(number)) { alert('شماره معتبر نیست. مثلا: 09121234567'); return; }
    state.settings.contacts.push({ name, number });
    saveSettings();
    $('#contactName').value = '';
    $('#contactNumber').value = '';
    renderContactsList();
    addBubble('jarvis', `مخاطب «${name}» ذخیره شد ✅ حالا بگو: «با ${name} تماس بگیر»`);
  });

  $('#btnSettings').addEventListener('click', () => {
    const s = state.settings;
    $('#setAI').checked = !!s.aiEnabled;
    $('#setBase').value = s.apiBase || 'https://api.openai.com/v1';
    $('#setKey').value = s.apiKey || '';
    $('#setModel').value = s.model || 'gpt-4o-mini';
    fillVoiceSelect();
    $('#dlgSettings').showModal();
  });
  $('#setClose').addEventListener('click', () => $('#dlgSettings').close());
  $('#setSave').addEventListener('click', () => {
    const s = state.settings;
    s.aiEnabled = $('#setAI').checked;
    s.apiBase = $('#setBase').value.trim() || 'https://api.openai.com/v1';
    s.apiKey = $('#setKey').value.trim();
    s.model = $('#setModel').value.trim() || 'gpt-4o-mini';
    s.voiceURI = $('#setVoice').value;
    saveSettings();
    $('#dlgSettings').close();
    addBubble('jarvis', 'تنظیمات ذخیره شد ✅');
    if (s.aiEnabled && s.apiKey) state.history = [];
  });
  $('#setTest').addEventListener('click', () => { $('#dlgSettings').close(); testAI(); });

  $('#alarmStop').addEventListener('click', () => {
    $('#alarmOverlay').hidden = true;
    stopAlarmSound();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkAlarms();
  });
  setInterval(checkAlarms, 20000);

  // دکمه نصب PWA
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#installBar').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBar').hidden = true;
  });
}

function init() {
  loadState();
  wireUI();
  setCoreState('idle');

  state.rec = initRecognition();
  if (!state.rec) {
    addBubble('jarvis', '⚠️ این مرورگر از تشخیص گفتار (میکروفن) پشتیبانی نمی‌کنه. با کروم اندروید امتحان کن. فعلاً می‌تونی دستورت رو بنویسی، جواب میدم!');
  } else {
    addBubble('jarvis', 'سلام! من جارویس‌ام 🤖\nبرای شروع دکمه وسط رو لمس کن و حرف بزن، یا «حالت گوش دادن» رو روشن کن و فقط بگو: «جارویس».\nبرای دیدن کارهایی که بلدم، بگو «راهنما».');
  }

  // زمان‌بندی دوباره هشدارهای قبلی
  const now = Date.now();
  const missed = state.alarms.filter((a) => a.time <= now);
  if (missed.length) {
    addBubble('jarvis', `⏰ ${toFaDigits(String(missed.length))} تا هشدار موقع بسته بودن برنامه زمانشون گذشته: ` + missed.map((a) => fmtAlarmTime(a.time)).join('، '));
    state.alarms = state.alarms.filter((a) => a.time > now);
    saveAlarms();
  }
  for (const a of state.alarms) scheduleAlarm(a);
  renderAlarmsList();

  // سرویس‌ورکر (فقط روی https یا localhost)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed:', e));
  }

  // اگه کاربر قبلاً حالت گوش دادن رو روشن گذاشته بود
  if (state.settings.wakeMode && state.rec) {
    setTimeout(() => startWake(), 800);
  }

  // برای تست و دیباگ: window.jarvis
  window.jarvis = {
    handle: handleCommand,
    state,
    addAlarm,
    findContact,
    wikiLookup,
    parseAlarmTime,
    speak,
  };
}

document.addEventListener('DOMContentLoaded', init);
