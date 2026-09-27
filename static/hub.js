// Pantalla de la casa: lo de hoy de un vistazo y todo a un toque.
// Pensada para una tablet pegada en la nevera y para quien no se lleva bien con la tecnología:
// botones grandes, pocas palabras, siempre un botón para volver, y vuelve sola al inicio.

import {
  $, $$, api, cap, compressImage, esc, fmtAmount, fmtMoney, isoDate, mondayOf, safe,
  toPantryLine, toast,
} from "./common.js";

const app = $("#app");
const IDLE_MS = 2 * 60 * 1000;
const MEAL_LABEL = { desayuno: "Desayuno", almuerzo: "Almuerzo", merienda: "Merienda", cena: "Cena" };
const MEAL_ICON = { desayuno: "☕", almuerzo: "🍛", merienda: "🍎", cena: "🌙" };

let META = null;
let TODAY = null;
let screen = "home";

// ---------------------------------------------------------------- navegación

const SCREENS = {
  home: renderHome, receipt: renderReceipt, shopping: renderShopping, what: renderWhat,
  cook: renderCook, ranout: renderRanOut, chores: renderChores, who: renderWho,
};

function go(name, params = {}) {
  screen = name;
  window.scrollTo(0, 0);
  safe(() => SCREENS[name](params));
}
const home = () => go("home");

function head(title) {
  return `<div class="screen-head">
    <button class="back" data-back>← Volver</button><h1>${title}</h1></div>`;
}
function bindBack(to = home) {
  $$("[data-back]", app).forEach((b) => b.onclick = to);
}

// Si nadie toca la pantalla un rato, vuelve al inicio (menos mientras se lee una factura).
let idleTimer = null;
let busy = false;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!busy && screen !== "home") home(); }, IDLE_MS);
}
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

// Mantener la pantalla encendida (funciona con HTTPS o en localhost).
let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { /* no disponible: se configura en la tablet */ }
}
document.addEventListener("pointerdown", keepAwake, { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    keepAwake();
    if (screen === "home") home();
  }
});

// ---------------------------------------------------------------- inicio

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "¡Buenos días!" : h < 19 ? "¡Buenas tardes!" : "¡Buenas noches!";
}
function clock() {
  return new Date().toLocaleTimeString("es", { hour: "numeric", minute: "2-digit" });
}

async function renderHome() {
  TODAY = await api("/api/today");
  const t = TODAY;
  const dueChores = t.chores.filter((c) => !c.done_today).length;
  const firstRun = !t.setup.recipes && !t.setup.chores && !t.setup.pantry;

  app.innerHTML = `
    <header class="hub-top">
      <div>
        <div class="hub-hello">${greeting()}</div>
        <div class="hub-date">${cap(new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }))}</div>
      </div>
      <div class="row"><div class="hub-clock" id="clock">${clock()}</div>
        <a class="hub-admin" href="/admin" title="Recetas, inventario y ajustes">⚙️ Administrar</a></div>
    </header>

    <div class="big-actions">
      <button class="big-btn primary" data-go="receipt"><span class="ico">🧾</span>Escanear factura</button>
      <button class="big-btn" data-go="shopping"><span class="ico">🛒</span>Lista de compras
        ${t.shopping_count ? `<span class="count">${t.shopping_count}</span>` : ""}</button>
      <button class="big-btn" data-go="what"><span class="ico">🍳</span>¿Qué cocino?</button>
      <button class="big-btn" data-go="ranout"><span class="ico">🫙</span>Se acabó algo</button>
    </div>

    ${firstRun ? `<div class="panel" style="margin-bottom:1rem">
      <h2>👋 Bienvenidos</h2>
      <p>Para empezar, entren a <b>⚙️ Administrar</b> y agreguen sus recetas, las personas de la casa y sus tareas.
        Lo que hay en la nevera se llena solo al <b>escanear las facturas</b> del mercado.</p></div>` : ""}

    <div class="hub-grid">
      <div>
        <section class="panel">
          <h2>Hoy comemos</h2>
          ${t.meals.length ? t.meals.map((m) => `
            <div class="meal ${m.cooked ? "done" : ""}" data-meal="${m.id}">
              <span class="when">${MEAL_ICON[m.meal_type] ?? ""} ${esc(MEAL_LABEL[m.meal_type] ?? m.meal_type)}</span>
              <span class="what">${esc(m.recipe.name)}
                <small>${m.cooked ? "✔ Ya se cocinó" : m.can_cook ? "✅ Tenemos todo" : "Falta: " + esc(m.missing.join(", "))}</small></span>
              <span style="font-size:1.6rem">›</span>
            </div>`).join("")
          : `<div class="empty-note">Todavía no hay menú para hoy.</div>
             <div class="row"><button class="huge primary" id="plan">✨ Armar el menú de la semana</button></div>`}
        </section>
        ${t.expiring.length || t.low_stock.length ? `<section class="panel">
          <h2>Ojo con esto</h2>
          <div class="chips">
            ${t.expiring.map((e) => `<span class="chip ${e.days_left < 0 ? "bad" : ""}">⏰ ${esc(e.name)} · ${e.days_left < 0 ? "venció" : e.days_left === 0 ? "vence hoy" : e.days_left === 1 ? "vence mañana" : `vence en ${e.days_left} días`}</span>`).join("")}
            ${t.low_stock.map((n) => `<span class="chip">📉 Queda poco: ${esc(n)}</span>`).join("")}
          </div>
          ${t.expiring.length ? `<div style="margin-top:.8rem"><button data-go="what">🍳 Ver qué cocinar con eso</button></div>` : ""}
        </section>` : ""}
      </div>
      <section class="panel">
        <h2>Tareas de hoy <small>${dueChores ? `${dueChores} pendiente${dueChores > 1 ? "s" : ""}` : "¡al día! 🎉"}</small></h2>
        ${t.chores.length ? t.chores.map(choreRow).join("")
          : `<div class="empty-note">${t.setup.chores ? "Nada pendiente por hoy. 🙌" : "Aún no hay tareas. Agréguenlas en ⚙️ Administrar → Casa y tareas."}</div>`}
        ${t.setup.chores ? `<div style="margin-top:.6rem"><button data-go="chores">Ver todas las tareas</button></div>` : ""}
      </section>
    </div>`;

  $$("[data-go]", app).forEach((b) => b.onclick = () => go(b.dataset.go));
  $$("[data-meal]", app).forEach((el) => el.onclick = () => {
    const m = t.meals.find((x) => x.id === +el.dataset.meal);
    go("cook", { recipeId: m.recipe.id, servings: m.servings, entryId: m.cooked ? null : m.id });
  });
  bindChores(t.chores, home);
  $("#plan")?.addEventListener("click", () => safe(async () => {
    const created = await api("/api/menu/autoplan", { method: "POST", json: {
      start: isoDate(mondayOf(new Date())), days: 7, meal_types: ["almuerzo", "cena"],
    } });
    toast(created.length ? "¡Listo! Menú de la semana armado con lo que hay 🎉" : "Primero agreguen recetas en ⚙️ Administrar");
    home();
  }));
}

setInterval(() => {
  const c = $("#clock");
  if (c) c.textContent = clock();
}, 15000);
// refrescar el inicio cada 5 minutos (cambia el día, otros tocaron algo desde el celular…)
setInterval(() => { if (screen === "home" && !busy) safe(renderHome); }, 5 * 60 * 1000);

// ---------------------------------------------------------------- tareas

function choreRow(c) {
  const who = c.done_today
    ? `Hecho${c.last_done_by ? ` por ${esc(c.last_done_by.emoji)} ${esc(c.last_done_by.name)}` : ""} ✨`
    : c.turn ? `Le toca a ${esc(c.turn.emoji)} ${esc(c.turn.name)}` : "Cualquiera";
  const late = !c.done_today && c.days_late ? `<span class="late"> · atrasada ${c.days_late} día${c.days_late > 1 ? "s" : ""}</span>` : "";
  const next = !c.is_due && !c.done_today
    ? ` · próxima: ${new Date(c.due_on + "T12:00").toLocaleDateString("es", { weekday: "long", day: "numeric" })}` : "";
  return `<div class="chore ${c.done_today ? "done" : ""}">
    <span class="emo">${esc(c.emoji)}</span>
    <span class="txt"><strong>${esc(c.name)}</strong><span>${who}${late}${next}</span></span>
    <button class="check" data-chore="${c.id}" aria-label="${c.done_today ? "Deshacer" : "Hecho"}">✓</button>
  </div>`;
}

function bindChores(chores, after) {
  $$("[data-chore]", app).forEach((b) => b.onclick = () => {
    const c = chores.find((x) => x.id === +b.dataset.chore);
    if (c.done_today) {
      safe(async () => {
        await api(`/api/chores/${c.id}/undo`, { method: "POST" });
        toast("Listo, se deshizo");
        after();
      });
      return;
    }
    const members = TODAY?.members ?? [];
    if (members.length <= 1) return finishChore(c, members[0]?.id ?? null, after);
    go("who", { chore: c, after });
  });
}

async function finishChore(chore, memberId, after) {
  await safe(async () => {
    await api(`/api/chores/${chore.id}/done`, { method: "POST", json: { member_id: memberId } });
    const m = TODAY?.members.find((x) => x.id === memberId);
    toast(m ? `¡Gracias, ${m.name}! 🎉` : "¡Gracias! 🎉");
  });
  after();
}

function renderWho({ chore, after }) {
  const members = TODAY.members;
  const first = chore.turn ? [chore.turn.id] : [];
  const ordered = [...members].sort((a, b) => first.includes(b.id) - first.includes(a.id));
  app.innerHTML = `${head(`${esc(chore.emoji)} ${esc(chore.name)}`)}
    <h2 style="text-align:center;font-size:1.6rem">¿Quién lo hizo?</h2>
    <div class="people">
      ${ordered.map((m) => `<button class="person" data-m="${m.id}"><span class="ico">${esc(m.emoji)}</span>${esc(m.name)}</button>`).join("")}
      <button class="person" data-m=""><span class="ico">🤝</span>Entre todos</button>
    </div>`;
  bindBack(after);
  $$("[data-m]", app).forEach((b) => b.onclick = () => finishChore(chore, b.dataset.m ? +b.dataset.m : null, after));
}

async function renderChores() {
  const chores = await api("/api/chores");
  TODAY = TODAY ?? await api("/api/today");
  app.innerHTML = `${head("🧹 Tareas de la casa")}
    <section class="panel">${chores.map(choreRow).join("") || `<div class="empty-note">Aún no hay tareas.</div>`}</section>
    <p class="muted" style="margin-top:1rem">Para agregar o cambiar tareas: ⚙️ Administrar → Casa y tareas.</p>`;
  bindBack();
  bindChores(chores, () => go("chores"));
}

// ---------------------------------------------------------------- factura

let receipt = { photos: [], draft: null };

function renderReceipt() {
  if (!receipt.draft) return receiptPhotos();
  return receiptReview();
}

function receiptPhotos() {
  const n = receipt.photos.length;
  app.innerHTML = `${head("🧾 Escanear factura")}
    <input type="file" id="cam" accept="image/*" capture="environment" hidden>
    ${n === 0 ? `
      <label class="photo-drop" for="cam">
        <span class="ico">📷</span>Tomar foto de la factura
        <span class="muted" style="font-weight:400;font-size:1rem">Que se vea completa y derecha, con buena luz</span>
      </label>` : `
      <div class="thumbs">${receipt.photos.map((p, i) => `<img src="${URL.createObjectURL(p)}" alt="Parte ${i + 1}">`).join("")}</div>
      <p class="muted">¿La factura es larga? Tomen otra foto de la parte que falta.</p>
      <div class="bottom-bar">
        <button class="huge ok" id="read">✅ Leer la factura</button>
        <label class="btn huge" for="cam" role="button">➕ Otra parte</label>
        <button class="huge" id="restart">↺ Empezar de nuevo</button>
      </div>`}`;
  bindBack(() => { receipt = { photos: [], draft: null }; home(); });
  $("#cam").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    receipt.photos.push(await compressImage(f));
    receiptPhotos();
  };
  $("#restart")?.addEventListener("click", () => { receipt.photos = []; receiptPhotos(); });
  $("#read")?.addEventListener("click", readReceipt);
}

async function readReceipt() {
  busy = true;
  app.innerHTML = `<div class="loading"><span class="ico">🧾</span>
    <p>Leyendo la factura…</p><p class="muted">Esto toma unos segundos. No hay que tocar nada.</p></div>`;
  try {
    const fd = new FormData();
    receipt.photos.forEach((p) => fd.append("photos", p));
    receipt.draft = await api("/api/receipts/scan", { method: "POST", body: fd });
    receiptReview();
  } catch (e) {
    app.innerHTML = `${head("🧾 Escanear factura")}
      <div class="celebrate"><span class="ico">😕</span><h1>No se pudo leer</h1>
        <p class="muted">${esc(e.message)}</p>
        <div class="row" style="justify-content:center"><button class="huge primary" id="retry">Intentar otra vez</button></div></div>`;
    bindBack();
    $("#retry").onclick = () => { receipt = { photos: [], draft: null }; receiptPhotos(); };
  } finally {
    busy = false;
  }
}

function receiptReview() {
  const d = receipt.draft;
  const kept = () => d.items.filter((i) => i.keep).length;
  const row = (i, idx) => `
    <li class="${i.keep ? "on" : "off"}" data-idx="${idx}">
      <button class="tick" data-toggle aria-label="Guardar o no">${i.keep ? "✓" : ""}</button>
      <input class="name-edit" value="${esc(i.name)}" data-f="name" aria-label="Nombre">
      <input class="qty-edit" type="number" step="any" min="0" value="${i.quantity}" data-f="quantity" aria-label="Cantidad">
      <input class="unit-edit" value="${esc(i.unit)}" data-f="unit" aria-label="Unidad">
      <span class="qty">${fmtMoney(i.price)}</span>
    </li>`;
  const food = d.items.map((i, idx) => [i, idx]).filter(([i]) => i.kind === "alimento");
  const homeItems = d.items.map((i, idx) => [i, idx]).filter(([i]) => i.kind === "hogar");
  const other = d.items.map((i, idx) => [i, idx]).filter(([i]) => i.kind === "otro");

  app.innerHTML = `${head("🧾 Revisar la factura")}
    <div class="panel" style="margin-bottom:1rem">
      <div class="row spread"><strong style="font-size:1.2rem">🏪 ${esc(d.store || "Compra")}</strong>
        <span>${d.day ? new Date(d.day + "T12:00").toLocaleDateString("es", { day: "numeric", month: "long" }) : ""}
          ${d.total ? ` · <b>Total ${fmtMoney(d.total)}</b>` : ""}</span></div>
      <p class="muted" style="margin:.4rem 0 0">Toquen ✓ para quitar lo que no quieran guardar. Pueden corregir nombres y cantidades.
        ${d.notes ? `<br>${esc(d.notes)}` : ""}</p>
    </div>
    ${food.length ? `<div class="section-label">🥕 Comida</div><ul class="big-list">${food.map(([i, idx]) => row(i, idx)).join("")}</ul>` : ""}
    ${homeItems.length ? `<div class="section-label">🧼 Aseo y hogar</div><ul class="big-list">${homeItems.map(([i, idx]) => row(i, idx)).join("")}</ul>` : ""}
    ${other.length ? `<div class="section-label">No se guarda (bolsas, domicilio…)</div><ul class="big-list">${other.map(([i, idx]) => row(i, idx)).join("")}</ul>` : ""}
    ${d.items.length ? "" : `<div class="empty-note">No se encontraron productos en la foto.</div>`}
    <div class="bottom-bar">
      <button class="huge ok" id="save" ${kept() ? "" : "disabled"}>✅ Guardar ${kept()} producto${kept() === 1 ? "" : "s"} en la casa</button>
      <button class="huge" id="again">📷 Tomar otra foto</button>
    </div>`;
  bindBack(() => { receipt = { photos: [], draft: null }; home(); });
  $$("[data-toggle]", app).forEach((b) => b.onclick = () => {
    const i = d.items[+b.closest("li").dataset.idx];
    i.keep = !i.keep;
    receiptReview();
  });
  $$("[data-f]", app).forEach((inp) => inp.onchange = () => {
    const i = d.items[+inp.closest("li").dataset.idx];
    i[inp.dataset.f] = inp.dataset.f === "quantity" ? parseFloat(inp.value) || 0 : inp.value;
  });
  $("#again").onclick = () => { receipt = { photos: [], draft: null }; receiptPhotos(); };
  $("#save").onclick = () => safe(async () => {
    const items = d.items.filter((i) => i.keep && i.name.trim());
    const res = await api("/api/receipts", { method: "POST", json: {
      store: d.store, day: d.day, total: d.total,
      items: items.map((i) => ({ raw_text: i.raw_text, name: i.name.trim(), quantity: i.quantity, unit: i.unit || "unidad", category: i.category, price: i.price })),
    } });
    receipt = { photos: [], draft: null };
    celebrate("¡Listo!", `Se guardaron ${res.added} productos en la casa.`);
  });
}

function celebrate(title, text) {
  app.innerHTML = `<div class="celebrate"><span class="ico">🎉</span><h1>${esc(title)}</h1>
    <p style="font-size:1.2rem">${esc(text)}</p>
    <button class="huge primary" id="ok">Volver al inicio</button></div>`;
  $("#ok").onclick = home;
  setTimeout(() => { if (screen !== "home" && $("#ok")) home(); }, 6000);
}

// ---------------------------------------------------------------- lista de compras

const CART_KEY = "mychef-cart";
function loadCart() {
  try { return new Set(JSON.parse(localStorage.getItem(CART_KEY) || "[]")); } catch { return new Set(); }
}
function saveCart(set) {
  try { localStorage.setItem(CART_KEY, JSON.stringify([...set])); } catch { /* sin almacenamiento */ }
}
const cartKey = (i) => `${i.reason}:${i.name}`;

async function renderShopping() {
  const list = await api(`/api/shopping-list?start=${isoDate(mondayOf(new Date()))}&days=7`);
  const cart = loadCart();
  const groups = [["anotado", "✍️ Anotado"], ["se acaba", "📉 Se está acabando"], ["menu", "🍛 Para el menú de la semana"]];
  const row = (i) => {
    const on = cart.has(cartKey(i));
    return `<li class="${on ? "on" : ""}" data-key="${esc(cartKey(i))}">
      <button class="tick" data-tick aria-label="En el carrito">${on ? "✓" : ""}</button>
      <span class="name">${esc(i.name)}${i.recipes.length ? `<small>${esc(i.recipes.join(", "))}</small>` : ""}</span>
      <span class="qty">${i.quantity != null ? esc(fmtAmount(i.quantity, i.unit)) : ""}</span>
      ${i.extra_id ? `<button class="ghost danger" data-rm="${i.extra_id}" aria-label="Quitar">✕</button>` : ""}
    </li>`;
  };
  app.innerHTML = `${head("🛒 Lista de compras")}
    <form class="add-row" id="add">
      <input name="name" placeholder="¿Qué hace falta? (ej: jabón, pan…)" autocomplete="off">
      <button class="huge primary" type="submit">Agregar</button>
    </form>
    ${list.length ? groups.map(([reason, label]) => {
      const items = list.filter((i) => i.reason === reason);
      return items.length ? `<div class="section-label">${label}</div><ul class="big-list">${items.map(row).join("")}</ul>` : "";
    }).join("") : `<div class="celebrate"><span class="ico">🎉</span><h1>No falta nada</h1></div>`}
    ${list.length ? `<div class="bottom-bar">
      <button class="huge ok" id="scan">🧾 Ya compré: escanear factura</button>
      <button class="huge" id="bought">✓ Guardar lo marcado sin factura</button>
    </div>` : ""}`;
  bindBack();

  $("#add").onsubmit = (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    safe(async () => {
      await api("/api/shopping/extra", { method: "POST", json: { name } });
      toast(`Anotado: ${name}`);
      renderShopping();
    });
  };
  $$("[data-tick]", app).forEach((b) => b.onclick = () => {
    const key = b.closest("li").dataset.key;
    if (cart.has(key)) cart.delete(key); else cart.add(key);
    saveCart(cart);
    b.closest("li").classList.toggle("on");
    b.textContent = cart.has(key) ? "✓" : "";
  });
  $$("[data-rm]", app).forEach((b) => b.onclick = () => safe(async () => {
    await api(`/api/shopping/extra/${b.dataset.rm}`, { method: "DELETE" });
    renderShopping();
  }));
  $("#scan")?.addEventListener("click", () => { saveCart(new Set()); go("receipt"); });
  $("#bought")?.addEventListener("click", () => safe(async () => {
    const items = list.filter((i) => cart.has(cartKey(i)));
    if (!items.length) return toast("Toquen ✓ en lo que ya compraron");
    await api("/api/pantry/bulk", { method: "POST", json: items.map(toPantryLine) });
    saveCart(new Set());
    celebrate("¡Guardado!", `${items.length} productos quedaron en la casa.`);
  }));
}

// ---------------------------------------------------------------- se acabó algo

async function renderRanOut() {
  const pantry = await api("/api/pantry");
  pantry.sort((a, b) => (b.min_quantity != null) - (a.min_quantity != null) || a.name.localeCompare(b.name));
  const done = new Set();
  const draw = (filter = "") => {
    const f = filter.trim().toLowerCase();
    const items = pantry.filter((p) => !f || p.name.toLowerCase().includes(f));
    $("#tiles").innerHTML = items.map((p) => `
      <button class="tile ${done.has(p.name) ? "done" : ""}" data-name="${esc(p.name)}">${done.has(p.name) ? "✓ " : ""}${esc(p.name)}</button>`).join("")
      + (f && !items.some((p) => p.name.toLowerCase() === f)
        ? `<button class="tile" data-name="${esc(cap(filter.trim()))}">➕ ${esc(cap(filter.trim()))}</button>` : "");
    $$("#tiles [data-name]").forEach((b) => b.onclick = () => safe(async () => {
      const name = b.dataset.name;
      await api("/api/shopping/ran-out", { method: "POST", json: { name } });
      done.add(name);
      toast(`Anotado en la lista: ${name}`);
      draw($("#q").value);
    }));
  };
  app.innerHTML = `${head("🫙 ¿Qué se acabó?")}
    <p class="muted" style="margin-top:-.4rem">Tóquenlo y queda anotado en la lista de compras.</p>
    <div class="add-row"><input id="q" placeholder="Buscar o escribir…" autocomplete="off"></div>
    <div class="tiles" id="tiles"></div>
    <div class="bottom-bar"><button class="huge primary" data-back>Listo</button></div>`;
  bindBack();
  $("#q").oninput = (e) => draw(e.target.value);
  draw();
}

// ---------------------------------------------------------------- ¿qué cocino?

function mealNow() {
  const h = new Date().getHours();
  return h < 10 ? "desayuno" : h < 15 ? "almuerzo" : h < 18 ? "merienda" : "cena";
}

async function renderWhat({ meal } = {}) {
  meal = meal ?? mealNow();
  const sugg = await api(`/api/suggestions?meal_type=${meal}&limit=6`);
  app.innerHTML = `${head("🍳 ¿Qué cocino?")}
    <div class="row" style="margin-bottom:1rem">${META.meal_types.map((m) => `
      <button class="${m === meal ? "huge primary" : "huge"}" data-meal="${m}">${MEAL_ICON[m]} ${esc(MEAL_LABEL[m])}</button>`).join("")}</div>
    ${sugg.length ? `<div class="suggest">${sugg.map((s) => `
      <div class="panel" data-r="${s.recipe.id}">
        <h3>${s.recipe.favorite ? "⭐ " : ""}${esc(s.recipe.name)}</h3>
        <div>${s.can_cook ? "✅ Tenemos todo" : `Falta: ${esc(s.missing.map((x) => x.name).join(", "))}`}</div>
        ${s.uses_expiring.length ? `<div class="chip" style="display:inline-block;margin-top:.5rem">⏰ Aprovecha: ${esc(s.uses_expiring.join(", "))}</div>` : ""}
        ${s.recipe.prep_minutes ? `<div class="muted" style="margin-top:.4rem">⏱ ${s.recipe.prep_minutes} min</div>` : ""}
      </div>`).join("")}</div>`
      : `<div class="empty-note">No hay recetas de ${esc(MEAL_LABEL[meal].toLowerCase())}. Agréguenlas en ⚙️ Administrar.</div>`}`;
  bindBack();
  $$("[data-meal]", app).forEach((b) => b.onclick = () => go("what", { meal: b.dataset.meal }));
  $$("[data-r]", app).forEach((el) => el.onclick = () => go("cook", { recipeId: +el.dataset.r, back: { name: "what", meal } }));
}

// ---------------------------------------------------------------- modo cocina

const STATUS_ICON = { ok: "✅", hay: "✅", poco: "🟡", falta: "❌" };

async function renderCook({ recipeId, servings, entryId = null, back = null }) {
  servings = servings || META.household_size;
  const r = await api(`/api/recipes/${recipeId}?servings=${servings}`);
  const status = Object.fromEntries(r.availability.items.map((i) => [i.ingredient_id, i.status]));
  const steps = r.instructions.split("\n").map((s) => s.replace(/^\s*\d+[.)-]\s*/, "").trim()).filter(Boolean);
  const params = { recipeId, entryId, back };
  app.innerHTML = `${head(esc(r.name))}
    <div class="cook-servings">Para
      <button id="minus" aria-label="Menos">−</button><strong>${r.scaled_to}</strong><button id="plus" aria-label="Más">+</button>
      personas ${r.availability.can_cook ? `<span class="chip" style="background:var(--ok-soft);color:var(--ok)">✅ Tenemos todo</span>` : ""}
    </div>
    <div class="cook-cols">
      <section class="panel">
        <h2>Ingredientes</h2>
        <ul class="big-list">${r.ingredients.map((i) => `
          <li><span style="font-size:1.4rem">${STATUS_ICON[status[i.ingredient_id]]}</span>
            <span class="name">${esc(i.name)}${i.note ? `<small>${esc(i.note)}</small>` : ""}${i.optional ? "<small>opcional</small>" : ""}</span>
            <span class="qty"><b>${i.quantity ? esc(fmtAmount(i.quantity, i.unit)) : "al gusto"}</b></span></li>`).join("")}</ul>
      </section>
      <section class="panel">
        <h2>Preparación</h2>
        ${steps.length ? `<ol class="steps">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<div class="empty-note">Sin pasos escritos.</div>`}
        ${r.notes ? `<p class="muted">💡 ${esc(r.notes)}</p>` : ""}
      </section>
    </div>
    <div class="bottom-bar"><button class="huge ok" id="done">✅ Terminé de cocinar</button></div>`;
  bindBack(back ? () => go(back.name, back) : home);
  $("#minus").onclick = () => r.scaled_to > 1 && go("cook", { ...params, servings: r.scaled_to - 1 });
  $("#plus").onclick = () => go("cook", { ...params, servings: r.scaled_to + 1 });
  $("#done").onclick = () => safe(async () => {
    if (entryId) {
      if (r.scaled_to !== servings) await api(`/api/menu/${entryId}`, { method: "PATCH", json: { servings: r.scaled_to } });
      await api(`/api/menu/${entryId}/cook`, { method: "POST" });
    } else {
      await api(`/api/recipes/${recipeId}/cook`, { method: "POST", json: { servings: r.scaled_to } });
    }
    celebrate("¡Buen provecho!", "Se descontó lo que se usó de la nevera y la alacena.");
  });
}

// ---------------------------------------------------------------- inicio

(async () => {
  await safe(async () => {
    META = await api("/api/meta");
    home();
    resetIdle();
  });
})();
