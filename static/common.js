// Utilidades compartidas entre la pantalla de la casa (index) y Administrar (admin).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "Content-Type": "application/json" };
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("No hay conexión con el computador de la casa. Revisen el wifi e intenten de nuevo.");
  }
  if (res.status === 401 && path !== "/api/login") {
    await askPin();
    return api(path, opts);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    let msg = data?.detail ?? (res.status >= 500
      ? "Algo salió mal en el computador de la casa. Intenten de nuevo en un momento."
      : "No se pudo completar. Intenten de nuevo.");
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join("; ");
    throw new Error(msg);
  }
  return data;
}

export function toast(msg, ms = 2800) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

export async function safe(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 4000); }
}

export function isoDate(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
export function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function fmtDay(d) { return cap(d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "short" })); }
export function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
export function fmtQty(q) {
  const n = Number(q);
  const digits = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return n.toLocaleString("es", { maximumFractionDigits: digits });
}
export function fmtMoney(v) {
  return v == null ? "" : "$" + Number(v).toLocaleString("es", { maximumFractionDigits: 0, useGrouping: "always" });
}
const NO_PLURAL = new Set(["g", "kg", "ml", "l", "lb", "oz", "cda", "cdta"]);
// "9 unidad" -> "9 unidades", "2 taza" -> "2 tazas"
export function fmtUnit(q, unit) {
  const u = String(unit ?? "");
  if (Number(q) === 1 || !u || NO_PLURAL.has(u) || u.endsWith("s")) return u;
  return /[aeiou]$/.test(u) ? u + "s" : u + "es";
}
// En la cocina se piensa en fracciones: "½ taza", "1 ⅓ unidades" en vez de "0,5" o "1,33".
const FRACTIONS = [[0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];
function kitchenQty(q) {
  const whole = Math.floor(q + 1e-9);
  const frac = q - whole;
  if (frac < 0.04) return String(whole);
  if (frac > 0.96) return String(whole + 1);
  const hit = FRACTIONS.find(([v]) => Math.abs(frac - v) < 0.04);
  if (!hit) return null;
  return whole ? `${whole} ${hit[1]}` : hit[1];
}
export function fmtAmount(q, unit) {
  const n = Number(q);
  const u = String(unit ?? "");
  if (!NO_PLURAL.has(u) && n > 0) {
    const k = kitchenQty(n);
    if (k) return `${k} ${fmtUnit(n > 1 ? 2 : 1, u)}`;
  }
  return `${fmtQty(n)} ${fmtUnit(n, u)}`;
}

// ---------------------------------------------------------------- PIN de la casa

let pinPromise = null;

export function askPin() {
  if (pinPromise) return pinPromise;
  pinPromise = new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "pin-screen";
    box.innerHTML = `
      <div class="pin-card">
        <div class="pin-emoji">${icon("home", 44)}</div>
        <h2>PIN de la casa</h2>
        <div class="pin-dots"></div>
        <div class="pin-error"></div>
        <div class="pin-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-n="${n}">${n}</button>`).join("")}
          <button data-n="del" aria-label="Borrar">${icon("backspace")}</button><button data-n="0">0</button><button data-n="ok" class="ok" aria-label="Entrar">${icon("check")}</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    let pin = "";
    const dots = $(".pin-dots", box);
    const err = $(".pin-error", box);
    const draw = () => { dots.textContent = "●".repeat(pin.length) || " "; };
    draw();
    const submit = async () => {
      const res = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        box.remove();
        pinPromise = null;
        resolve();
      } else {
        const data = await res.json().catch(() => ({}));
        err.textContent = data.detail || "PIN incorrecto";
        pin = "";
        draw();
      }
    };
    $$("button", box).forEach((b) => b.onclick = () => {
      const n = b.dataset.n;
      err.textContent = "";
      if (n === "del") pin = pin.slice(0, -1);
      else if (n === "ok") return submit();
      else if (pin.length < 12) pin += n;
      draw();
    });
  });
  return pinPromise;
}

// Convierte una línea de la lista de compras en lo que se suma al inventario.
export function toPantryLine(i) {
  return {
    name: i.name,
    quantity: i.quantity ?? 1,
    unit: i.quantity == null ? "unidad" : i.unit,
    category: i.category === "anotado" ? null : i.category,
  };
}

export const REASON_TEXT = { menu: "para el menú", "se acaba": "se está acabando", anotado: "anotado" };

// Las fotos del celular pesan 3–8 MB; se reducen antes de enviarlas (máx. ~2000 px, JPEG).
export async function compressImage(file, maxSide = 2000, quality = 0.85) {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3.5 * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    return blob ? new File([blob], "foto.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

// ---------------------------------------------------------------- íconos
// Dibujados para esta app: trazo redondeado de 1.8, en el color del texto.

const ICONS = {
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.8 4.3 4.2L19 7.5"/>',
  receipt: '<path d="M6.5 3.5h11v17l-1.9-1.3-1.9 1.3-1.8-1.3-1.8 1.3-1.9-1.3-1.7 1.3z"/><path d="M9.5 8h5M9.5 11.5h5M9.5 15h3"/>',
  basket: '<path d="M3.5 10h17l-1.6 8.4a2 2 0 0 1-2 1.6H7.1a2 2 0 0 1-2-1.6z"/><path d="m8.5 10 3-5.5M15.5 10l-3-5.5M9.5 13.5v3M14.5 13.5v3"/>',
  pot: '<path d="M4.5 10.5h15v5.5a4 4 0 0 1-4 4h-7a4 4 0 0 1-4-4z"/><path d="M2.5 10.5h19M9.5 7c0-1.2 1.2-1.6 1.2-2.8M13.3 7c0-1.2 1.2-1.6 1.2-2.8"/>',
  jar: '<path d="M8.5 3.5h7v2.8h-7z"/><path d="M7.5 6.3h9a1.5 1.5 0 0 1 1.5 1.5V18a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 18V7.8a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M6 11h12"/>',
  leaf: '<path d="M5 19.5C5 11 10 5 19.5 4.5c0 9.5-5.5 15-13.5 15"/><path d="m5 19.5 8-8"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  camera: '<path d="M4.5 8h2.8l1.9-2.8h5.6L16.7 8h2.8A1.5 1.5 0 0 1 21 9.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5A1.5 1.5 0 0 1 4.5 8z"/><circle cx="12" cy="13.5" r="3.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8.5 3v4M15.5 3v4"/>',
  spark: '<path d="M12 3.5 13.7 9 19 10.7 13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9z"/><path d="M18.5 16.5v4M16.5 18.5h4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5a1.5 1.5 0 0 0 1.5 1.5h6.2a1.5 1.5 0 0 0 1.5-1.5L17.5 7"/>',
  pencil: '<path d="m4.5 19.5 1-4.2L15.8 5a1.8 1.8 0 0 1 2.5 0l.7.7a1.8 1.8 0 0 1 0 2.5L8.7 18.5z"/><path d="m13.5 7.3 3.2 3.2"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3.5 19.5c0-3.3 2.5-5.6 5.5-5.6s5.5 2.3 5.5 5.6"/><path d="M15.5 5.3a3.3 3.3 0 0 1 0 6.4M17.3 14.2c2 .6 3.2 2.6 3.2 5.3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  undo: '<path d="M9 14.5 4.5 10 9 5.5"/><path d="M4.5 10h9.5a5.5 5.5 0 0 1 0 11H11"/>',
  home: '<path d="m3.5 11 8.5-7 8.5 7"/><path d="M5.5 9.5v10h13v-10"/><path d="M10 19.5V14h4v5.5"/>',
  star: '<path d="m12 4 2.4 5 5.3.7-3.9 3.7 1 5.3L12 16.2l-4.8 2.5 1-5.3-3.9-3.7 5.3-.7z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>',
  broom: '<path d="M19.5 3.5 12 11"/><path d="m12.8 10.2-4.6-.5L4 18.5l1.5 1.5 8.8-4.2-.5-4.6z"/><path d="m7.5 15.5 1.8 1.8"/>',
  warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8v.2"/>',
  backspace: '<path d="M9 5.5h10.5A1.5 1.5 0 0 1 21 7v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/>',
  cup: '<path d="M4.5 9h12v5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M16.5 10.5h1.5a2.5 2.5 0 0 1 0 5h-1.8M8.5 3.5c0 1.5 1.3 1.5 1.3 3M12.3 3.5c0 1.5 1.3 1.5 1.3 3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  apple: '<path d="M12 8c-2-1.5-6.5-1-6.5 4 0 4 2.5 8 4.5 8 1 0 1.3-.5 2-.5s1 .5 2 .5c2 0 4.5-4 4.5-8 0-5-4.5-5.5-6.5-4z"/><path d="M12 8c0-2 1-3.5 3-4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  chevron: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  cart: '<path d="M3.5 4.5h2.2l2 11h10.8l1.8-8H7"/><circle cx="9.5" cy="19.3" r="1.3"/><circle cx="17" cy="19.3" r="1.3"/>',
  bin: '<path d="M5 7.5h14M9.5 7.5V5h5v2.5M6.5 7.5l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12"/><path d="M10 11v6M14 11v6"/>',
  laundry: '<path d="M4 9.5h16l-1.5 9.2a2 2 0 0 1-2 1.8h-9a2 2 0 0 1-2-1.8z"/><path d="M4 9.5c2-3 5-5 8-5s6 2 8 5M8 13.5c1.3 1 2.6 1 4 0s2.7-1 4 0"/>',
  plate: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>',
  plant: '<path d="M7.5 14.5h9l-1.3 6h-6.4z"/><path d="M12 14.5V9M12 9c0-3 2-5 5.5-5 0 3-2 5-5.5 5zM12 11c0-2.5-1.8-4.3-4.8-4.3 0 2.6 1.8 4.3 4.8 4.3z"/>',
  paw: '<ellipse cx="12" cy="15.5" rx="4" ry="3.5"/><circle cx="6.5" cy="10.5" r="1.8"/><circle cx="9.8" cy="6.8" r="1.8"/><circle cx="14.2" cy="6.8" r="1.8"/><circle cx="17.5" cy="10.5" r="1.8"/>',
  bed: '<path d="M3.5 18.5V6.5M3.5 14.5h17v4M20.5 14.5v-2.5a2.5 2.5 0 0 0-2.5-2.5h-7.5v5"/><circle cx="7" cy="11.5" r="1.8"/>',
  shower: '<path d="M5 20.5V7a3 3 0 0 1 3-3h1.5a3 3 0 0 1 3 3v.5"/><path d="M9.5 9.5h6a3 3 0 0 0-6 0zM11 13v1M14 13v1M12.5 15.5v1M9.5 15.5v1M15.5 15.5v1"/>',
  sponge: '<rect x="3.5" y="8.5" width="17" height="10" rx="2.5"/><path d="M3.5 12.5h17M7.5 15.5h.01M11.5 15.5h.01M15.5 15.5h.01M9 5.5l1.5-1.5M14 5.5l1.5-1.5"/>',
  bulb: '<path d="M9 17.5h6M10 20.5h4M8.5 14c-1.5-1.2-2.5-3-2.5-5a6 6 0 0 1 12 0c0 2-1 3.8-2.5 5-.6.5-1 1.2-1 2v1.5h-5V16c0-.8-.4-1.5-1-2z"/>',
  box: '<path d="M3.5 8 12 4l8.5 4v8.5L12 20.5l-8.5-4z"/><path d="m3.5 8 8.5 4 8.5-4M12 12v8.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/>',
  fridge: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M6 9.5h12M9 5.5v2M9 12.5v3"/>',
  speaker: '<path d="M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5z"/><path d="M16 9a4.2 4.2 0 0 1 0 6M18.5 6.5a7.8 7.8 0 0 1 0 11"/>',
};

// Las tareas se guardan con un emoji (así las crea Administrar); en pantalla se dibujan con íconos propios.
export const CHORE_ICONS = {
  "🧹": ["broom", "Barrer"], "🗑️": ["bin", "Basura"], "🧺": ["laundry", "Ropa"], "🍽️": ["plate", "Loza"],
  "🪴": ["plant", "Plantas"], "🐶": ["paw", "Mascota"], "🛏️": ["bed", "Cama"], "🚿": ["shower", "Baño"],
  "🧽": ["sponge", "Limpiar"], "🛒": ["cart", "Mercado"], "💡": ["bulb", "Arreglos"], "📦": ["box", "Orden"],
};
export function choreIcon(emoji, size = 28) {
  return icon(CHORE_ICONS[emoji]?.[0] ?? "broom", size);
}

// Muestra "procesando" en el botón y evita dobles toques mientras dura la acción.
export async function withBusy(btn, fn) {
  if (!btn || btn.getAttribute("aria-busy") === "true") return undefined;
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }
}

export function icon(name, size = 24) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

// ---------------------------------------------------------------- modales
// Para confirmaciones y formularios. Se cierran con Esc, con la X o tocando fuera.

export function modal({ title = "", body = "", actions = [], size = "", onOpen = null } = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = `m ${size}`;
  dlg.innerHTML = `
    <div class="m-head">
      <h2 class="m-title">${title}</h2>
      <button class="m-x" data-m-close aria-label="Cerrar">${icon("close")}</button>
    </div>
    <div class="m-body">${body}</div>
    ${actions.length ? `<div class="m-actions">${actions.map((a, i) => `
      <button class="btn-${a.tone ?? "plain"}" data-m-act="${i}" ${a.id ? `id="${a.id}"` : ""}>
        ${a.icon ? icon(a.icon, 20) : ""}<span>${a.label}</span></button>`).join("")}</div>` : ""}`;
  document.body.appendChild(dlg);
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const close = (value = null) => {
    if (!dlg.open) return;
    dlg.classList.add("closing");
    setTimeout(() => { dlg.close(); dlg.remove(); }, 140);
    resolve(value);
  };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(null); });
  $$("[data-m-close]", dlg).forEach((b) => b.onclick = () => close(null));
  $$("[data-m-act]", dlg).forEach((b) => b.onclick = async () => {
    const a = actions[+b.dataset.mAct];
    if (a.onClick) {
      const r = await withBusy(b, () => a.onClick(dlg));
      if (r === false) return;
      close(r === undefined ? a.value ?? true : r);
    } else {
      close(a.value ?? true);
    }
  });
  dlg.showModal();
  onOpen?.(dlg, close);
  return { el: dlg, close, done };
}

export function confirmModal({ title, text = "", ok = "Sí", cancel = "Cancelar", tone = "primary", okIcon = "check" }) {
  return modal({
    title,
    size: "narrow",
    body: text ? `<p class="m-text">${text}</p>` : "",
    actions: [
      { label: cancel, tone: "plain", value: false },
      { label: ok, tone, value: true, icon: okIcon },
    ],
  }).done.then((v) => v === true);
}

// ---------------------------------------------------------------- avatares de la familia
// Un círculo con la inicial y un color propio por persona (estable según su id).
const AVATAR_COLORS = ["#17804f", "#1558b0", "#b45309", "#7b3fa0", "#c2410c", "#0f766e", "#be185d", "#4d7c0f"];
export function avatar(person, size = 28) {
  if (!person) return "";
  const color = AVATAR_COLORS[(person.id ?? 0) % AVATAR_COLORS.length];
  const initial = (person.name || "?").trim().charAt(0).toUpperCase();
  return `<span class="avatar" style="--av:${color};width:${size}px;height:${size}px;font-size:${Math.max(12, Math.round(size * 0.48))}px" aria-hidden="true">${esc(initial)}</span>`;
}
