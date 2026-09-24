/**
 * ============================================================================
 *  FireCheck — ระบบตรวจเช็คถังดับเพลิง   (Backend v2: มีระบบ session/token + ตรวจสิทธิ์ตามบทบาท)
 *  Google Apps Script + Google Sheets + Google Drive + Gmail
 * ============================================================================
 *  ติดตั้ง/อัปเดต: ดู README.md
 *  สรุปหลักการ:
 *   - ทุกคำขอเป็น POST (text/plain) รูปแบบ {action, payload, token}
 *   - login/register ไม่ต้องมี token; ที่เหลือต้องมี token และบทบาทต้องตรงกับ ACTION_ROLES
 *   - ค่าลับ (LINE token) เก็บใน Script Properties ไม่เขียนไว้ในโค้ด
 * ============================================================================
 */

/* ------------------------- ค่าคงที่ / การตั้งค่า ------------------------- */
const SHEET_EXT = 'Extinguishers';
const SHEET_INSPECTIONS = 'Inspections';
const SHEET_USERS = 'Users';
const SHEET_LOG = 'ActivityLog';
const DRIVE_FOLDER_NAME = 'FireCheck_Photos';

const NOTIFY_DAYS_BEFORE_EXPIRE = 60;   // แจ้งเตือนล่วงหน้ากี่วันก่อนหมดอายุ
const INSPECT_INTERVAL_DAYS = 30;       // ถังที่ไม่ได้ตรวจเกินกี่วันถือว่า "เลยรอบตรวจ"
const LOW_PRESSURE_THRESHOLD = 70;      // แรงดัน (%) ต่ำกว่านี้ = แรงดันต่ำ
const ADMIN_EMAIL = 'safety-admin@example.com'; // <-- เปลี่ยนเป็นอีเมลผู้รับแจ้งเตือน

const SESSION_TTL_SEC = 21600;          // 6 ชม. (เพดานของ CacheService) ต่ออายุทุกครั้งที่ใช้งาน
const HASH_ROUNDS = 500;                // จำนวนรอบ hash รหัสผ่าน (ปรับได้)
const MAX_LOGIN_FAILS = 5;              // ผิดได้กี่ครั้งต่อ username
const LOGIN_LOCK_SEC = 900;             // ล็อก 15 นาที
const MAX_REGISTER_PER_HOUR = 20;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PHOTOS = 10;
const DEBUG_ERRORS = false;            // true = ส่งข้อความ error จริงกลับไปแสดงที่หน้าเว็บ (ใช้ตอนไล่ปัญหาเท่านั้น แล้วตั้งกลับเป็น false)

const RESULT_PASS = 'ผ่าน';
const RESULT_FAIL = 'ไม่ผ่าน';
const TYPES = ['CO2', 'Dry Chemical', 'Foam', 'Water', 'Clean Agent'];
const CHECK_LABELS = { gauge:'เข็มวัดแรงดัน', seal:'ซีล', pin:'สลัก', hose:'สายฉีด', nozzle:'หัวฉีด', body:'ตัวถัง',
  label:'ป้ายคำแนะนำ', expiry:'วันหมดอายุ', weight:'น้ำหนัก', position:'ตำแหน่งติดตั้ง', access:'การเข้าถึง/สิ่งกีดขวาง' };

const HEADERS = {
  [SHEET_EXT]: ['id','code','qrCode','serial','type','size','building','floor','room','lat','lng',
    'installDate','expireDate','company','owner','photoUrl','status','lastInspected','createdAt'],
  [SHEET_INSPECTIONS]: ['id','extId','date','inspector','pressure','checklistJSON','result','notes',
    'photoUrls','gpsLat','gpsLng','signatureUrl','supervisorSignatureUrl','createdAt'],
  [SHEET_USERS]: ['username','passwordHash','role','fullName','email','active','salt'],
  [SHEET_LOG]: ['timestamp','user','action','detail'],
};
// คอลัมน์ที่ต้องเป็น "ข้อความล้วน" (กัน Sheets แปลง 85% เป็น 0.85, ตัดเลข 0 นำหน้า, แปลงวันที่, หรือตีความ = เป็นสูตร)
const TEXT_COLS = {
  [SHEET_EXT]: ['id','code','qrCode','serial','type','size','building','floor','room','installDate','expireDate',
    'company','owner','photoUrl','status','lastInspected'],
  [SHEET_INSPECTIONS]: ['id','extId','date','inspector','pressure','checklistJSON','result','notes','photoUrls',
    'signatureUrl','supervisorSignatureUrl'],
  [SHEET_USERS]: ['username','passwordHash','role','fullName','email','salt'],
  [SHEET_LOG]: ['timestamp','user','action','detail'],
};
const TIMESTAMP_COLS = ['createdAt'];
// หัวคอลัมน์ที่ต้องเป็นข้อความเสมอ — ถ้า Sheets เก็บเป็นตัวเลข (เช่น รหัสถัง 1000000) จะแปลงกลับเป็นข้อความตอนอ่าน
const TEXT_HEADERS = Object.keys(TEXT_COLS).reduce((s, k) => { TEXT_COLS[k].forEach(h => { s[h] = true; }); return s; }, {});

/* สิทธิ์ของแต่ละ action ฝั่ง server (แหล่งความจริงเดียว — ฝั่งหน้าเว็บมีไว้แค่ซ่อนปุ่ม) */
const ALL_ROLES = ['admin', 'supervisor', 'inspector', 'exec'];
const ACTION_ROLES = {
  listExtinguishers: ALL_ROLES, getExtinguisher: ALL_ROLES, listInspections: ALL_ROLES,
  dashboard: ALL_ROLES, getFile: ALL_ROLES,
  createExt: ['admin'], updateExt: ['admin'], deleteExt: ['admin'],
  submitInspection: ['admin', 'supervisor', 'inspector'],
  listUsers: ['admin'], setUserActive: ['admin'], listLog: ['admin'],
};

/* ------------------------------ SETUP ------------------------------ */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(name => {
    const sheet = ensureSheet(ss, name, HEADERS[name]);
    applyTextFormats(sheet, name);
  });
  getOrCreatePhotoFolder();
  PropertiesService.getScriptProperties().setProperty('schema_v', '2');
  try {
    SpreadsheetApp.getUi().alert('ตั้งค่าฐานข้อมูลเรียบร้อย: ชีต Extinguishers, Inspections, Users, ActivityLog และโฟลเดอร์ Drive');
  } catch (e) { console.log('setupSheets เสร็จสิ้น'); }
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    // เพิ่มคอลัมน์ที่ยังไม่มี (เช่น salt) ต่อท้าย โดยไม่แตะข้อมูลเดิม
    const existing = headersOf(sheet);
    headers.forEach(h => { if (existing.indexOf(h) < 0) { existing.push(h); sheet.getRange(1, existing.length).setValue(h); } });
  }
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#C62828').setFontColor('#ffffff');
  return sheet;
}

function applyTextFormats(sheet, name) {
  const hdr = headersOf(sheet);
  (TEXT_COLS[name] || []).forEach(h => {
    const i = hdr.indexOf(h);
    if (i >= 0) sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

/** รันอัตโนมัติครั้งเดียวหลังอัปเดตโค้ด (ถ้ายังไม่ได้รัน setupSheets ใหม่) */
function ensureSchema() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('schema_v') === '2') return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(name => {
    if (!ss.getSheetByName(name)) fail('ยังไม่ได้รัน setupSheets()', 'SETUP');
    applyTextFormats(ensureSheet(ss, name, HEADERS[name]), name);
  });
  props.setProperty('schema_v', '2');
}

function getOrCreatePhotoFolder() {
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME); // ไม่แชร์ให้ใคร (private)
}

/* ------------------------------ ENTRY POINTS ------------------------------ */
function doGet(e) {
  // ปิดการอ่านข้อมูลผ่าน GET ทั้งหมด (ข้อมูลต้องผ่าน POST + token เท่านั้น)
  return jsonResponse(e && e.parameter && e.parameter.action === 'ping' ? { ok: true } : { error: 'ใช้ POST เท่านั้น', code: 'METHOD' });
}

function doPost(e) {
  let action = '';
  try {
    const body = JSON.parse(e.postData.contents);
    action = String(body.action || '');
    return jsonResponse(handle(action, body.payload || {}, body.token));
  } catch (err) {
    if (!err.code) console.error('[' + action + '] ' + (err.stack || err)); // ดูได้ที่ Apps Script > Executions
    const generic = DEBUG_ERRORS ? 'ข้อผิดพลาดภายใน [' + action + ']: ' + err.message : 'เกิดข้อผิดพลาดภายในระบบ';
    return jsonResponse({ error: err.code ? err.message : generic, code: err.code || 'INTERNAL' });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }
function fail(msg, code) { const e = new Error(msg); e.code = code || 'VALIDATION'; throw e; }

function handle(action, payload, token) {
  if (action === 'ping') return { ok: true };
  ensureSchema();
  if (action === 'login') return login(payload);
  if (action === 'register') return register(payload);
  if (action === 'logout') return logout(token);

  if (!has(ACTION_ROLES, action)) fail('Unknown action', 'BAD_ACTION');
  const s = getSession(token);
  if (!s) fail('กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED');
  if (ACTION_ROLES[action].indexOf(s.role) < 0) fail('คุณไม่มีสิทธิ์ทำรายการนี้', 'FORBIDDEN');

  switch (action) {
    case 'listExtinguishers': return listExtinguishers();
    case 'getExtinguisher': return getExtinguisher(payload.id);
    case 'listInspections': return listInspections(payload.extId);
    case 'dashboard': return getDashboardSummary();
    case 'getFile': return getFile(payload.fileId);
    case 'createExt': return createExtinguisher(s, payload);
    case 'updateExt': return updateExtinguisher(s, payload);
    case 'deleteExt': return deleteExtinguisher(s, payload.id);
    case 'submitInspection': return submitInspection(s, payload);
    case 'listUsers': return listUsers();
    case 'setUserActive': return setUserActive(s, payload);
    case 'listLog': return listLog();
  }
}

/* ------------------------------ SESSION ------------------------------ */
function createSession(u) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const s = { username: u.username, role: u.role, fullName: u.fullName, iat: Date.now() };
  CacheService.getScriptCache().put('sess:' + token, JSON.stringify(s), SESSION_TTL_SEC);
  return token;
}
function getSession(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess:' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  const rev = cache.get('rev:' + s.username);           // บัญชีถูกระงับหลังออก token นี้หรือไม่
  if (rev && s.iat <= Number(rev)) { cache.remove('sess:' + token); return null; }
  cache.put('sess:' + token, raw, SESSION_TTL_SEC);     // ต่ออายุ
  return s;
}
function revokeSessions(username) {
  CacheService.getScriptCache().put('rev:' + username, String(Date.now()), SESSION_TTL_SEC);
}
function logout(token) {
  if (token && typeof token === 'string') CacheService.getScriptCache().remove('sess:' + token);
  return { success: true };
}

/* ------------------------------ PASSWORD / USERS ------------------------------ */
function hashPassword(pw) { // แบบเดิม (SHA-256 ล้วน) เก็บไว้ตรวจบัญชีเก่า แล้วจะอัปเกรดให้อัตโนมัติเมื่อ login สำเร็จ
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw));
}
function newSalt() { return Utilities.getUuid().replace(/-/g, ''); }
function hashPasswordSalted(pw, salt) {
  const pwBytes = Utilities.newBlob(String(pw)).getBytes();
  let d = Utilities.newBlob(String(salt)).getBytes().concat(pwBytes);
  for (let i = 0; i < HASH_ROUNDS; i++) d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d).concat(pwBytes);
  return 'v2$' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d));
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function isActive(v) { return v === true || String(v).toLowerCase() === 'true'; }

function usersSheet() { return getSheet(SHEET_USERS); }
function findUser(sheet, username) {
  const idx = findRowIndex(sheet, 'username', username, true);
  if (idx < 0) return null;
  const hdr = headersOf(sheet);
  return { row: idx, u: rowToObject(hdr, sheet.getRange(idx, 1, 1, hdr.length).getValues()[0]) };
}

function login(p) {
  const username = String(p.username || '').trim().slice(0, 100);
  const password = String(p.password || '');
  const bad = { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  if (!username || !password) return bad;

  const cache = CacheService.getScriptCache();
  const key = 'lf:' + username.toLowerCase();
  const fails = Number(cache.get(key) || 0);
  if (fails >= MAX_LOGIN_FAILS) return { success: false, message: 'ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่' };

  const sheet = usersSheet();
  const found = findUser(sheet, username);
  let ok = false;
  if (found) {
    const u = found.u;
    ok = u.salt
      ? safeEqual(hashPasswordSalted(password, u.salt), u.passwordHash)
      : safeEqual(hashPassword(password), u.passwordHash);          // บัญชีเก่ายังไม่มี salt
    if (ok && !u.salt) {                                              // อัปเกรดเป็นแบบมี salt
      const salt = newSalt();
      updateRowFields(sheet, found.row, { salt: salt, passwordHash: hashPasswordSalted(password, salt) });
    }
  }
  if (!ok) { cache.put(key, String(fails + 1), LOGIN_LOCK_SEC); return bad; }
  cache.remove(key);

  if (!isActive(found.u.active)) {
    return { success: false, pending: true, message: 'บัญชีนี้ยังไม่ได้รับการอนุมัติจากแอดมิน กรุณารอการอนุมัติก่อนเข้าสู่ระบบ' };
  }
  if (ACTION_ROLES.listExtinguishers.indexOf(found.u.role) < 0) return bad; // role ในชีตไม่ถูกต้อง
  logActivity(found.u.username, 'เข้าสู่ระบบ', '');
  return {
    success: true,
    token: createSession(found.u),
    user: { username: found.u.username, role: found.u.role, fullName: found.u.fullName, email: found.u.email },
  };
}

function register(p) {
  const username = String(p.username || '').trim();
  const fullName = clean(p.fullName, 100);
  const email = clean(p.email, 100);
  const password = String(p.password || '');
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return { success: false, message: 'ชื่อผู้ใช้ต้องเป็นอักษรอังกฤษ ตัวเลข _ . - ยาว 3–30 ตัว' };
  if (!fullName) return { success: false, message: 'กรุณากรอกชื่อ-นามสกุล' };
  if (password.length < 8 || password.length > 128) return { success: false, message: 'รหัสผ่านต้องยาว 8–128 ตัวอักษร' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { success: false, message: 'รูปแบบอีเมลไม่ถูกต้อง' };

  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('regcount') || 0);
  if (n >= MAX_REGISTER_PER_HOUR) return { success: false, message: 'มีการสมัครสมาชิกมากเกินไป กรุณาลองใหม่ภายหลัง' };
  cache.put('regcount', String(n + 1), 3600);

  return withLock(() => {
    const sheet = usersSheet();
    if (findUser(sheet, username)) return { success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' };
    const salt = newSalt();
    // role และ active ถูกบังคับที่นี่เสมอ ไม่รับจาก client
    appendByHeaders(sheet, { username, passwordHash: hashPasswordSalted(password, salt), salt,
      role: 'inspector', fullName: safeCell(fullName), email: safeCell(email), active: false });
    logActivity(username, 'สมัครสมาชิก (รออนุมัติ)', fullName);
    try { MailApp.sendEmail(ADMIN_EMAIL, '[FireCheck] มีผู้สมัครใหม่รออนุมัติ', 'ชื่อผู้ใช้: ' + username + '\nชื่อ: ' + fullName); } catch (e) { /* โควตาอีเมล */ }
    return { success: true };
  });
}

function listUsers() {
  return readAll(usersSheet()).map(u => ({ username: u.username, fullName: u.fullName, role: u.role, email: u.email, active: isActive(u.active) }));
}

function setUserActive(s, p) {
  const username = String(p.username || '');
  const active = p.active === true;
  if (!active && username.toLowerCase() === s.username.toLowerCase()) fail('ไม่สามารถระงับบัญชีของตัวเองได้');
  return withLock(() => {
    const sheet = usersSheet();
    const found = findUser(sheet, username);
    if (!found) return { success: false, message: 'ไม่พบผู้ใช้' };
    updateRowFields(sheet, found.row, { active: active });
    if (!active) revokeSessions(found.u.username);
    logActivity(s.username, active ? 'อนุมัติผู้ใช้' : 'ระงับผู้ใช้', found.u.username);
    return { success: true };
  });
}

/** รันเองใน Apps Script Editor เพื่อสร้างแอดมินคนแรก — แก้ค่าด้านล่าง กด Run แล้วลบรหัสผ่านออกจากโค้ด */
function bootstrapAdmin() {
  const USERNAME = 'admin', PASSWORD = '12345678', FULLNAME = 'ผู้ดูแลระบบ', EMAIL = '';
  if (PASSWORD === 'ตั้งรหัสผ่านที่นี่') throw new Error('แก้ PASSWORD ในฟังก์ชันนี้ก่อนรัน และลบออกหลังรันเสร็จ');
  createUser(USERNAME, PASSWORD, 'admin', FULLNAME, EMAIL);
}
function createUser(username, password, role, fullName, email) {
  if (ALL_ROLES.indexOf(role) < 0) throw new Error('role ไม่ถูกต้อง');
  if (String(password).length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัว');
  const sheet = usersSheet();
  if (findUser(sheet, username)) throw new Error('มีชื่อผู้ใช้นี้แล้ว');
  const salt = newSalt();
  appendByHeaders(sheet, { username, passwordHash: hashPasswordSalted(password, salt), salt, role, fullName, email: email || '', active: true });
}
/** รันเองใน Editor (แก้ค่าในฟังก์ชัน) เพื่อรีเซ็ตรหัสผ่านผู้ใช้ */
function resetPassword(username, newPassword) {
  if (String(newPassword).length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัว');
  const sheet = usersSheet();
  const found = findUser(sheet, username);
  if (!found) throw new Error('ไม่พบผู้ใช้');
  const salt = newSalt();
  updateRowFields(sheet, found.row, { salt, passwordHash: hashPasswordSalted(newPassword, salt) });
  revokeSessions(found.u.username);
}

/* ------------------------------ EXTINGUISHERS ------------------------------ */
function listExtinguishers() { return readAll(getSheet(SHEET_EXT)); }
function getExtinguisher(id) { return listExtinguishers().find(e => e.id === String(id)) || null; }

function cleanExtFields(p, requireAll) {
  const out = {};
  const maxLen = { serial: 60, type: 30, size: 30, building: 60, floor: 20, room: 80, company: 100, owner: 100 };
  Object.keys(maxLen).forEach(k => { if (p[k] !== undefined) out[k] = safeCell(clean(p[k], maxLen[k])); });
  if (p.code !== undefined) {
    out.code = clean(p.code, 50);
    if (/^[=+\-@]/.test(out.code)) fail('รหัสถังห้ามขึ้นต้นด้วย = + - @');
    if (/[\r\n]/.test(out.code) || out.code.indexOf('FE:') === 0) fail('รหัสถังไม่ถูกต้อง');
  }
  if (out.type !== undefined && out.type && TYPES.indexOf(out.type) < 0) fail('ประเภทถังไม่ถูกต้อง');
  ['installDate', 'expireDate'].forEach(k => {
    if (p[k] === undefined) return;
    const v = String(p[k] || '').trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('รูปแบบวันที่ต้องเป็น yyyy-mm-dd');
    out[k] = v;
  });
  if (p.lat !== undefined) out.lat = parseCoord(p.lat, -90, 90);
  if (p.lng !== undefined) out.lng = parseCoord(p.lng, -180, 180);
  if (requireAll || out.code !== undefined) { if (!out.code) fail('กรุณาระบุรหัสถัง'); }
  if (requireAll || out.building !== undefined) { if (!out.building) fail('กรุณาระบุอาคาร'); }
  return out;
}

function createExtinguisher(s, p) {
  const f = cleanExtFields(p, true);
  return withLock(() => {
    const sheet = getSheet(SHEET_EXT);
    if (findRowIndex(sheet, 'code', f.code, true) > 0) fail('รหัสถังนี้มีอยู่แล้ว');
    const id = 'ext-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    appendByHeaders(sheet, Object.assign({ type: 'CO2' }, f, { id, qrCode: 'FE:' + f.code, status: 'not_inspected', createdAt: fmtTs(new Date()) }));
    logActivity(s.username, 'เพิ่มถังดับเพลิงใหม่', f.code);
    return { success: true, id };
  });
}

function updateExtinguisher(s, p) {
  const f = cleanExtFields(p, false);
  return withLock(() => {
    const sheet = getSheet(SHEET_EXT);
    const row = findRowIndex(sheet, 'id', p.id);
    if (row < 0) return { success: false, message: 'ไม่พบรายการ' };
    if (f.code !== undefined) {
      const dup = findRowIndex(sheet, 'code', f.code, true);
      if (dup > 0 && dup !== row) fail('รหัสถังนี้มีอยู่แล้ว');
      f.qrCode = 'FE:' + f.code;
    }
    updateRowFields(sheet, row, f);
    logActivity(s.username, 'แก้ไขข้อมูลถังดับเพลิง', f.code || p.id);
    return { success: true };
  });
}

function deleteExtinguisher(s, id) {
  return withLock(() => {
    const sheet = getSheet(SHEET_EXT);
    const row = findRowIndex(sheet, 'id', id);
    if (row < 0) return { success: false, message: 'ไม่พบรายการ' };
    sheet.deleteRow(row);
    logActivity(s.username, 'ลบถังดับเพลิง', id);
    return { success: true };
  });
}

/* ------------------------------ INSPECTIONS ------------------------------ */
function listInspections(extId) {
  let list = readAll(getSheet(SHEET_INSPECTIONS));
  if (extId) list = list.filter(i => i.extId === String(extId));
  return list;
}

/**
 * payload: {extId, date, pressure, checklist:{}, notes, photosBase64:[{data}], gpsLat, gpsLng, signatureBase64}
 * ผู้ตรวจ = ผู้ที่ login (จาก token) ไม่รับชื่อจาก client; ผล ผ่าน/ไม่ผ่าน และสถานะถัง คำนวณที่ server
 */
function submitInspection(s, p) {
  const ext = getExtinguisher(p.extId);
  if (!ext) fail('ไม่พบถังดับเพลิง');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : todayStr();

  const checklist = {};
  if (p.checklist && typeof p.checklist === 'object') {
    Object.keys(p.checklist).slice(0, 30).forEach(k => { checklist[String(k).slice(0, 30)] = String(p.checklist[k]).slice(0, 10); });
  }
  const failedKeys = Object.keys(checklist).filter(k => checklist[k] === 'bad');
  const result = failedKeys.length ? RESULT_FAIL : RESULT_PASS;
  const pressureNum = parseFloat(String(p.pressure));
  const pressure = isFinite(pressureNum) ? pressureNum + '%' : '';
  const status = result === RESULT_FAIL ? 'need_repair' : (isFinite(pressureNum) && pressureNum < LOW_PRESSURE_THRESHOLD ? 'low_pressure' : 'normal');
  const notes = safeCell(clean(p.notes, 1000));
  const gpsLat = parseCoord(p.gpsLat, -90, 90), gpsLng = parseCoord(p.gpsLng, -180, 180);

  // อัปโหลดรูปก่อน (ช้า) แล้วค่อยล็อกเฉพาะช่วงเขียนชีต
  const folder = getOrCreatePhotoFolder();
  const stamp = String(ext.code).replace(/[^\w-]/g, '_') + '_' + Date.now(); // code อาจเป็นตัวเลขถ้าชีตเก็บเป็น number
  const photoUrls = (Array.isArray(p.photosBase64) ? p.photosBase64 : []).slice(0, MAX_PHOTOS)
    .map((ph, i) => saveBase64Image(folder, ph && ph.data, 'photo_' + stamp + '_' + i));
  const sigUrl = p.signatureBase64 ? saveBase64Image(folder, p.signatureBase64, 'signature_' + stamp) : '';

  const id = withLock(() => {
    const newId = 'insp-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    appendByHeaders(getSheet(SHEET_INSPECTIONS), { id: newId, extId: ext.id, date, inspector: safeCell(s.fullName), pressure,
      checklistJSON: JSON.stringify(checklist), result, notes, photoUrls: photoUrls.join(','),
      gpsLat, gpsLng, signatureUrl: sigUrl, supervisorSignatureUrl: '', createdAt: fmtTs(new Date()) });
    const extSheet = getSheet(SHEET_EXT);
    const row = findRowIndex(extSheet, 'id', ext.id);
    if (row > 0) updateRowFields(extSheet, row, { lastInspected: date, status });
    logActivity(s.username, 'บันทึกผลตรวจ', ext.code + ' — ' + result);
    return newId;
  });

  if (result === RESULT_FAIL) notifyIssue(ext, { inspector: s.fullName, date, notes: p.notes, failedKeys });
  return { success: true, id, result, status };
}

function saveBase64Image(folder, dataUrl, filename) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  const m = comma > 0 ? /^data:(image\/(jpeg|png|webp));base64$/.exec(s.slice(0, comma)) : null;
  if (!m) fail('รูปแบบรูปภาพไม่ถูกต้อง (รองรับ JPEG/PNG/WebP)');
  const bytes = Utilities.base64Decode(s.slice(comma + 1));
  if (bytes.length > MAX_IMAGE_BYTES) fail('รูปภาพมีขนาดใหญ่เกิน 4 MB');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[m[1]];
  return folder.createFile(Utilities.newBlob(bytes, m[1], filename + '.' + ext)).getUrl(); // ไฟล์เป็น private
}

/** ส่งรูปให้ผู้ที่ login แล้วเท่านั้น และอ่านได้เฉพาะไฟล์ในโฟลเดอร์ FireCheck_Photos */
function getFile(fileId) {
  const id = String(fileId || '');
  if (!/^[\w-]{10,}$/.test(id)) fail('รหัสไฟล์ไม่ถูกต้อง');
  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { fail('ไม่พบไฟล์'); }
  const folder = getOrCreatePhotoFolder();
  const parents = file.getParents();
  if (!parents.hasNext() || parents.next().getId() !== folder.getId()) fail('ไม่มีสิทธิ์เข้าถึงไฟล์นี้', 'FORBIDDEN');
  const blob = file.getBlob();
  const mime = blob.getContentType();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) fail('ไม่ใช่ไฟล์รูปภาพ');
  return { dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/* ------------------------------ DASHBOARD / LOG ------------------------------ */
function getDashboardSummary() {
  const exts = listExtinguishers();
  const counts = {};
  exts.forEach(e => { counts[e.status] = (counts[e.status] || 0) + 1; });
  return { total: exts.length, counts };
}

function logActivity(user, action, detail) {
  getSheet(SHEET_LOG).appendRow([fmtTs(new Date()), String(user), String(action), safeCell(String(detail || '').slice(0, 300))]);
}
function listLog() {
  const sheet = getSheet(SHEET_LOG);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - 199);
  const hdr = headersOf(sheet);
  return sheet.getRange(start, 1, last - start + 1, hdr.length).getValues().map(r => rowToObject(hdr, r)).reverse();
}

/* ------------------------------ NOTIFICATIONS ------------------------------ */
function prop(name) { return PropertiesService.getScriptProperties().getProperty(name) || ''; }

function notifyIssue(ext, insp) {
  const items = (insp.failedKeys || []).map(k => CHECK_LABELS[k] || k).join(', ') || '-';
  const subject = '[FireCheck] ตรวจพบความผิดปกติ ' + String(ext.code).replace(/[\r\n]/g, ' ');
  const body = 'ถังดับเพลิง: ' + ext.code + ' (' + ext.building + ' ' + (ext.room || '') + ')\nผลตรวจ: ไม่ผ่าน\nรายการที่ผิดปกติ: ' + items +
    '\nผู้ตรวจ: ' + insp.inspector + '\nวันที่: ' + insp.date + '\nหมายเหตุ: ' + (insp.notes || '-');
  try { MailApp.sendEmail(ADMIN_EMAIL, subject, body); } catch (e) { console.error(e); }
  sendLine(body);
}

/** LINE Messaging API (แทน LINE Notify ที่ปิดบริการแล้ว) — ตั้ง LINE_CHANNEL_TOKEN และ LINE_TO ใน Script Properties */
function sendLine(message) {
  const token = prop('LINE_CHANNEL_TOKEN'), to = prop('LINE_TO');
  if (!token || !to) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: String(message).slice(0, 4900) }] }),
    });
  } catch (e) { console.error(e); }
}

/** ตั้ง Time-driven trigger รายวัน: แจ้งถังใกล้หมดอายุ / หมดอายุ / เลยรอบตรวจ / ยังไม่เคยตรวจ */
function dailyExpiryCheck() {
  const exts = listExtinguishers();
  const now = new Date();
  const expiring = [], overdue = [];
  exts.forEach(e => {
    const exp = new Date(e.expireDate);
    if (e.expireDate && !isNaN(exp)) {
      const d = (exp - now) / 86400000;
      if (d <= NOTIFY_DAYS_BEFORE_EXPIRE) expiring.push('- ' + e.code + ' (' + e.building + ') ' + (d < 0 ? 'หมดอายุแล้ว ' : 'หมดอายุ ') + e.expireDate);
    }
    const last = e.lastInspected ? new Date(e.lastInspected) : null;
    if (!last || isNaN(last)) overdue.push('- ' + e.code + ' (' + e.building + ') ยังไม่เคยตรวจ');
    else if ((now - last) / 86400000 > INSPECT_INTERVAL_DAYS) overdue.push('- ' + e.code + ' (' + e.building + ') ตรวจล่าสุด ' + e.lastInspected);
  });
  if (!expiring.length && !overdue.length) return;
  const body = (expiring.length ? 'ถังใกล้หมดอายุ/หมดอายุ:\n' + expiring.join('\n') + '\n\n' : '') +
               (overdue.length ? 'ถังเลยรอบตรวจ (' + INSPECT_INTERVAL_DAYS + ' วัน):\n' + overdue.join('\n') : '');
  MailApp.sendEmail(ADMIN_EMAIL, '[FireCheck] สรุปถังที่ต้องติดตามประจำวัน', body);
  sendLine(body);
}

/* ------------------------------ DIAGNOSE ------------------------------ */
/**
 * รันเองใน Apps Script Editor (เลือก diagnose > Run) แล้วดูผลที่ Execution log
 * ตรวจ: ชีต/คอลัมน์, ผู้ใช้แอดมิน, สิทธิ์ Drive/Mail/Lock/Cache, และข้อมูลถังที่อาจทำให้บันทึกผลตรวจพัง
 * ไม่แก้ไขข้อมูลใด ๆ (ไฟล์ทดสอบใน Drive จะถูกย้ายลงถังขยะทันที)
 */
function diagnose() {
  const out = [];
  const check = (name, fn) => {
    try { const r = fn(); out.push('OK    ' + name + (r ? ' — ' + r : '')); }
    catch (e) { out.push('FAIL  ' + name + ' — ' + e.message); }
  };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  check('สคริปต์ผูกกับ Google Sheet', () => ss.getName());
  Object.keys(HEADERS).forEach(n => check('ชีต ' + n, () => {
    const sh = ss.getSheetByName(n);
    if (!sh) throw new Error('ไม่พบชีตชื่อนี้ (ต้องสะกดตรงเป๊ะ) — ให้รัน setupSheets ใน Sheet ตัวเดียวกับที่ผูกสคริปต์');
    const have = headersOf(sh), miss = HEADERS[n].filter(h => have.indexOf(h) < 0);
    if (miss.length) throw new Error('ขาดคอลัมน์: ' + miss.join(', ') + ' — ให้รัน setupSheets ซ้ำ');
    return Math.max(0, sh.getLastRow() - 1) + ' แถวข้อมูล';
  }));
  check('schema_v (setupSheets/ensureSchema เคยรันสำเร็จ)', () => prop('schema_v') || 'ยังไม่ตั้งค่า (จะตั้งเองในคำขอแรก)');
  check('มีแอดมินที่เปิดใช้งานอย่างน้อย 1 คน', () => {
    const n = readAll(usersSheet()).filter(u => u.role === 'admin' && isActive(u.active)).length;
    if (!n) throw new Error('ไม่มี — รัน bootstrapAdmin');
    return n + ' คน';
  });
  check('Drive: สร้างโฟลเดอร์ + เขียนไฟล์ได้', () => {
    const f = getOrCreatePhotoFolder();
    f.createFile(Utilities.newBlob('diagnose', 'text/plain', 'diagnose.txt')).setTrashed(true);
    return f.getName();
  });
  check('LockService', () => withLock(() => 'ได้ล็อก'));
  check('CacheService', () => {
    const c = CacheService.getScriptCache(); c.put('diag', '1', 10);
    if (c.get('diag') !== '1') throw new Error('อ่านค่าที่เพิ่งเขียนไม่ได้');
    return 'ok';
  });
  check('เขตเวลาของ Sheet', () => tz());
  check('โควตาอีเมลคงเหลือวันนี้', () => MailApp.getRemainingDailyQuota() + ' ฉบับ');
  check('ข้อมูลถังใน Extinguishers', () => {
    const list = readAll(getSheet(SHEET_EXT)), seen = {}, prob = [];
    list.forEach((e, i) => {
      const row = i + 2;
      if (!e.id) prob.push('แถว ' + row + ' ไม่มี id');
      else if (seen[e.id]) prob.push('แถว ' + row + ' id ซ้ำกับแถว ' + seen[e.id]);
      else seen[e.id] = row;
      if (!String(e.code).trim()) prob.push('แถว ' + row + ' ไม่มีรหัสถัง');
      if (e.lat !== '' && !isFinite(Number(e.lat))) prob.push('แถว ' + row + ' ละติจูดไม่ใช่ตัวเลข (' + e.lat + ')');
      if (e.lng !== '' && !isFinite(Number(e.lng))) prob.push('แถว ' + row + ' ลองจิจูดไม่ใช่ตัวเลข (' + e.lng + ')');
    });
    if (prob.length) throw new Error(prob.slice(0, 10).join('; '));
    const rawCodes = getSheet(SHEET_EXT).getLastRow() > 1
      ? getSheet(SHEET_EXT).getRange(2, headersOf(getSheet(SHEET_EXT)).indexOf('code') + 1, getSheet(SHEET_EXT).getLastRow() - 1, 1).getValues().filter(r => typeof r[0] === 'number').length : 0;
    return list.length + ' ถัง ไม่พบปัญหา' + (rawCodes ? ' (มี ' + rawCodes + ' แถวที่รหัสถังในชีตเป็นตัวเลข — ระบบแปลงเป็นข้อความให้แล้ว แต่ควรพิมพ์ใหม่ในชีตให้เป็นข้อความ)' : '');
  });
  const report = out.join('\n');
  console.log(report);
  return report;
}

/* ------------------------------ SHEET HELPERS ------------------------------ */
function getSheet(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) fail('ยังไม่ได้รัน setupSheets()', 'SETUP');
  return sh;
}
function headersOf(sheet) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; }

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function tz() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Bangkok'; }
function fmtTs(d) { return Utilities.formatDate(d, tz(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function todayStr() { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd'); }

/** แปลง Date ที่ Sheets สร้างเอง (ข้อมูลเก่า) ให้เป็นข้อความ ไม่ให้วันที่เลื่อนตามเขตเวลา UTC */
function cellValue(header, v) {
  if (v instanceof Date) return TIMESTAMP_COLS.indexOf(header) >= 0 ? fmtTs(v) : Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  if (typeof v === 'number' && TEXT_HEADERS[header]) return String(v);
  return v;
}
function rowToObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = cellValue(h, row[i]); });
  return obj;
}
function readAll(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const h = vals.shift();
  return vals.map(r => rowToObject(h, r));
}
function findRowIndex(sheet, colName, value, ignoreCase) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const col = headersOf(sheet).indexOf(colName);
  if (col < 0) return -1;
  const norm = v => ignoreCase ? String(v).toLowerCase() : String(v);
  const vals = sheet.getRange(2, col + 1, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (norm(vals[i][0]) === norm(value)) return i + 2;
  return -1;
}
function appendByHeaders(sheet, obj) {
  sheet.appendRow(headersOf(sheet).map(h => (obj[h] === undefined ? '' : obj[h])));
}
function updateRowFields(sheet, rowIdx, fields) { // เขียนทั้งแถวในครั้งเดียว
  const hdr = headersOf(sheet);
  const range = sheet.getRange(rowIdx, 1, 1, hdr.length);
  const row = range.getValues()[0].map((v, i) => cellValue(hdr[i], v));
  hdr.forEach((h, i) => { if (fields[h] !== undefined) row[i] = fields[h]; });
  range.setValues([row]);
}

/* ------------------------------ INPUT SANITIZING ------------------------------ */
function clean(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max); }
/** กัน formula injection: ข้อความที่ขึ้นต้นด้วย = + - @ จะถูกเติมช่องว่างนำหน้าให้ Sheets มองเป็นข้อความ */
function safeCell(v) { return (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? ' ' + v : v; }
function parseCoord(v, min, max) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) fail('ค่าพิกัดไม่ถูกต้อง');
  return n;
}
