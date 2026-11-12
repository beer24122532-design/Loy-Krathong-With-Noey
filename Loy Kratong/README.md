# ลอยกระทงออนไลน์ (Loy Krathong Online)

เว็บไซต์ลอยกระทงแบบผู้ใช้หลายคนพร้อมกัน ทุกคนเห็นกระทงและคำอธิษฐานของกันแบบ Real-time
ผ่าน Firebase Anonymous Authentication + Cloud Firestore (onSnapshot)

## โครงสร้างข้อมูล Firestore

| Collection | หน้าที่ | สิทธิ์ |
|---|---|---|
| `krathongs/{id}` | กระทง: id, userId, ownerName, wishMessage, krathongType, positionX, positionY, createdAt, status | อ่าน: ทุกคน / สร้าง: Anonymous user เท่านั้น / แก้ไข-ลบ: ไม่ได้ |
| `users/{uid}` | ใช้จำกัดอัตรา 1 กระทง / 20 วินาที | อ่าน-เขียน: เจ้าของเท่านั้น |
| `stats/global` | ตัวนับกระทงทั้งหมดแบบ Real-time | อ่าน: ทุกคน / +1 ได้เฉพาะเมื่อสร้างกระทงจริง |
| `presence/{uid}` | สัญญาณออนไลน์ (Heartbeat ทุก 30 วินาที) | อ่าน: ทุกคน / เขียน: เจ้าของเท่านั้น |

## ขั้นตอนที่ 1: สร้างโปรเจกต์ Firebase
1. เข้า https://console.firebase.google.com แล้วกด **Create a project / Add project**
2. ตั้งชื่อโปรเจกต์ (เช่น `loy-krathong-online`) จะเปิดหรือปิด Google Analytics ก็ได้
3. ในหน้า Project Overview กดไอคอน **Web `</>`** เพื่อเพิ่ม Web App
4. คัดลอกค่า `firebaseConfig` ที่แสดง

## ขั้นตอนที่ 2: ใส่ Firebase Configuration
เปิดไฟล์ **`public/js/firebase-config.js`** แล้ววางค่าแทน `YOUR_...` ทั้งหมด
และแก้ `YOUR_PROJECT_ID` ในไฟล์ **`.firebaserc`** ให้เป็น Project ID ของคุณ

> ค่า apiKey ของ Firebase Web ไม่ใช่ความลับ ความปลอดภัยมาจาก Security Rules
> ห้ามใส่ Service Account / Admin SDK / Private Key ในโปรเจกต์นี้

## ขั้นตอนที่ 3: เปิดใช้งาน Anonymous Authentication
1. Firebase Console → **Build → Authentication** → กด **Get started**
2. แท็บ **Sign-in method** → เลือก **Anonymous** → เปิด **Enable** → **Save**
3. (ถ้าใช้ Hosting อื่นที่ไม่ใช่ Firebase) แท็บ **Settings → Authorized domains** → เพิ่มโดเมนของคุณ

## ขั้นตอนที่ 4: สร้าง Firestore Database
1. Firebase Console → **Build → Firestore Database** → **Create database**
2. เลือก Location เช่น `asia-southeast1 (Singapore)` (เปลี่ยนภายหลังไม่ได้)
3. เลือก **Start in production mode** → **Create**
4. ติดตั้ง Rules (เลือกวิธีใดวิธีหนึ่ง)
   - **CLI (แนะนำ):** `firebase deploy --only firestore:rules`
   - **Console:** แท็บ **Rules** → วางเนื้อหาไฟล์ `firestore.rules` → **Publish**

ไม่ต้องสร้าง Collection เอง ระบบจะสร้างให้อัตโนมัติเมื่อมีกระทงใบแรก

## ขั้นตอนที่ 5: ทดสอบในเครื่อง
เว็บใช้ ES Modules จึง **เปิดไฟล์ด้วยการดับเบิลคลิก (file://) ไม่ได้** ต้องรันผ่าน Web Server:
```bash
npx serve public
# หรือ
firebase emulators:start --only hosting
```
แล้วเปิด http://localhost:3000 (หรือพอร์ตที่แสดง)

## ขั้นตอนที่ 6: Deploy ขึ้น Firebase Hosting
```bash
npm install -g firebase-tools
firebase login
firebase use YOUR_PROJECT_ID
firebase deploy
```
เว็บจะออนไลน์ที่ `https://YOUR_PROJECT_ID.web.app` ส่งลิงก์นี้ให้ทุกคนเข้าใช้งานได้ทันที

### ทางเลือก: Static Hosting อื่น (Netlify / Vercel / GitHub Pages)
1. อัปโหลดเฉพาะโฟลเดอร์ `public/`
2. Deploy Rules ผ่าน Firebase Console หรือ `firebase deploy --only firestore:rules`
3. เพิ่มโดเมนใน Authentication → Settings → Authorized domains
4. หมายเหตุ: Security Headers ใน `firebase.json` ใช้ได้กับ Firebase Hosting เท่านั้น

## ขั้นตอนที่ 7: ทดสอบหลายผู้ใช้
1. เปิด URL บนมือถือ (ผู้ใช้ A) และคอมพิวเตอร์ (ผู้ใช้ B)
2. A กด "เริ่มลอยกระทง" → เลือกแบบ → ใส่ชื่อ/คำอธิษฐาน → ยืนยัน
3. B จะเห็นกระทงของ A ปรากฏทันทีพร้อมแจ้งเตือน โดยไม่ต้องรีเฟรช
4. B คลิกกระทงของ A เพื่ออ่านคำอธิษฐาน แล้วสร้างกระทงของตัวเอง → A เห็นทันที
5. รีเฟรชหน้า: กระทงทั้งหมดยังอยู่ (โหลดจาก Firestore) และกระทงของคุณจะมีป้ายชื่อสีชมพู

## การแก้ปัญหา
| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| "ยังไม่ได้ตั้งค่า Firebase" | ยังไม่ได้แก้ `firebase-config.js` |
| "ยังไม่ได้เปิด Anonymous Authentication" | ทำขั้นตอนที่ 3 |
| "ไม่มีสิทธิ์อ่านข้อมูล" | ยังไม่สร้าง Database หรือยังไม่ Publish Rules |
| ส่งกระทงแล้ว "ระบบปฏิเสธการบันทึก" | ส่งถี่กว่า 20 วินาที หรือใช้อักขระ `<` `>` |
| หน้าเว็บค้างที่ "กำลังเชื่อมต่อ" | เปิดผ่าน file:// ให้ใช้ Web Server แทน หรือดู Console ของเบราว์เซอร์ |

## ความปลอดภัยที่มีในระบบ
- Rules ตรวจว่า `userId == request.auth.uid` และผู้ใช้ต้องเข้าสู่ระบบแบบ Anonymous
- ตรวจ Schema ทุกฟิลด์, ความยาวชื่อ ≤ 30 และคำอธิษฐาน ≤ 200, ห้ามมี `<` `>`, `createdAt` ต้องเป็นเวลาเซิร์ฟเวอร์
- Rate limit ฝั่งเซิร์ฟเวอร์: 1 กระทง / 20 วินาที / ผู้ใช้ ป้องกันการกดรัวทั้งฝั่งหน้าเว็บและฝั่งเซิร์ฟเวอร์
- ห้ามแก้ไขหรือลบกระทงจากฝั่งหน้าเว็บ
- ข้อความผู้ใช้แสดงผลผ่าน `textContent` เท่านั้น
- CSP Header จำกัดแหล่ง Script

## แนะนำเพิ่มเติมสำหรับใช้งานจริงจำนวนมาก
- เปิด **Firebase App Check** (reCAPTCHA v3) เพื่อกันบอท
- ตั้ง **Budget Alert** ใน Google Cloud Billing
- แผน Spark (ฟรี): อ่าน 50,000 ครั้ง/วัน และเขียน 20,000 ครั้ง/วัน ผู้เข้าชม 1 คนอ่านประมาณ 150 เอกสาร (กระทงล่าสุด) บวกกระทงวันนี้ ถ้าคาดว่าคนจะเข้ามาก ควรอัปเกรดเป็นแผน Blaze
- ลบกระทงที่ไม่เหมาะสมได้ผ่าน Firebase Console (ผู้ดูแลระบบ)