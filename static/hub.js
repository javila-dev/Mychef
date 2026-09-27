// Pantalla de la casa: lo de hoy de un vistazo y todo a un toque.
// Pensada para una tablet pegada en la nevera y para quien no se lleva bien con la tecnología:
// botones grandes, pocas palabras, confirmaciones y formularios en ventanas (modales),
// y si nadie la toca un rato, vuelve sola al inicio.

import {
  $, $$, api, cap, choreIcon, compressImage, confirmModal, esc, fmtAmount, fmtMoney, icon, isoDate,
  modal, mondayOf, safe, toPantryLine, toast, withBusy,
} from "./common.js";

const app = $("#app");
const IDLE_MS = 2 * 60 * 1000;
const MEAL_LABEL = { desayuno: "Desayuno", almuerzo: "Almuerzo", merienda: "Merienda", cena: "Cena" };
const MEAL_ICON = { desayuno: "cup", almuerzo: "sun", merienda: "apple", cena: "moon" };

let META = null;
let TODAY = null;
let screen = "home";
let busy = false; // mientras se lee una factura no se vuelve al inicio

// ---------------------------------------------------------------- navegación

const SCREENS = { home: renderHome, shopping: renderShopping, what: renderWhat, cook: renderCook, chores: renderChores };

function go(name, params = {}) {
  screen = name;
  window.scrollTo(0, 0);
  return safe(() => SCREENS[name](params));
}
const home = () => go("home");
const refresh = () => (screen === "home" ? home() : null);

function head(title, back = "Volver al inicio") {
  return `<div class="screen-head">
    <button class="back" data-back aria-label="${back}">${icon("back", 28)}</button><h1>${title}</h1></div>`;
}
function bindBack(to = home) {
  $$("[data-back]", app).forEach((b) => b.onclick = to);
}

let idleTimer = null;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (busy) return resetIdle();
    $$("dialog.m[open]").forEach((d) => { d.close(); d.remove(); });
    if (screen !== "home") home();
  }, IDLE_MS);
}
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

// Mantener la pantalla encendida (funciona con HTTPS o en localhost; si no, se configura en la tablet).
let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { /* no disponible */ }
}
document.addEventListener("pointerdown", keepAwake, { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepAwake(); refresh(); }
});

function doneModal(title, text) {
  const m = modal({
    size: "narrow",
    title: "",
    body: `<div class="done-msg"><div class="mark">${icon("check", 46)}</div>
      <h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`,
    actions: [{ label: "Listo", tone: "primary" }],
  });
  const t = setTimeout(() => m.close(), 5000);
  return m.done.then(() => clearTimeout(t));
}

// ---------------------------------------------------------------- inicio

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}
function clock() {
  return new Date().toLocaleTimeString("es", { hour: "numeric", minute: "2-digit" });
}
function daysText(d) {
  return d < 0 ? "ya venció" : d === 0 ? "vence hoy" : d === 1 ? "vence mañana" : `vence en ${d} días`;
}

function homeSkeleton() {
  app.innerHTML = `<div aria-busy="true" aria-label="Cargando">
    <div class="skel" style="height:96px;width:min(420px,70%);margin-bottom:1.4rem"></div>
    <div class="actions">${'<div class="skel" style="min-height:112px"></div>'.repeat(4)}</div>
    <div class="board"><div class="skel" style="height:260px"></div><div class="skel" style="height:320px"></div></div></div>`;
}

function errorState(retry) {
  app.innerHTML = `<div class="panel state-block">${icon("warn", 44)}
    <h2>No se pudo cargar</h2><p>Revisen que el computador de la casa esté prendido y conectado.</p>
    <button class="primary big" id="retry">${icon("undo")} Intentar de nuevo</button></div>`;
  $("#retry").onclick = retry;
}

async function renderHome() {
  if (!app.querySelector(".hub-top")) homeSkeleton();
  try {
    TODAY = await api("/api/today");
  } catch {
    return errorState(home);
  }
  const t = TODAY;
  const pending = t.chores.filter((c) => !c.done_today).length;
  const firstRun = !t.setup.recipes && !t.setup.chores && !t.setup.pantry;
  const listHint = t.shopping_count ? `${t.shopping_count} cosa${t.shopping_count > 1 ? "s" : ""} por comprar` : "No falta nada";
  const cookHint = t.expiring.length ? `Aprovechar lo que vence` : "Ideas con lo que hay";

  app.innerHTML = `
    <header class="hub-top">
      <div>
        <h1 class="hub-hello">${greeting()}</h1>
        <div class="hub-date">${cap(new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }))} · <b>${esc(META.house_name)}</b></div>
      </div>
      <div class="hub-right">
        <div class="hub-clock" id="clock">${clock()}</div>
        <a class="hub-admin" href="/admin" title="Administrar recetas, inventario y tareas" aria-label="Administrar">${icon("sliders", 26)}</a>
      </div>
    </header>

    <nav class="actions">
      <button class="act act-scan" data-act="receipt">${icon("receipt", 36)}
        <span><span class="label">Escanear factura</span><span class="hint">Una foto y queda todo guardado</span></span></button>
      <button class="act act-list" data-act="shopping">${icon("basket", 36)}
        ${t.shopping_count ? `<span class="count" aria-label="${t.shopping_count} por comprar">${t.shopping_count}</span>` : ""}
        <span><span class="label">Lista de compras</span><span class="hint">${listHint}</span></span></button>
      <button class="act act-cook" data-act="what">${icon("pot", 36)}
        <span><span class="label">¿Qué cocino?</span><span class="hint">${cookHint}</span></span></button>
      <button class="act act-out" data-act="ranout">${icon("jar", 36)}
        <span><span class="label">Se acabó algo</span><span class="hint">Anotarlo en la lista</span></span></button>
    </nav>

    ${firstRun ? `<section class="panel" style="margin-bottom:1.2rem">
      <div class="panel-title"><h2>Bienvenidos</h2></div>
      <p style="margin:0">Para empezar, toquen ${icon("sliders", 20)} arriba a la derecha y agreguen sus recetas, las personas de la casa y las tareas.
        Lo que hay en la nevera se llena solo al <b>escanear las facturas</b> del mercado.</p></section>` : ""}

    <div class="board">
      <div>
        <section class="panel menu-card">
          <h2>Hoy en la mesa</h2>
          ${t.meals.length ? t.meals.map((m) => `
            <button class="dish ${m.cooked ? "done" : ""}" data-meal="${m.id}">
              <span class="line"><span class="when">${esc(MEAL_LABEL[m.meal_type] ?? m.meal_type)}</span><span class="dots"></span>
                <span class="name">${esc(m.recipe.name)}</span></span>
              <span class="state ${m.cooked ? "" : m.can_cook ? "ok" : "miss"}">${m.cooked ? `${icon("check", 18)} Ya se cocinó`
                : m.can_cook ? `${icon("check", 18)} Tenemos todo` : `Falta: ${esc(m.missing.join(", "))}`}</span>
            </button>`).join("")
          : t.setup.recipes ? `<p class="empty-note" style="text-align:center">Todavía no hay menú para hoy.</p>
             <div class="row" style="justify-content:center"><button class="primary big" id="plan">${icon("spark")} Armar el menú de la semana</button></div>`
          : `<p class="empty-note" style="text-align:center">Cuando carguen sus recetas en ${icon("sliders", 18)} Administrar, aquí aparece lo que se come hoy.</p>`}
        </section>
        ${t.expiring.length || t.low_stock.length ? `<section class="panel">
          <div class="panel-title"><h2>Ojo con esto</h2></div>
          <div class="labels">
            ${t.expiring.map((e) => `<span class="label-tag ${e.days_left < 0 ? "bad" : ""}">${icon("clock", 20)} ${esc(e.name)} · ${daysText(e.days_left)}</span>`).join("")}
            ${t.low_stock.map((n) => `<span class="label-tag low">${icon("jar", 20)} Queda poco: ${esc(n)}</span>`).join("")}
          </div>
          ${t.expiring.length ? `<div style="margin-top:1rem"><button class="btn-soft" data-act="what">${icon("pot", 20)} Ver qué cocinar con eso</button></div>` : ""}
        </section>` : ""}
      </div>
      <section class="panel note">
        <div class="panel-title"><h2>Pendientes de hoy</h2>
          <small>${t.chores.length ? (pending ? `${pending} por hacer` : "¡Todo al día!") : ""}</small></div>
        ${t.chores.length ? t.chores.map(choreRow).join("")
          : `<p class="empty-note">${t.setup.chores ? "Nada pendiente por hoy." : `Aún no hay tareas. Se agregan en ${icon("sliders", 18)} → Casa y tareas.`}</p>`}
        ${t.setup.chores ? `<div style="margin-top:.8rem"><button data-act="chores">${icon("broom", 20)} Ver todas las tareas</button></div>` : ""}
      </section>
    </div>`;

  const ACTS = { receipt: receiptModal, shopping: () => go("shopping"), what: () => go("what"), ranout: ranOutModal, chores: () => go("chores") };
  $$("[data-act]", app).forEach((b) => b.onclick = () => ACTS[b.dataset.act]());
  $$("[data-meal]", app).forEach((el) => el.onclick = () => {
    const m = t.meals.find((x) => x.id === +el.dataset.meal);
    go("cook", { recipeId: m.recipe.id, servings: m.servings, entryId: m.cooked ? null : m.id });
  });
  bindChores(t.chores, home);
  $("#plan")?.addEventListener("click", (e) => safe(async () => {
    const btn = e.currentTarget;
    const ok = await confirmModal({
      title: "¿Armamos el menú de la semana?",
      text: "Se llenan el almuerzo y la cena de cada día con sus recetas, usando primero lo que ya hay en la casa. Después se puede cambiar.",
      ok: "Sí, armarlo", okIcon: "spark",
    });
    if (!ok) return;
    const created = await withBusy(btn, () => api("/api/menu/autoplan", { method: "POST", json: {
      start: isoDate(mondayOf(new Date())), days: 7, meal_types: ["almuerzo", "cena"],
    } }));
    toast(created.length ? "Menú de la semana listo" : "Primero agreguen recetas en Administrar");
    home();
  }));
}

setInterval(() => { const c = $("#clock"); if (c) c.textContent = clock(); }, 15000);
setInterval(() => { if (screen === "home" && !busy && !$("dialog.m[open]")) safe(renderHome); }, 5 * 60 * 1000);

// ---------------------------------------------------------------- tareas

function choreRow(c) {
  const who = c.done_today
    ? `Hecho${c.last_done_by ? ` por ${esc(c.last_done_by.emoji)} ${esc(c.last_done_by.name)}` : ""}`
    : c.turn ? `Le toca a ${esc(c.turn.emoji)} ${esc(c.turn.name)}` : "Cualquiera puede";
  const late = !c.done_today && c.days_late ? ` · <span class="late">atrasada ${c.days_late} día${c.days_late > 1 ? "s" : ""}</span>` : "";
  const next = !c.is_due && !c.done_today
    ? ` · ${new Date(c.due_on + "T12:00").toLocaleDateString("es", { weekday: "long", day: "numeric" })}` : "";
  return `<div class="chore ${c.done_today ? "done" : ""}">
    <span class="emo">${choreIcon(c.emoji, 30)}</span>
    <span class="txt"><strong>${esc(c.name)}</strong><span>${who}${late}${next}</span></span>
    <button class="tick-round" data-chore="${c.id}" aria-label="${c.done_today ? "Deshacer" : "Marcar como hecha"}">${icon("check", 30)}</button>
  </div>`;
}

function bindChores(chores, after) {
  $$("[data-chore]", app).forEach((b) => b.onclick = () => safe(async () => {
    if (b.getAttribute("aria-busy") === "true") return;
    const c = chores.find((x) => x.id === +b.dataset.chore);
    if (c.done_today) {
      const ok = await confirmModal({
        title: "¿Deshacer?", text: `«${esc(c.name)}» volverá a quedar pendiente.`,
        ok: "Sí, deshacer", okIcon: "undo",
      });
      if (!ok) return;
      await withBusy(b, () => api(`/api/chores/${c.id}/undo`, { method: "POST" }));
      toast("Listo, quedó pendiente");
      return after();
    }
    const members = TODAY?.members ?? [];
    if (members.length <= 1) return withBusy(b, () => finishChore(c, members[0]?.id ?? null, after));
    whoModal(c, members, after);
  }));
}

function whoModal(chore, members, after) {
  const turn = chore.turn?.id;
  const ordered = [...members].sort((a, b) => (b.id === turn) - (a.id === turn));
  modal({
    title: esc(chore.name),
    body: `<p class="m-text" style="margin-bottom:1rem">¿Quién lo hizo?</p>
      <div class="people">
        ${ordered.map((m) => `<button class="person ${m.id === turn ? "turn" : ""}" data-m="${m.id}">
          <span class="face">${esc(m.emoji)}</span>${esc(m.name)}${m.id === turn ? `<span class="turn-tag">le tocaba</span>` : ""}</button>`).join("")}
        <button class="person" data-m=""><span class="face">${icon("people", 40)}</span>Entre todos</button>
      </div>`,
    onOpen: (dlg, close) => $$("[data-m]", dlg).forEach((b) => b.onclick = () => withBusy(b, async () => {
      await finishChore(chore, b.dataset.m ? +b.dataset.m : null, () => {});
      close();
      after();
    })),
  });
}

async function finishChore(chore, memberId, after) {
  await safe(async () => {
    await api(`/api/chores/${chore.id}/done`, { method: "POST", json: { member_id: memberId } });
    const m = TODAY?.members.find((x) => x.id === memberId);
    toast(m ? `¡Gracias, ${m.name}!` : "¡Gracias!");
  });
  after();
}

async function renderChores() {
  const chores = await api("/api/chores");
  TODAY = TODAY ?? await api("/api/today");
  app.innerHTML = `${head("Tareas de la casa")}
    <section class="panel note">${chores.map(choreRow).join("") || `<p class="empty-note">Aún no hay tareas.</p>`}</section>
    <p class="muted" style="margin-top:1.2rem">Para agregar o cambiar tareas: ${icon("sliders", 18)} Administrar → Casa y tareas.</p>`;
  bindBack();
  bindChores(chores, () => go("chores"));
}

// ---------------------------------------------------------------- factura (en una ventana)

function receiptModal() {
  const state = { photos: [], draft: null };
  const m = modal({ title: "Escanear factura", size: "wide", body: `<div id="rc"></div>` });
  const box = $("#rc", m.el);
  busy = true; // con la factura abierta la pantalla no vuelve sola al inicio
  m.done.then(() => { busy = false; });

  const photos = () => {
    const n = state.photos.length;
    box.innerHTML = `
      <input type="file" id="cam" accept="image/*" capture="environment" hidden>
      ${n === 0 ? `
        <label class="shoot" for="cam">${icon("camera", 48)}Tomar foto de la factura
          <small>Que se vea completa y derecha, con buena luz</small></label>` : `
        <div class="thumbs">${state.photos.map((p, i) => `<img src="${URL.createObjectURL(p)}" alt="Parte ${i + 1}">`).join("")}</div>
        <p class="muted" style="margin-top:0">¿La factura es larga? Tomen otra foto de la parte que falta.</p>
        <div class="row">
          <button class="primary big" id="read">${icon("check")} Leer la factura</button>
          <label class="btn big" for="cam" role="button">${icon("plus")} Otra parte</label>
          <button class="ghost big" id="restart">${icon("undo")} Empezar de nuevo</button>
        </div>`}`;
    $("#cam", box).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      state.photos.push(await compressImage(f));
      photos();
    };
    $("#restart", box)?.addEventListener("click", () => { state.photos = []; photos(); });
    $("#read", box)?.addEventListener("click", read);
  };

  const read = async () => {
    box.innerHTML = `<div class="loading" role="status">${icon("receipt", 52)}
      <p><b>Leyendo la factura…</b></p><p class="muted">Toma unos segundos. No hay que tocar nada.</p></div>`;
    try {
      const fd = new FormData();
      state.photos.forEach((p) => fd.append("photos", p));
      state.draft = await api("/api/receipts/scan", { method: "POST", body: fd });
      review();
    } catch (e) {
      box.innerHTML = `<div class="done-msg"><div class="mark warn">${icon("warn", 44)}</div>
        <h2>No se pudo leer</h2><p class="muted">${esc(e.message)}</p>
        <div class="row" style="justify-content:center;margin-top:1rem"><button class="primary big" id="retry">Intentar otra vez</button></div></div>`;
      $("#retry", box).onclick = () => { state.photos = []; photos(); };
    }
  };

  const review = () => {
    const d = state.draft;
    const kept = d.items.filter((i) => i.keep).length;
    const line = (i, idx) => `
      <div class="rline ${i.keep ? "on" : "off"}" data-idx="${idx}">
        <button class="circle" data-toggle aria-label="${i.keep ? "No guardar" : "Guardar"}">${i.keep ? icon("check", 22) : ""}</button>
        <div class="who"><input class="nm" value="${esc(i.name)}" data-f="name" aria-label="Nombre">
          ${i.raw_text ? `<span class="raw">${esc(i.raw_text)}</span>` : ""}</div>
        <div class="amt"><input type="number" step="any" min="0" value="${i.quantity}" data-f="quantity" aria-label="Cantidad">
          <input value="${esc(i.unit)}" data-f="unit" aria-label="Unidad"></div>
        <span class="price">${fmtMoney(i.price)}</span>
      </div>`;
    const group = (kind, label) => {
      const rows = d.items.map((i, idx) => [i, idx]).filter(([i]) => i.kind === kind);
      return rows.length ? `<div class="group-label">${label}</div>${rows.map(([i, idx]) => line(i, idx)).join("")}` : "";
    };
    box.innerHTML = `
      <div class="receipt-head"><strong>${esc(d.store || "Compra")}</strong>
        <span>${d.day ? new Date(d.day + "T12:00").toLocaleDateString("es", { day: "numeric", month: "long" }) : ""}
          ${d.total ? ` · Total <b>${fmtMoney(d.total)}</b>` : ""}</span></div>
      <p class="muted" style="margin:.2rem 0 .4rem">Toquen el círculo para quitar lo que no quieran guardar. Se pueden corregir nombres y cantidades.
        ${d.notes ? `<br>${esc(d.notes)}` : ""}</p>
      ${group("alimento", "Comida")}${group("hogar", "Aseo y hogar")}${group("otro", "No se guarda (bolsas, domicilio…)")}
      ${d.items.length ? "" : `<p class="empty-note">No se encontraron productos en la foto.</p>`}
      <div class="row" style="margin-top:1.2rem">
        <button class="primary big" id="save" ${kept ? "" : "disabled"}>${icon("check")} Guardar ${kept} producto${kept === 1 ? "" : "s"}</button>
        <button class="ghost big" id="again">${icon("camera")} Tomar otra foto</button>
      </div>`;
    $$("[data-toggle]", box).forEach((b) => b.onclick = () => {
      const i = d.items[+b.closest(".rline").dataset.idx];
      i.keep = !i.keep;
      review();
    });
    $$("[data-f]", box).forEach((inp) => inp.onchange = () => {
      const i = d.items[+inp.closest(".rline").dataset.idx];
      i[inp.dataset.f] = inp.dataset.f === "quantity" ? parseFloat(inp.value) || 0 : inp.value;
    });
    $("#again", box).onclick = () => { state.photos = []; state.draft = null; photos(); };
    $("#save", box).onclick = (e) => safe(async () => {
      const items = d.items.filter((i) => i.keep && i.name.trim());
      const res = await withBusy(e.currentTarget, () => api("/api/receipts", { method: "POST", json: {
        store: d.store, day: d.day, total: d.total,
        items: items.map((i) => ({ raw_text: i.raw_text, name: i.name.trim(), quantity: i.quantity, unit: i.unit || "unidad", category: i.category, price: i.price })),
      } }));
      if (!res) return;
      m.close();
      await doneModal("¡Guardado!", `${res.added} productos quedaron en la casa.`);
      refresh();
    });
  };

  photos();
}

// ---------------------------------------------------------------- se acabó algo (en una ventana)

async function ranOutModal() {
  const pantry = await safe(() => api("/api/pantry"));
  if (!pantry) return;
  pantry.sort((a, b) => (b.min_quantity != null) - (a.min_quantity != null) || a.name.localeCompare(b.name));
  const done = new Set();
  const m = modal({
    title: "¿Qué se acabó?",
    body: `<p class="m-text" style="margin-bottom:.9rem">Tóquenlo y queda anotado en la lista de compras.</p>
      <div class="search">${icon("search", 22)}<input id="q" placeholder="Buscar o escribir…" autocomplete="off"></div>
      <div class="tiles" id="tiles"></div>`,
    actions: [{ label: "Listo", tone: "primary", icon: "check" }],
  });
  const draw = (filter = "") => {
    const f = filter.trim().toLowerCase();
    const items = pantry.filter((p) => !f || p.name.toLowerCase().includes(f));
    const typed = cap(filter.trim());
    $("#tiles", m.el).innerHTML = items.map((p) => `
      <button class="tile ${done.has(p.name) ? "done" : ""}" data-name="${esc(p.name)}">${done.has(p.name) ? icon("check", 20) : ""}${esc(p.name)}</button>`).join("")
      + (f && !items.some((p) => p.name.toLowerCase() === f) ? `<button class="tile" data-name="${esc(typed)}">${icon("plus", 20)} ${esc(typed)}</button>` : "")
      + (!items.length && !f ? `<p class="empty-note">Escriban lo que se acabó.</p>` : "");
    $$("#tiles [data-name]", m.el).forEach((b) => b.onclick = () => safe(async () => {
      const name = b.dataset.name;
      if (done.has(name)) return;
      await withBusy(b, () => api("/api/shopping/ran-out", { method: "POST", json: { name } }));
      done.add(name);
      toast(`Anotado: ${name}`);
      draw($("#q", m.el).value);
    }));
  };
  $("#q", m.el).oninput = (e) => draw(e.target.value);
  draw();
  m.done.then(() => { if (done.size) refresh(); });
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
  const groups = [["anotado", "Anotado a mano"], ["se acaba", "Se está acabando"], ["menu", "Para el menú de la semana"]];
  const row = (i) => {
    const on = cart.has(cartKey(i));
    return `<div class="item ${on ? "on" : ""}" data-key="${esc(cartKey(i))}">
      <button class="circle" data-tick aria-label="En el carrito">${on ? icon("check", 22) : ""}</button>
      <span class="name">${esc(i.name)}${i.recipes.length ? `<small>${esc(i.recipes.join(", "))}</small>` : ""}</span>
      <span class="qty">${i.quantity != null ? esc(fmtAmount(i.quantity, i.unit)) : ""}</span>
      ${i.extra_id ? `<button class="rm" data-rm="${i.extra_id}" aria-label="Quitar de la lista">${icon("close", 22)}</button>` : ""}
    </div>`;
  };
  app.innerHTML = `${head("Lista de compras")}
    <form class="add-row" id="add">
      <input name="name" placeholder="¿Qué hace falta? Por ejemplo: jabón, pan…" autocomplete="off">
      <button class="primary big" type="submit">${icon("plus")} Agregar</button>
    </form>
    ${list.length ? `<div class="notepad">${groups.map(([reason, label]) => {
      const items = list.filter((i) => i.reason === reason);
      return items.length ? `<h3>${label}</h3>${items.map(row).join("")}` : "";
    }).join("")}</div>
    <div class="bottom-bar">
      <button class="primary big" id="scan">${icon("receipt")} Ya compré: escanear factura</button>
      <button class="big" id="bought">${icon("check")} Guardar lo marcado sin factura</button>
    </div>` : `<div class="panel empty">${icon("basket", 48)}<h2>No falta nada</h2></div>`}`;
  bindBack();

  $("#add").onsubmit = (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return e.target.name.focus();
    safe(async () => {
      await withBusy($("button[type=submit]", e.target), () => api("/api/shopping/extra", { method: "POST", json: { name } }));
      toast(`Anotado: ${name}`);
      renderShopping();
    });
  };
  $$("[data-tick]", app).forEach((b) => b.onclick = () => {
    const row = b.closest(".item");
    const key = row.dataset.key;
    if (cart.has(key)) cart.delete(key); else cart.add(key);
    saveCart(cart);
    row.classList.toggle("on", cart.has(key));
    b.innerHTML = cart.has(key) ? icon("check", 22) : "";
  });
  $$("[data-rm]", app).forEach((b) => b.onclick = () => safe(async () => {
    const name = b.closest(".item").querySelector(".name").firstChild.textContent;
    const ok = await confirmModal({ title: "¿Quitar de la lista?", text: `«${esc(name)}» se borra de la lista de compras.`, ok: "Quitar", tone: "danger", okIcon: "trash" });
    if (!ok) return;
    await api(`/api/shopping/extra/${b.dataset.rm}`, { method: "DELETE" });
    renderShopping();
  }));
  $("#scan")?.addEventListener("click", () => { saveCart(new Set()); receiptModal(); });
  $("#bought")?.addEventListener("click", (ev) => safe(async () => {
    const btn = ev.currentTarget;
    const items = list.filter((i) => cart.has(cartKey(i)));
    if (!items.length) return toast("Toquen el círculo de lo que ya compraron");
    const ok = await confirmModal({
      title: "¿Guardar lo comprado?",
      text: `${items.length} producto${items.length > 1 ? "s" : ""} pasa${items.length > 1 ? "n" : ""} a la casa con las cantidades de la lista. Si tienen la factura, es mejor escanearla.`,
      ok: "Guardar",
    });
    if (!ok) return;
    await withBusy(btn, () => api("/api/pantry/bulk", { method: "POST", json: items.map(toPantryLine) }));
    saveCart(new Set());
    await doneModal("¡Guardado!", `${items.length} productos quedaron en la casa.`);
    renderShopping();
  }));
}

// ---------------------------------------------------------------- ¿qué cocino?

function mealNow() {
  const h = new Date().getHours();
  return h < 10 ? "desayuno" : h < 15 ? "almuerzo" : h < 18 ? "merienda" : "cena";
}

async function renderWhat({ meal } = {}) {
  meal = meal ?? mealNow();
  const sugg = await api(`/api/suggestions?meal_type=${meal}&limit=6`);
  app.innerHTML = `${head("¿Qué cocino?")}
    <div class="meal-tabs">${META.meal_types.map((m) => `
      <button class="${m === meal ? "on" : ""}" data-meal="${m}">${icon(MEAL_ICON[m], 22)} ${esc(MEAL_LABEL[m])}</button>`).join("")}</div>
    ${sugg.length ? `<div class="cards">${sugg.map((s) => `
      <button class="index-card ${s.can_cook ? "" : "miss"}" data-r="${s.recipe.id}">
        <div class="top"></div><div class="in">
          <h3>${s.recipe.favorite ? `${icon("star", 20)} ` : ""}${esc(s.recipe.name)}</h3>
          ${s.can_cook ? `<p class="ok">${icon("check", 20)} Tenemos todo</p>`
            : `<p class="miss-txt">Falta: ${esc(s.missing.map((x) => x.name).join(", "))}</p>`}
          ${s.uses_expiring.length ? `<p>${icon("clock", 18)} Aprovecha: ${esc(s.uses_expiring.join(", "))}</p>` : ""}
          ${s.recipe.prep_minutes ? `<p>${icon("clock", 18)} ${s.recipe.prep_minutes} minutos</p>` : ""}
        </div>
      </button>`).join("")}</div>`
      : `<div class="panel empty">${icon("pot", 48)}<p>No hay recetas de ${esc(MEAL_LABEL[meal].toLowerCase())}. Se agregan en Administrar.</p></div>`}`;
  bindBack();
  $$("[data-meal]", app).forEach((b) => b.onclick = () => go("what", { meal: b.dataset.meal }));
  $$("[data-r]", app).forEach((el) => el.onclick = () => go("cook", { recipeId: +el.dataset.r, back: { meal } }));
}

// ---------------------------------------------------------------- modo cocina

const STATUS = {
  ok: ["check", "st-ok", "Hay"], hay: ["check", "st-ok", "Hay"],
  poco: ["dot", "st-poco", "No alcanza"], falta: ["close", "st-falta", "No hay"],
};

async function renderCook({ recipeId, servings, entryId = null, back = null }) {
  servings = servings || META.household_size;
  const r = await api(`/api/recipes/${recipeId}?servings=${servings}`);
  const status = Object.fromEntries(r.availability.items.map((i) => [i.ingredient_id, i.status]));
  const steps = r.instructions.split("\n").map((s) => s.replace(/^\s*\d+[.)-]\s*/, "").trim()).filter(Boolean);
  const params = { recipeId, entryId, back };
  app.innerHTML = `${head(esc(r.name))}
    <div class="servings">Para
      <button id="minus" aria-label="Menos personas">${icon("minus", 26)}</button><strong>${r.scaled_to}</strong>
      <button id="plus" aria-label="Más personas">${icon("plus", 26)}</button> personas
      ${r.availability.can_cook ? `<span class="badge ok">${icon("check", 16)} Tenemos todo</span>` : ""}
    </div>
    <div class="cook-cols">
      <section class="panel">
        <div class="panel-title"><h2>Ingredientes</h2></div>
        ${r.ingredients.map((i) => {
          const [ic, cls, txt] = STATUS[status[i.ingredient_id]];
          return `<div class="ing"><span class="${cls}" title="${txt}">${icon(ic, 24)}</span>
            <span class="name">${esc(i.name)}${i.note ? `<small>${esc(i.note)}</small>` : ""}${i.optional ? "<small>opcional</small>" : ""}</span>
            <span class="qty">${i.quantity ? esc(fmtAmount(i.quantity, i.unit)) : "al gusto"}</span></div>`;
        }).join("")}
      </section>
      <section class="panel">
        <div class="panel-title"><h2>Preparación</h2></div>
        ${steps.length ? `<ol class="steps">${steps.map((s) => `<li><span>${esc(s)}</span></li>`).join("")}</ol>` : `<p class="empty-note">Sin pasos escritos.</p>`}
        ${r.notes ? `<div class="tip">${icon("leaf", 22)}<span>${esc(r.notes)}</span></div>` : ""}
      </section>
    </div>
    <div class="bottom-bar"><button class="primary big" id="done">${icon("check")} Terminé de cocinar</button></div>`;
  bindBack(back ? () => go("what", back) : home);
  $("#minus").onclick = () => r.scaled_to > 1 && go("cook", { ...params, servings: r.scaled_to - 1 });
  $("#plus").onclick = () => go("cook", { ...params, servings: r.scaled_to + 1 });
  $("#done").onclick = (ev) => safe(async () => {
    const btn = ev.currentTarget;
    const ok = await confirmModal({
      title: "¿Terminaron de cocinar?",
      text: `Se descuenta de la casa lo que usa «${esc(r.name)}» para ${r.scaled_to} personas.`,
      ok: "Sí, terminé",
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      if (entryId) {
        if (r.scaled_to !== servings) await api(`/api/menu/${entryId}`, { method: "PATCH", json: { servings: r.scaled_to } });
        await api(`/api/menu/${entryId}/cook`, { method: "POST" });
      } else {
        await api(`/api/recipes/${recipeId}/cook`, { method: "POST", json: { servings: r.scaled_to } });
      }
    });
    await doneModal("¡Buen provecho!", "Se descontó lo que se usó de la nevera y la alacena.");
    home();
  });
}

// ---------------------------------------------------------------- arranque

async function start() {
  homeSkeleton();
  try {
    META = await api("/api/meta");
  } catch {
    return errorState(start);
  }
  document.title = META.house_name;
  await home();
  resetIdle();
}
start();
