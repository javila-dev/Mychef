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
    const err = new Error(msg);
    err.status = res.status; // p. ej. 503 = falta configurar la IA
    throw err;
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
// ---------------------------------------------------------------- adultos y niños
// La casa dice cuántos adultos y niños comen y cuánto come un niño (½ de un adulto).
// Lo que se guarda "por porciones" cuenta porciones de adulto: 2 adultos y 1 niño = 2,5.
export const PORTION = "porcion";
const HOUSE = { adults: 4, kids: 0, kid: 0.5 };
export function setHouse(meta) {
  HOUSE.adults = meta.household_size ?? HOUSE.adults;
  HOUSE.kids = meta.household_kids ?? 0;
  HOUSE.kid = meta.kid_portion ?? 0.5;
}
export const house = () => ({ ...HOUSE });
export const portionsOf = (adults, kids) => adults + kids * HOUSE.kid;
export function peopleText(adults, kids) {
  const a = adults ? `${adults} adulto${adults === 1 ? "" : "s"}` : "";
  const k = kids ? `${kids} niño${kids === 1 ? "" : "s"}` : "";
  return [a, k].filter(Boolean).join(" y ") || "nadie";
}
// Porciones guardadas -> adultos y niños ("para 2 adultos y 1 niño").
export function splitPortions(q) {
  const n = Math.max(0, Number(q) || 0);
  const adults = Math.floor(n + 1e-9);
  const rest = n - adults;
  const kids = HOUSE.kid > 0 ? Math.round(rest / HOUSE.kid) : 0;
  return Math.abs(kids * HOUSE.kid - rest) < 0.01 ? { adults, kids } : null;
}
// Porciones guardadas -> comidas: primero comidas completas de la casa y lo que sobre, una comida más
// ("3 comidas de 2 adultos y 1 niño + 1 de 1 adulto y 1 niño").
export function splitMeals(q) {
  const n = Math.max(0, Number(q) || 0);
  const meal = portionsOf(HOUSE.adults, HOUSE.kids);
  const lines = [];
  const whole = meal > 0 ? Math.floor(n / meal + 1e-9) : 0;
  if (whole) lines.push({ meals: whole, adults: HOUSE.adults, kids: HOUSE.kids });
  const rest = Math.round((n - whole * meal) * 1000) / 1000;
  if (rest > 0.01) {
    const p = splitPortions(rest);
    lines.push(p ? { meals: 1, ...p } : { meals: 1, adults: Math.max(1, Math.round(rest)), kids: 0 });
  }
  return lines;
}
export function fmtPortions(q) {
  const lines = splitMeals(q);
  if (!lines.length) return "No hay";
  return "Para " + lines.map((l, i) => `${i === 0 ? `${l.meals} comida${l.meals === 1 ? "" : "s"} de ` : "1 de "}${peopleText(l.adults, l.kids)}`).join(" + ");
}

// Dos contadores grandes: adultos y niños. Se lee con readPeople().
export function peoplePicker(adults, kids, id = "pp") {
  const row = (key, label, v) => `
    <div class="pp-row"><span class="pp-label">${label}</span>
      <button type="button" data-pp="${key}" data-d="-1" aria-label="Menos ${label.toLowerCase()}">${icon("minus", 24)}</button>
      <strong data-pp-v="${key}">${v}</strong>
      <button type="button" data-pp="${key}" data-d="1" aria-label="Más ${label.toLowerCase()}">${icon("plus", 24)}</button></div>`;
  return `<div class="people-picker" id="${id}">${row("adults", "Adultos", adults)}${row("kids", "Niños", kids)}</div>`;
}
export function bindPeople(root, onChange = null) {
  $$("[data-pp]", root).forEach((b) => b.onclick = () => {
    const v = $(`[data-pp-v="${b.dataset.pp}"]`, root);
    v.textContent = Math.max(0, (+v.textContent || 0) + +b.dataset.d);
    onChange?.(readPeople(root));
  });
}
export function readPeople(root) {
  return { adults: +$('[data-pp-v="adults"]', root).textContent || 0, kids: +$('[data-pp-v="kids"]', root).textContent || 0 };
}

export const AMOUNT_UNITS = ["unidad", "g", "kg", "ml", "l", "lb", "paquete", "bolsa", "caja", "lata", "botella", "tarro"];
export const unitStep = (unit) => (["g", "ml"].includes(unit) ? 100 : ["kg", "l", "lb"].includes(unit) ? 0.5 : 1);

// ¿Cuánto hay? Se elige en el mismo formulario: por porciones (adultos y niños) o por medida
// (un contador con − y +). Devuelve { quantity, unit } o null si cancelan.
export function amountForm(unit, quantity, { withUnit = false, preferPortions = false } = {}) {
  const byPortions = unit === PORTION || (unit == null && preferPortions);
  const lines = byPortions && quantity ? splitMeals(quantity) : [];
  if (!lines.length) lines.push({ meals: 1, adults: HOUSE.adults, kids: HOUSE.kids });
  const measure = unit && unit !== PORTION ? unit : "unidad";
  const start = byPortions || quantity == null ? unitStep(measure) : quantity;
  return `<div class="amount-form" data-mode="${byPortions ? "portions" : "measure"}">
    <div class="amt-mode" role="radiogroup" aria-label="Cómo contar">
      <button type="button" role="radio" data-mode="portions" aria-checked="${byPortions}">${icon("people", 20)} Porciones</button>
      <button type="button" role="radio" data-mode="measure" aria-checked="${!byPortions}">${icon("jar", 20)} Medida</button>
    </div>
    <div class="amt-portions">
      <p class="m-text">¿Para cuántas comidas alcanza?</p>
      <div class="meal-lines">${lines.map(mealLine).join("")}</div>
      <button type="button" class="add-line">${icon("plus", 20)} Otras comidas con otras personas</button>
      <p class="meal-total" aria-live="polite"></p>
    </div>
    <div class="amt-measure">
      <div class="inv-qty">
        <button type="button" data-d="-1" aria-label="Menos">${icon("minus", 28)}</button>
        <label><input class="qv" type="number" inputmode="decimal" step="any" min="0" value="${start}">
          ${withUnit ? `<select class="qu">${AMOUNT_UNITS.map((u) => `<option ${u === measure ? "selected" : ""}>${u}</option>`).join("")}</select>`
            : `<span class="qu-txt">${esc(measure)}</span>`}</label>
        <button type="button" data-d="1" aria-label="Más">${icon("plus", 28)}</button>
      </div>
    </div>
  </div>`;
}
// Una línea de "comidas": cuántas comidas y para quiénes (adultos y niños).
function mealLine(l) {
  const step = (key, v, label) => `<span class="ml-step" data-key="${key}">
    <button type="button" data-ml="-1" aria-label="Menos ${label}">${icon("minus", 20)}</button>
    <strong>${v}</strong>
    <button type="button" data-ml="1" aria-label="Más ${label}">${icon("plus", 20)}</button>
    <span class="ml-word" data-word="${key}"></span></span>`;
  return `<div class="meal-line">
    <div class="ml-top">${step("meals", l.meals, "comidas")}
      <button type="button" class="ml-rm" aria-label="Quitar esta línea">${icon("close", 20)}</button></div>
    <div class="ml-who"><span class="ml-de">de</span>${step("adults", l.adults, "adultos")}
      ${step("kids", l.kids, "niños")}</div>
  </div>`;
}
function readMealLines(box) {
  return $$(".meal-line", box).map((el) => {
    const v = (k) => +$(`[data-key="${k}"] strong`, el).textContent || 0;
    return { meals: v("meals"), adults: v("adults"), kids: v("kids") };
  });
}
function bindMealLines(box) {
  const wrap = $(".meal-lines", box);
  const sync = () => {
    $$(".meal-line", wrap).forEach((el) => {
      const v = (k) => +$(`[data-key="${k}"] strong`, el).textContent || 0;
      $('[data-word="meals"]', el).textContent = v("meals") === 1 ? "comida" : "comidas";
      $('[data-word="adults"]', el).textContent = v("adults") === 1 ? "adulto" : "adultos";
      $('[data-word="kids"]', el).textContent = v("kids") === 1 ? "niño" : "niños";
      $(".ml-rm", el).hidden = $$(".meal-line", wrap).length < 2;
    });
    const total = readMealLines(box).reduce((t, l) => t + l.meals, 0);
    $(".meal-total", box).textContent = total ? `En total alcanza para ${total} comida${total === 1 ? "" : "s"}.` : "";
  };
  const bind = () => {
    $$("[data-ml]", wrap).forEach((b) => b.onclick = () => {
      const v = $("strong", b.parentElement);
      const min = b.closest("[data-key]").dataset.key === "meals" ? 1 : 0;
      v.textContent = Math.max(min, (+v.textContent || 0) + +b.dataset.ml);
      sync();
    });
    $$(".ml-rm", wrap).forEach((b) => b.onclick = () => { b.closest(".meal-line").remove(); sync(); });
  };
  $(".add-line", box).onclick = () => {
    wrap.insertAdjacentHTML("beforeend", mealLine({ meals: 1, adults: 1, kids: 0 }));
    bind();
    sync();
  };
  bind();
  sync();
}
export function bindAmountForm(root, unit) {
  const box = $(".amount-form", root);
  $$(".amt-mode [data-mode]", box).forEach((b) => b.onclick = () => {
    box.dataset.mode = b.dataset.mode;
    $$(".amt-mode [data-mode]", box).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  });
  bindMealLines(box);
  const inp = $(".qv", box);
  $$("[data-d]", box).forEach((b) => b.onclick = () => {
    const u = $(".qu", box)?.value ?? (unit && unit !== PORTION ? unit : "unidad");
    const v = (parseFloat(inp.value) || 0) + unitStep(u) * +b.dataset.d;
    inp.value = Math.max(0, Math.round(v * 100) / 100);
  });
}
export function readAmountForm(root, unit) {
  const box = $(".amount-form", root);
  if (box.dataset.mode === "portions") {
    const quantity = readMealLines(box).reduce((t, l) => t + l.meals * portionsOf(l.adults, l.kids), 0);
    return { quantity: Math.round(quantity * 1000) / 1000, unit: PORTION };
  }
  const u = $(".qu", box)?.value ?? (unit && unit !== PORTION ? unit : "unidad");
  return { quantity: Math.max(0, parseFloat($(".qv", box).value) || 0), unit: u };
}

export function fmtAmount(q, unit) {
  const n = Number(q);
  const u = String(unit ?? "");
  if (u === PORTION) return fmtPortions(n);
  if (!NO_PLURAL.has(u) && n > 0) {
    const k = kitchenQty(n);
    if (k) return `${k} ${fmtUnit(n > 1 ? 2 : 1, u)}`;
  }
  return `${fmtQty(n)} ${fmtUnit(n, u)}`;
}

// ---------------------------------------------------------------- entrar: usuario y contraseña, o PIN de la casa

let pinPromise = null;

export async function askPin() {
  if (pinPromise) return pinPromise;
  const auth = await fetch("/api/auth").then((r) => r.json()).catch(() => ({}));
  if (pinPromise) return pinPromise;
  pinPromise = auth.mode === "password" ? askPassword() : askPinPad();
  return pinPromise;
}

function askPassword() {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "pin-screen";
    box.innerHTML = `
      <form class="pin-card login-card" autocomplete="on">
        <div class="pin-emoji">${icon("home", 44)}</div>
        <h2>Nuestra casa</h2>
        <label class="field">Usuario<input name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="pin-error" role="alert"></div>
        <button class="primary" type="submit">${icon("check", 20)} Entrar</button>
        <p class="muted small">Cada aparato entra una sola vez y queda recordado.</p>
      </form>`;
    document.body.appendChild(box);
    const f = $("form", box);
    const err = $(".pin-error", box);
    f.user.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const btn = $("button", f);
      btn.disabled = true;
      const res = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: f.user.value, password: f.password.value }),
      }).catch(() => null);
      btn.disabled = false;
      if (res?.ok) {
        box.remove();
        pinPromise = null;
        resolve();
        return;
      }
      const data = await res?.json().catch(() => ({}));
      err.textContent = data?.detail || "No hay conexión con el computador de la casa.";
      f.password.value = "";
      f.password.focus();
    };
  });
}

function askPinPad() {
  return new Promise((resolve) => {
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
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/><path d="M9 12h1.8l1-2 1.6 4 1-2H17"/>',
  book: '<path d="M4.5 5.5c2.7-.9 5.2-.6 7.5 1v13c-2.3-1.6-4.8-1.9-7.5-1z"/><path d="M19.5 5.5c-2.7-.9-5.2-.6-7.5 1v13c2.3-1.6 4.8-1.9 7.5-1z"/>',
  cake: '<path d="M4.5 20.5h15v-7a2 2 0 0 0-2-2h-11a2 2 0 0 0-2 2z"/><path d="M4.5 15.5c1.9 1.3 3.8 1.3 5 0 1.3 1.3 3.7 1.3 5 0 1.2 1.3 3.1 1.3 5 0M12 11.5v-3M12 6.5c-.9-.8-.9-1.9 0-3 .9 1.1.9 2.2 0 3z"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 2.9 5.8 1.4 5.8 4.2 0 1.3-1.3 2.1-3 2.1-1.3 0-2.4-.6-2.9-1.5M12 6.3v1.5M12 16.2v1.5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4" y="3" width="16" height="18" rx="2.2"/><path d="M11 18h2"/>',
  speaker: '<path d="M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5z"/><path d="M16 9a4.2 4.2 0 0 1 0 6M18.5 6.5a7.8 7.8 0 0 1 0 11"/>',
  // Grupos del inventario
  meat: '<path d="M13.2 4.6c3.4-1.4 7.6 2.8 6.2 6.2-1 2.4-3.6 3.6-6 3.2l-3.2 3.2a2 2 0 1 1-2.5 2.5 2 2 0 1 1-2.5-2.5 2 2 0 1 1 2.5-2.5L11 11.5c-.4-2.4.4-5.8 2.2-6.9z"/>',
  milk: '<path d="M8 8 9.5 3.5h5L16 8v11.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z"/><path d="M8 8h8M8 12.5h8"/>',
  carrot: '<path d="M16 8 4.5 19.5c1-4 3.5-9.5 6.5-12.5a3.5 3.5 0 0 1 5 1z"/><path d="M16 8c1.5-1.5 3-2 4.5-1.5M16 8c1.5-1.5 2-3 1.5-4.5M8.8 12.2l1.4 1.4M7 15.4l1.1 1.1"/>',
  grain: '<path d="M12 21V8"/><path d="M12 12c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4zM12 12c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4zM12 16.5c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4zM12 16.5c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4zM12 8c-1.2-1-1.2-3.5 0-4.5 1.2 1 1.2 3.5 0 4.5z"/>',
  bread: '<path d="M5.5 11.5A3.5 3.5 0 0 1 7 5h10a3.5 3.5 0 0 1 1.5 6.5v7a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M9.5 9.5v6M14.5 9.5v6"/>',
  can: '<ellipse cx="12" cy="5.5" rx="6" ry="2"/><path d="M6 5.5v13c0 1.1 2.7 2 6 2s6-.9 6-2v-13M6 9.5c0 1.1 2.7 2 6 2s6-.9 6-2M6 15c0 1.1 2.7 2 6 2s6-.9 6-2"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>',
  bottle: '<path d="M10 2.5h4v3.5l1.5 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-11L10 6z"/><path d="M8.5 12h7"/>',
  half: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  // Logros de los niños
  starFill: '<path d="m12 4 2.4 5 5.3.7-3.9 3.7 1 5.3L12 16.2l-4.8 2.5 1-5.3-3.9-3.7 5.3-.7z" fill="currentColor"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v6.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6.5M12 8.5v12M12 8.5c-1-2.8-4.8-4.5-5.6-2.3-.6 1.6 1.8 2.3 5.6 2.3zM12 8.5c1-2.8 4.8-4.5 5.6-2.3.6 1.6-1.8 2.3-5.6 2.3z"/>',
  flame: '<path d="M12 21c-3.6 0-6-2.5-6-5.8 0-4.2 4-6 4.2-10.7 2.8 1.6 4.2 4.3 4 6.8 1-.6 1.6-1.6 1.8-2.8 1.3 1.4 2 3.2 2 5 0 4.2-2.6 7.5-6 7.5z"/><path d="M12 21c-1.5 0-2.5-1.1-2.5-2.5 0-1.8 2.5-2.8 2.5-4.5 1.4 1 2.5 2.4 2.5 4.2 0 1.6-1 2.8-2.5 2.8z"/>',
  medal: '<circle cx="12" cy="14.5" r="5.5"/><path d="m8.5 10.3-3-6.8h4l2.5 5M15.5 10.3l3-6.8h-4l-1.4 3"/><path d="m12 12 .9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
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

// ---------------------------------------------------------------- horario de una tarea
// Lo usan Administrar y la pantalla de la casa (las tareas cambian: se arreglan desde la tablet).

export const DAY_SHORT = ["L", "M", "X", "J", "V", "S", "D"];
export const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
export const EVERY_OPTS = [[1, "Todos los días"], [2, "Cada 2 días"], [3, "Cada 3 días"], [7, "Cada semana"], [14, "Cada 15 días"], [30, "Cada mes"]];

export function scheduleOf(c) {
  return {
    schedule: c.schedule ?? "every", every_days: c.every_days ?? 7, weekdays: c.weekdays ?? [],
    month_day: c.month_day ?? null, remind_at: c.remind_at ?? null,
  };
}

export function scheduleFields(c) {
  const s = scheduleOf(c);
  const kinds = [["weekdays", "Días de la semana"], ["every", "Cada ciertos días"], ["monthday", "Un día del mes"]];
  const everyOpts = EVERY_OPTS.some(([v]) => v === s.every_days) ? EVERY_OPTS : [...EVERY_OPTS, [s.every_days, `Cada ${s.every_days} días`]];
  return `
    <div class="field">¿Cuándo toca?
      <div class="seg">${kinds.map(([k, t]) => `<label><input type="radio" name="schedule" value="${k}" ${k === s.schedule ? "checked" : ""}><span>${t}</span></label>`).join("")}</div>
    </div>
    <div data-sch="weekdays" class="field">¿Qué días?
      <div class="days">${DAY_SHORT.map((d, i) => `<label title="${DAY_NAMES[i]}"><input type="checkbox" name="wd" value="${i}" ${s.weekdays.includes(i) ? "checked" : ""}><span>${d}</span></label>`).join("")}</div>
    </div>
    <label data-sch="every" class="field">¿Cada cuánto?<select name="every_days">
      ${everyOpts.map(([v, t]) => `<option value="${v}" ${v === s.every_days ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    <label data-sch="monthday" class="field">¿Qué día del mes?<input name="month_day" type="number" min="1" max="31" value="${s.month_day ?? ""}" placeholder="Ej: 1, 15, 30"></label>
    <label class="field">Recordar en voz alta a las
      <input name="remind_at" type="time" value="${s.remind_at ?? ""}">
      <small class="muted">La tablet lo dice en voz alta ese día a esa hora, si nadie la ha hecho. Vacío = sin recordatorio.</small></label>`;
}

export function bindSchedule(form) {
  const sync = () => {
    const kind = form.querySelector("[name=schedule]:checked")?.value ?? "every";
    $$("[data-sch]", form).forEach((el) => { el.hidden = el.dataset.sch !== kind; });
  };
  $$("[name=schedule]", form).forEach((r) => r.onchange = sync);
  sync();
}

export function readSchedule(form) {
  return {
    schedule: form.querySelector("[name=schedule]:checked")?.value ?? "every",
    every_days: +form.every_days.value || 7,
    weekdays: $$("[name=wd]:checked", form).map((i) => +i.value),
    month_day: form.month_day.value ? +form.month_day.value : null,
    remind_at: form.remind_at.value || null,
  };
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

// La estrella de los niños: gordita, con puntas redondas, carita feliz y un brillo (tipo sticker).
// Sin ganar: el contorno punteado, como el espacio donde se pega el sticker.
const STAR_PTS = "32,8 40.2,23.7 57.7,26.7 45.3,39.3 47.9,56.8 32,49 16.1,56.8 18.7,39.3 6.3,26.7 23.8,23.7";
export function kidStar(on = true) {
  if (!on) {
    return `<svg class="kstar off" viewBox="0 0 64 64" aria-hidden="true"><polygon class="ks-slot" points="${STAR_PTS}"/></svg>`;
  }
  return `<svg class="kstar" viewBox="0 0 64 64" aria-hidden="true">
    <polygon class="ks-edge" points="${STAR_PTS}"/><polygon class="ks-fill" points="${STAR_PTS}"/>
    <path class="ks-shine" d="M19.5 27.5q3.5-4.5 8.5-4.8"/>
    <circle class="ks-cheek" cx="21.5" cy="41" r="3"/><circle class="ks-cheek" cx="42.5" cy="41" r="3"/>
    <circle class="ks-eye" cx="26.5" cy="35.5" r="2.7"/><circle class="ks-eye" cx="37.5" cy="35.5" r="2.7"/>
    <path class="ks-smile" d="M27.5 41.5q4.5 4.6 9 0"/></svg>`;
}

// ---------------------------------------------------------------- premio de un niño
// Lo usan la tablet (Logros) y Administrar (Premios). Para los que aún no leen, el premio se ve:
// un ícono a color (los que trae la app o uno buscado en internet) o una foto de verdad.

export function prizeArt(goal, size = 64) {
  if (!goal?.art) return icon("gift", size);
  return `<img class="prize-img ${goal.kind === "photo" ? "is-photo" : ""}" src="${esc(goal.art)}" alt="" loading="lazy">`;
}

// El camino de estrellas con los premios en su sitio: ⭐×10 → 🍦, ⭐×5 → 🛝, ⭐×5 → 🚲.
// Estrellas ganadas con carita; las que faltan, punteadas. Cada premio: entregado (✓), listo para
// entregar (salta), el próximo (late suave) o más adelante. `from` = cuántas tenía antes: las nuevas se
// prenden con animación. Tocar un premio (data-say-prize) sirve para que la tablet lo diga en voz alta.
export function kidPath(kid, { from = kid.stars } = {}) {
  const prizes = kid.prizes ?? [];
  if (!prizes.length) return "";
  const at = new Map(prizes.map((p) => [p.stars, p]));
  const nextId = kid.goal?.id;
  const cells = [];
  let n = 0;
  for (let s = 1; s <= kid.path; s++) {
    const on = s <= kid.stars;
    const fresh = on && s > from;
    cells.push(`<span class="kp-star ${on ? "on" : ""} ${fresh ? "new" : ""} ${s === kid.stars + 1 ? "next" : ""}" style="--d:${fresh ? (s - from) * 0.12 : n * 0.03}s">${kidStar(on)}</span>`);
    n++;
    const p = at.get(s);
    if (p) {
      const state = p.claimed ? "done" : p.ready ? "ready" : p.id === nextId ? "next" : "later";
      cells.push(`<button type="button" class="kp-prize ${state}" data-say-prize="${p.id}"
          aria-label="${esc(p.name)}, en la estrella ${p.stars}${p.claimed ? ", ya entregado" : p.ready ? ", ya lo ganó" : ""}">
        <span class="kp-art">${prizeArt(p, 56)}</span>
        <span class="kp-num"><i class="ks-18">${kidStar()}</i>${p.stars}</span>
        ${p.claimed ? `<span class="kp-check" aria-hidden="true">${icon("check", 18)}</span>` : ""}
      </button>`);
    }
  }
  return `<div class="kid-path" role="img" aria-label="${kid.stars} de ${kid.path} estrellas">${cells.join("")}</div>`;
}

// Un premio del camino: su imagen (ícono a color, buscado o foto), qué se gana y en qué estrella.
export function prizeForm(kid, prizes, prize = null) {
  const k = kid.member;
  const taken = new Set((kid.prizes ?? []).filter((p) => p.id !== prize?.id).map((p) => p.stars));
  const last = Math.max(0, ...(kid.prizes ?? []).map((p) => p.stars));
  const g = prize ?? { name: "", stars: last ? last + 5 : 10, icon: "", art: null, kind: null };
  const ideas = [...new Set([g.stars, 5, 10, 15, 20, 25, 30, 40, 50, last + 5, last + 10])].filter((n) => n > 0 && !taken.has(n)).sort((a, b) => a - b);
  let pick = g.art ? { kind: g.kind, icon: g.icon, url: g.art } : null;
  const tile = (p) => `<button type="button" class="prize-tile" data-icon="${esc(p.icon)}" data-url="${esc(p.url)}" data-name="${esc(p.name ?? "")}"
      aria-pressed="false" title="${esc(p.name ?? "")}"><img src="${esc(p.url)}" alt="${esc(p.name ?? "")}" loading="lazy">${p.name ? `<small>${esc(p.name)}</small>` : ""}</button>`;
  const m = modal({
    title: prize ? `Premio de ${esc(k.name)}` : `Nuevo premio para ${esc(k.name)}`,
    size: "wide",
    body: `<form id="gf" class="stack prize-form">
      <div class="prize-top">
        <div class="prize-preview" aria-live="polite"></div>
        <div class="stack" style="gap:.6rem;flex:1;min-width:0">
          <label class="field">¿Qué se gana? <small class="muted">(la tablet se lo dice en voz alta)</small>
            <input name="name" required maxlength="60" autocomplete="off" value="${esc(g.name)}" placeholder="Ej: Un helado el domingo"></label>
          <div class="field">¿En qué estrella del camino se gana?
            <div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:center">
              <input name="stars" type="number" min="1" max="500" required value="${g.stars}" style="width:6rem">
              <span class="seg quick-stars">${ideas.slice(0, 7).map((n) => `<button type="button" data-n="${n}">${n}</button>`).join("")}</span>
            </div>
            ${taken.size ? `<small class="muted">Ya hay premios en: ${[...taken].sort((a, b) => a - b).join(", ")} estrellas.</small>` : ""}
          </div>
        </div>
      </div>
      <div class="field">Buscar un dibujo a color <small class="muted">(en español: helado, dinosaurio, playa, unicornio…)</small>
        <div class="row prize-search"><input name="q" type="search" autocomplete="off" placeholder="¿Qué le gusta a ${esc(k.name)}?">
          <button type="button" data-search>${icon("search", 20)} Buscar</button></div></div>
      <div class="prize-results" hidden></div>
      <div class="field">O elijan uno de estos
        <div class="prize-grid">${prizes.map(tile).join("")}</div></div>
      <div class="row" style="gap:.6rem;flex-wrap:wrap;align-items:center">
        <label class="btn">${icon("camera", 20)} Usar una foto del premio de verdad
          <input type="file" name="photo" accept="image/*" capture="environment" hidden></label>
        <small class="muted">Íconos: Fluent Emoji (Microsoft) y Noto Emoji (Google), de uso libre.</small>
      </div>
    </form>`,
    onOpen: (dlg) => {
      const f = $("#gf", dlg);
      const preview = $(".prize-preview", dlg);
      const results = $(".prize-results", dlg);
      let lastAuto = g.name;
      let objectUrl = null;
      const draw = () => {
        preview.innerHTML = pick?.url ? `<img class="prize-img ${pick.kind === "photo" ? "is-photo" : ""}" src="${esc(pick.url)}" alt="">` : icon("gift", 64);
        $$(".prize-tile", dlg).forEach((t) => t.setAttribute("aria-pressed", String(pick?.kind === "icon" && t.dataset.icon === pick.icon)));
        $$(".quick-stars [data-n]", dlg).forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.n === +f.stars.value)));
      };
      $$(".quick-stars [data-n]", dlg).forEach((b) => b.onclick = () => { f.stars.value = b.dataset.n; draw(); });
      f.stars.oninput = draw;
      const bindTiles = (root) => $$(".prize-tile", root).forEach((t) => t.onclick = () => {
        pick = { kind: "icon", icon: t.dataset.icon, url: t.dataset.url };
        // El nombre sugerido reemplaza al anterior solo si nadie lo escribió a mano
        if (t.dataset.name && (!f.name.value.trim() || f.name.value === lastAuto)) f.name.value = lastAuto = t.dataset.name;
        draw();
      });
      bindTiles(dlg);
      const search = async () => {
        const q = f.q.value.trim();
        if (!q) return f.q.focus();
        results.hidden = false;
        results.innerHTML = `<p class="muted">Buscando…</p>`;
        try {
          const res = await api(`/api/prize-icons?q=${encodeURIComponent(q)}`);
          results.innerHTML = res.icons.length
            ? `<div class="prize-grid small">${res.icons.map((i) => tile({ icon: i.icon, url: i.url })).join("")}</div>`
            : `<p class="muted">No encontramos «${esc(q)}». Prueben con otra palabra (también sirve en inglés).</p>`;
          bindTiles(results);
          draw();
        } catch (e) {
          results.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        }
      };
      $("[data-search]", dlg).onclick = search;
      f.q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } };
      f.photo.onchange = async () => {
        const raw = f.photo.files[0];
        if (!raw) return;
        const file = await compressImage(raw, 1200, 0.85);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(file);
        pick = { kind: "photo", file, url: objectUrl };
        draw();
      };
      draw();
    },
    actions: [
      ...(prize ? [{ label: "Quitar premio", tone: "danger", icon: "trash", value: "delete" }] : []),
      { label: "Cancelar", value: false },
      {
        label: prize ? "Guardar" : "Agregar premio", tone: "primary", icon: prize ? "check" : "plus",
        onClick: async (dlg) => {
          const f = $("#gf", dlg);
          if (!f.reportValidity()) return false;
          const body = { name: f.name.value.trim(), stars: +f.stars.value, icon: pick?.kind === "icon" ? pick.icon : "" };
          const ok = await safe(async () => {
            const res = prize
              ? await api(`/api/kids/${k.id}/prizes/${prize.id}`, { method: "PUT", json: body })
              : await api(`/api/kids/${k.id}/prizes`, { method: "POST", json: body });
            if (pick?.file) {
              const id = prize?.id ?? res.prizes.find((p) => p.stars === body.stars)?.id;
              const fd = new FormData();
              fd.append("photo", pick.file, "premio.jpg");
              await api(`/api/kids/${k.id}/prizes/${id}/photo`, { method: "POST", body: fd });
            }
            return true;
          });
          if (!ok) return false;
          toast(prize ? "Premio guardado" : `Premio agregado en la estrella ${body.stars}`);
          return "saved";
        },
      },
    ],
  });
  return m.done.then(async (v) => {
    if (v !== "delete") return v;
    if (!await confirmModal({ title: "¿Quitar este premio?", text: `«${esc(prize.name)}» sale del camino de ${esc(k.name)}. Sus estrellas no cambian.`, ok: "Quitar", tone: "danger", okIcon: "trash" })) return null;
    await safe(() => api(`/api/kids/${k.id}/prizes/${prize.id}`, { method: "DELETE" }));
    return "deleted";
  });
}

// La lista de premios de un niño (Administrar y el lápiz de la tablet): en orden de estrellas,
// con su estado, para cambiar, entregar o agregar otro.
export function prizeRows(kid) {
  return `<ol class="prize-rows">${(kid.prizes ?? []).map((p) => `
    <li class="${p.claimed ? "done" : p.ready ? "ready" : ""}">
      <span class="pr-art">${prizeArt(p, 34)}</span>
      <span class="pr-num"><i class="ks-18">${kidStar()}</i>${p.stars}</span>
      <span class="pr-name">${esc(p.name)}<small>${p.claimed ? "Entregado ✓" : p.ready ? "¡Ya llegó!" : `faltan ${p.stars - kid.stars}`}</small></span>
      ${p.ready && p.id === kid.goal?.id ? `<button class="primary" data-claim="${kid.member.id}">${icon("gift", 18)} Entregar</button>` : ""}
      <button class="ghost" data-edit-prize="${p.id}" aria-label="Cambiar «${esc(p.name)}»">${icon("pencil", 18)}</button>
    </li>`).join("")}</ol>`;
}
