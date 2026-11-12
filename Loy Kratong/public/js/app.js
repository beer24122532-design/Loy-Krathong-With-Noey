/* =====================================================================
 *  Loy Krathong Online — app.js
 *  Vanilla JS + Firebase Auth (Anonymous) + Cloud Firestore (onSnapshot)
 * ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, query, orderBy, limit, where, onSnapshot,
  writeBatch, serverTimestamp, increment, setDoc, deleteDoc, getDoc, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------------- ค่าคงที่ (ต้องตรงกับ firestore.rules) ---------------- */
const CONFIG = Object.freeze({
  NAME_MAX: 30,
  WISH_MAX: 200,
  COOLDOWN_MS: 21_000,            // rules บังคับ 20 วินาที (เผื่อ 1 วินาที)
  MAX_RENDER: 150,                // จำนวนกระทงล่าสุดที่แสดงบนแม่น้ำ
  HEARTBEAT_MS: 30_000,           // ส่งสัญญาณออนไลน์ทุก 30 วินาที
  ONLINE_WINDOW_MS: 95_000,       // ถือว่าออนไลน์ถ้าส่งสัญญาณภายใน 95 วินาที
  PRESENCE_RESUBSCRIBE_MS: 5 * 60_000,
  WRITE_TIMEOUT_MS: 15_000,
});

const KRATHONG_TYPES = Object.freeze({
  banana:   { label: "ใบตองดั้งเดิม",   hint: "กระทงใบตองพับกลีบ ประดับดอกไม้หลากสี ตามแบบโบราณ" },
  lotus:    { label: "ดอกบัวชมพู",     hint: "กลีบบัวบานรับแสงจันทร์ สื่อถึงความบริสุทธิ์" },
  marigold: { label: "ดาวเรืองทอง",    hint: "ดอกดาวเรืองสีทอง อธิษฐานขอความรุ่งเรือง" },
  bread:    { label: "ขนมปังรักษ์ปลา",  hint: "ย่อยสลายได้และเป็นอาหารปลา รักษ์โลก" },
  coconut:  { label: "กะลามะพร้าว",    hint: "วัสดุธรรมชาติ เรียบง่ายแต่งดงาม" },
});
const TYPE_KEYS = Object.keys(KRATHONG_TYPES);
const FORBIDDEN_CHARS = /[<>]/;

/* สีแสงเทียน (ต้องตรงกับ flameColor ใน firestore.rules) */
const FLAME_COLORS = Object.freeze({
  gold:   { label: "ทองอร่าม",   flame: "#ffb347", flameHi: "#fff4c2", core: "rgba(255, 214, 120, .55)", mid: "rgba(255, 143, 208, .18)", halo: "rgba(255, 200, 120, .55)", glowStrong: "rgba(255,214,120,.5)",  glowSoft: "rgba(255,143,208,.2)" },
  pink:   { label: "ชมพูหวาน",   flame: "#ff8fb5", flameHi: "#ffe1ee", core: "rgba(255, 143, 208, .55)", mid: "rgba(124, 77, 204, .25)",  halo: "rgba(255, 143, 208, .6)",  glowStrong: "rgba(255,143,208,.5)",  glowSoft: "rgba(124,77,204,.22)" },
  blue:   { label: "ฟ้าน้ำแข็ง", flame: "#7ec9ff", flameHi: "#eaf7ff", core: "rgba(126, 201, 255, .5)",  mid: "rgba(80, 130, 255, .28)",  halo: "rgba(126, 201, 255, .6)",  glowStrong: "rgba(126,201,255,.45)", glowSoft: "rgba(80,130,255,.22)" },
  green:  { label: "เขียวหยก",   flame: "#8fe3a8", flameHi: "#eafff0", core: "rgba(143, 227, 168, .5)",  mid: "rgba(60, 180, 140, .3)",   halo: "rgba(143, 227, 168, .6)",  glowStrong: "rgba(143,227,168,.45)", glowSoft: "rgba(60,180,140,.22)" },
  purple: { label: "ม่วงอม่าน",  flame: "#c49aff", flameHi: "#f4e8ff", core: "rgba(196, 154, 255, .5)",  mid: "rgba(140, 80, 220, .3)",   halo: "rgba(196, 154, 255, .6)",  glowStrong: "rgba(196,154,255,.45)", glowSoft: "rgba(140,80,220,.22)" },
});
const FLAME_KEYS = Object.keys(FLAME_COLORS);

/* ธีมฉากหลัง (id ต้องตรงกับ <svg> ใน index.html) */
const SCENES = Object.freeze([
  { id: "scene-temple", label: "วัดเจดีย์" },
  { id: "scene-market", label: "ตลาดน้ำ" },
  { id: "scene-port",   label: "เมืองท่า" },
]);

/* ---------------- State ---------------- */
let app, auth, db;
const state = {
  user: null,
  selectedType: "banana",
  submitting: false,
  lastSubmitAt: 0,
  initialLoaded: false,
  pendingHighlightId: null,
  rendered: new Map(),       // id -> element
  data: new Map(),           // id -> krathong data
  presence: new Map(),       // uid -> lastSeen (ms)
  serverOffset: 0,           // serverTime - localTime (ms)
  awaitingBeatAck: false,
  lastBeatLocal: 0,
  totalFromServer: 0,
  lastAnnounceAt: 0,
  detailId: null,            // กระทงที่เปิดอ่านอยู่ (ใช้กับปุ่มแชร์การ์ด)
  sharing: false,
  flameColor: "gold",        // สีแสงเทียนของกระทงใหม่ (จำไว้ใน lk:flame)
  sceneIndex: 0,             // ธีมฉากปัจจุบัน (จำไว้ใน lk:scene)
  unsub: {},
  timers: {},
  retry: {},
};

/* ---------------- DOM ---------------- */
const $ = (sel) => document.querySelector(sel);
const els = {};
function cacheEls() {
  Object.assign(els, {
    layer: $("#krathong-layer"), riverEmpty: $("#river-empty"),
    statTotal: $("#stat-total"), statOnline: $("#stat-online"), statToday: $("#stat-today"),
    btnStart: $("#btn-start"), userStatus: $("#user-status"),
    netBanner: $("#net-banner"), toasts: $("#toasts"),
    setupPanel: $("#setup-panel"), setupTitle: $("#setup-title"), setupList: $("#setup-list"),
    createModal: $("#create-modal"), form: $("#create-form"), typeGrid: $("#type-grid"), typeHint: $("#type-hint"),
    nameInput: $("#owner-name"), wishInput: $("#wish-message"),
    nameError: $("#name-error"), wishError: $("#wish-error"),
    nameCount: $("#name-count"), wishCount: $("#wish-count"),
    previewArt: $("#preview-art"), previewName: $("#preview-name"), previewWish: $("#preview-wish"),
    formError: $("#form-error"), btnSubmit: $("#btn-submit"),
    detailModal: $("#detail-modal"), detailArt: $("#detail-art"), detailType: $("#detail-type"),
    detailName: $("#detail-name"), detailMine: $("#detail-mine"),
    detailWish: $("#detail-wish"), detailDate: $("#detail-date"),
    btnShare: $("#btn-share"), soundToggle: $("#sound-toggle"),
    showToggle: $("#show-toggle"), sceneToggle: $("#scene-toggle"),
    ticker: $("#wish-ticker"), flameGrid: $("#flame-grid"), detailArtWrap: $("#detail-art-wrap"),
  });
}

/* =====================================================================
 *  Utilities
 * ===================================================================== */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const nowServer = () => Date.now() + state.serverOffset;
const numberFmt = new Intl.NumberFormat("th-TH");
const dateFmt = new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeStyle: "short" });
const formatThaiDate = (ms) => `${dateFmt.format(new Date(ms))} น.`;

function hashString(str) {               // FNV-1a — ใช้กำหนดความเร็ว/จังหวะลอยแบบคงที่ต่อกระทง
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** ทำความสะอาดข้อความ: ตัด control chars / bidi override / ช่องว่างเกิน */
function cleanText(value, multiline = false) {
  let s = String(value ?? "").normalize("NFC");
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "");
  if (multiline) {
    s = s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  } else {
    s = s.replace(/\s+/g, " ");
  }
  return s.trim();
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getKrathongSVG(type) {
  const key = TYPE_KEYS.includes(type) ? type : "banana";
  return document.getElementById(`tpl-${key}`).content.firstElementChild.cloneNode(true);
}

function div(className) {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

/* =====================================================================
 *  UI feedback (ใช้ textContent ทั้งหมด)
 * ===================================================================== */
function toast(message, type = "info", ms = 3800) {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.textContent = message;
  els.toasts.append(t);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 400);
  }, ms);
}

function showNet(message, type = "error", autoHideMs = 0) {
  clearTimeout(state.timers.net);
  els.netBanner.textContent = message;
  els.netBanner.dataset.type = type;
  els.netBanner.hidden = false;
  if (autoHideMs) state.timers.net = setTimeout(hideNet, autoHideMs);
}
function hideNet() { els.netBanner.hidden = true; }

function setUserStatus(text, type = "info") {
  els.userStatus.textContent = text;
  els.userStatus.dataset.type = type;
}

function showSetupPanel(title, lines) {
  els.setupTitle.textContent = title;
  els.setupList.replaceChildren(...lines.map((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    return li;
  }));
  els.setupPanel.hidden = false;
}

function setStat(el, n) {
  const text = numberFmt.format(n);
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

/* =====================================================================
 *  Modals
 * ===================================================================== */
let lastFocus = null;
function openModal(modal) {
  clearTimeout(modal._closeTimer);
  lastFocus = document.activeElement;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
  const target = modal.querySelector("[data-autofocus]") || modal.querySelector(".modal-close");
  setTimeout(() => target?.focus({ preventScroll: true }), 60);
}
function closeModal(modal) {
  if (!modal || modal.hidden) return;
  modal.classList.remove("is-open");
  modal._closeTimer = setTimeout(() => {
    modal.hidden = true;
    lastFocus?.focus?.({ preventScroll: true });
  }, 220);
}
function topOpenModal() {
  const open = [...document.querySelectorAll(".modal")].filter((m) => !m.hidden);
  return open[open.length - 1] || null;
}
function trapFocus(e, modal) {
  const focusables = [...modal.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* =====================================================================
 *  ฟอร์มสร้างกระทง
 * ===================================================================== */
function buildTypePicker() {
  const frag = document.createDocumentFragment();
  TYPE_KEYS.forEach((key) => {
    const label = document.createElement("label");
    label.className = "type-option";
    label.dataset.type = key;

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "krathongType";
    input.value = key;
    input.className = "sr-only";
    input.checked = key === state.selectedType;

    const art = document.createElement("span");
    art.className = "type-art";
    art.append(getKrathongSVG(key));

    const name = document.createElement("span");
    name.className = "type-name";
    name.textContent = KRATHONG_TYPES[key].label;

    label.append(input, art, name);
    frag.append(label);
  });
  els.typeGrid.append(frag);
  els.typeGrid.addEventListener("change", (e) => {
    if (e.target.name === "krathongType") selectType(e.target.value);
  });
  selectType(state.selectedType);
}

function selectType(key) {
  if (!TYPE_KEYS.includes(key)) return;
  state.selectedType = key;
  els.typeGrid.querySelectorAll(".type-option").forEach((opt) =>
    opt.classList.toggle("is-selected", opt.dataset.type === key));
  els.typeHint.textContent = KRATHONG_TYPES[key].hint;
  els.previewArt.replaceChildren(getKrathongSVG(key));
}

/* ---------------- สีแสงเทียน (จำค่าไว้ใน localStorage ไม่เกี่ยวกับฐานข้อมูลจนกดลอย) ---------------- */
function buildFlamePicker() {
  const frag = document.createDocumentFragment();
  FLAME_KEYS.forEach((key) => {
    const c = FLAME_COLORS[key];
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "flame-option";
    opt.dataset.flame = key;
    opt.setAttribute("role", "radio");
    opt.setAttribute("aria-checked", String(key === state.flameColor));
    opt.setAttribute("aria-label", `สีแสงเทียน${c.label}`);

    const sw = document.createElement("span");
    sw.className = "flame-swatch";
    sw.style.setProperty("--sw-core", c.flame);
    sw.style.setProperty("--sw-hi", c.flameHi);
    sw.style.setProperty("--sw-halo", c.halo);

    const name = document.createElement("span");
    name.className = "flame-name";
    name.textContent = c.label;

    opt.append(sw, name);
    frag.append(opt);
  });
  els.flameGrid.append(frag);
  els.flameGrid.addEventListener("click", (e) => {
    const opt = e.target.closest(".flame-option");
    if (opt) selectFlame(opt.dataset.flame);
  });
  selectFlame(state.flameColor);
}

function selectFlame(key) {
  if (!FLAME_KEYS.includes(key)) return;
  state.flameColor = key;
  try { localStorage.setItem("lk:flame", key); } catch { /* จำไม่ได้ก็ใช้ค่าเริ่มต้น */ }
  els.flameGrid.querySelectorAll(".flame-option").forEach((opt) =>
    opt.setAttribute("aria-checked", String(opt.dataset.flame === key)));
  // .kt-glow ในตัวอย่างเป็นพี่น้องกับ #preview-art → ตั้งตัวแปรบน .kt-bob ที่ครอบทั้งคู่
  applyFlameVars(els.previewArt.parentElement, key);
}

/** ตั้งตัวแปรสีเทียนบนองค์ประกอบที่ครอบ SVG กระทง (CSS อ้างผ่าน var(--flame) ฯลฯ) */
function applyFlameVars(el, key) {
  if (!el) return;
  const c = FLAME_COLORS[key] || FLAME_COLORS.gold;
  el.style.setProperty("--flame", c.flame);
  el.style.setProperty("--flame-hi", c.flameHi);
  el.style.setProperty("--glow-core", c.core);
  el.style.setProperty("--glow-mid", c.mid);
}

function restoreFlame() {
  try {
    const saved = localStorage.getItem("lk:flame");
    if (saved && FLAME_KEYS.includes(saved)) state.flameColor = saved;
  } catch { /* ignore */ }
}

function updatePreviewText() {
  els.previewName.textContent = cleanText(els.nameInput.value) || "ชื่อของคุณ";
  els.previewWish.textContent = cleanText(els.wishInput.value, true) || "คำอธิษฐานของคุณจะปรากฏที่นี่...";
  els.nameCount.textContent = `${els.nameInput.value.length}/${CONFIG.NAME_MAX}`;
  els.wishCount.textContent = `${els.wishInput.value.length}/${CONFIG.WISH_MAX}`;
}

function liveCheck(input, errorEl) {
  const bad = FORBIDDEN_CHARS.test(input.value);
  errorEl.textContent = bad ? "ไม่อนุญาตให้ใช้อักขระ < หรือ >" : "";
  input.setAttribute("aria-invalid", String(bad));
}

function validateForm() {
  const ownerName = cleanText(els.nameInput.value);
  const wishMessage = cleanText(els.wishInput.value, true);
  const errors = {};

  if (!ownerName) errors.name = "กรุณากรอกชื่อผู้ลอย";
  else if (ownerName.length > CONFIG.NAME_MAX) errors.name = `ชื่อยาวได้ไม่เกิน ${CONFIG.NAME_MAX} ตัวอักษร`;
  else if (FORBIDDEN_CHARS.test(ownerName)) errors.name = "ไม่อนุญาตให้ใช้อักขระ < หรือ >";

  if (!wishMessage) errors.wish = "กรุณาเขียนคำอธิษฐาน";
  else if (wishMessage.length > CONFIG.WISH_MAX) errors.wish = `คำอธิษฐานยาวได้ไม่เกิน ${CONFIG.WISH_MAX} ตัวอักษร`;
  else if (FORBIDDEN_CHARS.test(wishMessage)) errors.wish = "ไม่อนุญาตให้ใช้อักขระ < หรือ >";

  if (!TYPE_KEYS.includes(state.selectedType)) errors.form = "กรุณาเลือกรูปแบบกระทง";

  els.nameError.textContent = errors.name || "";
  els.wishError.textContent = errors.wish || "";
  els.formError.textContent = errors.form || "";
  els.nameInput.setAttribute("aria-invalid", String(!!errors.name));
  els.wishInput.setAttribute("aria-invalid", String(!!errors.wish));
  if (errors.name) els.nameInput.focus();
  else if (errors.wish) els.wishInput.focus();

  return { ok: Object.keys(errors).length === 0, ownerName, wishMessage };
}

const cooldownLeft = () => Math.max(0, state.lastSubmitAt + CONFIG.COOLDOWN_MS - Date.now());

function refreshSubmitButton() {
  const btn = els.btnSubmit;
  const left = cooldownLeft();
  if (state.submitting) { btn.disabled = true; btn.textContent = "กำลังส่งกระทงลงน้ำ..."; }
  else if (!state.user) { btn.disabled = true; btn.textContent = "กำลังเชื่อมต่อ..."; }
  else if (left > 0) { btn.disabled = true; btn.textContent = `รออีก ${Math.ceil(left / 1000)} วินาที`; }
  else { btn.disabled = false; btn.textContent = "ยืนยันลอยกระทง"; }
}

function writeErrorMessage(err) {
  switch (err?.code) {
    case "permission-denied":
      return "ระบบปฏิเสธการบันทึก: อาจส่งถี่เกินไป (ต้องเว้น 20 วินาที) หรือข้อมูลไม่ผ่านการตรวจสอบ";
    case "unavailable":
      return "เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่";
    case "unauthenticated":
      return "ยังไม่ได้เข้าสู่ระบบ กรุณารีเฟรชหน้าเว็บ";
    case "timeout":
      return "เครือข่ายช้า ระบบจะส่งกระทงให้อัตโนมัติเมื่อการเชื่อมต่อกลับมา กรุณาอย่ากดซ้ำ";
    case "resource-exhausted":
      return "มีผู้ใช้งานจำนวนมาก โควตาฐานข้อมูลเต็มชั่วคราว กรุณาลองใหม่ภายหลัง";
    default:
      return "เกิดข้อผิดพลาด ไม่สามารถลอยกระทงได้ กรุณาลองใหม่";
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  if (state.submitting) return;                     // กันกดรัว

  els.formError.textContent = "";
  if (!state.user) { els.formError.textContent = "กำลังเข้าสู่ระบบ กรุณารอสักครู่"; return; }
  const left = cooldownLeft();
  if (left > 0) { els.formError.textContent = `กรุณารออีก ${Math.ceil(left / 1000)} วินาทีก่อนลอยกระทงใบถัดไป`; return; }
  if (!navigator.onLine) { els.formError.textContent = "คุณออฟไลน์อยู่ กรุณาเชื่อมต่ออินเทอร์เน็ตก่อน"; return; }

  const v = validateForm();
  if (!v.ok) return;

  state.submitting = true;
  refreshSubmitButton();

  try {
    const uid = state.user.uid;
    const ref = doc(collection(db, "krathongs"));    // สร้าง ID ล่วงหน้า
    const krathong = {
      id: ref.id,
      userId: uid,
      ownerName: v.ownerName,
      wishMessage: v.wishMessage,
      krathongType: state.selectedType,
      flameColor: state.flameColor,
      positionX: Math.round((8 + Math.random() * 47) * 100) / 100,  // จุดเริ่มต้นในแนวนอน (%)
      positionY: Math.round(Math.random() * 10000) / 100,           // เลนบนแม่น้ำ (%)
      createdAt: serverTimestamp(),
      status: "floating",
    };

    // Batch: กระทง + ข้อมูล rate-limit ของผู้ใช้ + ตัวนับรวม (Rules ตรวจทั้ง 3 รายการร่วมกัน)
    const batch = writeBatch(db);
    batch.set(ref, krathong);
    batch.set(doc(db, "users", uid), {
      lastKrathongAt: serverTimestamp(),
      lastKrathongId: ref.id,
      count: increment(1),
    }, { merge: true });
    batch.set(doc(db, "stats", "global"), {
      total: increment(1),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    state.pendingHighlightId = ref.id;
    await withTimeout(batch.commit(), CONFIG.WRITE_TIMEOUT_MS);
    state.lastSubmitAt = Date.now();

    // รับข้อมูลกระทงที่สร้างกลับมาจากฐานข้อมูล
    const snap = await getDoc(ref);
    const created = snap.exists() ? normalizeKrathong(snap) : null;
    if (created && !state.rendered.has(created.id)) addKrathong(created, true);
    highlightKrathong(ref.id);
    sound.splash();
    sound.chime();
    showerFx?.(6, true);          // ดาวตกสีทองฉลองกระทงของเรา
    requestAnimationFrame(() => spawnReleaseRipple(ref.id));

    try { localStorage.setItem("lk:ownerName", v.ownerName); } catch { /* เก็บแค่ชื่อที่ใช้ล่าสุด */ }
    els.wishInput.value = "";
    updatePreviewText();
    closeModal(els.createModal);
    toast(`ลอยกระทงของ “${v.ownerName}” สำเร็จแล้ว ขอให้คำอธิษฐานเป็นจริง`, "success", 5000);
    tickerSay(`${v.ownerName} ขอให้ ${wishShort(v.wishMessage)}`);   // โชว์บนแถบวิ่งเมื่อเปิดจอโชว์
  } catch (err) {
    console.error("[create krathong]", err);
    if (err?.code === "timeout") state.lastSubmitAt = Date.now();   // ป้องกันส่งซ้ำระหว่างรอคิว
    else state.pendingHighlightId = null;
    els.formError.textContent = writeErrorMessage(err);
  } finally {
    state.submitting = false;
    refreshSubmitButton();
  }
}

/* =====================================================================
 *  แม่น้ำและกระทง (Animation แยกจากข้อมูล — ไม่เขียน Firestore ระหว่างลอย)
 * ===================================================================== */
function normalizeKrathong(snap) {
  const d = snap.data({ serverTimestamps: "estimate" }) || {};
  const ownerName = typeof d.ownerName === "string" ? d.ownerName.slice(0, CONFIG.NAME_MAX) : "";
  const wishMessage = typeof d.wishMessage === "string" ? d.wishMessage.slice(0, CONFIG.WISH_MAX) : "";
  if (!ownerName || !wishMessage) return null;
  const createdAt = d.createdAt && typeof d.createdAt.toMillis === "function" ? d.createdAt.toMillis() : nowServer();
  return {
    id: snap.id,
    userId: typeof d.userId === "string" ? d.userId : "",
    ownerName,
    wishMessage,
    krathongType: TYPE_KEYS.includes(d.krathongType) ? d.krathongType : "banana",
    flameColor: FLAME_KEYS.includes(d.flameColor) ? d.flameColor : "gold",
    positionX: clamp(Number(d.positionX) || 0, 0, 100),
    positionY: clamp(Number(d.positionY) || 0, 0, 100),
    createdAt,
    status: typeof d.status === "string" ? d.status : "",
  };
}

/**
 * คำนวณการเคลื่อนไหวจากข้อมูลคงที่ (positionX/Y + createdAt)
 * ทุกเครื่องคำนวณได้ผลเหมือนกัน → เห็นกระทงอยู่ตำแหน่งใกล้เคียงกัน
 * โดยไม่ต้องเขียนตำแหน่งลงฐานข้อมูลเลย
 */
function computeMotion(k) {
  const h = hashString(k.id);
  const lane = k.positionY / 100;
  const dur = 75 + (h % 45);                                   // 75–119 วินาทีต่อรอบ
  const elapsed = Math.max(0, (nowServer() - k.createdAt) / 1000);
  const phase = ((k.positionX / 100) * dur + elapsed) % dur;
  return {
    top: 8 + lane * 78,
    scale: 0.6 + lane * 0.55,                                  // ใกล้ผู้ชม = ใหญ่ขึ้น
    z: 10 + Math.round(lane * 200),
    dur,
    delay: -phase,
    bob: 3 + (h % 30) / 10,
    bobDelay: -((h >>> 5) % 40) / 10,
    staticX: k.positionX * 0.9,
  };
}

function buildKrathongEl(k) {
  const el = div("krathong");
  el.dataset.id = k.id;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `กระทงของ ${k.ownerName} กดเพื่ออ่านคำอธิษฐาน`);

  const m = computeMotion(k);
  const st = el.style;
  st.setProperty("--top", `${m.top}%`);
  st.setProperty("--scale", m.scale.toFixed(3));
  st.setProperty("--z", String(m.z));
  st.setProperty("--dur", `${m.dur}s`);
  st.setProperty("--delay", `${m.delay.toFixed(2)}s`);
  st.setProperty("--bob", `${m.bob}s`);
  st.setProperty("--bob-delay", `${m.bobDelay}s`);
  st.setProperty("--static-x", `${m.staticX}vw`);

  const body = div("kt-body");
  const bob = div("kt-bob");
  bob.append(div("kt-glow"), getKrathongSVG(k.krathongType));
  body.append(div("kt-reflection"), bob);

  const name = div("kt-name");
  name.textContent = k.ownerName;                 // ข้อความผู้ใช้ → textContent เท่านั้น

  el.append(name, body);
  applyFlameVars(el, k.flameColor);
  el.classList.toggle("is-mine", !!state.user && k.userId === state.user.uid);
  return el;
}

function addKrathong(k, animateIn) {
  if (state.rendered.has(k.id)) { updateKrathong(k); return; }
  state.data.set(k.id, k);
  const el = buildKrathongEl(k);
  if (animateIn) {
    el.classList.add("kt-new");
    setTimeout(() => el.classList.remove("kt-new"), 4000);
  }
  state.rendered.set(k.id, el);
  els.layer.append(el);
  if (k.id === state.pendingHighlightId) highlightKrathong(k.id);
}

function updateKrathong(k) {
  state.data.set(k.id, k);
  const el = state.rendered.get(k.id);
  if (!el) return;
  el.querySelector(".kt-name").textContent = k.ownerName;
  el.classList.toggle("is-mine", !!state.user && k.userId === state.user.uid);
}

function removeKrathong(id) {
  state.rendered.get(id)?.remove();
  state.rendered.delete(id);
  state.data.delete(id);
}

function highlightKrathong(id) {
  const el = state.rendered.get(id);
  if (!el) return;
  el.classList.add("kt-spotlight");
  setTimeout(() => el.classList.remove("kt-spotlight"), 9000);
  if (state.pendingHighlightId === id) state.pendingHighlightId = null;
}

function updateEmptyState() {
  if (!state.initialLoaded) return;
  if (state.rendered.size === 0) {
    els.riverEmpty.textContent = "ยังไม่มีกระทงในคืนนี้ มาเป็นคนแรกที่ลอยกระทงกันเถอะ";
    els.riverEmpty.hidden = false;
  } else {
    els.riverEmpty.hidden = true;
  }
  setStat(els.statTotal, Math.max(state.totalFromServer, state.rendered.size));
}

function announceNew(k) {
  if (state.user && k.userId === state.user.uid) return;
  const now = Date.now();
  if (now - state.lastAnnounceAt < 4000) return;
  state.lastAnnounceAt = now;
  toast(`${k.ownerName} เพิ่งลอยกระทงลงแม่น้ำ`, "info", 3000);
  sound.plink();                                  // เสียงน้ำเบา ๆ ให้รู้ว่ามีกระทงใหม่
  showerFx?.(3, false);                           // ดาวตกชุดเล็กต้อนรับ
  tickerSay(`${k.ownerName} ขอให้ ${wishShort(k.wishMessage)}`);   // โชว์บนแถบวิ่งเมื่อเปิดจอโชว์
}

/** คลื่นน้ำกระเพื่อม ณ จุดที่กระทงใหม่ปรากฏ (ฝั่งผู้ส่ง) */
function spawnReleaseRipple(id) {
  const kr = state.rendered.get(id);
  if (!kr) return;
  const body = kr.querySelector(".kt-body");
  if (!body) return;
  const layerRect = els.layer.getBoundingClientRect();
  const r = body.getBoundingClientRect();
  const ring = div("release-ripple");
  ring.style.setProperty("--x", `${Math.round(r.left - layerRect.left + r.width / 2)}px`);
  ring.style.setProperty("--y", `${Math.round(r.top - layerRect.top + r.height * 0.86)}px`);
  els.layer.append(ring);
  setTimeout(() => ring.remove(), 2800);
}

function openDetail(id) {
  const k = state.data.get(id);
  if (!k) return;
  state.detailId = id;
  applyFlameVars(els.detailArtWrap, k.flameColor);
  els.detailArt.replaceChildren(getKrathongSVG(k.krathongType));
  els.detailType.textContent = `กระทง${KRATHONG_TYPES[k.krathongType].label}`;
  els.detailName.textContent = k.ownerName;
  els.detailWish.textContent = k.wishMessage;
  els.detailDate.textContent = formatThaiDate(k.createdAt);
  els.detailDate.dateTime = new Date(k.createdAt).toISOString();
  els.detailMine.hidden = !(state.user && k.userId === state.user.uid);
  openModal(els.detailModal);
}

/* =====================================================================
 *  Firestore Real-time Listeners
 * ===================================================================== */
function handleListenError(name, err, retryFn) {
  console.error(`[listener:${name}]`, err);
  if (err?.code === "permission-denied") {
    showNet("ไม่มีสิทธิ์อ่านข้อมูล: กรุณา Deploy firestore.rules ให้เรียบร้อย", "error");
    return;
  }
  const attempt = (state.retry[name] || 0) + 1;
  state.retry[name] = attempt;
  showNet("การเชื่อมต่อฐานข้อมูลขัดข้อง กำลังลองเชื่อมต่อใหม่...", "error");
  clearTimeout(state.timers[`retry-${name}`]);
  state.timers[`retry-${name}`] = setTimeout(retryFn, Math.min(30_000, 1000 * 2 ** attempt));
}

function subscribeKrathongs() {
  state.unsub.krathongs?.();
  const q = query(collection(db, "krathongs"), orderBy("createdAt", "desc"), limit(CONFIG.MAX_RENDER));
  state.unsub.krathongs = onSnapshot(q, (snap) => {
    if (state.retry.krathongs) { state.retry.krathongs = 0; hideNet(); }
    const firstLoad = !state.initialLoaded;
    snap.docChanges().forEach((change) => {
      if (change.type === "removed") { removeKrathong(change.doc.id); return; }
      const k = normalizeKrathong(change.doc);
      if (!k || k.status !== "floating") { removeKrathong(change.doc.id); return; }
      if (change.type === "added") {
        addKrathong(k, !firstLoad);
        if (!firstLoad && !change.doc.metadata.hasPendingWrites) announceNew(k);
      } else {
        updateKrathong(k);
      }
    });
    state.initialLoaded = true;
    updateEmptyState();
  }, (err) => handleListenError("krathongs", err, subscribeKrathongs));
}

function subscribeStats() {
  state.unsub.stats?.();
  state.unsub.stats = onSnapshot(doc(db, "stats", "global"), (snap) => {
    state.retry.stats = 0;
    state.totalFromServer = snap.exists() ? Number(snap.data().total) || 0 : 0;
    setStat(els.statTotal, Math.max(state.totalFromServer, state.rendered.size));
  }, (err) => handleListenError("stats", err, subscribeStats));
}

function subscribeToday() {
  state.unsub.today?.();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const q = query(collection(db, "krathongs"), where("createdAt", ">=", Timestamp.fromDate(start)));
  state.unsub.today = onSnapshot(q, (snap) => {
    state.retry.today = 0;
    setStat(els.statToday, snap.size);
  }, (err) => handleListenError("today", err, subscribeToday));

  // เริ่มนับใหม่เมื่อข้ามเที่ยงคืน
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  clearTimeout(state.timers.today);
  state.timers.today = setTimeout(subscribeToday, next.getTime() - Date.now() + 1000);
}

/* ---------------- Presence: นับผู้ใช้ที่ออนไลน์จริง ---------------- */
function subscribePresence() {
  state.unsub.presence?.();
  clearTimeout(state.timers.presenceResub);
  const since = Timestamp.fromMillis(nowServer() - 10 * 60_000);
  const q = query(collection(db, "presence"), where("lastSeen", ">=", since));
  state.unsub.presence = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    state.retry.presence = 0;
    state.presence.clear();
    snap.forEach((d) => {
      const ts = d.data({ serverTimestamps: "estimate" }).lastSeen;
      if (ts?.toMillis) state.presence.set(d.id, ts.toMillis());
    });
    // ปรับเวลาให้ตรงกับเซิร์ฟเวอร์ จากสัญญาณล่าสุดของเราเอง
    if (state.user && state.awaitingBeatAck) {
      const mine = snap.docs.find((d) => d.id === state.user.uid);
      if (mine && !mine.metadata.hasPendingWrites) {
        const ts = mine.data().lastSeen;
        if (ts?.toMillis) {
          const offset = ts.toMillis() - state.lastBeatLocal;
          if (Math.abs(offset) < 86_400_000) state.serverOffset = offset;
          state.awaitingBeatAck = false;
        }
      }
    }
    recountOnline();
  }, (err) => handleListenError("presence", err, subscribePresence));
  state.timers.presenceResub = setTimeout(subscribePresence, CONFIG.PRESENCE_RESUBSCRIBE_MS);
}

function recountOnline() {
  const now = nowServer();
  let count = 0;
  state.presence.forEach((ts, uid) => {
    if (now - ts <= CONFIG.ONLINE_WINDOW_MS || (state.user && uid === state.user.uid)) count++;
  });
  if (state.user && !state.presence.has(state.user.uid)) count++;
  setStat(els.statOnline, count);
}

async function beat() {
  if (!state.user || !db || !navigator.onLine) return;
  try {
    state.lastBeatLocal = Date.now();
    state.awaitingBeatAck = true;
    await setDoc(doc(db, "presence", state.user.uid), { lastSeen: serverTimestamp() });
  } catch (err) {
    state.awaitingBeatAck = false;
    // permission-denied = ส่งถี่กว่า 10 วินาที (เช่น รีเฟรชเร็ว) → ข้ามได้
    if (err?.code !== "permission-denied") console.warn("[presence]", err);
  }
}

function startPresence() {
  beat();
  clearInterval(state.timers.beat);
  state.timers.beat = setInterval(beat, CONFIG.HEARTBEAT_MS);
}

/* =====================================================================
 *  Authentication (Anonymous)
 * ===================================================================== */
function authErrorMessage(err) {
  switch (err?.code) {
    case "auth/admin-restricted-operation":
    case "auth/operation-not-allowed":
      return "ยังไม่ได้เปิด Anonymous Authentication ใน Firebase Console";
    case "auth/configuration-not-found":
      return "ยังไม่ได้เปิดใช้งาน Firebase Authentication ในโปรเจกต์";
    case "auth/network-request-failed":
      return "เชื่อมต่ออินเทอร์เน็ตไม่ได้ กำลังลองใหม่...";
    case "auth/too-many-requests":
      return "มีการเข้าสู่ระบบถี่เกินไป กรุณารอสักครู่";
    default:
      return "เข้าสู่ระบบไม่สำเร็จ กำลังลองใหม่...";
  }
}

async function signIn(attempt = 0) {
  try {
    setUserStatus("กำลังเข้าร่วมแบบไม่ระบุตัวตน...");
    await signInAnonymously(auth);
  } catch (err) {
    console.error("[auth]", err);
    setUserStatus(authErrorMessage(err), "error");
    clearTimeout(state.timers.signIn);
    state.timers.signIn = setTimeout(() => signIn(attempt + 1), Math.min(30_000, 2000 * 2 ** attempt));
  }
}

async function loadCooldown() {
  try {
    const snap = await getDoc(doc(db, "users", state.user.uid));
    const ts = snap.exists() ? snap.data().lastKrathongAt : null;
    if (ts?.toMillis) state.lastSubmitAt = Math.max(state.lastSubmitAt, ts.toMillis() - state.serverOffset);
  } catch { /* ไม่กระทบการใช้งาน */ }
  refreshSubmitButton();
}

function startAuth() {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      state.user = user;
      setUserStatus(`เข้าร่วมแล้ว · รหัสผู้ร่วมงาน #${user.uid.slice(0, 6)}`, "ok");
      els.btnStart.disabled = false;
      state.rendered.forEach((el, id) =>
        el.classList.toggle("is-mine", state.data.get(id)?.userId === user.uid));
      startPresence();
      loadCooldown();
      recountOnline();
    } else {
      state.user = null;
      els.btnStart.disabled = true;
      signIn();
    }
    refreshSubmitButton();
  });
}

/* =====================================================================
 *  ฉากกลางคืน (Canvas): ดาว, โคมลอย, ดาวตก, ฝูงปลา, ประกายแสงบนน้ำ
 * ===================================================================== */
let showerFx = null;            // ฟังก์ชันปล่อยดาวตกชุด (เชื่อมจาก initScene)

function initScene() {
  const starsCanvas = $("#stars-canvas");
  const fxCanvas = $("#fx-canvas");
  const sctx = starsCanvas.getContext("2d");
  const fctx = fxCanvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STAR_COLORS = ["#ffffff", "#ffe9a8", "#f9c6ff", "#cfd8ff"];

  let W = 0, H = 0, horizon = 0;
  let stars = [], lanterns = [], sparkles = [], meteors = [], fish = [], nextMeteor = 4000;
  let moon = { x: 0, y: 0, r: 40 };
  let last = performance.now();

  function makeLantern(initial) {
    const size = 7 + Math.random() * 11;
    return {
      x: Math.random() * W,
      y: initial ? horizon * (0.1 + Math.random() * 0.85) : horizon - 4 - Math.random() * 30,
      size,
      vy: 0.12 + size * 0.018 + Math.random() * 0.1,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.004 + Math.random() * 0.006,
      swayAmp: 0.15 + Math.random() * 0.4,
      flicker: Math.random() * Math.PI * 2,
      pink: Math.random() < 0.25,
    };
  }

  function makeSparkle() {
    const depth = Math.random();
    const near = Math.random() < 0.75;          // ส่วนใหญ่อยู่ในแนวแสงจันทร์
    const spread = (60 + depth * W * 0.12);
    return {
      depth,
      y: horizon + 4 + depth * (H - horizon - 4),
      x: near ? moon.x + (Math.random() * 2 - 1) * spread * Math.random() : Math.random() * W,
      len: 3 + depth * 22,
      phase: Math.random() * Math.PI * 2,
      speed: 0.002 + Math.random() * 0.004,
      pink: !near && Math.random() < 0.5,
    };
  }

  /* ---------------- ฝูงปลาเงาใต้ผืนน้ำ ---------------- */
  function makeFish(opts = {}) {
    const size = 14 + Math.random() * 22;
    const depth = Math.random();                 // 0 = ใกล้ผิวน้ำ, 1 = ลึก
    const dir = opts.dir ?? (Math.random() < 0.5 ? 1 : -1);
    return {
      size, dir, depth,
      x: opts.initial ? Math.random() * W : (dir > 0 ? -size * 2 : W + size * 2),
      y: horizon + 30 + depth * (H - horizon - 70),
      vx: 0.08 + size * 0.004 + Math.random() * 0.08,   // ช้า ๆ ~8–18 px/s
      alpha: 0.5 - depth * 0.3,                        // ยิ่งลึกยิ่งจาง
      phase: Math.random() * Math.PI * 2,
      bobSpeed: 0.0006 + Math.random() * 0.0006,
      bobAmp: 3 + Math.random() * 4,
      wagSpeed: 0.006 + Math.random() * 0.004,
    };
  }

  function drawFish(f, t) {
    const s = f.size;
    const y = f.y + Math.sin(t * f.bobSpeed + f.phase) * f.bobAmp;
    const wag = Math.sin(t * f.wagSpeed + f.phase) * 0.5;
    fctx.save();
    fctx.translate(f.x, y);
    fctx.scale(f.dir, 1);
    fctx.globalAlpha = f.alpha;
    fctx.fillStyle = "#b9a8ef";
    // ลำตัว
    fctx.beginPath();
    fctx.ellipse(0, 0, s * 0.5, s * 0.2, 0, 0, Math.PI * 2);
    fctx.fill();
    // หางแกว่งไปมา
    fctx.beginPath();
    fctx.moveTo(-s * 0.4, 0);
    fctx.lineTo(-s * 0.8, -s * 0.2 + wag * s * 0.1);
    fctx.lineTo(-s * 0.8, s * 0.2 + wag * s * 0.1);
    fctx.closePath();
    fctx.fill();
    // ครีบหลัง
    fctx.beginPath();
    fctx.moveTo(-s * 0.02, -s * 0.16);
    fctx.lineTo(-s * 0.24, -s * 0.32 - wag * s * 0.04);
    fctx.lineTo(-s * 0.3, -s * 0.14);
    fctx.closePath();
    fctx.fill();
    // จุดตาสว่างเล็ก ๆ
    fctx.fillStyle = "rgba(255,246,220,.7)";
    fctx.beginPath();
    fctx.arc(s * 0.32, -s * 0.03, Math.max(0.8, s * 0.04), 0, Math.PI * 2);
    fctx.fill();
    fctx.restore();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    const ratio = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--horizon")) / 100 || 0.56;
    horizon = H * ratio;
    for (const c of [starsCanvas, fxCanvas]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const r = $("#moon").getBoundingClientRect();
    moon = { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
    document.documentElement.style.setProperty("--moon-x", `${moon.x}px`);

    const count = Math.min(380, Math.round((W * horizon) / 2600));
    stars = [];
    for (let i = 0; i < count; i++) {
      const x = Math.random() * W, y = Math.random() * horizon * 0.9;
      if (Math.hypot(x - moon.x, y - moon.y) < moon.r * 1.7) continue;
      stars.push({
        x, y,
        r: Math.random() ** 2 * 1.6 + 0.3,
        phase: Math.random() * Math.PI * 2,
        speed: 0.6 + Math.random() * 1.8,
        color: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0],
      });
    }
    const lanternCount = W < 640 ? 10 : 22;
    lanterns = Array.from({ length: lanternCount }, () => makeLantern(true));
    sparkles = Array.from({ length: Math.round(W / 7) }, makeSparkle);
    fish = Array.from({ length: W < 640 ? 3 : 6 }, () => makeFish({ initial: true }));
  }

  function drawStars(t) {
    sctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.001 * s.speed + s.phase));
      sctx.globalAlpha = a;
      sctx.fillStyle = s.color;
      sctx.beginPath();
      sctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      sctx.fill();
    }
    sctx.globalAlpha = 1;
  }

  function drawLantern(l, t) {
    const fadeIn = clamp((horizon - l.y) / 60, 0, 1);
    const fadeOut = clamp(l.y / (horizon * 0.3), 0, 1);
    const alpha = fadeIn * fadeOut * (0.85 + 0.15 * Math.sin(t * 0.006 + l.flicker));
    if (alpha <= 0.01) return;
    const glowR = l.size * 3.2;
    const g = fctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, glowR);
    g.addColorStop(0, l.pink ? `rgba(255,150,210,${0.45 * alpha})` : `rgba(255,190,90,${0.45 * alpha})`);
    g.addColorStop(1, "rgba(255,140,60,0)");
    fctx.fillStyle = g;
    fctx.beginPath();
    fctx.arc(l.x, l.y, glowR, 0, Math.PI * 2);
    fctx.fill();

    const w = l.size, h = l.size * 1.3;
    const body = fctx.createLinearGradient(l.x, l.y - h / 2, l.x, l.y + h / 2);
    body.addColorStop(0, l.pink ? `rgba(240,90,160,${alpha})` : `rgba(230,100,40,${alpha})`);
    body.addColorStop(1, `rgba(255,232,160,${alpha})`);
    fctx.fillStyle = body;
    fctx.beginPath();
    fctx.moveTo(l.x - w * 0.55, l.y - h / 2);
    fctx.lineTo(l.x + w * 0.55, l.y - h / 2);
    fctx.lineTo(l.x + w * 0.4, l.y + h / 2);
    fctx.lineTo(l.x - w * 0.4, l.y + h / 2);
    fctx.closePath();
    fctx.fill();
    fctx.fillStyle = `rgba(255,250,220,${alpha})`;
    fctx.beginPath();
    fctx.arc(l.x, l.y + h / 2 - 1, Math.max(1, w * 0.12), 0, Math.PI * 2);
    fctx.fill();
  }

  function drawSparkles(t) {
    fctx.lineCap = "round";
    for (const s of sparkles) {
      const a = Math.max(0, Math.sin(t * s.speed + s.phase)) ** 3 * (0.85 - s.depth * 0.35);
      if (a < 0.02) continue;
      fctx.strokeStyle = s.pink ? `rgba(255,160,220,${a * 0.6})` : `rgba(255,228,160,${a})`;
      fctx.lineWidth = 1 + s.depth * 1.6;
      fctx.beginPath();
      fctx.moveTo(s.x - s.len / 2, s.y);
      fctx.lineTo(s.x + s.len / 2, s.y);
      fctx.stroke();
    }
  }

  function spawnMeteor(opts = {}) {
    meteors.push({
      x: opts.x ?? Math.random() * W * 0.6,
      y: opts.y ?? Math.random() * horizon * 0.3,
      vx: opts.vx ?? 7 + Math.random() * 4,
      vy: opts.vy ?? 2.5 + Math.random() * 2,
      life: opts.life ?? 60,
      delay: opts.delay ?? 0,
      tint: opts.tint ?? "255,255,255",
    });
  }

  // ดาวตกพุ่งเป็นชุด ต้อนรับกระทงใหม่ (golden = ฉลองกระทงของเราเอง)
  function shower(count = 4, golden = false) {
    if (reduceMotion) return;
    for (let i = 0; i < count; i++) {
      spawnMeteor({
        x: Math.random() * W * 0.8,
        y: Math.random() * horizon * 0.25,
        vx: 8 + Math.random() * 5,
        vy: 3 + Math.random() * 2.5,
        life: 55 + Math.random() * 15,
        delay: i * 120 + Math.random() * 160,
        tint: golden ? "255,214,130" : "255,255,255",
      });
    }
  }

  function updateMeteors(dt, dtMs) {
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      if (m.delay > 0) { m.delay -= dtMs; continue; }
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.life -= dt;
      drawMeteor(m);
      if (m.life <= 0 || m.y > horizon) meteors.splice(i, 1);
    }
  }

  function drawMeteor(m) {
    const a = clamp(m.life / 40, 0, 1);
    const grad = fctx.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14);
    grad.addColorStop(0, `rgba(${m.tint},${a})`);
    grad.addColorStop(1, `rgba(${m.tint},0)`);
    fctx.strokeStyle = grad;
    fctx.lineWidth = 1.6;
    fctx.beginPath();
    fctx.moveTo(m.x, m.y);
    fctx.lineTo(m.x - m.vx * 14, m.y - m.vy * 14);
    fctx.stroke();
  }

  function frame(t) {
    const dtMs = Math.min(50, t - last);
    const dt = dtMs / 16.67;
    last = t;
    drawStars(t);
    fctx.clearRect(0, 0, W, H);
    drawSparkles(t);
    for (const f of fish) {
      f.x += f.vx * f.dir * dt;
      if ((f.dir > 0 && f.x > W + f.size * 2) || (f.dir < 0 && f.x < -f.size * 2)) {
        Object.assign(f, makeFish({ dir: f.dir }));
      }
      drawFish(f, t);
    }
    for (let i = 0; i < lanterns.length; i++) {
      const l = lanterns[i];
      l.y -= l.vy * dt;
      l.sway += l.swaySpeed * dt;
      l.x += Math.sin(l.sway) * l.swayAmp * dt;
      if (l.y < -40) lanterns[i] = makeLantern(false);
      drawLantern(l, t);
    }
    nextMeteor -= dtMs;
    if (nextMeteor <= 0) {
      spawnMeteor();
      nextMeteor = 7000 + Math.random() * 9000;
    }
    updateMeteors(dt, dtMs);
    if (!document.hidden) requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); if (reduceMotion) frame(performance.now()); }, 150);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !reduceMotion) { last = performance.now(); requestAnimationFrame(frame); }
  });

  showerFx = shower;
  resize();
  if (reduceMotion) {
    drawStars(0);
    fctx.clearRect(0, 0, W, H);
    drawSparkles(1000);
    lanterns.forEach((l) => drawLantern(l, 0));
    fish.forEach((f) => drawFish(f, 0));
  } else {
    requestAnimationFrame(frame);
  }
}

/* =====================================================================
 *  เสียงประกอบ (สังเคราะห์ด้วย Web Audio API — ไม่ใช้ไฟล์เสียง)
 * ===================================================================== */
const sound = (() => {
  let ctx = null, master = null;
  let enabled = true;
  try { enabled = localStorage.getItem("lk:sound") !== "0"; } catch { /* ใช้ค่าเริ่มต้น */ }

  function ac() {
    if (!enabled) return null;
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      master ??= ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      return ctx;
    } catch { return null; }
  }

  function env(node, t0, peak, decay) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  }

  function noiseBuffer(c, seconds) {
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function tone(freq, t0, peak, decay, glideTo = null, glideTime = 0) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + glideTime);
    const g = ctx.createGain();
    env(g, t0, peak, decay);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }

  return {
    isEnabled: () => enabled,
    setEnabled(on) {
      enabled = !!on;
      try { localStorage.setItem("lk:sound", on ? "1" : "0"); } catch { /* ignore */ }
      if (on) ac();
    },
    unlock() { ac(); },          // เรียกใน gesture แรกเพื่อปลดล็อกเสียงบนมือถือ
    // น้ำกระเพื่อม + เสียง "ปล๊อบ" ตอนปล่อยกระทงลงน้ำ
    splash() {
      const c = ac(); if (!c) return;
      const t = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c, 0.7);
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(140, t + 0.55);
      const g = c.createGain();
      env(g, t, 0.45, 0.65);
      src.connect(lp).connect(g).connect(master);
      src.start(t);
      src.stop(t + 0.7);
      tone(280, t, 0.35, 0.24, 70, 0.18);
    },
    // ระฆังเบา ๆ ตอนส่งกระทงสำเร็จ
    chime() {
      const c = ac(); if (!c) return;
      const t = c.currentTime + 0.12;
      tone(1046.5, t, 0.16, 1.4);
      tone(1568, t + 0.09, 0.09, 1.4);
    },
    // เสียงน้ำเบา ๆ เมื่อผู้อื่นลอยกระทง
    plink() {
      const c = ac(); if (!c) return;
      const f = 620 + Math.random() * 160;
      tone(f, c.currentTime, 0.10, 0.38, f * 1.5, 0.12);
    },
  };
})();

function refreshSoundToggle() {
  if (!els.soundToggle) return;
  const on = sound.isEnabled();
  els.soundToggle.textContent = on ? "🔊" : "🔇";
  els.soundToggle.setAttribute("aria-pressed", String(on));
  els.soundToggle.setAttribute("aria-label", on ? "ปิดเสียงประกอบ" : "เปิดเสียงประกอบ");
}

/* =====================================================================
 *  การ์ดแชร์คำอธิษฐาน (วาดลง Canvas → PNG → แชร์/บันทึกเครื่อง)
 * ===================================================================== */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** ตัดบรรทัดภาษาไทย: ใช้พจนานุกรมของ Intl.Segmenter ถ้ามี ไม่มีก็ตัดรายตัวอักษร */
function wrapLines(ctx, text, maxWidth) {
  const chunks = (() => {
    try {
      if (typeof Intl === "undefined" || !Intl.Segmenter) return [...text];
      const seg = new Intl.Segmenter("th", { granularity: "word" });
      return Array.from(seg.segment(text), (s) => s.segment);
    } catch { return [...text]; }
  })();
  const lines = [];
  let line = "";
  for (const chunk of chunks) {
    const test = line + chunk;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line.trimEnd());
      line = chunk.trimStart();
    } else {
      line = test;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

async function drawShareCard(k) {
  const W = 1080, H = 1350, WATER = Math.round(H * 0.68), CX = W / 2;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");

  // ฟ้าคืนเพ็ญ → ผืนน้ำ
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#03051a");
  sky.addColorStop(0.42, "#22135a");
  sky.addColorStop(0.67, "#4a2275");
  sky.addColorStop(0.68, "#2b1a5e");
  sky.addColorStop(0.82, "#0c0b36");
  sky.addColorStop(1, "#050519");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // ดาว (ตำแหน่งคงที่ตาม id ของกระทง → การ์ดเดียวกันวาดได้เหมือนกันทุกครั้ง)
  let seed = hashString(k.id) || 1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const STAR_COLORS = ["#ffffff", "#ffe9a8", "#f9c6ff", "#cfd8ff"];
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.2 + rand() * 0.65;
    ctx.fillStyle = STAR_COLORS[(rand() * 4) | 0];
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * WATER * 0.78, rand() ** 2 * 3 + 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // พระจันทร์ + แสงฟุ้ง
  const mx = W * 0.79, my = H * 0.135, mr = 76;
  const halo = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 3.6);
  halo.addColorStop(0, "rgba(255,227,161,.5)");
  halo.addColorStop(1, "rgba(255,227,161,0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(mx, my, mr * 3.6, 0, Math.PI * 2); ctx.fill();
  const moon = ctx.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, mr * 0.15, mx, my, mr);
  moon.addColorStop(0, "#fffaf0");
  moon.addColorStop(0.55, "#fff1c9");
  moon.addColorStop(1, "#e9bd62");
  ctx.fillStyle = moon;
  ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();

  // ขอบการ์ด + เส้นขอบฟ้า/น้ำ
  ctx.strokeStyle = "rgba(245,196,81,.5)";
  ctx.lineWidth = 3;
  roundRectPath(ctx, 26, 26, W - 52, H - 52, 42);
  ctx.stroke();
  const hz = ctx.createLinearGradient(0, 0, W, 0);
  hz.addColorStop(0, "rgba(255,227,161,0)");
  hz.addColorStop(0.5, "rgba(255,227,161,.65)");
  hz.addColorStop(1, "rgba(255,227,161,0)");
  ctx.fillStyle = hz;
  ctx.fillRect(0, WATER - 2, W, 3);

  // ประกายแสงบนผืนน้ำ
  ctx.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    const y = WATER + 20 + rand() * (H - WATER - 90);
    const len = 14 + rand() * 60;
    ctx.strokeStyle = `rgba(255,228,160,${(0.05 + rand() * 0.18).toFixed(3)})`;
    ctx.lineWidth = 2 + rand() * 4;
    ctx.beginPath();
    ctx.moveTo(mx - len * (0.4 + rand()), y);
    ctx.lineTo(mx + len * (0.4 + rand()), y);
    ctx.stroke();
  }

  // กระทงจาก SVG template เดียวกับบนเว็บ (+ แทนสีเทียนของกระทงใบนี้ลงบน clone ตรง ๆ)
  const flame = FLAME_COLORS[k.flameColor] || FLAME_COLORS.gold;
  const ART_W = 430, ART_H = Math.round(ART_W * 100 / 120);
  const svg = getKrathongSVG(k.krathongType);
  svg.querySelectorAll(".kt-flame path").forEach((p, i) => {
    p.setAttribute("fill", i === 0 ? flame.flame : flame.flameHi);
  });
  svg.setAttribute("width", ART_W);
  svg.setAttribute("height", ART_H);
  const svgUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("โหลดรูปกระทงไม่สำเร็จ"));
      img.src = svgUrl;
    });
    const ax = CX, ay = 470;
    const artGlow = ctx.createRadialGradient(ax, ay + 70, 30, ax, ay + 70, 300);
    artGlow.addColorStop(0, flame.glowStrong);
    artGlow.addColorStop(0.55, flame.glowSoft);
    artGlow.addColorStop(1, flame.glowSoft.replace(/[\d.]+\)$/, "0)"));
    ctx.fillStyle = artGlow;
    ctx.beginPath(); ctx.arc(ax, ay + 70, 300, 0, Math.PI * 2); ctx.fill();
    ctx.drawImage(img, ax - ART_W / 2, ay - ART_H / 2, ART_W, ART_H);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }

  ctx.textAlign = "center";

  // ชื่อผู้ลอย (ฟอนต์วน ลดขนาดอัตโนมัติถ้าชื่อยาว)
  let ns = 64;
  ctx.font = `700 ${ns}px Charm, Mitr, sans-serif`;
  while (ctx.measureText(k.ownerName).width > 860 && ns > 40) {
    ns -= 4;
    ctx.font = `700 ${ns}px Charm, Mitr, sans-serif`;
  }
  ctx.fillStyle = "#f5c451";
  ctx.shadowColor = "rgba(245,196,81,.6)";
  ctx.shadowBlur = 24;
  ctx.fillText(k.ownerName, CX, 756);
  ctx.shadowBlur = 0;

  // คำอธิษฐาน (ตัดบรรทัดแบบภาษาไทย ลดขนาดถ้ายาว)
  let ws = 40;
  ctx.font = `400 ${ws}px Sarabun, sans-serif`;
  let lines = wrapLines(ctx, k.wishMessage, 840);
  while (lines.length * ws * 1.55 > 330 && ws > 24) {
    ws -= 4;
    ctx.font = `400 ${ws}px Sarabun, sans-serif`;
    lines = wrapLines(ctx, k.wishMessage, 840);
  }
  const lh = Math.round(ws * 1.55);
  ctx.fillStyle = "#f7f1ff";
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = 8;
  lines.forEach((ln, i) => ctx.fillText(ln, CX, 850 + i * lh));
  ctx.shadowBlur = 0;

  // วันที่ + แบรนด์
  ctx.font = "400 30px Sarabun, sans-serif";
  ctx.fillStyle = "#c4b8e3";
  ctx.fillText(`ลอยเมื่อ ${formatThaiDate(k.createdAt)}`, CX, 1248);
  const host = ["", "localhost", "127.0.0.1"].includes(location.hostname) ? "" : location.hostname;
  ctx.font = "500 30px Mitr, sans-serif";
  ctx.fillStyle = "#ffe3a1";
  ctx.fillText(host ? `ลอยกระทงออนไลน์ · ${host}` : "ลอยกระทงออนไลน์", CX, 1294);

  return cv;
}

async function shareDetail() {
  const k = state.data.get(state.detailId);
  if (!k || state.sharing) return;
  state.sharing = true;
  const btn = els.btnShare;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "กำลังสร้างรูป...";
  try {
    // รอฟอนต์ให้พร้อมก่อนวาด (ถ้าโหลดไม่ได้จะใช้ฟอนต์สำรอง)
    await Promise.all([
      document.fonts.load("700 64px Charm", k.ownerName),
      document.fonts.load("400 40px Sarabun", k.wishMessage),
      document.fonts.load("500 30px Mitr", "ลอยกระทงออนไลน์"),
    ]).catch(() => {});
    const cv = await drawShareCard(k);
    const blob = await new Promise((resolve, reject) =>
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob ล้มเหลว"))), "image/png"));
    const file = new File([blob], `loikrathong-${k.id}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: "คำอธิษฐานลอยกระทง",
        text: `คำอธิษฐานของ ${k.ownerName}`,
      });
      toast("แชร์การ์ดคำอธิษฐานแล้ว", "success");
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast("บันทึกรูปการ์ดลงเครื่องแล้ว", "success");
    }
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.error("[share card]", err);
      toast("สร้างรูปการ์ดไม่สำเร็จ กรุณาลองใหม่", "error");
    }
  } finally {
    state.sharing = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* =====================================================================
 *  จอโชว์ + แถบคำอธิษฐานวิ่ง + ธีมฉาก
 * ===================================================================== */
/** ย่อคำอธิษฐานสำหรับแถบวิ่ง (ตัด 90 ตัวอักษร) */
function wishShort(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 90)}…` : t;
}

const ticker = { queue: [], busy: false };

function tickerSay(text) {
  if (!els.ticker || !document.documentElement.classList.contains("show-mode")) return;
  if (ticker.queue.length > 5) return;           // กันคิวล้นเมื่อกระทงไหลเข้ารัว ๆ
  ticker.queue.push(text);
  pumpTicker();
}

function pumpTicker() {
  if (ticker.busy) return;
  const next = ticker.queue.shift();
  if (!next) return;
  const tick = els.ticker?.firstElementChild;
  if (!tick) return;
  tick.textContent = next;                       // ข้อความผู้ใช้ → textContent เท่านั้น
  ticker.busy = true;
  tick.addEventListener("animationend", () => {
    ticker.busy = false;
    tick.textContent = "";
    pumpTicker();
  }, { once: true });
  tick.style.animation = "none";
  void tick.offsetWidth;                         // force reflow เพื่อรีสตาร์ตแอนิเมชัน
  tick.style.animation = "";
}

function setShowMode(on) {
  document.documentElement.classList.toggle("show-mode", on);
  els.showToggle.textContent = on ? "จอปกติ" : "จอโชว์";
  els.showToggle.setAttribute("aria-pressed", String(on));
  els.showToggle.setAttribute("aria-label", on ? "ออกจากโหมดจอโชว์" : "เปิดโหมดจอโชว์");
  // ล้างแถบวิ่งเสมอ — animationend จะไม่ยิงเมื่อแถบถูกซ่อน (display:none)
  ticker.queue.length = 0;
  ticker.busy = false;
  const tick = els.ticker?.firstElementChild;
  if (tick) tick.textContent = "";
  try {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch { /* เบราว์เซอร์บางตัวไม่รองรับ fullscreen — โหมดใหญ่ยังใช้ได้อยู่ */ }
}

/* ---------------- ธีมฉากหลัง ---------------- */
function applyScene() {
  const scene = SCENES[state.sceneIndex] || SCENES[0];
  SCENES.forEach((s) => {
    document.getElementById(s.id)?.toggleAttribute("hidden", s.id !== scene.id);
  });
  if (els.sceneToggle) els.sceneToggle.textContent = `ฉาก: ${scene.label}`;
}

function cycleScene() {
  state.sceneIndex = (state.sceneIndex + 1) % SCENES.length;
  applyScene();
  try { localStorage.setItem("lk:scene", String(state.sceneIndex)); } catch { /* ignore */ }
}

function restoreScene() {
  try {
    const saved = Number(localStorage.getItem("lk:scene"));
    if (Number.isInteger(saved) && saved >= 0 && saved < SCENES.length) state.sceneIndex = saved;
  } catch { /* ignore */ }
}

/* =====================================================================
 *  Event bindings
 * ===================================================================== */
function bindUI() {
  els.btnStart.addEventListener("click", () => {
    if (!state.user) { toast("กำลังเชื่อมต่อ กรุณารอสักครู่", "error"); return; }
    els.formError.textContent = "";
    refreshSubmitButton();
    openModal(els.createModal);
  });

  els.form.addEventListener("submit", handleSubmit);
  els.btnShare.addEventListener("click", shareDetail);

  // ปุ่มเปิด/ปิดเสียงประกอบ
  refreshSoundToggle();
  els.soundToggle.addEventListener("click", () => {
    const on = !sound.isEnabled();
    sound.setEnabled(on);
    refreshSoundToggle();
    if (on) sound.plink();          // เสียงยืนยันตอนเปิดเสียง
    toast(on ? "เปิดเสียงประกอบแล้ว" : "ปิดเสียงประกอบแล้ว", "info", 1800);
  });
  document.addEventListener("pointerdown", () => sound.unlock(), { once: true, capture: true });

  // ปุ่มโหมดจอโชว์ + สลับธีมฉาก
  els.showToggle.addEventListener("click", () => setShowMode(
    !document.documentElement.classList.contains("show-mode")));
  els.sceneToggle.addEventListener("click", cycleScene);
  // ออกจากโหมดเมื่อออกจากเต็มจอ (กด Esc ฯลฯ)
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement &&
        document.documentElement.classList.contains("show-mode")) setShowMode(false);
  });

  els.nameInput.addEventListener("input", () => { liveCheck(els.nameInput, els.nameError); updatePreviewText(); });
  els.wishInput.addEventListener("input", () => { liveCheck(els.wishInput, els.wishError); updatePreviewText(); });

  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) closeModal(closer.closest(".modal"));
  });
  document.addEventListener("keydown", (e) => {
    const modal = topOpenModal();
    if (!modal) return;
    if (e.key === "Escape") closeModal(modal);
    if (e.key === "Tab") trapFocus(e, modal);
  });

  // คลิก/กด Enter ที่กระทงใบใดก็ได้ → เปิดอ่านคำอธิษฐาน
  els.layer.addEventListener("click", (e) => {
    const el = e.target.closest(".krathong");
    if (el) openDetail(el.dataset.id);
  });
  els.layer.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("krathong")) {
      e.preventDefault();
      openDetail(e.target.dataset.id);
    }
  });

  // สถานะอินเทอร์เน็ต
  window.addEventListener("offline", () =>
    showNet("อินเทอร์เน็ตหลุด ระบบจะเชื่อมต่อใหม่อัตโนมัติเมื่อกลับมาออนไลน์", "error"));
  window.addEventListener("online", () => {
    showNet("กลับมาออนไลน์แล้ว กำลังซิงค์ข้อมูล...", "ok", 3000);
    beat();
  });
  if (!navigator.onLine) showNet("คุณกำลังออฟไลน์อยู่", "error");

  // Presence: แจ้งออฟไลน์เมื่อปิดหน้า และกลับมาออนไลน์เมื่อเปิดใหม่
  document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });
  window.addEventListener("pagehide", () => {
    if (state.user && db) deleteDoc(doc(db, "presence", state.user.uid)).catch(() => {});
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) beat(); });

  setInterval(refreshSubmitButton, 1000);
  setInterval(recountOnline, 10_000);
}

function restoreName() {
  try {
    const saved = localStorage.getItem("lk:ownerName");   // จำเฉพาะชื่อที่ใช้ล่าสุด (ไม่ใช่ฐานข้อมูล)
    if (saved) els.nameInput.value = cleanText(saved).slice(0, CONFIG.NAME_MAX);
  } catch { /* ignore */ }
}

/* =====================================================================
 *  Init
 * ===================================================================== */
function isConfigured(c) {
  return !!(c && c.apiKey && c.projectId && !c.apiKey.startsWith("YOUR_") && !c.projectId.startsWith("YOUR_"));
}

function init() {
  cacheEls();
  initScene();
  restoreFlame();
  buildTypePicker();
  buildFlamePicker();
  restoreScene();
  applyScene();
  bindUI();
  restoreName();
  updatePreviewText();

  if (!isConfigured(firebaseConfig)) {
    setUserStatus("ยังไม่ได้ตั้งค่า Firebase", "error");
    els.riverEmpty.textContent = "รอการตั้งค่า Firebase";
    showSetupPanel("ยังไม่ได้ตั้งค่า Firebase", [
      "เปิดไฟล์ public/js/firebase-config.js",
      "นำค่า Config จาก Firebase Console → Project settings → Your apps มาวางแทนค่า YOUR_...",
      "เปิด Anonymous Authentication และสร้าง Firestore Database",
      "Deploy firestore.rules แล้วรีเฟรชหน้านี้",
    ]);
    return;
  }

  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (err) {
    console.error("[firebase init]", err);
    showSetupPanel("เริ่มต้น Firebase ไม่สำเร็จ", ["ตรวจสอบค่าใน public/js/firebase-config.js ให้ถูกต้อง"]);
    return;
  }

  // การอ่านเป็นสาธารณะ → เริ่มฟังข้อมูลได้ทันที
  subscribeKrathongs();
  subscribeStats();
  subscribeToday();
  subscribePresence();
  startAuth();
}

init();