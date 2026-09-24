# FireCheck — ระบบตรวจเช็คถังดับเพลิง (เวอร์ชันแก้ไข v2)

เว็บแอปตรวจเช็คถังดับเพลิง รองรับมือถือ/คอมพิวเตอร์ มี Dashboard, QR Code, GPS, ลายเซ็นดิจิทัล, ถ่ายรูป และรายงาน
Frontend = `index.html` · Backend = `Code.gs` (Google Apps Script + Sheets + Drive + Gmail)

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | หน้าเว็บทั้งหมด |
| `Code.gs` | Backend: login/session, ตรวจสิทธิ์ตามบทบาท, ฐานข้อมูลใน Google Sheets, เก็บรูปใน Drive, แจ้งเตือน |

---

## ⚠️ ถ้าใช้เวอร์ชันเดิมอยู่แล้ว ให้ทำตามนี้ก่อน (อัปเดต)

1. **วาง `Code.gs` ใหม่ทับของเดิม** ใน Apps Script แล้วบันทึก
2. รันฟังก์ชัน `setupSheets` หนึ่งครั้ง (เพิ่มคอลัมน์ `salt`, ตั้งคอลัมน์ให้เป็นข้อความล้วนเพื่อกันวันที่/แรงดันเพี้ยน)
   *(ถ้าลืม ระบบจะทำให้เองอัตโนมัติในคำขอแรก)*
3. **Deploy เป็น New deployment ใหม่** (Deploy > New deployment > Web app) แล้วนำ URL ใหม่ไปใส่ `API_URL` ใน `index.html`
   จากนั้น **Archive deployment เก่า** (Deploy > Manage deployments) — URL เก่าเปิดให้เรียกได้โดยไม่ต้อง login จึงไม่ควรใช้ต่อ
4. บัญชีผู้ใช้เดิมใช้ได้ทันที รหัสผ่านจะถูกอัปเกรดเป็นแบบมี salt อัตโนมัติเมื่อ login สำเร็จครั้งแรก
   ถ้าในชีต `Users` มีบัญชีตัวอย่าง (`admin123`, `insp123` ฯลฯ) **ให้ลบหรือเปลี่ยนรหัสผ่าน**
   (ใช้ `resetPassword` ตามด้านล่าง)
5. ใน Google Drive เปิดโฟลเดอร์ `FireCheck_Photos` แล้ว **ยกเลิกการแชร์แบบ "Anyone with the link"** ของโฟลเดอร์/ไฟล์เดิม
   (เวอร์ชันใหม่เก็บเป็น private และส่งรูปผ่านแอปให้เฉพาะคนที่ login แล้ว)
6. ตั้งเขตเวลา: Apps Script > Project Settings > Time zone = `Asia/Bangkok`

## ติดตั้งใหม่

1. สร้าง Google Sheet ชื่อ `FireCheck_DB` > Extensions > Apps Script > วาง `Code.gs`
2. แก้ `ADMIN_EMAIL` ใน `Code.gs`
3. รัน `setupSheets` (อนุญาตสิทธิ์ Sheets/Drive/Gmail)
4. **สร้างแอดมินคนแรก:** แก้ค่า `PASSWORD` (ฯลฯ) ในฟังก์ชัน `bootstrapAdmin` → รัน → **ลบรหัสผ่านออกจากโค้ดทันที**
5. Deploy > New deployment > Web app — Execute as: **Me**, Who has access: **Anyone** (ทุกคำขอต้องมี token จึงปลอดภัยตามที่ออกแบบ)
   หรือ "Anyone within organization" ถ้าใช้ Google Workspace
6. คัดลอก Web App URL ไปใส่ `const API_URL = '...'` ใน `index.html` แล้วนำ `index.html` ไปโฮสต์
7. ตั้ง Trigger: ฟังก์ชัน `dailyExpiryCheck` แบบ Time-driven > Day timer

**Demo Mode:** ถ้า `API_URL` ว่าง เปิด `index.html` ได้เลย ใช้ข้อมูลจำลองในหน่วยความจำ (หายเมื่อรีเฟรช)
บัญชีทดลอง: `admin/admin123`, `inspector/insp123`, `supervisor/sup123`, `exec/exec123` (ใช้ได้เฉพาะ Demo Mode)

## การตั้งค่าแจ้งเตือน

- **อีเมล:** `ADMIN_EMAIL` — ส่งเมื่อผลตรวจไม่ผ่าน / มีผู้สมัครใหม่ / สรุปรายวัน
- **LINE:** LINE Notify ปิดบริการแล้ว ใช้ **LINE Messaging API** แทน — ตั้งใน Apps Script > Project Settings > **Script properties**:
  `LINE_CHANNEL_TOKEN` (Channel access token) และ `LINE_TO` (userId/groupId ปลายทาง) — ค่าลับจึงไม่อยู่ในโค้ด
- **รอบตรวจ:** `INSPECT_INTERVAL_DAYS` (ค่าเริ่มต้น 30 วัน) — `dailyExpiryCheck` จะเตือนถังที่เลยรอบตรวจ/ยังไม่เคยตรวจ และถังใกล้หมดอายุ (`NOTIFY_DAYS_BEFORE_EXPIRE`)

## จัดการผู้ใช้

- ผู้ใช้สมัครเองจากหน้า login → ได้บทบาท `inspector` และ **รออนุมัติ** เสมอ (บังคับที่ server) → admin อนุมัติ/ระงับที่ หน้า Admin
- ระงับผู้ใช้แล้ว token เดิมใช้ไม่ได้ทันที
- รีเซ็ตรหัสผ่าน / สร้างผู้ใช้ด้วยมือ: รัน `resetPassword('username','รหัสใหม่')` หรือ `createUser(...)` ใน Apps Script Editor (แก้ค่าแล้วรันผ่านฟังก์ชันชั่วคราว หรือใช้ debugger) — รหัสผ่านต้องยาวอย่างน้อย 8 ตัว

## สิทธิ์ตามบทบาท (บังคับที่ Backend — `ACTION_ROLES` ใน `Code.gs`)

| action | admin | supervisor | inspector | exec |
|---|:-:|:-:|:-:|:-:|
| `listExtinguishers` `getExtinguisher` `listInspections` `dashboard` `getFile` | ✓ | ✓ | ✓ | ✓ |
| `submitInspection` | ✓ | ✓ | ✓ | – |
| `createExt` `updateExt` `deleteExt` | ✓ | – | – | – |
| `listUsers` `setUserActive` `listLog` | ✓ | – | – | – |
| `login` `register` `logout` | ไม่ต้อง login (`logout` ต้องมี token) | | | |

รูปแบบคำขอทั้งหมด: `POST` (`Content-Type: text/plain`) ด้วย body `{"action":"...","payload":{...},"token":"..."}`
`GET` ไม่คืนข้อมูลใด ๆ (ยกเว้น `?action=ping`)

## สิ่งที่แก้ไขในเวอร์ชันนี้

**ความปลอดภัย**
- ระบบ session token (เก็บใน CacheService อายุ 6 ชม. ต่ออายุเมื่อใช้งาน) + ตรวจบทบาทที่ backend ทุก action
- ผู้ตรวจ (`inspector`) ในผลตรวจมาจาก session ไม่ใช่ค่าที่ client ส่ง; ผล ผ่าน/ไม่ผ่านและสถานะถังคำนวณที่ server
- รหัสผ่าน: salt + hash หลายรอบ (บัญชีเก่าอัปเกรดอัตโนมัติ), เปรียบเทียบแบบ constant-time
- จำกัดการเดารหัส: ผิด 5 ครั้งต่อ username ล็อก 15 นาที (ที่ backend); จำกัดการสมัครสมาชิก 20 คน/ชม.
- ตอบ "รออนุมัติ" เฉพาะเมื่อรหัสผ่านถูกต้อง (ไม่เปิดเผยว่ามีบัญชีนั้นอยู่)
- กัน formula injection ใน Sheets; ตรวจข้อมูลนำเข้า (ความยาว, รูปแบบวันที่, พิกัด, ประเภทถัง); ไม่รับ `status`/`role`/`qrCode` จาก client
- รูปและลายเซ็นเป็น private (ไม่แชร์ลิงก์) — โหลดผ่าน `getFile` เฉพาะผู้ที่ login และเฉพาะไฟล์ในโฟลเดอร์ `FireCheck_Photos`; รับเฉพาะ JPEG/PNG/WebP ≤ 4 MB
- ข้อผิดพลาดภายในไม่เปิดเผยรายละเอียดให้ client; ค่า LINE token ย้ายไป Script Properties; เอา Web App URL จริงออกจาก `index.html`

**บั๊ก / ฟังก์ชันที่ไม่ครบ**
- เพิ่ม `register`, `listUsers`, `setUserActive`, `listLog`, `logout`, `getFile` ที่หน้าเว็บเรียกใช้แต่ backend เดิมไม่มี; `login` รองรับสถานะรออนุมัติ
- แก้ `active` ที่เป็นข้อความ `"FALSE"` แล้วถูกมองว่าเป็นจริง
- **หน้าประวัติการตรวจ error เมื่อเชื่อม backend จริง** (`h.gps` ไม่มีค่า) — แก้แล้ว และแสดงรูป/ลายเซ็นจาก Drive ได้
- สถานะ "แรงดันต่ำ" ถูกบันทึกลงชีต ไม่หายเมื่อรีเฟรช
- แท็บ Log ดึงจากชีต `ActivityLog` จริง (เดิมเห็นเฉพาะ session ปัจจุบัน)
- Restore JSON ปิดในโหมดจริง (เดิมกู้แค่ในเบราว์เซอร์แล้วถูกซิงค์ทับ)
- ฟอร์มถังมีช่องละติจูด/ลองจิจูด + ปุ่มใช้ตำแหน่งปัจจุบัน; เลิกใส่พิกัดสมมติ (13.75, 100.50); ไม่แสดงแถว GPS ถ้าไม่มีพิกัด
- วันที่/แรงดัน/รหัสถังเก็บเป็นข้อความ (กัน `85%` กลายเป็น `0.85`, ตัดเลข 0 นำหน้า, วันที่เลื่อนเพราะเขตเวลา)
- ป้องกันเขียนชนกันด้วย `LockService`; เขียนแถวเดียวในครั้งเดียว; รหัสถังห้ามซ้ำ
- LINE Notify → LINE Messaging API; อีเมลแจ้งเตือนระบุรายการที่ผิดปกติ; `dailyExpiryCheck` เตือนเลยรอบตรวจด้วย
- หน้า Settings เอาสวิตช์ที่ไม่ทำงานออก; รหัสผ่านสมัครใหม่ขั้นต่ำ 8 ตัว

## ข้อจำกัดที่ยังเหลือ

- session เก็บใน CacheService (best-effort) — อาจถูกล้างเองก่อนครบ 6 ชม. ผู้ใช้จะต้อง login ใหม่ และรีเฟรชหน้าเว็บก็ต้อง login ใหม่ (token อยู่ในหน่วยความจำ ไม่ใช้ localStorage)
- Apps Script ไม่ให้ข้อมูล IP จึงจำกัดการเดารหัสได้ต่อ username เท่านั้น (ผู้โจมตีอาจล็อกบัญชีคนอื่นชั่วคราวได้)
- ยังไม่มี flow อนุมัติผลตรวจ/ลายเซ็นหัวหน้างาน (คอลัมน์ `supervisorSignatureUrl` ยังว่าง) และยังไม่มีหน้าเปลี่ยนรหัสผ่านด้วยตนเอง
- ข้อมูลรูปในตารางประวัติโหลดทีละรูปผ่าน backend จึงช้ากว่าลิงก์ตรง — แลกกับความเป็นส่วนตัว
- Google Sheets เหมาะกับข้อมูลระดับหลักพัน–หมื่นแถว หากโตกว่านั้นควรย้ายไปฐานข้อมูลจริง

## การทดสอบที่ทำแล้ว

จำลองบริการของ Apps Script (Sheets/Cache/Drive/Mail) แล้วรัน `Code.gs` จริง 57 กรณี (login, สิทธิ์ทุกบทบาท, สมัคร/อนุมัติ/ระงับ, ตรวจเช็ค, รูป, formula injection, วันที่) และเปิด `index.html` ใน jsdom เชื่อมกับ backend นั้น 22 กรณี (login → โหลดข้อมูล → ประวัติ → เพิ่มถัง → Admin → logout/หมดอายุ) รวมทั้ง Demo Mode
**ยังไม่ได้ทดสอบบน Google Apps Script จริง** — หลัง deploy ควรลอง login, ตรวจเช็คพร้อมรูป และอนุมัติผู้ใช้หนึ่งรอบ และตรวจว่าเวลาตอบสนองของ login ยอมรับได้ (ถ้าช้า ลด `HASH_ROUNDS`)
