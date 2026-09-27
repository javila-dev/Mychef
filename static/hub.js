// Pantalla de la casa: lo de hoy de un vistazo y todo a un toque.
// Pensada para una tablet pegada en la nevera y para quien no se lleva bien con la tecnología:
// botones grandes, pocas palabras, confirmaciones y formularios en ventanas (modales),
// y si nadie la toca un rato, vuelve sola al inicio.

import {
  $, $$, api, avatar, cap, choreIcon, compressImage, confirmModal, esc, fmtAmount, fmtMoney, icon, isoDate,
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
  document.body.classList.toggle("at-home", name === "home");
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
  document.body.classList.add("at-home");
  app.innerHTML = `<div class="skel-home" aria-busy="true" aria-label="Cargando"></div>`;
}

function errorState(retry) {
  app.innerHTML = `<div class="state-block">${icon("warn", 44)}
    <h2>No se pudo cargar</h2><p>Revisen que el computador de la casa esté prendido y conectado.</p>
    <button class="primary big" id="retry">${icon("undo")} Intentar de nuevo</button></div>`;
  document.body.classList.remove("at-home");
  $("#retry").onclick = retry;
}

// ---------------------------------------------------------------- fotos de la familia (fondo)

const stage = $("#stage");
const ROTATE_MS = 45 * 1000;
let PHOTOS = [];
let photoIdx = -1;
let rotateTimer = null;

async function loadPhotos() {
  try { PHOTOS = await api("/api/photos"); } catch { PHOTOS = []; }
  photoIdx = -1;
  stage.innerHTML = "";
  nextPhoto();
  clearInterval(rotateTimer);
  if (PHOTOS.length > 1) rotateTimer = setInterval(nextPhoto, ROTATE_MS);
}

function nextPhoto() {
  if (!PHOTOS.length) { stage.innerHTML = ""; return; }
  photoIdx = (photoIdx + 1) % PHOTOS.length;
  const p = PHOTOS[photoIdx];
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.onload = () => {
    stage.appendChild(img);
    requestAnimationFrame(() => {
      img.classList.add("on");
      const old = [...stage.querySelectorAll("img")].filter((x) => x !== img);
      setTimeout(() => old.forEach((x) => x.remove()), 1800);
    });
    const cap = $("#caption");
    if (cap) cap.textContent = p.caption || "";
  };
  img.src = p.url;
}

// ---------------------------------------------------------------- inicio

async function renderHome() {
  document.body.classList.add("at-home");
  if (!app.querySelector(".home")) homeSkeleton();
  try {
    TODAY = await api("/api/today");
  } catch {
    return errorState(home);
  }
  const t = TODAY;
  const firstRun = !t.setup.recipes && !t.setup.chores && !t.setup.pantry;
  const pending = t.chores.filter((c) => !c.done_today);
  const shownChores = [...pending, ...t.chores.filter((c) => c.done_today)].slice(0, 3);
  const alerts = [
    ...t.expiring.map((e) => `<span class="${e.days_left < 0 ? "bad" : "warn"}">${icon("clock", 18)} ${esc(e.name)} · ${daysText(e.days_left)}</span>`),
    ...t.low_stock.map((n) => `<span class="warn">${icon("jar", 18)} Queda poco: ${esc(n)}</span>`),
  ];
  const date = cap(new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }));
  const current = PHOTOS[photoIdx];

  app.innerHTML = `
    <div class="home">
      <header class="time-block">
        <a class="corner-btn" href="/admin" title="Ajustes: recetas, inventario y tareas" aria-label="Ajustes">${icon("sliders", 24)}</a>
        <div class="clock" id="clock">${clock()}</div>
        <div class="today-line">${date}</div>
        <div class="greet">${greeting()} · ${esc(META.house_name)}</div>
        ${alerts.length ? `<div class="photo-alerts"><button class="alert-chip" id="alerts">${alerts[0]}${alerts.length > 1 ? ` <span class="more">y ${alerts.length - 1} más</span>` : ""}</button></div>` : ""}
      </header>
      <div class="photo-caption" id="caption">${esc(current?.caption ?? "")}</div>

      <div class="widgets">
        ${!firstRun && !PHOTOS.length ? `<section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("camera", 22)} Pongan sus fotos</h2></div>
          <p class="empty-note">Las fotos de la familia se van turnando aquí de fondo.</p>
          <div class="w-more"><button class="primary" data-act="photos">${icon("plus", 20)} Agregar fotos</button></div>
        </section>` : ""}
        ${firstRun ? `<section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("home", 22)} Bienvenidos</h2></div>
          <p class="empty-note">Toquen ${icon("sliders", 18)} <b>Ajustes</b> (arriba a la derecha) para cargar sus recetas, las personas y las tareas, y <b>Fotos</b> para poner fotos de la familia.</p>
        </section>` : ""}

        <section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("pot", 22)} Hoy en el menú</h2></div>
          ${t.meals.length ? t.meals.map((m) => `
            <button class="meal-row ${m.cooked ? "done" : ""}" data-meal="${m.id}">
              <span class="when">${esc(MEAL_LABEL[m.meal_type] ?? m.meal_type)}</span>
              <span class="what"><span class="dish">${esc(m.recipe.name)}</span>
                <span class="state ${m.cooked ? "" : m.can_cook ? "ok" : "miss"}">${m.cooked ? `${icon("check", 16)} Ya se cocinó`
                  : m.can_cook ? `${icon("check", 16)} Tenemos todo` : `Falta: ${esc(m.missing.join(", "))}`}</span></span>
              ${icon("chevron", 20)}
            </button>`).join("")
          : t.setup.recipes ? `<p class="empty-note">Todavía no hay menú para hoy.</p>
             <div class="w-more"><button class="primary" id="plan">${icon("spark", 20)} Armar el menú de la semana</button></div>`
          : `<p class="empty-note">Cuando carguen sus recetas, aquí aparece lo que se come hoy.</p>`}
        </section>

        <section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("broom", 22)} Tareas de hoy</h2>
            <small>${t.chores.length ? (pending.length ? `${pending.length} por hacer` : "¡Todo al día!") : ""}</small></div>
          ${shownChores.length ? shownChores.map(choreRow).join("")
            : `<p class="empty-note">${t.setup.chores ? "Nada pendiente por hoy." : "Aún no hay tareas. Se agregan en Ajustes."}</p>`}
          ${t.setup.chores ? `<div class="w-more"><button data-act="chores">Ver todas${t.chores.length > 3 ? ` (${t.chores.length})` : ""}</button></div>` : ""}
        </section>

      </div>

      <nav class="dock" aria-label="Apps de la casa">
        <button class="app app-scan" data-act="receipt"><span class="disc">${icon("receipt", 34)}</span><span class="name">Escanear factura</span></button>
        <button class="app app-list" data-act="shopping"><span class="disc">${icon("basket", 34)}
          ${t.shopping_count ? `<span class="count" aria-label="${t.shopping_count} por comprar">${t.shopping_count}</span>` : ""}</span><span class="name">Lista de compras</span></button>
        <button class="app app-cook" data-act="what"><span class="disc">${icon("pot", 34)}</span><span class="name">¿Qué cocino?</span></button>
        <button class="app app-out" data-act="ranout"><span class="disc">${icon("jar", 34)}</span><span class="name">Se acabó algo</span></button>
        <button class="app app-photos" data-act="photos"><span class="disc">${icon("camera", 34)}</span><span class="name">Fotos</span></button>
      </nav>
    </div>`;

  const ACTS = {
    receipt: receiptModal, shopping: () => go("shopping"), what: () => go("what"),
    ranout: ranOutModal, chores: () => go("chores"), photos: photosModal,
  };
  $$("[data-act]", app).forEach((b) => b.onclick = () => ACTS[b.dataset.act]());
  $("#alerts")?.addEventListener("click", () => modal({
    title: "Ojo con esto", size: "narrow",
    body: `<ul class="alert-list">${alerts.map((a) => `<li>${a}</li>`).join("")}</ul>`,
    actions: [{ label: "Ver qué cocinar con eso", tone: "plain", icon: "pot", onClick: () => { go("what"); } },
      { label: "Listo", tone: "primary", icon: "check" }],
  }));
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
    toast(created.length ? "Menú de la semana listo" : "Primero agreguen recetas en Ajustes");
    home();
  }));
}

setInterval(() => { const c = $("#clock"); if (c) c.textContent = clock(); }, 15000);
setInterval(() => { if (screen === "home" && !busy && !$("dialog.m[open]")) safe(renderHome); }, 5 * 60 * 1000);

// ---------------------------------------------------------------- fotos (ventana)

async function photosModal() {
  const m = modal({ title: "Fotos de la familia", size: "wide", body: `<div id="ph"></div>` });
  const box = $("#ph", m.el);
  const draw = () => {
    box.innerHTML = `
      <p class="m-text" style="margin-bottom:1rem">Estas fotos se van turnando en la pantalla de inicio.</p>
      <input type="file" id="ph-in" accept="image/*" multiple hidden>
      <div class="gallery">
        <label class="add" for="ph-in">${icon("plus", 30)}Agregar fotos</label>
        ${PHOTOS.map((p) => `<figure><img src="${esc(p.url)}" alt="${esc(p.caption || "Foto de la familia")}" loading="lazy">
          <button class="rm" data-rm="${p.id}" aria-label="Quitar esta foto">${icon("trash", 20)}</button></figure>`).join("")}
      </div>`;
    $("#ph-in", box).onchange = (e) => safe(async () => {
      const files = [...e.target.files];
      if (!files.length) return;
      busy = true;
      box.querySelector(".add").innerHTML = `${icon("camera", 30)}Subiendo ${files.length} foto${files.length > 1 ? "s" : ""}…`;
      try {
        for (const f of files) {
          const fd = new FormData();
          fd.append("photo", await compressImage(f, 2400, 0.86));
          await api("/api/photos", { method: "POST", body: fd });
        }
        toast(files.length > 1 ? `${files.length} fotos agregadas` : "Foto agregada");
      } finally {
        busy = false;
        await loadPhotos();
        draw();
      }
    });
    $$("[data-rm]", box).forEach((b) => b.onclick = () => safe(async () => {
      const ok = await confirmModal({ title: "¿Quitar esta foto?", text: "Deja de aparecer en la pantalla de inicio.", ok: "Quitar", tone: "danger", okIcon: "trash" });
      if (!ok) return;
      await api(`/api/photos/${b.dataset.rm}`, { method: "DELETE" });
      await loadPhotos();
      draw();
    }));
  };
  draw();
}

// ---------------------------------------------------------------- tareas

function choreRow(c) {
  const who = c.done_today
    ? `Hecho${c.last_done_by ? ` por ${avatar(c.last_done_by, 24)} ${esc(c.last_done_by.name)}` : ""}`
    : c.turn ? `Le toca a ${avatar(c.turn, 24)} ${esc(c.turn.name)}` : "Cualquiera puede";
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
          <span class="face">${avatar(m, 64)}</span>${esc(m.name)}${m.id === turn ? `<span class="turn-tag">le tocaba</span>` : ""}</button>`).join("")}
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
    <section class="sheet chores-sheet">${chores.map(choreRow).join("") || `<p class="empty-note">Aún no hay tareas.</p>`}</section>
    <p class="muted" style="margin-top:1.2rem">Para agregar o cambiar tareas: Ajustes → Casa y tareas.</p>`;
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
    ${list.length ? `<div class="sheet">${groups.map(([reason, label]) => {
      const items = list.filter((i) => i.reason === reason);
      return items.length ? `<h3>${label}</h3>${items.map(row).join("")}` : "";
    }).join("")}</div>
    <div class="bottom-bar">
      <button class="primary big" id="scan">${icon("receipt")} Ya compré: escanear factura</button>
      <button class="big" id="bought">${icon("check")} Guardar lo marcado sin factura</button>
    </div>` : `<div class="state-block">${icon("basket", 48)}<h2>No falta nada</h2><p>Lo que anoten aquí o se acabe aparece en esta lista.</p></div>`}`;
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
      <button class="recipe-card" data-r="${s.recipe.id}">
          <h3>${s.recipe.favorite ? `${icon("star", 20)} ` : ""}${esc(s.recipe.name)}</h3>
          ${s.can_cook ? `<p class="ok">${icon("check", 20)} Tenemos todo</p>`
            : `<p class="miss-txt">Falta: ${esc(s.missing.map((x) => x.name).join(", "))}</p>`}
          ${s.uses_expiring.length ? `<p>${icon("clock", 18)} Aprovecha: ${esc(s.uses_expiring.join(", "))}</p>` : ""}
          ${s.recipe.prep_minutes ? `<p>${icon("clock", 18)} ${s.recipe.prep_minutes} minutos</p>` : ""}
      </button>`).join("")}</div>`
      : `<div class="state-block">${icon("pot", 48)}<h2>Sin recetas de ${esc(MEAL_LABEL[meal].toLowerCase())}</h2><p>Se agregan en Ajustes → Recetas.</p></div>`}`;
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
  await loadPhotos();
  await home();
  resetIdle();
}
start();
