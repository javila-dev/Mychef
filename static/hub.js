// Pantalla de la casa: lo de hoy de un vistazo y todo a un toque.
// Pensada para una tablet pegada en la nevera y para quien no se lleva bien con la tecnología:
// botones grandes, pocas palabras, confirmaciones y formularios en ventanas (modales),
// y si nadie la toca un rato, vuelve sola al inicio.

import {
  $, $$, addDays, amountForm, api, avatar, bindPeople, peoplePicker, readPeople, bindAmountForm, bindSchedule, cap, CHORE_ICONS, readSchedule, scheduleFields, choreIcon, compressImage, confirmModal, esc, fmtAmount, fmtMoney, house,
  icon, isoDate, modal, mondayOf, peopleText, PORTION, readAmountForm, safe, setHouse,
  toPantryLine, toast, withBusy,
} from "./common.js";
import {
  HandsFree, Timers, VOICE_SECURE, VOICE_SUPPORTED, chime, listenOnce, matchWake, speak, stopListening,
  stopRinging, stopSpeaking,
} from "./voice.js";

const app = $("#app");
const IDLE_MS = 2 * 60 * 1000;
const MEAL_LABEL = { desayuno: "Desayuno", almuerzo: "Almuerzo", merienda: "Merienda", cena: "Cena" };
const MEAL_ICON = { desayuno: "cup", almuerzo: "sun", merienda: "apple", cena: "moon" };
const MEAL_ORDER = ["desayuno", "almuerzo", "merienda", "cena"];

let META = null;
let TODAY = null;
let screen = "home";
let busy = false; // mientras se lee una factura no se vuelve al inicio

// ---------------------------------------------------------------- navegación

const SCREENS = {
  home: renderHome, shopping: renderShopping, what: renderWhat, cook: renderCook, chores: renderChores, agenda: renderAgenda,
  inventory: renderInventory, invGroup: renderInvGroup, menu: renderMenu,
};

function go(name, params = {}) {
  if (name !== "cook") stopCookVoice();
  screen = name;
  resetIdle();
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
  // Revisando la nevera se pasa rato mirando adentro sin tocar la pantalla: ahí espera más.
  const wait = screen === "invGroup" ? 5 * IDLE_MS : IDLE_MS;
  idleTimer = setTimeout(() => {
    if (busy || handsFree?.active || document.querySelector("dialog[open] .ring")) return resetIdle();
    $$("dialog.m[open]").forEach((d) => { d.close(); d.remove(); });
    if (screen !== "home") home();
  }, wait);
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

// Enlace pequeño arriba a la derecha de cada tarjeta del inicio («Semana ›», «Todas ›»).
function headLink(act, label) {
  return `<button class="w-link" data-act="${act}">${label}${icon("chevron", 18)}</button>`;
}

// Una comida de hoy en una sola línea: ícono, plato y cómo estamos. La que sigue va resaltada.
function mealRow(m, next) {
  const label = MEAL_LABEL[m.meal_type] ?? m.meal_type;
  const state = m.cooked ? `<span class="m-done">ya se cocinó</span>`
    : m.can_cook ? `<span class="m-ok" aria-label="Tenemos todo">${icon("check", 20)}</span>`
    : `<span class="m-miss" title="Falta: ${esc(m.missing.join(", "))}">${m.missing.length === 1 ? `falta ${esc(m.missing[0].toLowerCase())}` : `faltan ${m.missing.length}`}</span>`;
  return `<button class="meal-row ${m.cooked ? "done" : ""} ${next ? "next" : ""}" data-meal="${m.id}"
      aria-label="${esc(label)}: ${esc(m.recipe.name)}${m.cooked ? ", ya se cocinó" : m.can_cook ? ", tenemos todo" : `, falta ${esc(m.missing.join(", "))}`}">
    <span class="m-ic">${icon(MEAL_ICON[m.meal_type] ?? "plate", 20)}</span>
    <span class="m-txt">${next ? `<small>${esc(label)} · lo siguiente</small>` : ""}<span class="m-name">${esc(m.recipe.name)}</span></span>
    ${state}
  </button>`;
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
  const inv = t.inventory ?? {};
  const weekend = [0, 6].includes(new Date().getDay());
  const pendingMeals = t.meals.filter((m) => !m.cooked);
  const nextMeal = pendingMeals.find((m) => MEAL_ORDER.indexOf(m.meal_type) >= MEAL_ORDER.indexOf(mealNow())) ?? pendingMeals[0];

  app.innerHTML = `
    <div class="home">
      <div class="left">
        <header class="time-block">
          <div class="clock-row"><div class="clock" id="clock">${clock()}</div>${micButton("on-photo")}
            <button class="scan-pill" data-act="scan">${icon("camera", 26)}<span>Escanear</span></button></div>
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
          <p class="empty-note">Toquen <b>Ajustes</b> (abajo a la derecha) para cargar sus recetas y las personas, <b>Tareas</b> para las tareas de la casa y <b>Fotos</b> para poner fotos de la familia.</p>
        </section>` : ""}

        <section class="widget mesa">
          <div class="w-head"><h2 class="w-title">${icon("plate", 22)} Hoy en la mesa</h2>
            ${t.setup.recipes ? headLink("menu", "Semana") : ""}</div>
          ${t.meals.length ? t.meals.map((m) => mealRow(m, m.id === nextMeal?.id)).join("")
          : t.setup.recipes ? `<p class="empty-note">Todavía no hay menú para hoy.</p>
             <div class="w-more"><button class="primary" data-act="menu">${icon("calendar", 20)} Armar el menú de la semana</button></div>`
          : `<p class="empty-note">Cuando carguen sus recetas, aquí aparece lo que se come hoy.</p>`}
        </section>

        ${t.agenda?.length ? `<section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("calendar", 22)} Próximos días</h2>${headLink("agenda", "Agenda")}</div>
          ${t.agenda.slice(0, 2).map((e) => eventRow(e, true)).join("")}
        </section>` : ""}

        <section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("broom", 22)} Pendientes de hoy
              ${t.chores.length ? `<small>${pending.length ? `${pending.length} por hacer` : "¡Todo al día!"}</small>` : ""}</h2>
            ${headLink("chores", "Todas")}</div>
          ${shownChores.length ? shownChores.map(choreRow).join("")
            : `<p class="empty-note">${t.setup.chores ? "Nada pendiente por hoy." : "Aún no hay tareas. Toquen «Todas» para agregar la primera."}</p>`}
        </section>
      </div>

      <nav class="actions" aria-label="Qué quieren hacer">
        <button class="act act-list" data-act="shopping">${icon("basket", 34)}
          ${t.shopping_count ? `<span class="count" aria-label="${t.shopping_count} por comprar">${t.shopping_count}</span>` : ""}
          <span class="label">Lista de compras</span></button>
        <button class="act act-cook" data-act="what">${icon("pot", 34)}<span class="label">¿Qué cocino?</span></button>
        <button class="act act-out" data-act="ranout">${icon("jar", 34)}<span class="label">¿Qué falta?</span></button>
        <button class="act act-inv ${inv.due && weekend ? "due" : ""}" data-act="inventory"
          ${inv.due && weekend ? `aria-label="¿Qué hay? Hoy toca revisar"` : ""}>${icon("fridge", 34)}<span class="label">¿Qué hay?</span></button>
        <button class="act act-chores" data-act="chores">${icon("broom", 34)}
          ${pending.length ? `<span class="count" aria-label="${pending.length} tareas pendientes hoy">${pending.length}</span>` : ""}
          <span class="label">Tareas</span></button>
        <button class="act act-agenda" data-act="agenda">${icon("calendar", 34)}<span class="label">Agenda</span></button>
        <button class="act act-photos" data-act="photos">${icon("camera", 34)}<span class="label">Fotos</span></button>
        <a class="act act-admin" href="/admin" title="Ajustes: recetas, inventario y tareas" aria-label="Ajustes">${icon("sliders", 28)}<span class="label">Ajustes</span></a>
      </nav>
    </div>`;

  const ACTS = {
    scan: scanChooser, receipt: () => startScan("receipt"), shopping: () => go("shopping"), what: () => go("what"),
    ranout: ranOutModal, chores: () => go("chores"), photos: photosModal, agenda: () => go("agenda"),
    inventory: () => go("inventory"), menu: () => go("menu"),
  };
  $$("[data-act]", app).forEach((b) => b.onclick = () => ACTS[b.dataset.act]());
  $$("[data-ev]", app).forEach((b) => b.onclick = () => go("agenda"));
  $$("[data-meal]", app).forEach((el) => el.onclick = () => {
    const m = t.meals.find((x) => x.id === +el.dataset.meal);
    go("cook", { recipeId: m.recipe.id, servings: m.servings, kids: m.kids, entryId: m.cooked ? null : m.id });
  });
  bindChores(t.chores, home);
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

function choreRow(c, full = false) {
  const who = c.done_today
    ? `Hecho${c.last_done_by ? ` por ${avatar(c.last_done_by, 26)} ${esc(c.last_done_by.name)}` : ""}`
    : c.turn ? `Le toca a ${avatar(c.turn, 26)} ${esc(c.turn.name)}` : "Cualquiera puede";
  const late = !c.done_today && c.days_late ? ` · <span class="late">atrasada ${c.days_late} día${c.days_late > 1 ? "s" : ""}</span>` : "";
  const next = !c.is_due && !c.done_today ? ` · toca ${esc(c.due_text)}` : "";
  const when = full ? `<small class="when">${icon("calendar", 16)} ${esc(c.when)}${c.remind_at ? ` · ${icon("speaker", 16)} lo recuerda a las ${esc(fmtHour(c.remind_at))}` : ""}</small>` : "";
  return `<div class="chore ${c.done_today ? "done" : ""}">
    <span class="emo">${choreIcon(c.emoji, 30)}</span>
    <span class="txt"><strong>${esc(c.name)}</strong><span>${who}${late}${next}</span>${when}</span>
    ${full ? `<button class="edit-round" data-edit-chore="${c.id}" aria-label="Cambiar «${esc(c.name)}»">${icon("pencil", 22)}</button>` : ""}
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

// «19:30» → «7:30 p. m.»
function fmtHour(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------- recordatorios en voz alta
// Cada minuto la tablet pregunta al servidor qué tareas de hoy tienen recordatorio y nadie ha hecho.
// Se usa la hora de la casa que da el servidor. Lo ya avisado se guarda en este aparato por día.

const REMIND_KEY = "mychef-reminded";
const REMIND_WINDOW = 4 * 60; // si la tablet estuvo apagada, no avisar horas después
let reminding = false;

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
function remindState(today) {
  try {
    const st = JSON.parse(localStorage.getItem(REMIND_KEY) || "{}");
    if (st.today === today) return st;
  } catch { /* sin almacenamiento */ }
  return { today, seen: {} };
}
function saveRemind(st) { try { localStorage.setItem(REMIND_KEY, JSON.stringify(st)); } catch { /* sin almacenamiento */ } }

async function checkReminders() {
  if (reminding || isPhone() || document.hidden || document.querySelector("dialog[open]")) return;
  let data;
  try { data = await api("/api/reminders"); } catch { return; }
  const st = remindState(data.today);
  const now = toMinutes(data.now);
  const r = data.items.find((i) => {
    const at = toMinutes(i.remind_at), until = st.seen[i.id];
    return now >= at && now - at <= REMIND_WINDOW && until !== "off" && (until == null || now >= until);
  });
  if (r) remindModal(r, st, now);
}

function remindModal(r, st, now) {
  if (r.kind === "event") return eventReminder(r, st, now);
  reminding = true;
  chime();
  setTimeout(() => say(r.say), 700);
  const m = modal({
    title: "Recordatorio", size: "narrow",
    body: `<div class="done-msg"><div class="mark">${choreIcon(r.emoji, 44)}</div>
      <h2>${esc(r.name)}</h2>
      <p class="muted">${r.turn ? `Hoy le toca a ${avatar(r.turn, 26)} ${esc(r.turn.name)}` : "Cualquiera puede hacerla"}${r.days_late ? ` · atrasada ${r.days_late} día${r.days_late > 1 ? "s" : ""}` : ""}</p></div>`,
    actions: [
      { label: "Ya la hicimos", tone: "primary", icon: "check", value: "done" },
      { label: "En 30 minutos", icon: "clock", value: "later" },
      { label: "Hoy no", value: "off" },
    ],
  });
  m.done.then(async (v) => {
    reminding = false;
    stopSpeaking();
    // Cerrar con la X cuenta como «más tarde»: se vuelve a recordar en media hora.
    st.seen[r.id] = v === "done" || v === "off" ? "off" : now + 30;
    saveRemind(st);
    if (v === "done") {
      const members = await safe(() => api("/api/members"));
      if (members) whoModal(r, members, refresh);
    }
  });
}

function eventReminder(r, st, now) {
  reminding = true;
  chime();
  setTimeout(() => say(r.say), 700);
  const [ic, cls] = EVENT_CATS[r.category] ?? EVENT_CATS.otro;
  const m = modal({
    title: "Recordatorio", size: "narrow",
    body: `<div class="done-msg"><div class="mark ev-mark ${cls}">${icon(ic, 44)}</div>
      <h2>${esc(r.title)}</h2>
      <p class="muted">${esc(cap(r.day_text))}${r.time ? ` · ${esc(r.time_text)}` : ""}${r.member ? ` · ${avatar(r.member, 26)} ${esc(r.member.name)}` : ""}</p>
      ${r.notes ? `<p class="m-text">${esc(r.notes)}</p>` : ""}</div>`,
    actions: [
      { label: "Entendido", tone: "primary", icon: "check", value: "ok" },
      { label: "En 30 minutos", icon: "clock", value: "later" },
    ],
  });
  m.done.then((v) => {
    reminding = false;
    stopSpeaking();
    st.seen[r.id] = v === "ok" ? "off" : now + 30;
    saveRemind(st);
  });
}

// ---------------------------------------------------------------- agenda de la familia

const EVENT_CATS = {
  salud: ["heart", "cat-salud", "Salud"], colegio: ["book", "cat-colegio", "Colegio"],
  "cumpleaños": ["cake", "cat-cumple", "Cumpleaños"], pagos: ["coin", "cat-pagos", "Pagos"],
  familia: ["people", "cat-familia", "Familia"], otro: ["calendar", "cat-otro", "Otro"],
};
const REPEAT_TEXT = { none: "", weekly: "Cada semana", monthly: "Cada mes", yearly: "Cada año" };
const REMIND_OPTS = [[1440, "El día antes"], [120, "2 horas antes"], [60, "1 hora antes"], [0, "A la hora"]];

function eventRow(e, compact = false) {
  const [ic, cls] = EVENT_CATS[e.category] ?? EVENT_CATS.otro;
  const late = e.date < isoDate(new Date());
  const when = compact ? `${cap(e.day_text)}${e.time ? ` · ${e.time_text}` : ""}` : (e.time ? e.time_text : "Todo el día");
  return `<button class="ev-row" data-ev="${e.id}" data-date="${e.date}">
    <span class="ev-ic ${cls}">${icon(ic, 24)}</span>
    <span class="ev-txt"><strong>${esc(e.title)}</strong>
      <span>${esc(when)}${e.member ? ` · ${avatar(e.member, 22)} ${esc(e.member.name)}` : ""}${!compact && e.repeat !== "none" ? ` · ${REPEAT_TEXT[e.repeat]}` : ""}${late ? ` · <span class="late">ya pasó</span>` : ""}</span></span>
  </button>`;
}

async function renderAgenda() {
  const [items, members] = await Promise.all([api("/api/events?days=60"), api("/api/members")]);
  const groups = [];
  for (const e of items) {
    const g = groups.at(-1);
    if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, label: e.day_text, items: [e] });
  }
  const dayName = (iso) => new Date(iso + "T12:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  app.innerHTML = `${head("Agenda de la familia", "Volver al inicio",
      `<button class="primary" id="add-ev">${icon("plus", 22)} Agregar</button>`)}
    ${groups.length ? groups.map((g) => `
      <section class="sheet ev-day">
        <h2>${esc(cap(g.label))}${/^(hoy|mañana|pasado)/.test(g.label) ? ` <small>${esc(dayName(g.date))}</small>` : ""}</h2>
        ${g.items.map((e) => `<div class="ev-line">${eventRow(e)}
          ${e.repeat === "none" ? `<button class="tick-round" data-done="${e.id}" aria-label="Ya pasó / listo">${icon("check", 26)}</button>` : ""}</div>`).join("")}
      </section>`).join("")
    : `<section class="sheet"><p class="empty-note">No hay nada en la agenda para los próximos dos meses.<br>
        Toquen <b>Agregar</b> o digan «Oye casa, recuérdame la cita de Benja el jueves a las 3».</p></section>`}`;
  bindBack();
  $("#add-ev").onclick = () => eventModal(null, members);
  $$("[data-ev]", app).forEach((b) => b.onclick = () => eventModal(items.find((e) => e.id === +b.dataset.ev && e.date === b.dataset.date), members));
  $$("[data-done]", app).forEach((b) => b.onclick = () => withBusy(b, async () => {
    const id = +b.dataset.done;
    await safe(() => api(`/api/events/${id}/done`, { method: "POST" }));
    toast("Listo");
    lastUndo = { steps: [{ method: "POST", url: `/api/events/${id}/undone` }], speak: "Listo, volvió a la agenda." };
    go("agenda");
  }));
}

function eventModal(ev, members) {
  const e = ev ?? { title: "", category: "familia", member_id: null, first_day: isoDate(new Date()), time: null, repeat: "none", remind: [60], notes: "" };
  const chip = (name, value, label, checked, type = "radio") =>
    `<label><input type="${type}" name="${name}" value="${value}" ${checked ? "checked" : ""}><span>${label}</span></label>`;
  const m = modal({
    title: ev ? "Cambiar en la agenda" : "Agregar a la agenda",
    body: `<form id="evf" class="stack">
      <label class="field">¿Qué es?<input name="title" required maxlength="80" value="${esc(e.title)}" placeholder="Ej: Cita con la pediatra" autocomplete="off"></label>
      <div class="field">¿De qué tipo?<div class="seg">${Object.entries(EVENT_CATS).map(([k, [ic, , label]]) =>
        chip("category", k, `${icon(ic, 18)} ${label}`, k === e.category)).join("")}</div></div>
      <div class="field">¿Para quién?<div class="seg">${chip("member", "", "Toda la familia", !e.member_id)}${members.map((p) =>
        chip("member", p.id, `${avatar(p, 22)} ${esc(p.name)}`, p.id === e.member_id)).join("")}</div></div>
      <div class="form-grid">
        <label class="field">¿Qué día?<input name="day" type="date" required value="${e.first_day ?? e.date}"></label>
        <label class="field">¿A qué hora?<input name="time" type="time" value="${e.time ?? ""}"></label>
      </div>
      <label class="field">¿Se repite?<select name="repeat">${Object.entries({ none: "No, una sola vez", weekly: "Cada semana", monthly: "Cada mes", yearly: "Cada año" })
        .map(([k, t]) => `<option value="${k}" ${k === e.repeat ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <div class="field">¿Cuándo avisar en voz alta?<div class="seg">${REMIND_OPTS.map(([v, t]) =>
        chip("remind", v, t, e.remind.includes(v), "checkbox")).join("")}</div>
        <small class="muted">Sin hora, «A la hora» avisa ese día a las 7:30 a. m. y «El día antes», la noche anterior.</small></div>
      <label class="field">Notas <small class="muted">(opcional)</small><textarea name="notes" rows="2" maxlength="300" placeholder="Ej: llevar el carné de vacunas">${esc(e.notes)}</textarea></label>
    </form>`,
    actions: [
      ...(ev ? [{ label: "Borrar", tone: "danger", icon: "trash", value: "delete" }] : []),
      { label: "Cancelar", value: false },
      { label: "Guardar", tone: "primary", icon: "check", onClick: async (dlg) => {
        const f = $("#evf", dlg);
        if (!f.reportValidity()) return false;
        const data = {
          title: f.title.value, category: f.querySelector("[name=category]:checked").value,
          member_id: +f.querySelector("[name=member]:checked").value || null,
          day: f.day.value, time: f.time.value || null, repeat: f.repeat.value, notes: f.notes.value,
          remind: $$("[name=remind]:checked", f).map((i) => +i.value),
        };
        const ok = await safe(() => api(ev ? `/api/events/${ev.id}` : "/api/events", { method: ev ? "PUT" : "POST", json: data }));
        if (!ok) return false;
        toast(ev ? "Guardado" : "Anotado en la agenda");
      } },
    ],
  });
  m.done.then(async (v) => {
    if (v === "delete") {
      if (!await confirmModal({ title: "¿Borrar de la agenda?", text: esc(ev.title), ok: "Borrar", tone: "danger", okIcon: "trash" })) return;
      await safe(() => api(`/api/events/${ev.id}`, { method: "DELETE" }));
    }
    if (v) go("agenda");
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
    <section class="sheet chores-sheet">${chores.map((c) => choreRow(c, true)).join("")
      || `<p class="empty-note">Aún no hay tareas. Agreguen la primera: sacar la basura, regar las plantas…</p>`}</section>
    <div class="bottom-bar"><button class="primary big" id="add-chore">${icon("plus")} Agregar tarea</button></div>`;
  bindBack();
  bindChores(chores, () => go("chores"));
  $("#add-chore").onclick = () => choreForm();
  $$("[data-edit-chore]", app).forEach((b) => b.onclick = () => choreForm(chores.find((c) => c.id === +b.dataset.editChore)));
}

// Agregar o cambiar una tarea desde la tablet: qué es, su dibujo, a quién le toca y cuándo.
async function choreForm(chore = null) {
  const members = await safe(() => api("/api/members"));
  if (!members) return;
  const c = chore ?? { name: "", emoji: META.chore_emojis[0], member_id: null, rotate: false };
  const who = c.rotate ? "rotate" : c.member_id ? String(c.member_id) : "";
  const whoOpts = [["", "Cualquiera"], ["rotate", "Por turnos"], ...members.map((m) => [String(m.id), m.name])];
  const m = modal({
    title: chore ? "Cambiar tarea" : "Nueva tarea",
    body: `<form id="chf" class="stack">
      <label class="field">¿Qué hay que hacer?<input name="name" required maxlength="80" autocomplete="off"
        value="${esc(c.name)}" placeholder="Ej: Sacar la basura"></label>
      <div class="field">Dibujo<div class="pick">${META.chore_emojis.map((e) => `
        <label title="${esc(CHORE_ICONS[e]?.[1] ?? "")}"><input type="radio" name="emoji" value="${e}" ${e === c.emoji ? "checked" : ""}>
          <span>${choreIcon(e, 26)}</span></label>`).join("")}</div></div>
      <div class="field">¿A quién le toca?<div class="seg">${whoOpts.map(([v, t]) => `
        <label><input type="radio" name="who" value="${v}" ${v === who ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div></div>
      ${scheduleFields(c)}
    </form>`,
    onOpen: (dlg) => bindSchedule($("#chf", dlg)),
    actions: [
      ...(chore ? [{ label: "Quitar", tone: "danger", icon: "trash", value: "delete" }] : []),
      { label: "Cancelar", value: false },
      {
        label: chore ? "Guardar" : "Agregar tarea", tone: "primary", icon: chore ? "check" : "plus",
        onClick: async (dlg) => {
          const f = $("#chf", dlg);
          if (!f.reportValidity()) return false;
          const w = f.who.value;
          const body = {
            name: f.name.value.trim(), emoji: f.emoji.value,
            member_id: w && w !== "rotate" ? +w : null, rotate: w === "rotate", ...readSchedule(f),
          };
          const ok = await safe(() => api(chore ? `/api/chores/${chore.id}` : "/api/chores", { method: chore ? "PUT" : "POST", json: body }));
          if (!ok) return false;
          toast(chore ? "Tarea guardada" : `Agregada: ${body.name}`);
          return true;
        },
      },
    ],
  });
  const v = await m.done;
  if (v === "delete") {
    const ok = await confirmModal({ title: "¿Quitar esta tarea?", text: `«${esc(c.name)}» se borra junto con su historial.`, ok: "Quitar", tone: "danger", okIcon: "trash" });
    if (!ok) return choreForm(chore);
    await safe(() => api(`/api/chores/${chore.id}`, { method: "DELETE" }));
    toast("Tarea quitada");
  }
  if (v) go("chores");
}

// ---------------------------------------------------------------- factura (en una ventana)

function receiptModal(remote = null) {
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
      const text = `${res.added} productos de la factura quedaron en la casa.`;
      if (remote) await reportRemote(remote, text);
      await doneModal("¡Guardado!", remote ? `${text} Ya se ve en la tablet.` : text);
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
    startScan(b.dataset.c);
  });
}

// ¿Con qué toman la foto? La tablet vive pegada a la nevera, así que su cámara no ve adentro:
// lo más cómodo suele ser el celular (escanea un código y la foto llega a la casa).
const SCAN_WHAT = { receipt: "la factura", nevera: "la nevera", alacena: "la alacena" };
const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

function openScan(kind, remote = null) {
  kind === "receipt" ? receiptModal(remote) : fridgeModal(kind, remote);
}

function startScan(kind) {
  if (isPhone()) return openScan(kind); // ya están en el celular
  const m = modal({
    title: `¿Con qué le toman la foto a ${SCAN_WHAT[kind]}?`, size: "narrow",
    body: `<div class="choices">
      <button class="choice" data-h="phone">${icon("phone", 36)}<span><b>Con el celular</b>
        <small>Apuntan la cámara del celular a un código y listo. La tablet se queda en su sitio.</small></span></button>
      <button class="choice" data-h="tablet">${icon("tablet", 36)}<span><b>Con esta tablet</b>
        <small>Hay que despegarla un momento de la nevera para tomar la foto.</small></span></button>
    </div>`,
  });
  $$("[data-h]", m.el).forEach((b) => b.onclick = () => {
    m.close();
    b.dataset.h === "phone" ? phoneScanModal(kind) : openScan(kind);
  });
}

async function phoneScanModal(kind) {
  const ses = await safe(() => api("/api/scan-sessions", { method: "POST", json: { kind } }));
  if (!ses) return;
  busy = true;
  const m = modal({
    title: "Tómenla con el celular", size: "narrow",
    body: `<div class="qr-box">
      <img src="/api/scan-sessions/${ses.id}/qr.svg" alt="Código para abrir en el celular" width="220" height="220">
      <ol class="qr-steps">
        <li>Abran la <b>cámara</b> del celular y apunten a este código.</li>
        <li>Toquen el enlace que aparece en la pantalla del celular.</li>
        <li>Tomen la foto de ${SCAN_WHAT[kind]} y guarden.</li>
      </ol>
      <p class="qr-status" id="qs" role="status">${icon("clock", 20)} Esperando el celular…</p>
      ${ses.local_only ? `<p class="qr-warn">${icon("warn", 20)} Esta tablet abrió la app como «localhost» y el celular no va a poder entrar.
        Ábranla con la dirección de la red de la casa (por ejemplo http://192.168.1.20:8000).</p>` : ""}
      <p class="muted small qr-url">¿No lee el código? En el celular escriban:<br><b>${esc(ses.url)}</b></p>
    </div>`,
    actions: [{ label: "Mejor con esta tablet", value: "tablet", icon: "tablet" }, { label: "Cancelar", value: false }],
  });
  const poll = setInterval(async () => {
    let st;
    try { st = await api(`/api/scan-sessions/${ses.id}`); } catch { clearInterval(poll); return; }
    if (st.status === "opened") $("#qs", m.el).innerHTML = `${icon("check", 20)} El celular ya lo abrió. Tomen la foto…`;
    if (st.status === "done") {
      clearInterval(poll);
      m.close("done");
      say(`Listo. ${st.summary}`);
      await doneModal("¡Listo!", st.summary || "Quedó guardado desde el celular.");
      refresh();
    }
  }, 2000);
  m.done.then((v) => {
    clearInterval(poll);
    busy = false;
    if (v === "tablet") openScan(kind);
  });
}

async function reportRemote(remote, summary) {
  try { await api(`/api/scan-sessions/${remote}/done`, { method: "POST", json: { summary } }); } catch { /* la tablet ya no espera */ }
}

// Fotos de la nevera o la alacena: la IA dice qué ve y cuánto queda; la familia revisa y guarda.
function fridgeModal(place = "nevera", remote = null) {
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
      Object.assign(state, { draft: d, urls: null, shown: 0, sel: null });
      review();
    } catch (e) {
      box.innerHTML = `<div class="done-msg"><div class="mark warn">${icon("warn", 44)}</div>
        <h2>No se pudo ver</h2><p class="muted">${esc(e.message)}</p>
        <div class="row" style="justify-content:center;margin-top:1rem"><button class="primary big" id="retry">Intentar otra vez</button></div></div>`;
      $("#retry", box).onclick = () => { state.photos = []; photos(); };
    }
  };

  // Revisión: la foto con un marcador numerado sobre cada cosa reconocida, y la lista al lado.
  // Tocar un marcador (o una fila) la selecciona para corregir qué es y cuánto hay;
  // tocar un lugar vacío de la foto agrega algo que la IA no vio.
  const review = () => {
    const d = state.draft;
    state.urls ??= state.photos.map((p) => URL.createObjectURL(p));
    state.shown ??= 0;
    const kept = d.items.filter((i) => i.keep).length;
    const sel = d.items[state.sel];
    const sure = { alta: "", media: "", baja: `<span class="badge warn">¿seguro?</span>` };
    const pins = d.items.map((i, idx) => [i, idx]).filter(([i]) => i.photo === state.shown && i.x != null);
    const unpinned = d.items.filter((i) => i.x == null).length;
    box.innerHTML = `
      <div class="snap-cols">
        <div class="snap-side">
          ${state.urls.length > 1 ? `<div class="snap-tabs">${state.urls.map((_, n) => `
            <button class="${n === state.shown ? "on" : ""}" data-shot="${n}">Foto ${n + 1}</button>`).join("")}</div>` : ""}
          <div class="snap" id="snap">
            <img src="${state.urls[state.shown]}" alt="Foto ${state.shown + 1} de ${where}" draggable="false">
            ${pins.map(([i, idx]) => `
              <button class="pin ${i.keep ? "" : "off"} ${i.confidence === "baja" ? "doubt" : ""} ${idx === state.sel ? "sel" : ""}"
                style="left:${i.x * 100}%;top:${i.y * 100}%" data-pin="${idx}" aria-label="${idx + 1}: ${esc(i.name || "sin nombre")}">${idx + 1}</button>`).join("")}
          </div>
          <p class="muted small snap-hint">Toquen un número para corregirlo, o un lugar vacío de la foto para agregar algo que no vio.
            ${unpinned ? `${unpinned} no se ${unpinned === 1 ? "pudo" : "pudieron"} señalar en la foto.` : ""}</p>
          ${sel ? `
            <div class="pin-edit" data-idx="${state.sel}">
              <span class="pin-n">${state.sel + 1}</span>
              <label class="field">¿Qué es?<input data-f="name" value="${esc(sel.name)}" placeholder="Ej: Queso" autocomplete="off"></label>
              <div class="pin-amt">
                <label class="field">¿Cuánto hay?<input type="number" step="any" min="0" data-f="quantity" value="${sel.quantity}"></label>
                <label class="field">Unidad<input data-f="unit" value="${esc(sel.unit)}" list="dl-units-hub"></label>
              </div>
              <div class="row">
                ${sel.manual
                  ? `<button class="ghost" data-drop>${icon("trash", 18)} Quitar</button>`
                  : `<button class="${sel.keep ? "ghost" : "primary"}" data-toggle>${sel.keep ? `${icon("close", 18)} No es eso, no guardar` : `${icon("check", 18)} Sí, guardarlo`}</button>`}
                <button class="ghost" data-close-edit>${icon("check", 18)} Listo</button>
              </div>
            </div>` : ""}
        </div>
        <div class="snap-list">
          ${d.notes ? `<p class="muted small" style="margin:0 0 .4rem">${esc(d.notes)}</p>` : ""}
          ${d.items.map((i, idx) => `
            <div class="rline ${i.keep ? "on" : "off"} ${idx === state.sel ? "sel" : ""}" data-idx="${idx}">
              <button class="circle" data-toggle aria-label="${i.keep ? "No guardar" : "Guardar"}">${i.keep ? icon("check", 22) : ""}</button>
              <button class="nm-btn" data-pick><span class="num">${idx + 1}</span>
                <span class="nm-txt">${esc(i.name || "Sin nombre")}</span>
                <span class="nm-amt">${esc(fmtAmount(i.quantity, i.unit))}</span></button>
              <span class="price">${sure[i.confidence] ?? ""}</span>
            </div>`).join("") || `<p class="empty-note">No se reconocieron alimentos. Toquen la foto donde está cada cosa para agregarla.</p>`}
        </div>
      </div>
      <datalist id="dl-units-hub">${(META.units || []).map((u) => `<option value="${u}">`).join("")}</datalist>
      ${d.not_seen?.length ? `
        <div class="group-label">No se ve en la foto. ¿Se acabó? Tóquenlo y pasa a la lista de compras</div>
        <div class="tiles">${d.not_seen.map((n) => `
          <button class="tile ${state.gone.has(n.name) ? "done" : ""}" data-gone="${esc(n.name)}">${state.gone.has(n.name) ? icon("check", 20) : ""}${esc(n.name)}</button>`).join("")}</div>` : ""}
      <div class="row" style="margin-top:1.2rem">
        <button class="primary big" id="save" ${kept || state.gone.size ? "" : "disabled"}>${icon("check")} Poner al día ${kept} cosa${kept === 1 ? "" : "s"}</button>
        <button class="ghost big" id="again">${icon("camera")} Tomar otra foto</button>
      </div>`;

    const itemOf = (el) => d.items[+el.closest("[data-idx]").dataset.idx];
    const select = (idx) => {
      state.sel = idx;
      const i = d.items[idx];
      if (i?.photo != null) state.shown = i.photo;
      review();
    };
    $$("[data-shot]", box).forEach((b) => b.onclick = () => { state.shown = +b.dataset.shot; review(); });
    $$("[data-pin]", box).forEach((b) => b.onclick = (e) => { e.stopPropagation(); select(+b.dataset.pin); });
    $$("[data-pick]", box).forEach((b) => b.onclick = () => select(+b.closest("[data-idx]").dataset.idx));
    $("#snap", box).onclick = (e) => {
      if (e.target.closest("[data-pin]")) return;
      const r = e.currentTarget.getBoundingClientRect();
      d.items.push({
        name: "", quantity: 1, unit: "unidad", category: "otros", confidence: "alta", keep: true, manual: true,
        photo: state.shown, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height,
      });
      select(d.items.length - 1);
      $(".pin-edit [data-f=name]", box)?.focus();
    };
    $$("[data-toggle]", box).forEach((b) => b.onclick = () => { const i = itemOf(b); i.keep = !i.keep; review(); });
    $("[data-drop]", box)?.addEventListener("click", () => { d.items.splice(state.sel, 1); state.sel = null; review(); });
    $("[data-close-edit]", box)?.addEventListener("click", () => { state.sel = null; review(); });
    $$("[data-f]", box).forEach((inp) => inp.onchange = () => {
      const i = itemOf(inp);
      i[inp.dataset.f] = inp.dataset.f === "quantity" ? parseFloat(inp.value) || 0 : inp.value;
      if (inp.closest(".pin-edit")) {
        if (inp.dataset.f === "name") i.confidence = "alta"; // ya lo corrigió una persona
        review();
        $(`.pin-edit [data-f=${inp.dataset.f}]`, box)?.focus();
      }
    });
    $$("[data-gone]", box).forEach((b) => b.onclick = () => {
      const n = b.dataset.gone;
      state.gone.has(n) ? state.gone.delete(n) : state.gone.add(n);
      review();
    });
    $("#again", box).onclick = () => {
      Object.assign(state, { photos: [], draft: null, urls: null, shown: 0, sel: null });
      state.gone.clear();
      photos();
    };
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
      const text = `${items.length} cosa${items.length === 1 ? "" : "s"} de ${where} quedaron actualizadas.${gone}`;
      if (remote) await reportRemote(remote, text);
      await doneModal("¡Al día!", remote ? `${text} Ya se ve en la tablet.` : text);
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

// ---------------------------------------------------------------- menú de la semana
// Su propia página (se entra desde «Hoy en la mesa»): los 7 días con sus comidas, qué falta para
// cada plato y, con un toque, cambiarlo, quitarlo, decir para quiénes o ponerse a cocinar.


async function renderMenu({ start } = {}) {
  const monday = start ? new Date(`${start}T12:00`) : mondayOf(new Date());
  const iso = isoDate(monday);
  const entries = await api(`/api/menu?start=${iso}&days=7`);
  const todayIso = isoDate(new Date());
  const meals = [...META.meal_types].sort((a, b) => MEAL_ORDER.indexOf(a) - MEAL_ORDER.indexOf(b));
  const thisWeek = iso === isoDate(mondayOf(new Date()));
  const sunday = addDays(monday, 6);
  const range = `${monday.getDate()} al ${sunday.toLocaleDateString("es", { day: "numeric", month: "long" })}`;
  const empty = entries.length === 0;

  const plate = (e) => `
    <button class="plate ${e.cooked ? "done" : ""}" data-entry="${e.id}">
      <span class="p-name">${esc(e.recipe.name)}</span>
      <span class="p-state ${e.cooked ? "" : e.can_cook ? "ok" : "miss"}">${e.cooked ? `${icon("check", 16)} Ya se cocinó`
        : e.can_cook ? `${icon("check", 16)} Tenemos todo` : `Falta: ${esc(e.missing.join(", "))}`}</span>
      ${e.servings === house().adults && e.kids === house().kids ? ""
        : `<span class="p-who">${icon("people", 16)} ${esc(peopleText(e.servings, e.kids))}</span>`}
    </button>`;

  app.innerHTML = `${head("Menú de la semana")}
    <div class="menu-bar">
      <div class="week-nav">
        <button class="round" id="prev" aria-label="Semana anterior">${icon("back", 24)}</button>
        <strong>${thisWeek ? "Esta semana" : "Semana"} · ${range}</strong>
        <button class="round" id="next" aria-label="Semana siguiente">${icon("chevron", 24)}</button>
        ${thisWeek ? "" : `<button id="now">${icon("undo", 18)} Volver a esta semana</button>`}
      </div>
      <div class="menu-tools">
        <button class="${empty ? "primary" : ""}" id="fill">${icon("spark", 20)} ${empty ? "Armar la semana" : "Llenar lo que falta"}</button>
        <button id="to-list">${icon("basket", 20)} Lista de compras</button>
      </div>
    </div>
    <div class="week">${[...Array(7)].map((_, n) => {
      const d = addDays(monday, n);
      const di = isoDate(d);
      return `<section class="menu-day ${di === todayIso ? "today" : ""} ${di < todayIso ? "past" : ""}" ${di === todayIso ? `id="today"` : ""}>
        <h2>${esc(cap(d.toLocaleDateString("es", { weekday: "long" })))} <small>${d.getDate()}</small>
          ${di === todayIso ? `<span class="today-tag">Hoy</span>` : ""}</h2>
        <div class="slots" style="--n:${meals.length}">${meals.map((m) => {
          const list = entries.filter((e) => e.day === di && e.meal_type === m);
          return `<div class="slot">
            <span class="slot-meal">${icon(MEAL_ICON[m], 18)} ${esc(MEAL_LABEL[m] ?? m)}</span>
            ${list.map(plate).join("") || `<button class="plate add" data-add="${di}|${m}">${icon("plus", 20)} Agregar</button>`}
          </div>`;
        }).join("")}</div>
      </section>`;
    }).join("")}</div>`;

  bindBack();
  const again = () => go("menu", { start: iso });
  $("#prev").onclick = () => go("menu", { start: isoDate(addDays(monday, -7)) });
  $("#next").onclick = () => go("menu", { start: isoDate(addDays(monday, 7)) });
  $("#now")?.addEventListener("click", () => go("menu"));
  $("#to-list").onclick = () => go("shopping");
  $("#fill").onclick = (ev) => safe(async () => {
    const btn = ev.currentTarget;
    const ok = await confirmModal({
      title: empty ? "¿Armamos la semana?" : "¿Llenamos lo que falta?",
      text: "Se ponen sus recetas en las comidas vacías de la semana (desayuno, almuerzo, merienda y cena, según las recetas que tengan para cada una), usando primero lo que ya hay en la casa. Lo que ya está no se toca.",
      ok: "Sí, llenar", okIcon: "spark",
    });
    if (!ok) return;
    const created = await withBusy(btn, () => api("/api/menu/autoplan", { method: "POST", json: {
      start: iso, days: 7, meal_types: meals,
    } }));
    toast(created.length ? `Se agregaron ${created.length} comidas` : "No quedaron espacios (o faltan recetas en Ajustes)");
    again();
  });
  $$("[data-add]", app).forEach((b) => b.onclick = () => {
    const [day, meal] = b.dataset.add.split("|");
    pickRecipeModal({ day, meal }, again);
  });
  $$("[data-entry]", app).forEach((b) => b.onclick = () => menuEntryModal(entries.find((e) => e.id === +b.dataset.entry), again));
  if (thisWeek) $("#today")?.scrollIntoView({ block: "center" });
}

function menuEntryModal(e, after) {
  const day = cap(new Date(`${e.day}T12:00`).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }));
  const m = modal({
    title: esc(e.recipe.name),
    body: `<p class="m-text">${esc(day)} · ${esc(MEAL_LABEL[e.meal_type] ?? e.meal_type)}</p>
      <p class="entry-state ${e.cooked ? "" : e.can_cook ? "ok" : "miss"}">${e.cooked ? `${icon("check", 18)} Ya se cocinó`
        : e.can_cook ? `${icon("check", 18)} Tenemos todo` : `Falta: ${esc(e.missing.join(", "))}`}</p>
      <div class="field" style="margin-top:1rem">¿Para quiénes?${peoplePicker(e.servings, e.kids, "em-pp")}</div>
      ${e.cooked ? "" : `<button class="primary big entry-cook" data-cook>${icon("pot")} Ver la receta y cocinar</button>`}`,
    actions: [
      { label: "Quitar", tone: "danger", icon: "trash", value: "del" },
      { label: "Cambiar plato", icon: "undo", value: "swap" },
      { label: "Listo", tone: "primary", icon: "check", value: "ok" },
    ],
  });
  bindPeople(m.el);
  $("[data-cook]", m.el)?.addEventListener("click", () => m.close("cook"));
  m.done.then((v) => safe(async () => {
    const p = readPeople(m.el);
    const changed = p.adults !== e.servings || p.kids !== e.kids;
    if (v && v !== "del" && changed && p.adults + p.kids > 0) {
      await api(`/api/menu/${e.id}`, { method: "PATCH", json: { servings: p.adults, kids: p.kids } });
    }
    if (v === "cook") return go("cook", { recipeId: e.recipe.id, servings: p.adults, kids: p.kids, entryId: e.id });
    if (v === "swap") return pickRecipeModal({ day: e.day, meal: e.meal_type, entry: e }, after);
    if (v === "del") {
      const ok = await confirmModal({ title: "¿Quitar del menú?", text: `«${esc(e.recipe.name)}» se quita de ese día. La receta no se borra.`, ok: "Quitar", tone: "danger", okIcon: "trash" });
      if (!ok) return;
      await api(`/api/menu/${e.id}`, { method: "DELETE" });
      toast("Quitado del menú");
    }
    if (v) after();
  }));
}

// Elegir qué se come: sus recetas, primero las que se pueden hacer con lo que hay.
async function pickRecipeModal({ day, meal, entry = null }, after) {
  const { adults, kids } = entry ? { adults: entry.servings, kids: entry.kids } : house();
  let sugg = await safe(() => api(`/api/suggestions?meal_type=${encodeURIComponent(meal)}&servings=${adults}&kids=${kids}&limit=40`));
  if (!sugg) return;
  // Si ninguna receta está marcada para esa comida, se ofrecen todas (a veces se cena lo del almuerzo).
  const others = !sugg.length;
  if (others) sugg = await safe(() => api(`/api/suggestions?servings=${adults}&kids=${kids}&limit=40`)) ?? [];
  const when = cap(new Date(`${day}T12:00`).toLocaleDateString("es", { weekday: "long", day: "numeric" }));
  const m = modal({
    title: entry ? "Cambiar el plato" : `${esc(MEAL_LABEL[meal] ?? meal)} del ${esc(when.toLowerCase())}`,
    size: "wide",
    body: sugg.length ? `${others ? `<p class="m-text" style="margin-bottom:.8rem">No tienen recetas marcadas para ${esc((MEAL_LABEL[meal] ?? meal).toLowerCase())}. Estas son todas las de la casa:</p>` : ""}
      <div class="choices pick-recipe">${sugg.map((s) => `
      <button class="choice" data-r="${s.recipe.id}">${icon(s.recipe.favorite ? "star" : "pot", 30)}
        <span><b>${esc(s.recipe.name)}</b>
          <small class="${s.can_cook ? "ok" : "miss"}">${s.can_cook ? "Tenemos todo" : `Falta: ${esc(s.missing.map((x) => x.name).join(", "))}`}
          ${s.uses_expiring.length ? ` · aprovecha ${esc(s.uses_expiring.join(", "))}` : ""}</small></span></button>`).join("")}</div>`
      : `<div class="state-block">${icon("pot", 44)}<h2>Todavía no hay recetas</h2>
        <p>Se agregan en Ajustes → Recetas.</p></div>`,
  });
  $$("[data-r]", m.el).forEach((b) => b.onclick = () => safe(async () => {
    await withBusy(b, () => entry
      ? api(`/api/menu/${entry.id}`, { method: "PATCH", json: { recipe_id: +b.dataset.r } })
      : api("/api/menu", { method: "POST", json: { day, meal_type: meal, recipe_id: +b.dataset.r } }));
    m.close(true);
    after();
  }));
}

// ---------------------------------------------------------------- ¿qué hay? (revisar la casa)
// El repaso del fin de semana: con la nevera abierta, grupo por grupo (proteínas, lácteos…),
// cada cosa se marca como Hay, Poco o Se acabó. Poco y Se acabó pasan a la lista de compras.

const INV_STATES = [
  ["ok", "Hay", "check"],
  ["low", "Poco", "half"],
  ["out", "Se acabó", "close"],
];

const invState = (i) => (i.quantity <= 0 ? "out" : i.in_list || i.low ? "low" : "ok");
// En modo tranquilo se piensa en porciones ("para 2 adultos y 1 niño"), no en gramos.
const prefersPortions = () => META.inventory_mode === "tranquilo";
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function renderInventory() {
  const data = await api("/api/inventory");
  const withItems = data.groups.filter((g) => g.items.length);
  const done = withItems.filter((g) => g.reviewed_today).length;
  const pct = withItems.length ? Math.round((done / withItems.length) * 100) : 0;
  app.innerHTML = `${head("¿Qué hay en la casa?")}
    <section class="inv-intro">
      <p>Abran la nevera y la alacena. Toquen un grupo y marquen cómo está cada cosa.</p>
      ${withItems.length ? `<div class="inv-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${withItems.length}" aria-valuenow="${done}">
        <div class="bar"><span style="width:${pct}%"></span></div>
        <b>${done === withItems.length ? `${icon("check", 20)} Todo revisado hoy` : `Revisados hoy: ${done} de ${withItems.length}`}</b>
      </div>` : ""}
    </section>
    <div class="inv-grid">${data.groups.map((g) => `
      <button class="inv-card g-${g.key} ${g.reviewed_today ? "seen" : ""} ${g.items.length ? "" : "empty"}" data-g="${g.key}">
        <span class="inv-ic">${icon(g.icon, 36)}</span>
        <span class="inv-name">${esc(g.label)}</span>
        <span class="inv-sub">${g.items.length
          ? `${plural(g.count, "cosa", "cosas")}${g.out ? ` · <span class="gone">${plural(g.out, "acabada", "acabadas")}</span>` : ""}`
          : "Vacío"}</span>
        ${g.reviewed_today ? `<span class="inv-seen" aria-label="Revisado hoy">${icon("check", 20)}</span>` : ""}
      </button>`).join("")}</div>`;
  bindBack();
  $$("[data-g]", app).forEach((b) => b.onclick = () => go("invGroup", { key: b.dataset.g }));
}

async function renderInvGroup({ key }) {
  const data = await api("/api/inventory");
  const g = data.groups.find((x) => x.key === key);
  const changes = new Map(); // id -> { state, quantity }
  const stateOf = (i) => changes.get(i.id)?.state ?? invState(i);
  const qtyOf = (i) => changes.get(i.id)?.quantity ?? i.quantity;
  const unitOf = (i) => changes.get(i.id)?.unit ?? i.unit;
  const setChange = (i, patch) => {
    const prev = changes.get(i.id) ?? {};
    const next = { state: stateOf(i), quantity: prev.quantity ?? null, unit: prev.unit ?? null, ...patch };
    const same = next.state === invState(i) && (next.quantity == null || next.quantity === i.quantity)
      && (next.unit == null || next.unit === i.unit);
    if (same) changes.delete(i.id);
    else changes.set(i.id, next);
  };
  const ask = (i) => askQty({ ...i, unit: unitOf(i) }, stateOf(i) === "out" ? null : qtyOf(i));

  const row = (i) => {
    const st = stateOf(i);
    const q = st === "out" ? 0 : qtyOf(i);
    return `<div class="inv-row s-${st}" data-id="${i.id}">
      <button class="inv-what" data-qty aria-label="Cambiar cuánto hay de ${esc(i.name)}">
        <span class="nm">${esc(i.name)}</span>
        <span class="amt">${st === "out" ? "No hay" : esc(fmtAmount(q, unitOf(i)))} ${icon("pencil", 16)}</span>
      </button>
      <div class="inv-seg" role="radiogroup" aria-label="¿Cómo está ${esc(i.name)}?">
        ${INV_STATES.map(([s, label, ic]) => `
          <button class="st-${s} ${st === s ? "on" : ""}" role="radio" aria-checked="${st === s}" data-st="${s}">${icon(ic, 20)}<span>${label}</span></button>`).join("")}
      </div>
    </div>`;
  };

  const draw = () => {
    const n = changes.size;
    const toList = [...changes.values()].filter((c) => c.state !== "ok").length;
    app.innerHTML = `${head(esc(g.label), "Volver a los grupos")}
      <p class="inv-help">Toquen <b>Hay</b>, <b>Poco</b> o <b>Se acabó</b>. Lo que quede poco o se acabe pasa a la lista de compras.
        Toquen el nombre para corregir cuánto hay.</p>
      ${g.items.length ? `<div class="sheet inv-sheet">${g.items.map(row).join("")}</div>`
        : `<div class="state-block">${icon(g.icon, 48)}<h2>No hay nada anotado aquí</h2><p>Si tienen algo de ${esc(g.label.toLowerCase())}, agréguenlo.</p></div>`}
      <button class="inv-add" id="add">${icon("plus", 24)} Agregar algo que no está en la lista</button>
      <div class="bottom-bar">
        <button class="primary big" id="save">${icon("check")} ${g.items.length ? `Listo con ${esc(g.label.toLowerCase())}` : "Listo"}</button>
        ${n ? `<span class="inv-count">${plural(n, "cambio", "cambios")}${toList ? ` · ${toList} a la lista de compras` : ""}</span>` : ""}
      </div>`;
    bindBack(() => leave());
    const itemOf = (el) => g.items.find((x) => x.id === +el.closest("[data-id]").dataset.id);
    $$("[data-st]", app).forEach((b) => b.onclick = () => safe(async () => {
      const i = itemOf(b);
      const s = b.dataset.st;
      // Si estaba acabado y ahora hay, hay que saber cuánto.
      if (s !== "out" && qtyOf(i) <= 0) {
        const a = await ask(i);
        if (!a) return;
        setChange(i, { state: s, ...a });
      } else {
        setChange(i, { state: s });
      }
      draw();
    }));
    $$("[data-qty]", app).forEach((b) => b.onclick = () => safe(async () => {
      const i = itemOf(b);
      const a = await ask(i);
      if (!a) return;
      setChange(i, { ...a, state: a.quantity <= 0 ? "out" : stateOf(i) === "out" ? "ok" : stateOf(i) });
      draw();
    }));
    $("#add").onclick = () => safe(async () => {
      if (await addToGroup(g)) {
        const fresh = await api("/api/inventory");
        g.items = fresh.groups.find((x) => x.key === key).items;
        draw();
      }
    });
    $("#save").onclick = (e) => safe(() => save(e.currentTarget));
  };

  const save = async (btn) => {
    const items = [...changes].map(([id, c]) => ({ id, state: c.state, quantity: c.quantity, unit: c.unit }));
    const res = await withBusy(btn, () => api(`/api/inventory/${key}/review`, { method: "POST", json: { items } }));
    if (!res) return;
    toast(res.to_list.length
      ? `${g.label} al día. A la lista: ${res.to_list.join(", ")}`
      : `${g.label} al día`, 3600);
    go("inventory");
  };

  // Volver sin tocar «Listo»: si marcaron algo, se guarda igual (nada se pierde).
  const leave = () => safe(async () => {
    if (changes.size) await save($("#save"));
    else go("inventory");
  });

  draw();
}

function askQty(item, start) {
  const m = modal({
    title: esc(item.name), size: "narrow",
    body: amountForm(item.unit, start, { withUnit: item.unit === PORTION, preferPortions: prefersPortions() }),
    actions: [
      { label: "Cancelar", value: null },
      { label: "Listo", tone: "primary", icon: "check", onClick: (dlg) => readAmountForm(dlg, item.unit) },
    ],
  });
  bindAmountForm(m.el, item.unit);
  return m.done.then((v) => (v && typeof v === "object" ? v : null));
}

// Algo que tienen y no estaba anotado: nombre, cuánto y (si el grupo junta varias) de qué tipo.
function addToGroup(g) {
  const cats = g.categories;
  const m = modal({
    title: `Agregar a ${esc(g.label.toLowerCase())}`,
    body: `<form id="invf" class="inv-form">
      <label class="field">¿Qué es?<input name="name" placeholder="Ej: ${esc({ proteinas: "Pechuga de pollo", lacteos: "Yogur", verduras: "Tomate",
        frutas: "Banano", granos: "Arroz", panaderia: "Pan tajado", despensa: "Atún", congelados: "Arvejas", bebidas: "Jugo",
        aseo: "Jabón de loza" }[g.key] ?? "Algo")}" autocomplete="off" required></label>
      <div class="field">¿Cuánto hay?${amountForm(null, null, { withUnit: true, preferPortions: prefersPortions() })}</div>
      ${cats.length > 1 ? `<div class="field">¿De qué tipo?<div class="inv-kinds">${cats.map((c, n) => `
        <label><input type="radio" name="category" value="${esc(c)}" ${n === 0 ? "checked" : ""}><span>${esc(cap(c))}</span></label>`).join("")}</div></div>` : ""}
    </form>`,
    actions: [
      { label: "Cancelar", value: false },
      {
        label: "Agregar", tone: "primary", icon: "plus",
        onClick: async (dlg) => {
          const f = $("#invf", dlg);
          const name = f.name.value.trim();
          if (!name) { f.name.focus(); return false; }
          const amount = readAmountForm(dlg, null);
          await api("/api/pantry", { method: "POST", json: {
            name, ...amount, category: f.category?.value ?? cats[0], replace: true,
          } });
          toast(`Agregado: ${cap(name)}`);
          return true;
        },
      },
    ],
    onOpen: (dlg) => $("[name=name]", dlg).focus(),
  });
  bindAmountForm(m.el, null);
  $("#invf", m.el).onsubmit = (e) => { e.preventDefault(); $("[data-m-act='1']", m.el).click(); };
  return m.done.then((v) => v === true);
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
  $("#scan")?.addEventListener("click", () => { saveCart(new Set()); startScan("receipt"); });
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

async function renderCook({ recipeId, servings, kids, entryId = null, back = null, step = 0 }) {
  // servings = adultos; kids = niños (comen menos: «Un niño come…» en Ajustes)
  if (servings == null) ({ adults: servings, kids } = house());
  kids = kids ?? 0;
  const r = await api(`/api/recipes/${recipeId}?servings=${servings}&kids=${kids}`);
  const status = Object.fromEntries(r.availability.items.map((i) => [i.ingredient_id, i.status]));
  const steps = r.instructions.split("\n").map((s) => s.replace(/^\s*\d+[.)-]\s*/, "").trim()).filter(Boolean);
  const params = { recipeId, entryId, back };
  const wasHandsFree = Boolean(handsFree?.active);
  COOK = { recipeId, servings, kids, steps, idx: Math.min(step, Math.max(steps.length - 1, 0)), name: r.name };
  app.innerHTML = `${head(esc(r.name), "Volver",
      VOICE_SUPPORTED ? `<button class="handsfree ${wasHandsFree ? "on" : ""}" id="hf" aria-pressed="${wasHandsFree}">${icon("mic", 22)}<span>Manos libres</span></button>` : "")}
    <p class="hf-hint" id="hf-hint" ${wasHandsFree ? "" : "hidden"}>Escuchando. Digan «<b>siguiente</b>», «<b>repite</b>» o «<b>¿cuánta sal lleva?</b>»</p>
    <div class="servings">Para
      <span class="who"><button data-who="adults" data-d="-1" aria-label="Menos adultos">${icon("minus", 26)}</button><strong>${servings}</strong>
        <button data-who="adults" data-d="1" aria-label="Más adultos">${icon("plus", 26)}</button> adulto${servings === 1 ? "" : "s"}</span>
      <span class="who"><button data-who="kids" data-d="-1" aria-label="Menos niños">${icon("minus", 26)}</button><strong>${kids}</strong>
        <button data-who="kids" data-d="1" aria-label="Más niños">${icon("plus", 26)}</button> niño${kids === 1 ? "" : "s"}</span>
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
  $$("[data-who]", app).forEach((b) => b.onclick = () => {
    const next = { servings, kids };
    const k = b.dataset.who === "adults" ? "servings" : "kids";
    next[k] = Math.max(0, next[k] + +b.dataset.d);
    if (next.servings + next.kids < 1) return;
    go("cook", { ...params, ...next, step: COOK.idx });
  });
  $("#prev")?.addEventListener("click", () => showStep(COOK.idx - 1, false));
  $("#next")?.addEventListener("click", () => showStep(COOK.idx + 1, false));
  $$("[data-step]", app).forEach((li) => li.onclick = () => showStep(+li.dataset.step, false));
  $("#hf")?.addEventListener("click", () => toggleHandsFree());
  if (wasHandsFree) setHandsFreeUI(true);
  $("#done").onclick = (ev) => finishCooking(ev.currentTarget, r, { recipeId, entryId, servings, kids });
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

async function finishCooking(btn, r, { recipeId, entryId, servings, kids }) {
  await safe(async () => {
    const ok = await confirmModal({
      title: "¿Terminaron de cocinar?",
      text: `Se descuenta de la casa lo que usa «${esc(r.name)}» para ${peopleText(servings, kids)}.`,
      ok: "Sí, terminé",
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      if (entryId) {
        await api(`/api/menu/${entryId}`, { method: "PATCH", json: { servings, kids } });
        await api(`/api/menu/${entryId}/cook`, { method: "POST" });
      } else {
        await api(`/api/recipes/${recipeId}/cook`, { method: "POST", json: { servings, kids } });
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
// (botón Hablar, manos libres) y vuelve sola. Se activa por aparato en Ajustes → Casa y tareas.

const WAKE_KEY = "mychef-wake";
const wake = { listener: null, ui: null, armTimer: null, holds: new Set(), busy: false };

function wakeEnabled() {
  try { return localStorage.getItem(WAKE_KEY) === "1"; } catch { return false; }
}
function wakeWord() { return META?.wake_word || "Oye casa"; }

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
  const context = { screen, handsfree: hf, ...(COOK ? { recipe_id: COOK.recipeId, servings: COOK.servings, kids: COOK.kids } : {}) };
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
    if (nav.screen === "receipt") startScan("receipt");
    else if (nav.screen === "fridge") startScan(nav.place || "nevera");
    else if (nav.screen === "agenda") go("agenda");
    else if (nav.screen === "photos") photosModal();
    else if (nav.screen === "cook") go("cook", { recipeId: nav.recipeId });
    else if (nav.screen === "what") go("what", nav.meal ? { meal: nav.meal } : {});
    else go(nav.screen);
  } else if (screen === "home" && ["ran_out", "list_add", "chore_done", "agenda_add"].includes(res.intent)) {
    safe(renderHome);
  } else if (screen === "agenda" && res.intent === "agenda_add") {
    go("agenda");
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
  setHouse(META);
  await loadPhotos();
  await home();
  resetIdle();
  startWake();
  setTimeout(checkReminders, 5000);
  setInterval(checkReminders, 60 * 1000);
  // Llegaron desde el código QR de la tablet: abrir directo la foto.
  const q = new URLSearchParams(location.search);
  const kind = q.get("scan");
  if (kind && SCAN_WHAT[kind]) {
    const remote = q.get("s");
    history.replaceState(null, "", "/");
    if (remote) api(`/api/scan-sessions/${remote}/opened`, { method: "POST" }).catch(() => {});
    openScan(kind, remote);
  }
}
start();
