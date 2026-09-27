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
  const res = await fetch(path, init);
  if (res.status === 401 && path !== "/api/login") {
    await askPin();
    return api(path, opts);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    let msg = data?.detail ?? `Error ${res.status}`;
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
export function fmtDay(d) { return d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "short" }); }
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
export function fmtAmount(q, unit) { return `${fmtQty(q)} ${fmtUnit(q, unit)}`; }

// ---------------------------------------------------------------- PIN de la casa

let pinPromise = null;

export function askPin() {
  if (pinPromise) return pinPromise;
  pinPromise = new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "pin-screen";
    box.innerHTML = `
      <div class="pin-card">
        <div class="pin-emoji">🏠</div>
        <h2>PIN de la casa</h2>
        <div class="pin-dots"></div>
        <div class="pin-error"></div>
        <div class="pin-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-n="${n}">${n}</button>`).join("")}
          <button data-n="del" aria-label="Borrar">⌫</button><button data-n="0">0</button><button data-n="ok" class="ok" aria-label="Entrar">✓</button>
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
