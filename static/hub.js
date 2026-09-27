// Pantalla de la casa: lo de hoy de un vistazo y todo a un toque.
// Pensada para una tablet pegada en la nevera y para quien no se lleva bien con la tecnología:
// botones grandes, pocas palabras, confirmaciones y formularios en ventanas (modales),
// y si nadie la toca un rato, vuelve sola al inicio.

import {
  $, $$, api, avatar, cap, choreIcon, compressImage, confirmModal, esc, fmtAmount, fmtMoney, icon, isoDate,
  modal, mondayOf, safe, toPantryLine, toast, withBusy,
} from "./common.js";
import {
  HandsFree, Timers, VOICE_SECURE, VOICE_SUPPORTED, chime, listenOnce, matchWake, speak, stopListening,
  stopRinging, stopSpeaking,
} from "./voice.js";

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
  if (name !== "cook") stopCookVoice();
  screen = name;
  document.body.classList.toggle("at-home", name === "home");
  window.scrollTo(0, 0);
  return safe(() => SCREENS[name](params));
}
const home = () => go("home");
const refresh = () => (screen === "home" ? home() : null);

function micButton(extra = "") {
  return `<button class="mic ${extra}" data-mic aria-label="Hablar">${icon("mic", 28)}<span>Hablar</span></button>`;
}

function head(title, back = "Volver al inicio", tools = "") {
  return `<div class="screen-head">
    <button class="back" data-back aria-label="${back}">${icon("back", 28)}</button><h1>${title}</h1>
    <div class="head-tools">${tools}${micButton()}</div></div>`;
}
function bindBack(to = home) {
  $$("[data-back]", app).forEach((b) => b.onclick = to);
}

let idleTimer = null;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (busy || handsFree?.active || document.querySelector("dialog[open] .ring")) return resetIdle();
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
    ...t.expiring.map((e) => `<span class="label-tag ${e.days_left < 0 ? "bad" : ""}">${icon("clock", 18)} ${esc(e.name)} · ${daysText(e.days_left)}</span>`),
    ...t.low_stock.map((n) => `<span class="label-tag low">${icon("jar", 18)} Queda poco: ${esc(n)}</span>`),
  ];
  const date = cap(new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }));
  const current = PHOTOS[photoIdx];
  const listHint = t.shopping_count ? `${t.shopping_count} cosa${t.shopping_count > 1 ? "s" : ""} por comprar` : "No falta nada";
  const cookHint = t.expiring.length ? "Aprovechar lo que vence" : "Ideas con lo que hay";
  const photoHint = PHOTOS.length ? `${PHOTOS.length} foto${PHOTOS.length > 1 ? "s" : ""}` : "Poner fotos";

  app.innerHTML = `
    <div class="home">
      <div class="left">
        <header class="time-block">
          <div class="clock-row"><div class="clock" id="clock">${clock()}</div>${micButton("on-photo")}${wakeButton()}</div>
          <h1 class="hello">${greeting()}</h1>
          <div class="today-line">${date} · ${esc(META.house_name)}</div>
        </header>

        ${!firstRun && !PHOTOS.length ? `<button class="invite" data-act="photos">${icon("camera", 22)}
          <span>Pongan fotos de la familia aquí de fondo</span><span class="go">Agregar</span></button>` : ""}

        <div class="photo-caption" id="caption">${esc(current?.caption ?? "")}</div>

        ${alerts.length ? `<section class="widget ojo">
          <div class="w-head"><h2 class="w-title">${icon("warn", 22)} Ojo con esto</h2></div>
          <div class="labels">${alerts.slice(0, 4).join("")}${alerts.length > 4 ? `<span class="label-tag more">+${alerts.length - 4} más</span>` : ""}</div>
          ${t.expiring.length ? `<div class="w-more"><button class="btn-soft" data-act="what">${icon("pot", 20)} Ver qué cocinar con eso</button></div>` : ""}
        </section>` : ""}
      </div>

      <div class="widgets">
        ${firstRun ? `<section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("home", 22)} Bienvenidos</h2></div>
          <p class="empty-note">Toquen <b>Ajustes</b> (abajo a la derecha) para cargar sus recetas, las personas y las tareas, y <b>Fotos</b> para poner fotos de la familia.</p>
        </section>` : ""}

        <section class="widget mesa">
          <h2>Hoy en la mesa</h2>
          ${t.meals.length ? t.meals.map((m) => `
            <button class="dish ${m.cooked ? "done" : ""}" data-meal="${m.id}">
              <span class="line"><span class="when">${esc(MEAL_LABEL[m.meal_type] ?? m.meal_type)}</span><span class="dots"></span>
                <span class="name">${esc(m.recipe.name)}</span></span>
              <span class="state ${m.cooked ? "" : m.can_cook ? "ok" : "miss"}">${m.cooked ? `${icon("check", 16)} Ya se cocinó`
                : m.can_cook ? `${icon("check", 16)} Tenemos todo` : `Falta: ${esc(m.missing.join(", "))}`}</span>
            </button>`).join("")
          : t.setup.recipes ? `<p class="empty-note" style="text-align:center">Todavía no hay menú para hoy.</p>
             <div class="w-more" style="text-align:center"><button class="primary" id="plan">${icon("spark", 20)} Armar el menú de la semana</button></div>`
          : `<p class="empty-note" style="text-align:center">Cuando carguen sus recetas, aquí aparece lo que se come hoy.</p>`}
        </section>

        <section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("broom", 22)} Pendientes de hoy</h2>
            <small>${t.chores.length ? (pending.length ? `${pending.length} por hacer` : "¡Todo al día!") : ""}</small></div>
          ${shownChores.length ? shownChores.map(choreRow).join("")
            : `<p class="empty-note">${t.setup.chores ? "Nada pendiente por hoy." : "Aún no hay tareas. Se agregan en Ajustes."}</p>`}
          ${t.setup.chores ? `<div class="w-more"><button data-act="chores">${icon("broom", 18)} Ver todas las tareas${t.chores.length > 3 ? ` (${t.chores.length})` : ""}</button></div>` : ""}
        </section>
      </div>

      <nav class="actions" aria-label="Qué quieren hacer">
        <button class="act act-scan" data-act="scan">${icon("camera", 34)}
          <span><span class="label">Escanear</span><span class="hint">La factura o la nevera</span></span></button>
        <button class="act act-list" data-act="shopping">${icon("basket", 34)}
          ${t.shopping_count ? `<span class="count" aria-label="${t.shopping_count} por comprar">${t.shopping_count}</span>` : ""}
          <span><span class="label">Lista de compras</span><span class="hint">${listHint}</span></span></button>
        <button class="act act-cook" data-act="what">${icon("pot", 34)}
          <span><span class="label">¿Qué cocino?</span><span class="hint">${cookHint}</span></span></button>
        <button class="act act-out" data-act="ranout">${icon("jar", 34)}
          <span><span class="label">Se acabó algo</span><span class="hint">Anotarlo en la lista</span></span></button>
        <button class="act act-photos" data-act="photos">${icon("camera", 30)}
          <span><span class="label">Fotos</span><span class="hint">${photoHint}</span></span></button>
        <a class="act act-admin" href="/admin" title="Ajustes: recetas, inventario y tareas" aria-label="Ajustes">${icon("sliders", 28)}<span class="label only-phone">Ajustes</span></a>
      </nav>
    </div>`;

  const ACTS = {
    scan: scanChooser, receipt: receiptModal, shopping: () => go("shopping"), what: () => go("what"),
    ranout: ranOutModal, chores: () => go("chores"), photos: photosModal,
  };
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
    ? `Hecho${c.last_done_by ? ` por ${avatar(c.last_done_by, 26)} ${esc(c.last_done_by.name)}` : ""}`
    : c.turn ? `Le toca a ${avatar(c.turn, 26)} ${esc(c.turn.name)}` : "Cualquiera puede";
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

// ---------------------------------------------------------------- escanear: factura o nevera

function scanChooser() {
  const m = modal({
    title: "¿Qué van a escanear?", size: "narrow",
    body: `<div class="choices">
      <button class="choice" data-c="receipt">${icon("receipt", 36)}<span><b>La factura del mercado</b><small>Suma lo que compraron</small></span></button>
      <button class="choice" data-c="nevera">${icon("fridge", 36)}<span><b>La nevera</b><small>Pone al día lo que hay</small></span></button>
      <button class="choice" data-c="alacena">${icon("jar", 36)}<span><b>La alacena</b><small>Granos, enlatados, aceites…</small></span></button>
    </div>`,
  });
  $$("[data-c]", m.el).forEach((b) => b.onclick = () => {
    m.close();
    b.dataset.c === "receipt" ? receiptModal() : fridgeModal(b.dataset.c);
  });
}

// Fotos de la nevera o la alacena: la IA dice qué ve y cuánto queda; la familia revisa y guarda.
function fridgeModal(place = "nevera") {
  const where = place === "alacena" ? "la alacena" : "la nevera";
  const state = { photos: [], draft: null, gone: new Set() };
  const m = modal({ title: `Foto de ${where}`, size: "wide", body: `<div id="fr"></div>` });
  const box = $("#fr", m.el);
  busy = true;
  m.done.then(() => { busy = false; });

  const photos = () => {
    const n = state.photos.length;
    box.innerHTML = `
      <input type="file" id="cam" accept="image/*" capture="environment" hidden>
      ${n === 0 ? `
        <label class="shoot" for="cam">${icon("camera", 48)}Tomar foto de ${where}
          <small>Con la puerta bien abierta y buena luz. Si no cabe, tomen varias.</small></label>` : `
        <div class="thumbs">${state.photos.map((p, i) => `<img src="${URL.createObjectURL(p)}" alt="Foto ${i + 1}">`).join("")}</div>
        <p class="muted" style="margin-top:0">${place === "nevera" ? "¿Falta la puerta, los cajones o el congelador?" : "¿Falta algún estante?"} Tomen otra foto.</p>
        <div class="row">
          <button class="primary big" id="read">${icon("check")} Ver qué hay</button>
          ${n < 6 ? `<label class="btn big" for="cam" role="button">${icon("plus")} Otra foto</label>` : ""}
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
    box.innerHTML = `<div class="loading" role="status">${icon("fridge", 52)}
      <p><b>Mirando ${where}…</b></p><p class="muted">Toma unos segundos. No hay que tocar nada.</p></div>`;
    try {
      const fd = new FormData();
      state.photos.forEach((p) => fd.append("photos", p));
      fd.append("place", place);
      const d = await api("/api/pantry/scan", { method: "POST", body: fd });
      d.items.forEach((i) => { i.keep = i.confidence !== "baja"; });
      state.draft = d;
      review();
    } catch (e) {
      box.innerHTML = `<div class="done-msg"><div class="mark warn">${icon("warn", 44)}</div>
        <h2>No se pudo ver</h2><p class="muted">${esc(e.message)}</p>
        <div class="row" style="justify-content:center;margin-top:1rem"><button class="primary big" id="retry">Intentar otra vez</button></div></div>`;
      $("#retry", box).onclick = () => { state.photos = []; photos(); };
    }
  };

  const review = () => {
    const d = state.draft;
    const kept = d.items.filter((i) => i.keep).length;
    const sure = { alta: "", media: "", baja: `<span class="badge warn">¿seguro?</span>` };
    box.innerHTML = `
      <p class="muted" style="margin:0 0 .4rem">Esto es lo que se ve y cuánto queda. Toquen el círculo para quitar lo que no sea,
        y corrijan lo que haga falta. ${d.notes ? `<br>${esc(d.notes)}` : ""}</p>
      ${d.items.map((i, idx) => `
        <div class="rline ${i.keep ? "on" : "off"}" data-idx="${idx}">
          <button class="circle" data-toggle aria-label="${i.keep ? "No guardar" : "Guardar"}">${i.keep ? icon("check", 22) : ""}</button>
          <div class="who"><input class="nm" value="${esc(i.name)}" data-f="name" aria-label="Nombre"></div>
          <div class="amt"><input type="number" step="any" min="0" value="${i.quantity}" data-f="quantity" aria-label="Cantidad">
            <input value="${esc(i.unit)}" data-f="unit" aria-label="Unidad"></div>
          <span class="price">${sure[i.confidence] ?? ""}</span>
        </div>`).join("") || `<p class="empty-note">No se reconocieron alimentos en la foto.</p>`}
      ${d.not_seen?.length ? `
        <div class="group-label">No se ve en la foto. ¿Se acabó? Tóquenlo y pasa a la lista de compras</div>
        <div class="tiles">${d.not_seen.map((n) => `
          <button class="tile ${state.gone.has(n.name) ? "done" : ""}" data-gone="${esc(n.name)}">${state.gone.has(n.name) ? icon("check", 20) : ""}${esc(n.name)}</button>`).join("")}</div>` : ""}
      <div class="row" style="margin-top:1.2rem">
        <button class="primary big" id="save" ${kept || state.gone.size ? "" : "disabled"}>${icon("check")} Poner al día ${kept} cosa${kept === 1 ? "" : "s"}</button>
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
    $$("[data-gone]", box).forEach((b) => b.onclick = () => {
      const n = b.dataset.gone;
      state.gone.has(n) ? state.gone.delete(n) : state.gone.add(n);
      review();
    });
    $("#again", box).onclick = () => { state.photos = []; state.draft = null; state.gone.clear(); photos(); };
    $("#save", box).onclick = (e) => safe(async () => {
      const items = d.items.filter((i) => i.keep && i.name.trim());
      await withBusy(e.currentTarget, async () => {
        // La foto muestra lo que QUEDA: se reemplaza la cantidad, no se suma.
        if (items.length) {
          await api("/api/pantry/bulk", { method: "POST", json: items.map((i) => ({
            name: i.name.trim(), quantity: i.quantity, unit: i.unit || "unidad", category: i.category, replace: true,
          })) });
        }
        for (const name of state.gone) await api("/api/shopping/ran-out", { method: "POST", json: { name } });
      });
      m.close();
      const gone = state.gone.size ? ` ${state.gone.size} pasaron a la lista de compras.` : "";
      await doneModal("¡Al día!", `${items.length} cosa${items.length === 1 ? "" : "s"} de ${where} quedaron actualizadas.${gone}`);
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
  ok: ["check", "st-ok", "Hay"], hay: ["check", "st-ok", "Hay"], justo: ["check", "st-ok", "Hay, justo"],
  basico: ["check", "st-basic", "Básico: se da por hecho que hay"],
  poco: ["dot", "st-poco", "No alcanza"], falta: ["close", "st-falta", "No hay"],
};

let COOK = null;       // receta abierta: pasos, paso actual, porciones (para la voz)
let handsFree = null;

function stopCookVoice() {
  if (handsFree) wakeRelease("handsfree");
  handsFree?.stop();
  handsFree = null;
  COOK = null;
}

async function renderCook({ recipeId, servings, entryId = null, back = null, step = 0 }) {
  servings = servings || META.household_size;
  const r = await api(`/api/recipes/${recipeId}?servings=${servings}`);
  const status = Object.fromEntries(r.availability.items.map((i) => [i.ingredient_id, i.status]));
  const steps = r.instructions.split("\n").map((s) => s.replace(/^\s*\d+[.)-]\s*/, "").trim()).filter(Boolean);
  const params = { recipeId, entryId, back };
  const wasHandsFree = Boolean(handsFree?.active);
  COOK = { recipeId, servings: r.scaled_to, steps, idx: Math.min(step, Math.max(steps.length - 1, 0)), name: r.name };
  app.innerHTML = `${head(esc(r.name), "Volver",
      VOICE_SUPPORTED ? `<button class="handsfree ${wasHandsFree ? "on" : ""}" id="hf" aria-pressed="${wasHandsFree}">${icon("mic", 22)}<span>Manos libres</span></button>` : "")}
    <p class="hf-hint" id="hf-hint" ${wasHandsFree ? "" : "hidden"}>Escuchando. Digan «<b>siguiente</b>», «<b>repite</b>» o «<b>¿cuánta sal lleva?</b>»</p>
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
        <div class="panel-title"><h2>Preparación</h2>
          ${steps.length > 1 ? `<div class="step-nav"><button id="prev" aria-label="Paso anterior">${icon("back", 22)}</button>
            <span id="step-count">Paso ${COOK.idx + 1} de ${steps.length}</span>
            <button id="next" aria-label="Paso siguiente">${icon("chevron", 22)}</button></div>` : ""}</div>
        ${steps.length ? `<ol class="steps">${steps.map((s, i) => `<li class="${i === COOK.idx ? "current" : ""}" data-step="${i}"><span>${esc(s)}</span></li>`).join("")}</ol>` : `<p class="empty-note">Sin pasos escritos.</p>`}
        ${r.notes ? `<div class="tip">${icon("leaf", 22)}<span>${esc(r.notes)}</span></div>` : ""}
      </section>
    </div>
    <div class="bottom-bar"><button class="primary big" id="done">${icon("check")} Terminé de cocinar</button></div>`;
  bindBack(back ? () => go("what", back) : home);
  $("#minus").onclick = () => r.scaled_to > 1 && go("cook", { ...params, servings: r.scaled_to - 1, step: COOK.idx });
  $("#plus").onclick = () => go("cook", { ...params, servings: r.scaled_to + 1, step: COOK.idx });
  $("#prev")?.addEventListener("click", () => showStep(COOK.idx - 1, false));
  $("#next")?.addEventListener("click", () => showStep(COOK.idx + 1, false));
  $$("[data-step]", app).forEach((li) => li.onclick = () => showStep(+li.dataset.step, false));
  $("#hf")?.addEventListener("click", () => toggleHandsFree());
  if (wasHandsFree) setHandsFreeUI(true);
  $("#done").onclick = (ev) => finishCooking(ev.currentTarget, r, { recipeId, entryId, servings });
}

function showStep(i, read = true) {
  if (!COOK || !COOK.steps.length) return;
  COOK.idx = Math.max(0, Math.min(i, COOK.steps.length - 1));
  $$("[data-step]", app).forEach((li) => li.classList.toggle("current", +li.dataset.step === COOK.idx));
  const c = $("#step-count");
  if (c) c.textContent = `Paso ${COOK.idx + 1} de ${COOK.steps.length}`;
  $(`[data-step="${COOK.idx}"]`, app)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (read) return say(`Paso ${COOK.idx + 1}. ${COOK.steps[COOK.idx]}`);
}

function setHandsFreeUI(on) {
  $("#hf")?.classList.toggle("on", on);
  $("#hf")?.setAttribute("aria-pressed", String(on));
  const hint = $("#hf-hint");
  if (hint) hint.hidden = !on;
}

function toggleHandsFree() {
  if (!voiceReady()) return;
  if (handsFree?.active) {
    handsFree.stop();
    handsFree = null;
    wakeRelease("handsfree");
    setHandsFreeUI(false);
    toast("Manos libres apagado");
    return;
  }
  // Si hablan mientras la casa habla, se calla y obedece. Lo que no es comando (incluida su propia voz) se ignora.
  wakeHold("handsfree");
  handsFree = new HandsFree((text) => {
    stopSpeaking();
    const w = matchWake(text, wakeWord()); // si anteponen «Oye casa», se ignora el saludo
    handleVoiceText(w.hit ? (w.rest || text) : text, { handsFree: true });
  });
  handsFree.start();
  setHandsFreeUI(true);
  showStep(COOK?.idx ?? 0, true);
}

async function finishCooking(btn, r, { recipeId, entryId, servings }) {
  await safe(async () => {
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
    stopCookVoice();
    await doneModal("¡Buen provecho!", "Se descontó lo que se usó de la nevera y la alacena.");
    home();
  });
}

// ---------------------------------------------------------------- voz

let lastUndo = null;
// Un solo manejador para todos los botones "Hablar", aunque la pantalla se redibuje.
document.addEventListener("click", (e) => { if (e.target.closest("[data-mic]")) voiceModal(); });

function voiceReady() {
  if (VOICE_SUPPORTED && VOICE_SECURE) return true;
  modal({
    title: "La voz no está disponible", size: "narrow",
    body: `<p class="m-text">${!VOICE_SUPPORTED
      ? "Este navegador no reconoce la voz. En la tablet usen Google Chrome (o Fully Kiosk Browser)."
      : "El navegador solo deja usar el micrófono en una conexión segura (HTTPS). En Ajustes del README está cómo activarla en la casa."}</p>`,
    actions: [{ label: "Entendido", tone: "primary" }],
  });
  return false;
}

async function say(text) {
  if (text) await speak(text);
}

// Ventana "Te escucho": la usan el botón Hablar y la palabra de activación.
function listenUI(intro = "Hablen ahora. Por ejemplo: «se acabó la leche».") {
  const m = modal({
    title: "Te escucho…", size: "narrow",
    body: `<div class="listen"><div class="mic-wave">${icon("mic", 40)}</div>
      <p class="heard">${esc(intro)}</p>
      <p class="reply" hidden></p></div>`,
  });
  const ui = {
    m,
    closed: false,
    heard: (t) => { $(".heard", m.el).textContent = t; },
    title: (t) => { $(".m-title", m.el).textContent = t; },
    idle: () => $(".mic-wave", m.el).classList.add("idle"),
    reply: $(".reply", m.el),
    close: () => m.close(),
  };
  m.done.then(() => { ui.closed = true; });
  return ui;
}

// Lo que pasa después de entender una frase: ejecutar, mostrar la respuesta y ofrecer deshacer.
async function processUtterance(text, ui) {
  ui.idle();
  ui.heard(`«${text}»`);
  ui.title("Entendido");
  const res = await handleVoiceText(text, { box: ui.reply });
  if (!res) return ui.close();
  if (res.undo && !ui.closed) {
    const act = document.createElement("div");
    act.className = "row";
    act.style.cssText = "justify-content:center;margin-top:1rem";
    act.innerHTML = `<button class="btn-plain" data-v-undo>${icon("undo", 20)} Deshacer</button><button class="primary" data-v-ok>${icon("check", 20)} Listo</button>`;
    $(".listen", ui.m.el).appendChild(act);
    $("[data-v-undo]", ui.m.el).onclick = async () => { await runUndo(); ui.close(); };
    $("[data-v-ok]", ui.m.el).onclick = () => ui.close();
    setTimeout(() => ui.close(), 9000);
  } else {
    setTimeout(() => ui.close(), res.navigate ? 600 : 2500);
  }
}

function voiceModal() {
  if (!voiceReady()) return;
  stopRinging();
  wakeHold("tap");
  const ui = listenUI();
  ui.m.done.then(() => { stopListening(); wakeRelease("tap"); });
  (async () => {
    let text = "";
    try {
      text = await listenOnce({ onInterim: (t) => ui.heard(`«${t}»`) });
    } catch (e) {
      ui.title("No pude escuchar");
      ui.heard(e.message === "not-allowed"
        ? "El micrófono está bloqueado. Denle permiso al navegador para usarlo."
        : "No se oyó bien. Intenten de nuevo, más cerca de la tablet.");
      ui.idle();
      return;
    }
    if (!text) {
      ui.idle();
      ui.title("No escuché nada");
      ui.heard("Toquen el micrófono y hablen apenas se abra esta ventana.");
      setTimeout(() => ui.close(), 3500);
      return;
    }
    await processUtterance(text, ui);
  })();
}

// ---------------------------------------------------------------- palabra de activación («Oye casa»)
// Escucha continua mientras la pantalla está abierta. Se pausa cuando otro modo usa el micrófono
// (botón Hablar, manos libres) y vuelve sola. Se activa por dispositivo (queda recordado).

const WAKE_KEY = "mychef-wake";
const wake = { listener: null, ui: null, armTimer: null, holds: new Set(), busy: false };

function wakeEnabled() {
  try { return localStorage.getItem(WAKE_KEY) === "1"; } catch { return false; }
}
function wakeWord() { return META?.wake_word || "Oye casa"; }

function wakeButton() {
  if (!VOICE_SUPPORTED) return "";
  const on = wakeEnabled();
  return `<button class="wake-toggle ${on ? "on" : ""}" data-wake aria-pressed="${on}" title="${on ? "Toquen para apagar" : "Toquen para que la casa responda sin tocar la pantalla"}">
    <span class="dot"></span>${on ? `Digan «${esc(wakeWord())}»` : `Activar «${esc(wakeWord())}»`}</button>`;
}

function refreshWakeButtons() {
  $$("[data-wake]").forEach((b) => { b.outerHTML = wakeButton(); });
}

function startWake() {
  if (!wakeEnabled() || wake.listener || wake.holds.size || !VOICE_SUPPORTED || !VOICE_SECURE) return;
  wake.listener = new HandsFree(onWakeFinal, { onInterim: onWakeInterim });
  wake.listener.start();
}
function stopWake() {
  wake.listener?.stop();
  wake.listener = null;
}
function wakeHold(reason) { wake.holds.add(reason); stopWake(); }
function wakeRelease(reason) { wake.holds.delete(reason); setTimeout(startWake, 400); }

function toggleWake() {
  if (wakeEnabled()) {
    try { localStorage.setItem(WAKE_KEY, "0"); } catch { /* sin almacenamiento */ }
    stopWake();
    toast(`«${wakeWord()}» apagado en este dispositivo`);
  } else {
    if (!voiceReady()) return;
    try { localStorage.setItem(WAKE_KEY, "1"); } catch { /* sin almacenamiento */ }
    startWake();
    toast(`Listo: digan «${wakeWord()}» y lo que necesiten`, 4000);
  }
  refreshWakeButtons();
}

function wakeOpenUI() {
  if (wake.ui && !wake.ui.closed) return wake.ui;
  stopRinging();
  wake.ui = listenUI("Te escucho…");
  wake.ui.m.done.then(() => { clearTimeout(wake.armTimer); wake.ui = null; });
  return wake.ui;
}

function onWakeInterim(text) {
  if (wake.busy) return;
  const m = matchWake(text, wakeWord());
  if (!m.hit) return;
  const ui = wakeOpenUI();
  if (m.rest) ui.heard(`«${m.rest}»`);
}

async function onWakeFinal(text) {
  if (wake.busy) return;
  const m = matchWake(text, wakeWord());
  const armed = wake.ui && wake.ui.armed;
  let command = "";
  if (m.hit) command = m.rest;
  else if (armed) command = text;
  else {
    // Se abrió por algo que parecía la palabra, pero no lo era.
    if (wake.ui && !wake.ui.armed) wake.ui.close();
    return;
  }
  const ui = wakeOpenUI();
  if (!command) {
    // Solo dijeron «Oye casa»: sonar y esperar el comando unos segundos.
    chime();
    ui.armed = true;
    ui.heard("Te escucho… digan lo que necesitan.");
    clearTimeout(wake.armTimer);
    wake.armTimer = setTimeout(() => {
      ui.idle(); ui.title("No escuché nada"); ui.heard(`Cuando quieran, digan «${wakeWord()}».`);
      setTimeout(() => ui.close(), 2500);
    }, 8000);
    return;
  }
  clearTimeout(wake.armTimer);
  ui.armed = false;
  wake.busy = true;               // mientras responde, no escucharse a sí misma
  if (wake.listener) wake.listener.paused = true;
  try {
    await processUtterance(command, ui);
  } finally {
    setTimeout(() => { wake.busy = false; if (wake.listener) wake.listener.paused = false; }, 600);
  }
}

document.addEventListener("click", (e) => { if (e.target.closest("[data-wake]")) toggleWake(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") startWake(); else stopWake();
});

async function runUndo() {
  if (!lastUndo) return say("No hay nada para deshacer.");
  const u = lastUndo;
  lastUndo = null;
  for (const step of u.steps) {
    await api(step.url, { method: step.method, ...(step.json ? { json: step.json } : {}) });
  }
  toast("Listo, se deshizo");
  await say(u.speak || "Listo, lo deshice.");
  if (screen === "home") home();
}

async function handleVoiceText(text, { box = null, handsFree: hf = false } = {}) {
  const context = { screen, handsfree: hf, ...(COOK ? { recipe_id: COOK.recipeId, servings: COOK.servings } : {}) };
  let res;
  try {
    res = await api("/api/voice", { method: "POST", json: { text, context } });
  } catch (e) {
    toast(e.message, 4000);
    return null;
  }
  if (hf && res.intent === "unknown") return null; // en manos libres se ignora lo que no es comando
  if (box) { box.hidden = !res.speak; box.textContent = res.speak; }

  switch (res.intent) {
    case "undo": await runUndo(); return res;
    case "timer_set": Timers.add(res.data.seconds, res.data.label, res.data.said); break;
    case "timer_cancel": if (!Timers.count) res.speak = "No hay temporizadores."; Timers.cancelAll(); break;
    case "timer_query": res.speak = Timers.describe(); if (box) { box.hidden = false; box.textContent = res.speak; } break;
    case "step_next": return (showStep((COOK?.idx ?? -1) + 1), res);
    case "step_prev": return (showStep((COOK?.idx ?? 1) - 1), res);
    case "step_repeat": return (showStep(COOK?.idx ?? 0), res);
    case "cook_done": $("#done")?.click(); return res;
    default: break;
  }
  if (res.undo?.steps?.length) lastUndo = res.undo;

  const nav = res.navigate;
  const speaking = say(res.speak);
  if (nav) {
    if (nav.screen === "receipt") receiptModal();
    else if (nav.screen === "fridge") fridgeModal(nav.place);
    else if (nav.screen === "photos") photosModal();
    else if (nav.screen === "cook") go("cook", { recipeId: nav.recipeId });
    else if (nav.screen === "what") go("what", nav.meal ? { meal: nav.meal } : {});
    else go(nav.screen);
  } else if (screen === "home" && ["ran_out", "list_add", "chore_done"].includes(res.intent)) {
    safe(renderHome);
  }
  await speaking;
  return res;
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
  startWake();
}
start();
