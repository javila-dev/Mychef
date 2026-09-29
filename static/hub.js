// Pantalla de la casa: lo de hoy de un vistazo y todo a un toque.
// Pensada para una tablet pegada en la nevera y para quien no se lleva bien con la tecnología:
// botones grandes, pocas palabras, confirmaciones y formularios en ventanas (modales),
// y si nadie la toca un rato, vuelve sola al inicio.

import {
  $, $$, addDays, amountForm, api, avatar, bindPeople, peoplePicker, readPeople, bindAmountForm, bindSchedule, cap, CHORE_ICONS, readSchedule, scheduleFields, choreIcon, compressImage, confirmModal, esc, fmtAmount, fmtMoney, house,
  icon, isoDate, kidPath, kidStar, modal, mondayOf, peopleText, PORTION, prizeArt, prizeForm, prizeRows, readAmountForm, safe, setHouse,
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
  inventory: renderInventory, invGroup: renderInvGroup, menu: renderMenu, kids: renderKids, stars: renderStars,
  sunday: renderSunday,
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

function micButton(extra = "", label = true) {
  return `<button class="mic ${extra}" data-mic aria-label="Hablar" title="Hablar">${icon("mic", 28)}${label ? "<span>Hablar</span>" : ""}</button>`;
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
  const wait = ["invGroup", "sunday"].includes(screen) ? 5 * IDLE_MS : IDLE_MS;
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
// «3:45» grande y «p. m.» pequeño al lado (hora de 12 horas, como se dice en Colombia).
function clock() {
  const d = new Date();
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}<span class="ampm">${d.getHours() < 12 ? "a. m." : "p. m."}</span>`;
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

// Una comida de hoy en una sola línea: ícono, plato y cómo estamos.
function mealRow(m) {
  const label = MEAL_LABEL[m.meal_type] ?? m.meal_type;
  const state = m.cooked ? `<span class="m-done">ya se cocinó</span>`
    : m.can_cook ? `<span class="m-ok" aria-label="Tenemos todo">${icon("check", 20)}</span>`
    : `<span class="m-miss" title="Falta: ${esc(m.missing.join(", "))}">${m.missing.length === 1 ? `falta ${esc(m.missing[0].toLowerCase())}` : `faltan ${m.missing.length}`}</span>`;
  return `<button class="meal-row ${m.cooked ? "done" : ""}" data-meal="${m.id}"
      aria-label="${esc(label)}: ${esc(m.recipe.name)}${m.cooked ? ", ya se cocinó" : m.can_cook ? ", tenemos todo" : `, falta ${esc(m.missing.join(", "))}`}">
    <span class="m-ic">${icon(MEAL_ICON[m.meal_type] ?? "plate", 20)}</span>
    <span class="m-txt"><span class="m-name">${esc(m.recipe.name)}</span></span>
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
  const planDay = [5, 6, 0].includes(new Date().getDay()); // del viernes al domingo se arma la semana que viene

  app.innerHTML = `
    <div class="home">
      <div class="left">
        <header class="time-block">
          <div class="clock-row"><div class="clock" id="clock">${clock()}</div>
            <div class="round-acts">${micButton("on-photo", false)}
              <button class="scan-pill" data-act="scan" aria-label="Escanear" title="Escanear">${icon("camera", 30)}</button>
              <button class="star-pill" data-act="kids" aria-label="Logros de los niños" title="Logros de los niños">${kidStar()}</button></div></div>
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
          <div class="w-body"><p class="empty-note">Toquen <b>Ajustes</b> (abajo a la derecha) para cargar sus recetas y las personas, <b>Tareas</b> para las tareas de la casa y <b>Fotos</b> para poner fotos de la familia.</p></div>
        </section>` : ""}

        <section class="widget mesa">
          <div class="w-head"><h2 class="w-title">${icon("plate", 22)} Hoy en la mesa</h2>
            ${t.setup.recipes ? headLink("menu", "Semana") : ""}</div>
          <div class="w-body">${t.meals.length ? t.meals.map(mealRow).join("")
          : t.setup.recipes ? `<p class="empty-note">Todavía no hay menú para hoy.</p>`
          : `<p class="empty-note">Cuando carguen sus recetas, aquí aparece lo que se come hoy.</p>`}
          ${t.setup.recipes && (planDay || !t.meals.length) ? `<div class="w-more"><button class="primary" data-act="sunday">${icon("spark", 20)}
            ${planDay ? "Armar el menú de la semana que viene" : "Armar el menú de la semana"}</button></div>` : ""}</div>
        </section>

        ${t.agenda?.length ? `<section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("calendar", 22)} Próximos días</h2>${headLink("agenda", "Agenda")}</div>
          <div class="w-body">${t.agenda.map(homeEvent).join("")}</div>
        </section>` : ""}

        <section class="widget">
          <div class="w-head"><h2 class="w-title">${icon("broom", 22)} Pendientes de hoy
              ${t.chores.length ? `<small>${pending.length ? `${pending.length} por hacer` : "¡Todo al día!"}</small>` : ""}</h2>
            ${headLink("chores", "Todas")}</div>
          <div class="w-body">${shownChores.length ? shownChores.map(choreRow).join("")
            : `<p class="empty-note">${t.setup.chores ? "Nada pendiente por hoy." : "Aún no hay tareas. Toquen «Todas» para agregar la primera."}</p>`}</div>
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
    kids: () => go("stars"), scan: scanChooser, receipt: () => startScan("receipt"), shopping: () => go("shopping"), what: () => go("what"),
    ranout: ranOutModal, chores: () => go("chores"), photos: photosModal, agenda: () => go("agenda"),
    inventory: () => go("inventory"), menu: () => go("menu"), sunday: () => go("sunday", { start: wizWeek() }),
  };
  $$("[data-act]", app).forEach((b) => b.onclick = () => ACTS[b.dataset.act]());
  $$("[data-ev]", app).forEach((b) => b.onclick = () => {
    Object.assign(agendaView, { mode: "month", anchor: b.dataset.date, sel: b.dataset.date });
    go("agenda");
  });
  $$("[data-meal]", app).forEach((el) => el.onclick = () => {
    const m = t.meals.find((x) => x.id === +el.dataset.meal);
    go("cook", { recipeId: m.recipe.id, servings: m.servings, kids: m.kids, entryId: m.cooked ? null : m.id });
  });
  bindChores(t.chores, home);
}

setInterval(() => { const c = $("#clock"); if (c) c.innerHTML = clock(); }, 15000);
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
  const kidOf = c.done_today ? c.last_done_by : c.turn;
  const stars = kidOf?.kid ? starChip(c.stars) : "";
  const when = full ? `<small class="when">${icon("calendar", 16)} ${esc(c.when)}${c.remind_at ? ` · ${icon("speaker", 16)} lo recuerda a las ${esc(fmtHour(c.remind_at))}` : ""}</small>` : "";
  return `<div class="chore ${c.done_today ? "done" : ""}">
    <span class="emo">${choreIcon(c.emoji, 30)}</span>
    <span class="txt"><strong>${esc(c.name)}${stars}</strong><span>${who}${late}${next}</span>${when}</span>
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
    onOpen: (dlg, close) => $$("[data-m]", dlg).forEach((b) => b.onclick = () => {
      close();
      finishChore(chore, b.dataset.m ? +b.dataset.m : null, after);
    }),
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

// «Próximos días» en el inicio: dos renglones cortos por evento para que quepan varios.
// «Hoy · 3 pm · Kelly», «Mañana · Todo el día», «Jue 1 · 10:30 am».
function homeEvent(e) {
  const todayIso = isoDate(new Date());
  const d = new Date(`${e.date}T12:00`);
  const diff = Math.round((d - new Date(`${todayIso}T12:00`)) / 86400000);
  const day = diff === 0 ? "Hoy" : diff === 1 ? "Mañana"
    : `${cap(d.toLocaleDateString("es", { weekday: "short" }).replace(".", ""))} ${d.getDate()}`;
  const when = e.time ? shortHour(e.time) : "Todo el día";
  const who = e.member && !e.title.toLowerCase().includes(e.member.name.toLowerCase()) ? ` · ${esc(e.member.name)}` : "";
  return `<button class="home-ev" data-ev="${e.id}" data-date="${e.date}" data-cat="${esc(e.category)}">
    <strong>${esc(e.title)}</strong>
    <span><b>${day}</b> · ${when}${who}</span>
  </button>`;
}

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

// La agenda se ve como un calendario: el mes (con el día elegido al lado), la semana o la lista
// de lo que viene. Se recuerda cómo la dejaron mientras la pantalla esté abierta.
const agendaView = { mode: "month", anchor: null, sel: null };
const WEEKDAYS_SHORT = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function shortHour(t) {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}
const longDay = (iso) => cap(new Date(`${iso}T12:00`).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }));

// Cada evento en cada día que ocupa (un viaje de tres días sale en los tres).
function byDay(items, from, to) {
  const days = {};
  for (const e of items) {
    for (let d = new Date(`${e.date}T12:00`); isoDate(d) <= e.end_date; d = addDays(d, 1)) {
      const di = isoDate(d);
      if (di < from || di > to) continue;
      (days[di] ??= []).push({ ...e, cont: di !== e.date });
    }
  }
  // Primero lo de todo el día, luego por hora
  for (const list of Object.values(days)) list.sort((a, b) => (a.time ? 1 : 0) - (b.time ? 1 : 0) || (a.time ?? "").localeCompare(b.time ?? ""));
  return days;
}

function googleChip(g) {
  if (!g?.enabled) return "";
  const t = g.last_sync ? new Date(g.last_sync).getTime() : NaN;
  const mins = Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
  const when = mins == null ? "sin sincronizar" : mins < 1 ? "al día" : mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)} h`;
  return `<button class="g-chip ${g.error ? "bad" : ""}" id="g-sync" title="${esc(g.error ?? "Sincronizar ahora")}">
    ${icon(g.error ? "warn" : "undo", 18)}<span>${g.error ? "Google: no se pudo sincronizar" : `Google Calendar · ${when}`}</span></button>`;
}

async function renderAgenda() {
  const v = agendaView;
  const todayIso = isoDate(new Date());
  v.anchor ??= todayIso;
  v.sel ??= todayIso;
  const anchor = new Date(`${v.anchor}T12:00`);
  let from, to, title;
  if (v.mode === "month") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
    from = isoDate(mondayOf(first));
    to = isoDate(addDays(mondayOf(first), 41));
    title = cap(first.toLocaleDateString("es", { month: "long", year: "numeric" }));
  } else if (v.mode === "week") {
    const monday = mondayOf(anchor);
    from = isoDate(monday);
    to = isoDate(addDays(monday, 6));
    title = `${monday.getDate()} al ${addDays(monday, 6).toLocaleDateString("es", { day: "numeric", month: "long" })}`;
  }
  const [items, members, g] = await Promise.all([
    v.mode === "list" ? api("/api/events?days=60") : api(`/api/events?start=${from}&end=${to}`),
    api("/api/members"), api("/api/gcal").catch(() => null),
  ]);
  const days = v.mode === "list" ? {} : byDay(items, from, to);
  const current = v.mode === "month" ? v.anchor.slice(0, 7) === todayIso.slice(0, 7)
    : v.mode === "week" ? from <= todayIso && todayIso <= to : true;

  const chip = (e) => {
    const [, cls] = EVENT_CATS[e.category] ?? EVENT_CATS.otro;
    return e.time && !e.cont
      ? `<span class="cal-ev timed ${e.done ? "done" : ""}"><i class="${cls}"></i><b>${shortHour(e.time)}</b> ${esc(e.title)}</span>`
      : `<span class="cal-ev ${cls} ${e.done ? "done" : ""}">${esc(e.title)}</span>`;
  };
  // El día elegido, como una agenda: la hora a la izquierda, el color de la categoría y el título con todo el ancho.
  const hourParts = (t) => {
    const [h, m] = t.split(":").map(Number);
    return [`${h % 12 || 12}:${String(m).padStart(2, "0")}`, h < 12 ? "a. m." : "p. m."];
  };
  const dayItem = (e) => {
    const [h, ampm] = e.time && !e.cont ? hourParts(e.time) : [];
    const meta = [
      e.cont ? `Sigue desde el ${new Date(`${e.date}T12:00`).toLocaleDateString("es", { day: "numeric", month: "long" })}` : "",
      e.end_time && e.time && !e.cont ? `Hasta las ${hourParts(e.end_time).join(" ")}` : "",
      e.end_day && !e.cont ? `Hasta el ${new Date(`${e.end_day}T12:00`).toLocaleDateString("es", { day: "numeric", month: "long" })}` : "",
      e.member && !e.title.toLowerCase().includes(e.member.name.toLowerCase()) ? `${avatar(e.member, 20)} ${esc(e.member.name)}` : "",
      e.repeat !== "none" ? REPEAT_TEXT[e.repeat] : "",
    ].filter(Boolean);
    return `<div class="day-ev ${e.done ? "done" : ""}" data-cat="${esc(e.category)}">
      <span class="de-time">${h ? `<b>${h}</b><small>${ampm}</small>` : `<small>${e.cont ? "Sigue" : "Todo el día"}</small>`}
        ${e.repeat === "none" && !e.cont && !e.done ? `<button class="de-tick" data-done="${e.id}" aria-label="Listo: ${esc(e.title)}">${icon("check", 18)}</button>` : ""}</span>
      <button class="de-body" data-ev="${e.id}" data-date="${e.date}">
        <strong>${esc(e.title)}</strong>
        ${meta.length ? `<span class="de-meta">${meta.map((x) => `<span>${x}</span>`).join("")}</span>` : ""}
      </button>
    </div>`;
  };
  const dayList = (di) => (days[di] ?? []).map(dayItem).join("") || `<p class="empty-note">Nada anotado.</p>`;

  let body;
  if (v.mode === "month") {
    const month = anchor.getMonth();
    // Seis semanas, salvo que la última sea toda del mes siguiente
    const weeks = addDays(new Date(`${from}T12:00`), 35).getMonth() === month ? 6 : 5;
    const cells = [...Array(weeks * 7)].map((_, n) => {
      const d = addDays(new Date(`${from}T12:00`), n);
      const di = isoDate(d);
      const list = days[di] ?? [];
      return `<button class="cal-cell ${d.getMonth() !== month ? "out" : ""} ${di === todayIso ? "today" : ""} ${di === v.sel ? "sel" : ""} ${di < todayIso ? "past" : ""}"
          data-day="${di}" aria-label="${esc(longDay(di))}${list.length ? `, ${list.length} en la agenda` : ""}">
        <span class="cal-num">${d.getDate()}</span>
        ${list.slice(0, 3).map(chip).join("")}
        ${list.length > 3 ? `<span class="cal-more">+${list.length - 3} más</span>` : ""}
        ${list.length ? `<span class="cal-dots">${list.slice(0, 4).map((e) => `<i class="${(EVENT_CATS[e.category] ?? EVENT_CATS.otro)[1]}"></i>`).join("")}</span>` : ""}
      </button>`;
    }).join("");
    const selDate = new Date(`${v.sel}T12:00`);
    const selName = cap(selDate.toLocaleDateString("es", { weekday: "long" }));
    const selRest = selDate.toLocaleDateString("es", { day: "numeric", month: "long" });
    body = `<div class="cal-wrap">
      <div class="cal-month" id="cal-grid" style="--weeks:${weeks}">
        ${WEEKDAYS_SHORT.map((w) => `<span class="cal-wd">${w}</span>`).join("")}${cells}
      </div>
      <section class="sheet cal-side">
        <div class="cal-side-head"><h2>${v.sel === todayIso ? "Hoy" : esc(selName)} <small>${esc(v.sel === todayIso ? longDay(v.sel) : selRest)}</small></h2>
          <button class="round" data-add-day="${v.sel}" aria-label="Agregar este día">${icon("plus", 24)}</button></div>
        ${dayList(v.sel)}
      </section></div>`;
  } else if (v.mode === "week") {
    body = `<div class="cal-week">${[...Array(7)].map((_, n) => {
      const di = isoDate(addDays(new Date(`${from}T12:00`), n));
      const d = new Date(`${di}T12:00`);
      return `<section class="cal-col ${di === todayIso ? "today" : ""} ${di < todayIso ? "past" : ""}">
        <div class="cal-col-head"><h2>${esc(cap(d.toLocaleDateString("es", { weekday: "short" }).replace(".", "")))} <span class="cal-num">${d.getDate()}</span></h2>
          <button class="round" data-add-day="${di}" aria-label="Agregar el ${esc(longDay(di))}">${icon("plus", 20)}</button></div>
        ${(days[di] ?? []).map((e) => `<button class="cal-card ${(EVENT_CATS[e.category] ?? EVENT_CATS.otro)[1]} ${e.done ? "done" : ""}" data-ev="${e.id}" data-date="${e.date}">
            <small>${e.cont ? "Sigue" : e.time ? esc(e.time_text) : "Todo el día"}</small>
            <strong>${esc(e.title)}</strong>
            ${e.member ? `<span>${avatar(e.member, 20)} ${esc(e.member.name)}</span>` : ""}
          </button>`).join("")}
      </section>`;
    }).join("")}</div>`;
  } else {
    const groups = [];
    for (const e of items) {
      const last = groups.at(-1);
      if (last && last.date === e.date) last.items.push(e); else groups.push({ date: e.date, label: e.day_text, items: [e] });
    }
    body = groups.length ? groups.map((gr) => `
      <section class="sheet ev-day">
        <h2>${esc(cap(gr.label))}${/^(hoy|mañana|pasado)/.test(gr.label) ? ` <small>${esc(longDay(gr.date))}</small>` : ""}</h2>
        ${gr.items.map((e) => `<div class="ev-line">${eventRow(e)}
          ${e.repeat === "none" ? `<button class="tick-round" data-done="${e.id}" aria-label="Ya pasó / listo">${icon("check", 26)}</button>` : ""}</div>`).join("")}
      </section>`).join("")
      : `<section class="sheet"><p class="empty-note">No hay nada en la agenda para los próximos dos meses.<br>
          Toquen <b>Agregar</b> o digan «Oye casa, recuérdame la cita de Benja el jueves a las 3».</p></section>`;
  }

  const seg = (mode, label) => `<button class="${v.mode === mode ? "on" : ""}" data-mode="${mode}" aria-pressed="${v.mode === mode}">${label}</button>`;
  app.innerHTML = `${head("Agenda de la familia", "Volver al inicio",
      `<button class="primary" id="add-ev">${icon("plus", 22)} Agregar</button>`)}
    <div class="menu-bar cal-bar">
      <div class="week-nav">${v.mode === "list" ? `<strong>Los próximos dos meses</strong>` : `
        <button class="round" id="prev" aria-label="${v.mode === "month" ? "Mes anterior" : "Semana anterior"}">${icon("back", 24)}</button>
        <strong>${esc(title)}</strong>
        <button class="round" id="next" aria-label="${v.mode === "month" ? "Mes siguiente" : "Semana siguiente"}">${icon("chevron", 24)}</button>
        ${current ? "" : `<button id="now">${icon("undo", 18)} Hoy</button>`}`}
      </div>
      <div class="cal-tools">${googleChip(g)}
        <div class="cal-seg" role="group" aria-label="Cómo ver la agenda">${seg("month", "Mes")}${seg("week", "Semana")}${seg("list", "Lista")}</div></div>
    </div>
    ${body}`;

  bindBack();
  const again = () => go("agenda");
  const move = (n) => {
    const d = v.mode === "month" ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1, 12) : addDays(anchor, 7 * n);
    v.anchor = isoDate(d);
    if (v.mode === "month") v.sel = v.anchor.slice(0, 7) === todayIso.slice(0, 7) ? todayIso : v.anchor;
    again();
  };
  $("#prev")?.addEventListener("click", () => move(-1));
  $("#next")?.addEventListener("click", () => move(1));
  $("#now")?.addEventListener("click", () => { v.anchor = v.sel = todayIso; again(); });
  $$("[data-mode]", app).forEach((b) => b.onclick = () => { v.mode = b.dataset.mode; v.anchor = v.sel; again(); });
  $$("[data-day]", app).forEach((b) => b.onclick = () => {
    v.sel = b.dataset.day;
    if (b.classList.contains("out")) v.anchor = v.sel; // un día del mes de al lado: se pasa a ese mes
    again();
  });
  const grid = $("#cal-grid");
  if (grid) { // deslizar el dedo para cambiar de mes
    let x0 = null;
    grid.addEventListener("pointerdown", (e) => { x0 = e.clientX; });
    grid.addEventListener("pointerup", (e) => {
      if (x0 != null && Math.abs(e.clientX - x0) > 80) move(e.clientX < x0 ? 1 : -1);
      x0 = null;
    });
  }
  $("#add-ev").onclick = () => eventModal(null, members, v.mode === "month" && v.sel >= todayIso ? v.sel : null);
  $$("[data-add-day]", app).forEach((b) => b.onclick = () => eventModal(null, members, b.dataset.addDay));
  $$("[data-ev]", app).forEach((b) => b.onclick = () => eventModal(items.find((e) => e.id === +b.dataset.ev && e.date === b.dataset.date), members));
  $$("[data-done]", app).forEach((b) => b.onclick = () => withBusy(b, async () => {
    const id = +b.dataset.done;
    await safe(() => api(`/api/events/${id}/done`, { method: "POST" }));
    toast("Listo");
    lastUndo = { steps: [{ method: "POST", url: `/api/events/${id}/undone` }], speak: "Listo, volvió a la agenda." };
    again();
  }));
  $("#g-sync")?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      const r = await api("/api/gcal/sync", { method: "POST" });
      toast(r.up + r.down ? "Al día con Google Calendar" : "Ya estaba al día");
    } catch (err) {
      toast(err.message);
    }
    again();
  }));
}

function eventModal(ev, members, day = null) {
  const e = ev ?? { title: "", category: "familia", member_id: null, first_day: day ?? isoDate(new Date()), time: null, repeat: "none", remind: [60], notes: "" };
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
        <label class="field">¿Hasta qué hora?<input name="end_time" type="time" value="${e.end_time ?? ""}"></label>
        <label class="field">¿Hasta qué día?<input name="end_day" type="date" value="${e.end_day ?? ""}"></label>
      </div>
      <small class="muted" style="margin-top:-.4rem">«Hasta» es opcional: solo si dura varias horas o varios días (un viaje, unas vacaciones).</small>
      ${e.single ? `<p class="muted small" style="margin:0">Es una sola vez de algo que se repite en Google Calendar: lo que cambien aquí cambia solo este día.</p>`
      : `<label class="field">¿Se repite?<select name="repeat">${Object.entries({ none: "No, una sola vez", weekly: "Cada semana", monthly: "Cada mes", yearly: "Cada año" })
        .map(([k, t]) => `<option value="${k}" ${k === e.repeat ? "selected" : ""}>${t}</option>`).join("")}</select></label>`}
      <div class="field">¿Cuándo avisar en voz alta?<div class="seg">${REMIND_OPTS.map(([v, t]) =>
        chip("remind", v, t, e.remind.includes(v), "checkbox")).join("")}</div>
        <small class="muted">Sin hora, «A la hora» avisa ese día a las 7:30 a. m. y «El día antes», la noche anterior.</small></div>
      <label class="field">Notas <small class="muted">(opcional)</small><textarea name="notes" rows="2" maxlength="300" placeholder="Ej: llevar el carné de vacunas">${esc(e.notes)}</textarea></label>
      ${e.google ? `<p class="muted small g-note">${icon("calendar", 16)} Está en el calendario de Google de la familia: los cambios se ven también en los celulares.</p>` : ""}
    </form>`,
    actions: [
      ...(ev ? [{ label: "Borrar", tone: "danger", icon: "trash", value: "delete" }] : []),
      { label: "Cancelar", value: false },
      { label: "Guardar", tone: "primary", icon: "check", onClick: async (dlg) => {
        const f = $("#evf", dlg);
        if (!f.reportValidity()) return false;
        if (f.end_day.value && f.end_day.value < f.day.value) {
          toast("El último día no puede ser antes del primero");
          return false;
        }
        const data = {
          title: f.title.value, category: f.querySelector("[name=category]:checked").value,
          member_id: +f.querySelector("[name=member]:checked").value || null,
          day: f.day.value, time: f.time.value || null, end_time: f.end_time.value || null, end_day: f.end_day.value || null,
          repeat: f.repeat?.value ?? "none", notes: f.notes.value,
          remind: $$("[name=remind]:checked", f).map((i) => +i.value),
        };
        const ok = await safe(() => api(ev ? `/api/events/${ev.id}` : "/api/events", { method: ev ? "PUT" : "POST", json: data }));
        if (!ok) return false;
        if (!ev) agendaView.anchor = agendaView.sel = data.day; // el calendario queda en el día que se anotó
        toast(ev ? "Guardado" : "Anotado en la agenda");
      } },
    ],
  });
  m.done.then(async (v) => {
    if (v === "delete") {
      if (!await confirmModal({ title: e.single ? "¿Borrar solo este día?" : "¿Borrar de la agenda?", text: esc(ev.title),
        ok: "Borrar", tone: "danger", okIcon: "trash" })) return;
      await safe(() => api(`/api/events/${ev.id}`, { method: "DELETE" }));
    }
    if (v) go("agenda");
  });
}

async function finishChore(chore, memberId, after) {
  const m = TODAY?.members.find((x) => x.id === memberId);
  // Si la hizo un niño se celebra en grande: se compara cómo iba antes y cómo quedó.
  const before = m?.kid ? await api(`/api/kids/${memberId}`).catch(() => null) : null;
  const ok = await safe(async () => {
    await api(`/api/chores/${chore.id}/done`, { method: "POST", json: { member_id: memberId } });
    if (!before) toast(m ? `¡Gracias, ${m.name}!` : "¡Gracias!");
    return true;
  });
  const now = ok && before ? await api(`/api/kids/${memberId}`).catch(() => null) : null;
  if (now) await celebrate(before, now, chore);
  after();
}

// Filtro de la lista de tareas: "all", "any" (cualquiera puede) o el id de una persona.
// Se recuerda mientras la pantalla esté abierta, también al marcar o cambiar una tarea.
let choreFilter = "all";

async function renderChores() {
  const [chores, members] = await Promise.all([api("/api/chores"), api("/api/members")]);
  TODAY = TODAY ?? await api("/api/today");
  const kids = members.some((m) => m.kid) ? await api("/api/kids") : [];
  // De una persona: las que tiene fijas y las de turnos cuando le toca a ella.
  const mine = (c, id) => c.member_id === id || (c.rotate && c.turn?.id === id);
  const anyone = (c) => !c.member_id && !c.rotate;
  if (choreFilter !== "all" && choreFilter !== "any" && !members.some((m) => m.id === choreFilter)) choreFilter = "all";
  const shown = chores.filter((c) => choreFilter === "all" ? true : choreFilter === "any" ? anyone(c) : mine(c, choreFilter));
  const chip = (value, label, n, face = "") => `
    <button class="who-chip ${choreFilter === value ? "on" : ""}" data-filter="${value}" aria-pressed="${choreFilter === value}">
      ${face}<span>${esc(label)}</span><span class="n">${n}</span></button>`;
  const anyCount = chores.filter(anyone).length;
  const person = members.find((m) => m.id === choreFilter);
  const kid = kids.find((k) => k.member.id === choreFilter);
  app.innerHTML = `${head("Tareas de la casa", "Volver al inicio",
      `<button class="kids-btn" data-kids aria-label="Logros de los niños"><i class="ks-24">${kidStar()}</i><span>Logros</span></button>`)}
    ${members.length && chores.length ? `<div class="who-chips" role="group" aria-label="Ver las tareas de">
      ${chip("all", "Todas", chores.length)}
      ${members.map((m) => chip(m.id, m.name, chores.filter((c) => mine(c, m.id)).length, avatar(m, 26))).join("")}
      ${anyCount ? chip("any", "Cualquiera", anyCount) : ""}
    </div>` : ""}
    ${kid ? `<button class="kid-banner" data-kids="${kid.member.id}">
      <span class="kb-star"><i class="ks-32">${kidStar()}</i><b>${kid.stars}</b></span>
      <span class="kb-txt"><strong>${kid.goal ? `Juntando para: ${esc(kid.goal.name)}` : `${esc(kid.member.name)} va en el nivel ${kid.level.number}`}</strong>
        <span>${kid.goal ? (kid.goal.ready ? "¡Ya le alcanza para el premio!" : `${kid.goal.stars - kid.stars === 1 ? "Le falta" : "Le faltan"} ${plural(kid.goal.stars - kid.stars, "estrella", "estrellas")}`) : "Toquen para ver sus logros"}</span></span>
      ${kid.goal ? `<span class="kb-prize" aria-hidden="true">${prizeArt(kid.goal, 30)}</span>` : ""}
      ${icon("chevron", 24)}</button>` : ""}
    <section class="sheet chores-sheet">${shown.map((c) => choreRow(c, true)).join("")
      || `<p class="empty-note">${!chores.length ? "Aún no hay tareas. Agreguen la primera: sacar la basura, regar las plantas…"
        : person ? `${esc(person.name)} no tiene tareas por ahora.` : "No hay tareas para cualquiera."}</p>`}</section>
    <div class="bottom-bar"><button class="primary big" id="add-chore">${icon("plus")} Agregar tarea</button></div>`;
  bindBack();
  $$("[data-filter]", app).forEach((b) => b.onclick = () => {
    choreFilter = ["all", "any"].includes(b.dataset.filter) ? b.dataset.filter : +b.dataset.filter;
    renderChores();
  });
  bindChores(shown, () => go("chores"));
  $$("[data-kids]", app).forEach((b) => b.onclick = () => go("kids", { id: b.dataset.kids ? +b.dataset.kids : null, back: "chores" }));
  $("#add-chore").onclick = () => choreForm();
  $$("[data-edit-chore]", app).forEach((b) => b.onclick = () => choreForm(chores.find((c) => c.id === +b.dataset.editChore)));
}

// Agregar o cambiar una tarea desde la tablet: qué es, su dibujo, a quién le toca y cuándo.
async function choreForm(chore = null) {
  const members = await safe(() => api("/api/members"));
  if (!members) return;
  const c = chore ?? { name: "", emoji: META.chore_emojis[0], member_id: null, rotate: false, stars: 1 };
  const starsField = members.some((x) => x.kid) ? `
      <div class="field">Estrellas que gana un niño o niña<div class="seg">${[[1, "Fácil"], [2, "Normal"], [3, "Grande"]].map(([n, t]) => `
        <label><input type="radio" name="stars" value="${n}" ${n === (c.stars ?? 1) ? "checked" : ""}><span class="stars-opt">${starRow(n, 18)} ${t}</span></label>`).join("")}</div></div>` : "";
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
      ${starsField}
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
            ...(f.stars ? { stars: +f.stars.value } : {}),
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

// ---------------------------------------------------------------- logros de los niños
// Economía de fichas: cada tarea da estrellas al momento; se juntan para un premio pactado con los papás
// (mejor experiencias que cosas). Nunca se quitan estrellas por no hacer algo: solo se suma.
// La tabla de la semana es como la de stickers de la nevera, y las insignias marcan los hitos.
// A los niños se les habla de «tú»; lo de adultos (premio, canjear) pide una cuenta rápida.

const PRAISE = ["¡Muy bien, {n}!", "¡Lo lograste, {n}!", "¡Qué gran ayuda, {n}!", "¡Excelente trabajo, {n}!", "¡Así se hace, {n}!"];
const BADGE_TINTS = ["honey", "sky", "lilac", "teal", "clay", "berry", "indigo", "wheat"];
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// «Te falta 1 estrella» / «Te faltan 3 estrellas»
const missing = (n) => `${n === 1 ? "Te falta" : "Te faltan"} ${plural(n, "estrella", "estrellas")}`;

function starChip(n) {
  return ` <span class="star-chip" aria-label="${plural(n, "estrella", "estrellas")}"><i class="ks-18">${kidStar()}</i>${n > 1 ? n : ""}</span>`;
}
function starRow(n, size = 18) {
  return `<span class="star-row" aria-hidden="true" style="--s:${size}px">${`<span>${kidStar()}</span>`.repeat(n)}</span>`;
}

// Lluvia de papelitos por encima de la ventana (va en su propia capa superior con popover).
function confetti() {
  if (reduceMotion()) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  const tints = ["var(--honey-fill)", "var(--green)", "var(--tint-sky-ink)", "var(--tint-lilac-ink)", "var(--tint-berry-ink)", "var(--tint-teal-ink)"];
  box.innerHTML = Array.from({ length: 70 }, (_, i) => {
    const x = Math.random() * 100, delay = Math.random() * 0.6, dur = 2.2 + Math.random() * 1.6;
    const drift = (Math.random() - 0.5) * 30, spin = 360 + Math.random() * 720;
    return `<i style="left:${x}vw;background:${tints[i % tints.length]};--drift:${drift}vw;--spin:${spin}deg;animation-delay:${delay}s;animation-duration:${dur}s;${i % 3 ? "" : "border-radius:50%;"}"></i>`;
  }).join("");
  box.setAttribute("popover", "manual");
  document.body.appendChild(box);
  try { box.showPopover(); } catch { /* sin popover: queda detrás de la ventana, igual se ve al cerrar */ }
  setTimeout(() => box.remove(), 4200);
}

// Tocar un premio del camino: la tablet le dice qué es y cuánto le falta (para los que aún no leen).
function bindPrizeVoice(root, kid) {
  $$("[data-say-prize]", root).forEach((b) => b.onclick = () => {
    const p = kid.prizes.find((x) => x.id === +b.dataset.sayPrize);
    if (!p) return;
    const left = p.stars - kid.stars;
    const name = kid.member.name;
    say(p.claimed ? `${name}, ese ya te lo ganaste: ${p.name}.`
      : left > 0 ? `${name}, con ${p.stars} estrellas te ganas: ${p.name}. Te ${left === 1 ? "falta una" : `faltan ${left}`}.`
        : `¡${name}, ya te ganaste: ${p.name}! Pídele a un adulto que te lo dé.`);
  });
}

// ¿A qué premio acaba de llegar? (estaba sin alcanzar antes de la tarea y ahora sí)
const justReached = (before, now) => now.prizes.find((p) => p.ready && !before.prizes.find((x) => x.id === p.id)?.reached);

async function celebrate(before, now, chore) {
  const name = now.member.name;
  const gained = Math.max(now.earned - before.earned, chore.stars ?? 1);
  const praise = PRAISE[Math.floor(Math.random() * PRAISE.length)].replace("{n}", name);
  const newBadges = now.badges.filter((b) => b.earned && !before.badges.find((x) => x.id === b.id)?.earned);
  const levelUp = now.level.number > before.level.number;
  const goal = now.goal;
  const reached = justReached(before, now);
  const allDone = now.chores.length > 0 && now.today_done === now.chores.length;
  const lines = [];
  if (now.prizes.length) {
    lines.push(`<div class="cel-goal">
      <strong>${reached ? `¡Llegaste a: ${esc(reached.name)}!` : goal?.ready ? `Ya puedes pedir: ${esc(goal.name)}` : goal ? `${missing(goal.stars - now.stars)} para: ${esc(goal.name)}` : ""}</strong>
      ${kidPath(now, { from: before.stars })}</div>`);
  }
  newBadges.forEach((b, i) => lines.push(`<div class="cel-badge tint-${BADGE_TINTS[now.badges.indexOf(b) % BADGE_TINTS.length]}" style="--d:${0.6 + i * 0.3}s">
    <span class="b-ic">${icon(b.icon, 30)}</span><div><small>¡Nueva insignia!</small><strong>${esc(b.name)}</strong></div></div>`));
  if (levelUp) lines.push(`<p class="cel-level">${icon("medal", 22)} Subiste al nivel ${now.level.number}: <b>${esc(now.level.name)}</b></p>`);
  if (allDone) lines.push(`<p class="cel-all">${icon("check", 22)} ¡Terminaste todas tus tareas de hoy!</p>`);

  chime();
  const m = modal({
    size: "narrow", title: "",
    body: `<div class="celebrate">
      <div class="cel-star">${kidStar()}<span class="plus">+${gained}</span></div>
      <h2>${esc(praise)}</h2>
      <p class="muted">${esc(chore.name)} · ahora tienes <b>${plural(now.stars, "estrella", "estrellas")}</b></p>
      ${lines.join("")}
    </div>`,
    actions: [{ label: "¡Genial!", tone: "primary" }],
  });
  confetti();
  bindPrizeVoice(m.el, now);
  const left = goal ? goal.stars - now.stars : 0;
  const extra = reached ? ` ¡Llegaste a ${reached.name}!` : goal && left > 0 && left <= 3 ? ` Te ${left === 1 ? "falta una estrella" : `faltan ${left} estrellas`} para ${goal.name}.` : newBadges.length ? ` Ganaste la insignia ${newBadges[0].name}.` : allDone ? " Terminaste todas tus tareas de hoy." : "";
  setTimeout(() => say(`${praise} Ganaste ${gained === 1 ? "una estrella" : `${gained} estrellas`}.${extra}`), 500);
  const t = setTimeout(() => m.close(), 9000);
  await m.done;
  clearTimeout(t);
  stopSpeaking();
}

// Lo de adultos (poner el premio, canjearlo, elegir quiénes son niños) pide una cuenta rápida.
function adultGate() {
  const a = 6 + Math.floor(Math.random() * 4), b = 6 + Math.floor(Math.random() * 4), ok = a * b;
  const opts = [...new Set([ok, ok + a, ok - b, ok + 1 + Math.floor(Math.random() * 3)])].sort(() => Math.random() - 0.5);
  return modal({
    size: "narrow", title: "Esto lo hace un adulto",
    body: `<p class="m-text">Para seguir, ¿cuánto es <b>${a} × ${b}</b>?</p>
      <div class="gate-opts">${opts.map((n) => `<button data-n="${n}">${n}</button>`).join("")}</div>`,
    onOpen: (dlg, close) => $$("[data-n]", dlg).forEach((btn) => btn.onclick = () => {
      if (+btn.dataset.n === ok) return close(true);
      toast("Esa no es. Pídele ayuda a un adulto.");
      close(false);
    }),
  }).done.then((v) => v === true);
}

let kidSel = null;
let kidsBack = "chores";

async function renderKids(params = {}) {
  if (params.back) kidsBack = params.back;
  const kids = await api("/api/kids");
  TODAY = TODAY ?? await api("/api/today");
  const back = () => go(kidsBack);
  const title = head("Logros", { chores: "Volver a las tareas", stars: "Volver a las estrellas" }[kidsBack] ?? "Volver al inicio",
    `<button class="kids-btn plain" data-kids-setup aria-label="Ajustes de logros">${icon("sliders", 24)}</button>`);
  if (!kids.length) {
    app.innerHTML = `${title}
      <section class="state-block kids-empty"><span class="empty-star">${kidStar()}</span>
        <h2>Estrellas para los niños</h2>
        <p>Cada tarea que hagan les da estrellas. Las juntan para un premio que acuerdan con ustedes,
          ganan insignias y ven su semana llena de estrellas.</p>
        <button class="primary big" data-kids-setup>${icon("people")} Elegir quiénes son niños</button></section>`;
    bindBack(back);
    $$("[data-kids-setup]", app).forEach((b) => b.onclick = kidsSetup);
    return;
  }
  if (params.id) kidSel = params.id;
  const k = kids.find((x) => x.member.id === kidSel) ?? kids[0];
  kidSel = k.member.id;
  const lv = k.level;
  const toNext = lv.next != null ? lv.next - k.earned : 0;
  const earnedBadges = k.badges.filter((b) => b.earned).length;
  const WEEK = ["L", "M", "X", "J", "V", "S", "D"];
  const claim = k.claims[0];

  app.innerHTML = `${title}
    ${kids.length > 1 ? `<div class="who-chips" role="group" aria-label="Ver los logros de">${kids.map((x) => `
      <button class="who-chip ${x.member.id === kidSel ? "on" : ""}" data-kid="${x.member.id}" aria-pressed="${x.member.id === kidSel}">
        ${avatar(x.member, 26)}<span>${esc(x.member.name)}</span><span class="n"><i class="ks-18">${kidStar()}</i> ${x.stars}</span></button>`).join("")}</div>` : ""}
    <div class="kid-grid">
      <section class="panel prize-panel ${k.goal?.ready ? "ready" : ""}">
        ${k.prizes.length ? `
          <div class="prize-head">
            <div><small>El camino de premios de ${esc(k.member.name)}</small>
              <strong>${k.goal ? (k.goal.ready ? `¡Llegó a: ${esc(k.goal.name)}!` : `Próximo: ${esc(k.goal.name)}`) : "¡Camino completo!"}</strong></div>
            <button class="edit-round" data-goal aria-label="Cambiar los premios">${icon("pencil", 20)}</button></div>
          ${kidPath(k)}
          <div class="prize-foot">
            <p class="goal-note">${k.goal?.ready ? "¡Ya te lo ganaste! Pídele a un adulto que te lo dé." : k.goal ? `<b>${missing(k.goal.stars - k.stars)}</b> · toca un premio para escucharlo` : ""}</p>
            ${k.goal?.ready ? `<button class="primary big claim-btn" data-claim>${icon("gift")} Entregar premio</button>` : ""}
          </div>`
        : `<div class="prize-empty">${icon("gift", 56)}
            <div><strong>Todavía no hay premios</strong>
              <p class="goal-note">Pongan premios en el camino de ${esc(k.member.name)}: a las 10 estrellas un helado, a las 15 el parque…</p></div>
            <button class="primary big" data-goal>${icon("plus")} Poner premios</button></div>`}
        ${claim ? `<p class="small muted last-claim">Último premio: ${esc(claim.name)} · ${fmtShortDay(claim.day)}
          <button class="link-btn" data-unclaim>Deshacer</button></p>` : ""}
      </section>
      <section class="panel kid-hero">
        <div class="kid-id">${avatar(k.member, 64)}
          <div><h2>${esc(k.member.name)}</h2>
            <span class="lvl">${icon("medal", 18)} Nivel ${lv.number} · ${esc(lv.name)}</span></div></div>
        <div class="kid-stars">
          <span class="big-star">${kidStar()}</span>
          <div><strong>${k.stars}</strong><span>${k.stars === 1 ? "estrella" : "estrellas"}</span></div>
        </div>
        ${lv.next != null ? `<div class="lvl-bar" role="progressbar" aria-valuemin="${lv.from}" aria-valuemax="${lv.next}" aria-valuenow="${k.earned}" aria-label="Camino al nivel ${lv.number + 1}">
            <span style="--to:${((k.earned - lv.from) / (lv.next - lv.from)) * 100}%"></span></div>
          <p class="small muted">${plural(toNext, "estrella más", "estrellas más")} y llegas a <b>${esc(lv.next_name)}</b></p>`
        : `<p class="small muted">¡Llegaste al nivel más alto!</p>`}
        <div class="streak ${k.streak ? "on" : ""}">${icon("flame", 30)}
          <div><strong>${k.streak ? `${plural(k.streak, "día", "días")} ayudando` : "Empieza tu racha hoy"}</strong>
          <small>${k.best_streak > 1 ? `Tu récord: ${k.best_streak} días. ` : ""}Un día de descanso no la rompe.</small></div></div>
      </section>

      <section class="panel kid-today">
        <h3>Tus tareas de hoy ${k.chores.length ? `<small>${k.today_done} de ${k.chores.length}</small>` : ""}</h3>
        ${k.chores.length ? k.chores.map((c) => `
          <button class="kid-task ${c.done_today ? "done" : ""}" data-task="${c.id}"
              aria-label="${esc(c.name)}, ${plural(c.stars, "estrella", "estrellas")}${c.done_today ? ", hecha. Toca para deshacer" : ". Toca cuando la termines"}">
            <span class="kt-ic">${choreIcon(c.emoji, 36)}</span>
            <span class="kt-name">${esc(c.name)}${c.days_late ? `<small>quedó pendiente de antes</small>` : ""}</span>
            <span class="kt-stars">${starRow(c.stars, 20)}</span>
            <span class="kt-check">${icon("check", 32)}</span>
          </button>`).join("")
        : `<p class="empty-note">Hoy no tienes tareas. ¡Día libre!</p>`}
        <h3>Tu semana</h3>
        <div class="week-stickers">${k.week.map((d, i) => `
          <div class="wd ${d.today ? "today" : ""} ${d.future ? "future" : ""} ${d.stars ? "got" : ""}">
            <span class="wd-name">${WEEK[i]}</span>
            <span class="sticker" aria-label="${d.stars ? plural(d.stars, "estrella", "estrellas") : "sin estrellas"}">${d.stars ? `${kidStar()}${d.stars > 1 ? `<b>${d.stars}</b>` : ""}` : ""}</span>
          </div>`).join("")}</div>
      </section>

      <section class="panel kid-badges">
        <h3>Insignias <small>${earnedBadges} de ${k.badges.length}</small></h3>
        <div class="badges">${k.badges.map((b, i) => `
          <div class="badge-card ${b.earned ? `earned tint-${BADGE_TINTS[i % BADGE_TINTS.length]}` : ""}">
            <span class="b-ic">${icon(b.earned ? b.icon : "lock", 30)}</span>
            <strong>${esc(b.name)}</strong>
            <small>${esc(b.text)}</small>
            ${b.earned ? "" : `<span class="b-prog" aria-label="${b.progress} de ${b.target}"><span style="--to:${(b.progress / b.target) * 100}%"></span></span>`}
          </div>`).join("")}</div>
      </section>
    </div>`;

  bindBack(back);
  const again = () => go("kids");
  $$("[data-kid]", app).forEach((b) => b.onclick = () => { kidSel = +b.dataset.kid; renderKids(); });
  $$("[data-kids-setup]", app).forEach((b) => b.onclick = kidsSetup);
  $$("[data-goal]", app).forEach((b) => b.onclick = async () => {
    if (!await adultGate()) return;
    await prizesModal(k);
    again();
  });
  bindPrizeVoice(app, k);
  $$("[data-task]", app).forEach((b) => b.onclick = () => safe(async () => {
    if (b.getAttribute("aria-busy") === "true") return;
    const c = k.chores.find((x) => x.id === +b.dataset.task);
    if (c.done_today) {
      const ok = await confirmModal({ title: "¿Deshacer?", text: `«${esc(c.name)}» vuelve a quedar pendiente y se quitan sus estrellas.`, ok: "Sí, deshacer", okIcon: "undo" });
      if (!ok) return;
      await withBusy(b, () => api(`/api/chores/${c.id}/undo`, { method: "POST" }));
      return again();
    }
    await withBusy(b, () => finishChore(c, k.member.id, again));
  }));
  const claimBtn = $("[data-claim]", app);
  if (claimBtn) claimBtn.onclick = async () => {
    if (!await adultGate()) return;
    const ok = await confirmModal({
      title: "¿Entregar el premio?", ok: "Sí, entregar", okIcon: "gift",
      text: `${esc(k.member.name)} llegó a «${esc(k.goal.name)}». Sus estrellas no bajan: el camino sigue.`,
    });
    if (!ok) return;
    const res = await safe(() => api(`/api/kids/${k.member.id}/claim`, { method: "POST" }));
    if (!res) return;
    chime();
    const m = modal({
      size: "narrow", title: "",
      body: `<div class="celebrate"><div class="cel-prize">${prizeArt(k.goal, 84)}</div>
        <h2>¡A disfrutar, ${esc(k.member.name)}!</h2>
        <p class="muted">Te ganaste: <b>${esc(k.goal.name)}</b>.
          ${res.stars < k.stars ? "¡Completaste todo el camino! Empieza otra vuelta." : res.goal ? `Ahora vas por: <b>${esc(res.goal.name)}</b>.` : ""}</p></div>`,
      actions: [{ label: "¡Gracias!", tone: "primary", icon: "heart" }],
    });
    confetti();
    setTimeout(() => say(`¡A disfrutar, ${k.member.name}! Te ganaste ${k.goal.name}.`), 400);
    await m.done;
    again();
  };
  const unclaim = $("[data-unclaim]", app);
  if (unclaim) unclaim.onclick = async () => {
    if (!await adultGate()) return;
    const ok = await confirmModal({ title: "¿Deshacer el último premio?", text: `«${esc(claim.name)}» vuelve a quedar sin entregar.`, ok: "Sí, deshacer", okIcon: "undo" });
    if (!ok) return;
    await safe(() => api(`/api/kids/${k.member.id}/claim/undo`, { method: "POST" }));
    again();
  };
}

// ---------------------------------------------------------------- estrellas (la pantalla de los niños)
// Lo más simple posible, para los que aún no leen: su carita, una barra de estrellas y el premio al
// final, que crece y se encoge. Tocar el premio o la barra: la tablet dice cuánto falta.

async function renderStars() {
  const kids = await api("/api/kids");
  const face = kids.length === 1 && !isPhone() ? 96 : 72; // un solo niño en la tablet: en grande
  // Las tareas de hoy, para que entienda qué puede hacer y cuántas estrellas le da cada una:
  // el dibujo, las estrellas dibujadas, un botón de voz y el ✓ para marcarla cuando la termine.
  const task = (k, c) => `<div class="sb-task ${c.done_today ? "done" : ""}" data-kid="${k.member.id}" data-task="${c.id}">
      <button type="button" class="st-say" data-say-task aria-label="Escuchar: ${esc(c.name)}">${icon("speaker", 30)}</button>
      <span class="st-ic">${choreIcon(c.emoji, 56)}</span>
      <span class="st-name">${esc(c.name)}</span>
      <span class="st-stars" aria-label="${plural(c.stars, "estrella", "estrellas")}">${`<i>${kidStar()}</i>`.repeat(c.stars)}</span>
      <button type="button" class="st-done" data-done-task aria-label="${c.done_today ? `${esc(c.name)}: hecha. Tocar para deshacer` : `Ya terminé: ${esc(c.name)}`}">${icon("check", 40)}</button>
    </div>`;
  const row = (k) => `<section class="sb-row ${k.goal?.ready ? "ready" : ""}" data-kid="${k.member.id}">
      <span class="sb-face">${avatar(k.member, face)}</span>
      ${k.prizes.length ? kidPath(k) : `<button type="button" class="sb-track" data-say="${k.member.id}" aria-label="${esc(k.member.name)}: ${k.stars} estrellas">
        <div class="sb-empty"><span>${kidStar()}</span><b>${k.stars}</b></div></button>`}
    </section>
    <section class="sb-tasks" aria-label="Tareas de hoy de ${esc(k.member.name)}">
      ${k.chores.length ? [...k.chores].sort((a, b) => a.done_today - b.done_today).map((c) => task(k, c)).join("")
        : `<button type="button" class="sb-free" data-say-free="${k.member.id}">${icon("sun", 44)}<span>Hoy no hay tareas. ¡Día libre!</span>${icon("speaker", 26)}</button>`}
    </section>`;
  app.innerHTML = `${head("Estrellas", "Volver al inicio",
      kids.length ? `<button class="kids-btn" data-more aria-label="Más logros">${icon("medal", 24)}<span>Más logros</span></button>` : "")}
    ${kids.length ? `<div class="sb-list ${kids.length === 1 ? "solo" : ""}">${kids.map(row).join("")}</div>
      ${kids.some((k) => !k.prizes.length) ? `<p class="sb-hint">Para ver los premios en el camino, pónganlos en <b>Ajustes → Premios</b>.</p>` : ""}`
    : `<section class="state-block"><span class="empty-star">${kidStar()}</span><h2>Estrellas para los niños</h2>
        <p>Marquen quiénes son niños y pónganles un premio en <b>Ajustes → Premios</b>.</p></section>`}
`;
  bindBack();
  kids.forEach((k) => bindPrizeVoice($(`.sb-row[data-kid="${k.member.id}"]`, app), k));
  $$("[data-say]", app).forEach((b) => b.onclick = () => {
    const k = kids.find((x) => x.member.id === +b.dataset.say);
    say(`${k.member.name}, tienes ${k.stars === 1 ? "una estrella" : `${k.stars} estrellas`}.`);
  });
  const find = (el) => {
    const k = kids.find((x) => x.member.id === +el.closest("[data-kid]").dataset.kid);
    return [k, k.chores.find((c) => c.id === +el.closest("[data-task]").dataset.task)];
  };
  const low = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  const starsWord = (n) => (n === 1 ? "una estrella" : n === 2 ? "dos estrellas" : `${n} estrellas`);
  $$("[data-say-task]", app).forEach((b) => b.onclick = () => {
    const [k, c] = find(b);
    say(c.done_today ? `¡Muy bien, ${k.member.name}! Ya hiciste: ${low(c.name)}. Ganaste ${starsWord(c.stars)}.`
      : `${c.name}. Te da ${starsWord(c.stars)}. Cuando termines, toca el chulito verde.`);
  });
  $$("[data-say-free]", app).forEach((b) => b.onclick = () => {
    const k = kids.find((x) => x.member.id === +b.dataset.sayFree);
    say(`${k.member.name}, hoy no tienes tareas. ¡Día libre!`);
  });
  $$("[data-done-task]", app).forEach((b) => b.onclick = () => safe(async () => {
    if (b.getAttribute("aria-busy") === "true") return;
    const [k, c] = find(b);
    const again = () => go("stars");
    if (c.done_today) {
      const ok = await confirmModal({ title: "¿Deshacer?", text: `«${esc(c.name)}» vuelve a quedar pendiente y se quitan sus estrellas.`, ok: "Sí, deshacer", okIcon: "undo" });
      if (!ok) return;
      await withBusy(b, () => api(`/api/chores/${c.id}/undo`, { method: "POST" }));
      return again();
    }
    TODAY = TODAY ?? await api("/api/today");
    await withBusy(b, () => finishChore(c, k.member.id, again));
  }));
  $("[data-more]", app)?.addEventListener("click", () => go("kids", { back: "stars" }));
  if (kids.some((k) => k.goal?.ready)) setTimeout(confetti, 500);
}

// Los premios del camino de un niño: la lista, para cambiar uno o agregar otro. Devuelve al cerrar.
async function prizesModal(kid) {
  let k = kid;
  for (;;) {
    const draw = (dlg) => {
      $("#pz", dlg).innerHTML = k.prizes.length ? prizeRows(k) : `<p class="empty-note">Todavía no hay premios.</p>`;
      $$("[data-claim]", dlg).forEach((b) => b.remove()); // entregar se hace en Logros, frente al niño
      $$("[data-edit-prize]", dlg).forEach((b) => b.onclick = async () => {
        if (await prizeForm(k, META.prizes, k.prizes.find((p) => p.id === +b.dataset.editPrize))) {
          k = await api(`/api/kids/${k.member.id}`);
          draw(dlg);
        }
      });
    };
    const m = modal({
      title: `Premios de ${esc(k.member.name)}`, size: "wide",
      body: `<p class="m-text" style="margin-bottom:.8rem">Los premios van en el mismo camino de estrellas: al llegar a cada uno, se entrega y sigue al siguiente.</p><div id="pz"></div>`,
      actions: [
        { label: "Agregar premio", icon: "plus", value: "add" },
        { label: "Listo", tone: "primary", icon: "check" },
      ],
      onOpen: (dlg) => draw(dlg),
    });
    if (await m.done !== "add") return;
    await prizeForm(k, META.prizes);
    k = await api(`/api/kids/${k.member.id}`);
  }
}

function fmtShortDay(iso) {
  return new Date(iso + "T12:00").toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

// Quiénes son niños: sus tareas dan estrellas y tienen su pantalla de logros.
async function kidsSetup() {
  if (!await adultGate()) return;
  const members = await safe(() => api("/api/members"));
  if (!members) return;
  if (!members.length) {
    return modal({ size: "narrow", title: "Primero, las personas", body: `<p class="m-text">Agreguen a las personas de la casa en <b>Ajustes</b>.</p>`, actions: [{ label: "Entendido", tone: "primary" }] });
  }
  const m = modal({
    title: "¿Quiénes son niños?",
    body: `<p class="m-text" style="margin-bottom:1rem">Sus tareas les dan estrellas para juntar un premio.
      Cuántas da cada tarea se elige al cambiar la tarea.</p>
      <div class="kid-toggles">${members.map((p) => `
        <label class="kid-toggle"><input type="checkbox" value="${p.id}" ${p.kid ? "checked" : ""}>
          ${avatar(p, 40)}<span>${esc(p.name)}</span><span class="tg" aria-hidden="true"></span></label>`).join("")}</div>`,
    actions: [
      { label: "Cancelar", value: false },
      {
        label: "Guardar", tone: "primary", icon: "check",
        onClick: async (dlg) => {
          const changed = $$("input[type=checkbox]", dlg).map((i) => [members.find((p) => p.id === +i.value), i.checked]).filter(([p, on]) => p.kid !== on);
          const ok = await safe(() => Promise.all(changed.map(([p, on]) => api(`/api/members/${p.id}`, { method: "PUT", json: { name: p.name, emoji: p.emoji, kid: on } }))));
          if (!ok) return false;
          TODAY = null;
          return true;
        },
      },
    ],
  });
  if (await m.done) go("kids");
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
  // Por páginas para que no se vuelva inmanejable: primero la categoría y luego el producto.
  // Escribir en el buscador busca en toda la casa, en cualquier página.
  const inv = await safe(() => api("/api/inventory"));
  if (!inv) return;
  const groups = inv.groups.filter((g) => g.items.length);
  const all = groups.flatMap((g) => g.items);
  const done = new Set();
  const state = { group: null, text: "" };
  const m = modal({
    title: "¿Qué falta?",
    body: `<p class="m-text" style="margin-bottom:.9rem">Toquen lo que se acabó y queda anotado en la lista de compras.</p>
      <div class="search">${icon("search", 22)}<input id="q" placeholder="Buscar o escribir…" autocomplete="off"></div>
      <div id="ro"></div>`,
    actions: [{ label: "Listo", tone: "primary", icon: "check" }],
  });
  const box = $("#ro", m.el);
  const tile = (name) => `
    <button class="tile ${done.has(name) ? "done" : ""}" data-name="${esc(name)}">${done.has(name) ? icon("check", 20) : ""}${esc(name)}</button>`;
  const draw = () => {
    const f = state.text.trim().toLowerCase();
    const typed = cap(state.text.trim());
    if (f) {
      // Buscando: resultados de todas las categorías, y si no existe, se puede anotar lo escrito.
      const found = all.filter((p) => p.name.toLowerCase().includes(f));
      box.innerHTML = `<div class="tiles">${found.map((p) => tile(p.name)).join("")}
        ${found.some((p) => p.name.toLowerCase() === f) ? "" : `<button class="tile" data-name="${esc(typed)}">${icon("plus", 20)} ${esc(typed)}</button>`}</div>`;
    } else if (state.group) {
      const g = groups.find((x) => x.key === state.group);
      box.innerHTML = `<div class="ro-crumb"><button class="ro-back" data-back-g>${icon("back", 20)} Categorías</button>
          <span class="inv-ic g-${g.key}">${icon(g.icon, 22)}</span><b>${esc(g.label)}</b></div>
        <div class="tiles">${g.items.map((p) => tile(p.name)).join("")}</div>`;
    } else {
      box.innerHTML = groups.length ? `<div class="ro-groups">${groups.map((g) => `
          <button class="ro-group g-${g.key}" data-g="${g.key}">
            <span class="inv-ic">${icon(g.icon, 26)}</span><span class="nm">${esc(g.label)}</span>
            <span class="n">${[...done].filter((n) => g.items.some((p) => p.name === n)).length ? icon("check", 18) : g.items.length}</span>
          </button>`).join("")}</div>`
        : `<p class="empty-note">Todavía no hay nada en el inventario. Escriban lo que se acabó.</p>`;
    }
    $$("[data-g]", box).forEach((b) => b.onclick = () => { state.group = b.dataset.g; draw(); });
    $("[data-back-g]", box)?.addEventListener("click", () => { state.group = null; draw(); });
    $$("[data-name]", box).forEach((b) => b.onclick = () => safe(async () => {
      const name = b.dataset.name;
      if (done.has(name)) return;
      await withBusy(b, () => api("/api/shopping/ran-out", { method: "POST", json: { name } }));
      done.add(name);
      toast(`Anotado: ${name}`);
      draw();
    }));
  };
  $("#q", m.el).oninput = (e) => { state.text = e.target.value; draw(); };
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
        <button class="${empty ? "primary" : ""}" id="fill">${icon("spark", 20)} ${empty ? "Armar la semana" : "Armar con lo que hay"}</button>
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
  // El asistente: revisar qué hay, decir cuándo se come en casa y elegir entre la casa y las ideas nuevas.
  $("#fill").onclick = () => go("sunday", { start: iso });
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
  const ask = (extra = "") => api(`/api/suggestions?servings=${adults}&kids=${kids}&day=${day}&limit=500${extra}`);
  let sugg = await safe(() => ask(`&meal_type=${encodeURIComponent(meal)}`));
  if (!sugg) return;
  // Si ninguna receta está marcada para esa comida, se ofrecen todas (a veces se cena lo del almuerzo).
  const others = !sugg.length;
  if (others) sugg = await safe(() => ask()) ?? [];
  const when = cap(new Date(`${day}T12:00`).toLocaleDateString("es", { weekday: "long", day: "numeric" }));
  const FILTERS = [["all", "Todas", () => true], ["ok", "Tenemos todo", (s) => s.can_cook], ["fav", "Favoritas", (s) => s.recipe.favorite]];
  const state = { filter: "all", text: "" };
  // Hace cuánto estuvo en el menú (antes de ese día): así no se repite lo mismo seguido.
  const ago = (s) => {
    const n = s.days_since_menu;
    if (n == null) return "";
    const txt = n === 1 ? "ayer" : n < 7 ? `hace ${n} días` : n < 14 ? "hace 1 semana" : n < 60 ? `hace ${Math.floor(n / 7)} semanas` : "hace meses";
    return `<span class="ago ${n <= 3 ? "recent" : ""}" title="Estuvo en el menú el ${esc(s.last_menu)}">${icon("calendar", 14)} ${txt}</span>`;
  };
  const m = modal({
    title: entry ? "Cambiar el plato" : `${esc(MEAL_LABEL[meal] ?? meal)} del ${esc(when.toLowerCase())}`,
    size: "wide",
    body: sugg.length ? `${others ? `<p class="m-text" style="margin-bottom:.8rem">No tienen recetas marcadas para ${esc((MEAL_LABEL[meal] ?? meal).toLowerCase())}. Estas son todas las de la casa:</p>` : ""}
      <div class="pick-tools">
        <div class="search">${icon("search", 22)}<input id="rq" placeholder="Buscar receta…" autocomplete="off"></div>
        <div class="who-chips" role="group" aria-label="Mostrar">${FILTERS.map(([k, label, fn]) => `
          <button class="who-chip ${k === "all" ? "on" : ""}" data-f="${k}" aria-pressed="${k === "all"}">
            <span>${label}</span><span class="n">${sugg.filter(fn).length}</span></button>`).join("")}</div>
      </div>
      <div class="pick-list" id="pl"></div>`
      : `<div class="state-block">${icon("pot", 44)}<h2>Todavía no hay recetas</h2>
        <p>Se agregan en Ajustes → Recetas.</p></div>`,
  });
  const list = $("#pl", m.el);
  const draw = () => {
    if (!list) return;
    const fn = FILTERS.find(([k]) => k === state.filter)[2];
    const q = state.text.trim().toLowerCase();
    const shown = sugg.filter((s) => fn(s) && (!q || s.recipe.name.toLowerCase().includes(q)));
    list.innerHTML = shown.map((s) => `
      <button class="pick-row" data-r="${s.recipe.id}">
        <span class="pr-ic">${icon(s.recipe.favorite ? "star" : "pot", 22)}</span>
        <span class="pr-txt"><b>${esc(s.recipe.name)}</b>
          <small class="${s.can_cook ? "ok" : "miss"}">${s.can_cook ? "Tenemos todo" : `Falta: ${esc(s.missing.map((x) => x.name).join(", "))}`}${
            s.uses_expiring.length ? ` · aprovecha ${esc(s.uses_expiring.join(", "))}` : ""}</small></span>
        ${entry && s.recipe.id === entry.recipe.id ? `<span class="ago now">Es el de ahora</span>` : ago(s)}
      </button>`).join("") || `<p class="empty-note">Ninguna receta coincide.</p>`;
    $$("[data-r]", list).forEach((b) => b.onclick = () => safe(async () => {
      await withBusy(b, () => entry
        ? api(`/api/menu/${entry.id}`, { method: "PATCH", json: { recipe_id: +b.dataset.r } })
        : api("/api/menu", { method: "POST", json: { day, meal_type: meal, recipe_id: +b.dataset.r } }));
      m.close(true);
      after();
    }));
  };
  $("#rq", m.el)?.addEventListener("input", (e) => { state.text = e.target.value; draw(); });
  $$("[data-f]", m.el).forEach((b) => b.onclick = () => {
    state.filter = b.dataset.f;
    $$("[data-f]", m.el).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
    draw();
  });
  draw();
}

// ---------------------------------------------------------------- menú del domingo (asistente)
// El ritual del domingo en cuatro pasos: 1) revisar qué hay, 2) decir cuándo se come en casa,
// 3) elegir el menú entre recetas de la casa e ideas nuevas de la IA (un deslizador de cinco
// posiciones) y 4) guardarlo. Lo que se elige se guarda en el aparato: si la pantalla vuelve sola
// al inicio, al abrir de nuevo sigue donde iba.

const WIZ_KEY = "mychef-sunday";
const WIZ_STEPS = ["¿Qué hay?", "¿Cuándo comen en casa?", "El menú", "Listo"];
const MIX = ["Todo de la casa", "Más de la casa", "Mitad y mitad", "Más ideas nuevas", "Todo ideas nuevas"];
const FIRST_GROUPS = ["proteinas", "granos", "verduras", "lacteos"]; // lo que manda en el menú
const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

let wiz = null;

// La semana que se planea: desde el viernes, la que viene; si no, esta.
function wizWeek() {
  const now = new Date();
  const monday = mondayOf(now);
  return isoDate([5, 6, 0].includes(now.getDay()) ? addDays(monday, 7) : monday);
}

function wizLoad(start) {
  try {
    const d = JSON.parse(localStorage.getItem(WIZ_KEY) || "null");
    if (d && d.start === start && Date.now() - d.saved < 18 * 3600 * 1000) return { ...d, ideasLoading: null };
  } catch { /* sin almacenamiento */ }
  return { start, step: 0, on: null, keep: true, mix: 2, plan: null, planKey: null, ideas: null, ideasKey: null,
    ideasError: null, idea: {}, pick: {}, seenIdeas: {} };
}
function wizSave() {
  try { localStorage.setItem(WIZ_KEY, JSON.stringify({ ...wiz, saved: Date.now() })); } catch { /* sin almacenamiento */ }
}
function wizClear() {
  try { localStorage.removeItem(WIZ_KEY); } catch { /* sin almacenamiento */ }
}

const slotKey = (s) => `${s.day}|${s.meal}`;
const dayOf = (iso) => new Date(`${iso}T12:00`);
const dayName = (iso, long = false) => cap(dayOf(iso).toLocaleDateString("es", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "long", day: "numeric" }));

async function renderSunday({ start = null, step = null } = {}) {
  const week = start ?? wiz?.start ?? wizWeek();
  if (!wiz || wiz.start !== week) wiz = wizLoad(week);
  if (step !== null) wiz.step = step;
  wizSave();
  const monday = dayOf(wiz.start);
  const sunday = addDays(monday, 6);
  const range = `${monday.toLocaleDateString("es", monday.getMonth() === sunday.getMonth() ? { day: "numeric" } : { day: "numeric", month: "short" })} al ${
    sunday.toLocaleDateString("es", { day: "numeric", month: "short" })}`;
  const steps = `<nav class="wiz-steps" aria-label="Pasos">${WIZ_STEPS.map((label, n) => `
    <button class="wiz-step ${n === wiz.step ? "now" : n < wiz.step ? "done" : ""}" data-step="${n}" ${n < wiz.step ? "" : "disabled"}
      ${n === wiz.step ? `aria-current="step"` : ""}><span class="n">${n < wiz.step ? icon("check", 18) : n + 1}</span>${label}</button>`).join("")}</nav>`;
  const frame = (body, bar) => {
    app.innerHTML = `${head(`Armar el menú · ${range}`)}${steps}${body}<div class="bottom-bar wiz-bar">${bar}</div>`;
    bindBack();
    $$("[data-step]", app).forEach((b) => b.onclick = () => go("sunday", { step: +b.dataset.step }));
    $("#w-back")?.addEventListener("click", () => go("sunday", { step: wiz.step - 1 }));
  };
  await [wizInventory, wizWhen, wizChoose, wizDone][wiz.step](frame);
}

// ---------------------------------------------------------------- paso 1: ¿qué hay?

async function wizInventory(frame) {
  const data = await api("/api/inventory");
  const groups = data.groups.filter((g) => g.key !== "aseo");
  groups.sort((a, b) => (FIRST_GROUPS.indexOf(a.key) + 1 || 99) - (FIRST_GROUPS.indexOf(b.key) + 1 || 99));
  const card = (g) => `
    <button class="inv-card g-${g.key} ${g.reviewed_today ? "seen" : ""} ${g.items.length ? "" : "empty"}" data-g="${g.key}">
      <span class="inv-ic">${icon(g.icon, 36)}</span>
      <span class="inv-name">${esc(g.label)}</span>
      <span class="inv-sub">${g.items.length ? plural(g.count, "cosa", "cosas") : "Vacío"}</span>
      ${g.reviewed_today ? `<span class="inv-seen" aria-label="Revisado hoy">${icon("check", 20)}</span>` : ""}
    </button>`;
  const first = groups.filter((g) => FIRST_GROUPS.includes(g.key));
  frame(`<p class="wiz-lead">Abran la nevera y la alacena y revisen, sobre todo, <b>las proteínas y las harinas</b>: el menú gira alrededor de eso.</p>
    <div class="inv-grid">${first.map(card).join("")}</div>
    <h2 class="wiz-sub">Lo demás, si quieren</h2>
    <div class="inv-grid">${groups.filter((g) => !FIRST_GROUPS.includes(g.key)).map(card).join("")}</div>`,
  `<button class="primary big" id="w-next">${first.every((g) => g.reviewed_today || !g.items.length) ? "Siguiente" : "Ya revisé, seguir"} ${icon("chevron")}</button>`);
  $$("[data-g]", app).forEach((b) => b.onclick = () => go("invGroup", { key: b.dataset.g, back: "sunday" }));
  $("#w-next").onclick = () => go("sunday", { step: 1 });
}

// ---------------------------------------------------------------- paso 2: ¿cuándo comen en casa?

async function wizWhen(frame) {
  const days = [...Array(7)].map((_, n) => isoDate(addDays(dayOf(wiz.start), n)));
  const todayIso = isoDate(new Date());
  const meals = [...META.meal_types].sort((a, b) => MEAL_ORDER.indexOf(a) - MEAL_ORDER.indexOf(b));
  const [current, before] = await Promise.all([
    api(`/api/menu?start=${wiz.start}&days=7`),
    wiz.on ? null : api(`/api/menu?start=${isoDate(addDays(dayOf(wiz.start), -7))}&days=7`),
  ]);
  const fixed = new Map();
  current.forEach((e) => fixed.set(`${e.day}|${e.meal_type}`, [...(fixed.get(`${e.day}|${e.meal_type}`) ?? []), e.recipe.name]));
  if (!wiz.on) {
    // Como la semana pasada; si no hubo menú, desayuno, almuerzo y cena (y la merienda si es de alguien).
    const usual = new Set((before ?? []).map((e) => `${(dayOf(e.day).getDay() + 6) % 7}|${e.meal_type}`));
    const defaults = ["desayuno", "almuerzo", "cena", ...(META.meal_people?.merienda?.length ? ["merienda"] : [])];
    wiz.on = days.flatMap((d, n) => meals.filter((m) => (usual.size ? usual.has(`${n}|${m}`) : defaults.includes(m)))
      .map((m) => `${d}|${m}`));
    fixed.forEach((_, k) => { if (!wiz.on.includes(k)) wiz.on.push(k); });
  }
  const on = new Set(wiz.on.filter((k) => k.split("|")[0] >= todayIso));
  const past = (d) => d < todayIso;

  const draw = () => {
    const count = on.size;
    frame(`<p class="wiz-lead">Marquen las comidas que se hacen en casa. Tocando el día o la comida se marca toda la fila.</p>
      <div class="when" style="--n:${meals.length}" role="grid">
        <span></span>${meals.map((m) => `<button class="when-meal" data-col="${m}">${icon(MEAL_ICON[m], 20)} ${esc(MEAL_LABEL[m] ?? m)}</button>`).join("")}
        ${days.map((d) => `
          <button class="when-day" data-row="${d}" ${past(d) ? "disabled" : ""}>${DAY_SHORT[dayOf(d).getDay()]} <small>${dayOf(d).getDate()}</small></button>
          ${meals.map((m) => {
            const k = `${d}|${m}`;
            const has = fixed.get(k);
            return `<button class="when-cell ${on.has(k) ? "on" : ""} ${has && wiz.keep ? "fixed" : ""}" data-k="${k}" ${past(d) ? "disabled" : ""}
              aria-pressed="${on.has(k)}" aria-label="${esc(MEAL_LABEL[m])} del ${esc(dayName(d))}${has ? `: ya está ${esc(has.join(", "))}` : ""}">
              ${on.has(k) ? icon("check", 22) : ""}${has && on.has(k) ? `<small>${wiz.keep ? "Ya está" : "Se rehace"}</small>` : ""}</button>`;
          }).join("")}`).join("")}
      </div>
      ${fixed.size ? `<label class="wiz-keep"><input type="checkbox" id="w-keep" ${wiz.keep ? "" : "checked"}>
        <span>Rehacer también lo que ya estaba en el menú (${plural(fixed.size, "comida", "comidas")})</span></label>` : ""}`,
    `<button id="w-back" aria-label="Atrás">${icon("back")}<span class="lbl"> Atrás</span></button>
      <button class="primary big" id="w-next" ${count ? "" : "disabled"}>${count ? `${plural(count, "comida", "comidas")} · Siguiente` : "Marquen al menos una"} ${icon("chevron")}</button>`);
    const flip = (keys) => {
      const open = keys.filter((k) => !past(k.split("|")[0]));
      const all = open.every((k) => on.has(k));
      open.forEach((k) => (all ? on.delete(k) : on.add(k)));
      wiz.on = [...on];
      wizSave();
      draw();
    };
    $$("[data-k]", app).forEach((b) => b.onclick = () => flip([b.dataset.k]));
    $$("[data-row]", app).forEach((b) => b.onclick = () => flip(meals.map((m) => `${b.dataset.row}|${m}`)));
    $$("[data-col]", app).forEach((b) => b.onclick = () => flip(days.map((d) => `${d}|${b.dataset.col}`)));
    $("#w-keep")?.addEventListener("change", (e) => { wiz.keep = !e.target.checked; wizSave(); draw(); });
    $("#w-next").onclick = () => go("sunday", { step: 2 });
  };
  draw();
}

// ---------------------------------------------------------------- paso 3: el menú

const wizSlots = () => (wiz.plan?.slots ?? []);
const freeSlots = () => wizSlots().filter((s) => !s.fixed);

async function wizPlan() {
  const key = JSON.stringify([wiz.on.slice().sort(), wiz.keep]);
  if (wiz.plan && wiz.planKey === key) return;
  const slots = wiz.on.map((k) => { const [day, meal] = k.split("|"); return { day, meal }; });
  wiz.plan = await api("/api/menu/plan", { method: "POST", json: { start: wiz.start, slots, keep_existing: wiz.keep } });
  wiz.planKey = key;
  wiz.pick = {};
  wizSave();
}

// Las ideas de la IA se piden una vez por semana armada; el deslizador solo decide cuántas se usan.
function wizAskIdeas(redraw) {
  const free = freeSlots();
  const key = JSON.stringify(free.map(slotKey));
  if (!free.length || (wiz.ideasKey === key && (wiz.ideas || wiz.ideasError)) || wiz.ideasLoading === key) return;
  wiz.ideasLoading = key;
  wiz.ideasError = null;
  api("/api/menu/ideas", { method: "POST", json: {
    start: wiz.start, slots: free.map((s) => ({ day: s.day, meal: s.meal, servings: s.adults, kids: s.kids })),
  } }).then((res) => {
    wiz.ideas = res;
    wiz.idea = Object.fromEntries(res.slots.map((s) => [slotKey(s), { main: s.main, salad: s.salad ?? null }]));
    wiz.seenIdeas = Object.fromEntries(res.slots.map((s) => [slotKey(s), [s.main?.recipe.name, s.salad?.recipe.name].filter(Boolean)]));
  }).catch((e) => {
    wiz.ideasError = { message: e.message, noKey: e.status === 503 };
  }).finally(() => {
    wiz.ideasKey = key;
    wiz.ideasLoading = null;
    wizSave();
    if (screen === "sunday" && wiz.step === 2) redraw();
  });
}

// Qué va en cada comida: lo que eligieron a mano, o lo que dice el deslizador.
function chosen(s) {
  if (s.fixed) return null;
  const k = slotKey(s);
  const idea = wiz.idea[k] ?? {};
  const pick = wiz.pick[k];
  let main;
  let salad;
  if (pick) {
    ({ main, salad } = pick);
  } else {
    const useAi = aiSlots().has(k);
    main = useAi ? { src: "ai" } : s.main ? { src: "house", i: 0 } : null;
    const hasSalad = "salad" in s;
    salad = !hasSalad ? null
      : useAi && idea.salad ? { src: "ai" }
      : s.salad ? { src: "house", i: 0 }
      : idea.salad && wiz.mix > 0 ? { src: "ai" } : null;
  }
  const get = (c, kind) => {
    if (!c) return null;
    if (c.src === "ai") return idea[kind] ? { ...idea[kind], src: "ai" } : null;
    const list = kind === "main" ? s.main_options : s.salad_options;
    return list?.[c.i] ? { ...list[c.i], src: "house" } : null;
  };
  return { main: get(main, "main"), salad: get(salad, "salad"), locked: !!pick };
}

function aiSlots() {
  const free = freeSlots().filter((s) => wiz.idea[slotKey(s)]?.main);
  const n = Math.round((wiz.mix / 4) * freeSlots().length);
  return new Set(free.sort((a, b) => a.ai_rank - b.ai_rank).slice(0, n).map(slotKey));
}

function dishState(c) {
  if (c.can_cook) return `<span class="d-state ok">${icon("check", 16)} Tenemos todo</span>`;
  return `<span class="d-state miss">Falta: ${esc(c.missing.map((m) => m.name).join(", "))}</span>`;
}

async function wizChoose(frame) {
  frame(`<div class="state-block">${icon("spark", 44)}<h2>Armando la semana con lo que hay…</h2></div>`, "");
  try {
    await wizPlan();
  } catch (e) {
    frame(`<div class="state-block">${icon("warn", 44)}<h2>No se pudo armar la semana</h2><p>${esc(e.message)}</p>
      <button class="primary" id="w-again">${icon("undo")} Intentar de nuevo</button></div>`, `<button id="w-back" aria-label="Atrás">${icon("back")}<span class="lbl"> Atrás</span></button>`);
    $("#w-again").onclick = () => go("sunday", { step: 2 });
    return;
  }
  const draw = () => {
    wizAskIdeas(draw);
    const loading = wiz.ideasLoading;
    const err = wiz.ideasError;
    const byDay = new Map();
    wizSlots().forEach((s) => byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]));
    // Cada comida en su columna, para que los días se lean como una tabla
    const cols = MEAL_ORDER.filter((m) => wizSlots().some((s) => s.meal === m));
    const col = (s) => `style="--col:${cols.indexOf(s.meal) + 1}"`;
    let nAi = 0;
    let nHouse = 0;
    const card = (s) => {
      const k = slotKey(s);
      if (s.fixed) {
        return `<div class="dish fixed" ${col(s)}><span class="d-top"><span class="d-meal">${icon(MEAL_ICON[s.meal], 18)} ${esc(MEAL_LABEL[s.meal])}</span>
          <span class="src">Ya estaba</span></span><span class="d-name">${esc(s.entries.map((e) => e.recipe.name).join(" + "))}</span></div>`;
      }
      const c = chosen(s);
      if (c.main?.src === "ai") nAi += 1; else if (c.main) nHouse += 1;
      const m = c.main;
      const core = m ? [m.protein, m.starch].filter(Boolean).join(" · ") : "";
      const again = m && (m.repeat ? "Repite de la semana pasada" : m.again ? "Se repite en la semana" : "");
      return `<button class="dish ${m ? "" : "empty"}" data-k="${k}" ${col(s)}>
        <span class="d-top"><span class="d-meal">${icon(MEAL_ICON[s.meal], 18)} ${esc(MEAL_LABEL[s.meal])}</span>
          ${m ? `<span class="src ${m.src}">${m.src === "ai" ? `${icon("spark", 14)} Idea nueva` : "De la casa"}</span>` : ""}</span>
        ${m ? `<span class="d-name">${esc(m.recipe.name)}</span>
          ${core ? `<span class="d-core">${esc(core)}</span>` : ""}
          ${dishState(m)}
          ${again ? `<span class="d-again">${esc(again)}</span>` : ""}`
        : `<span class="d-name muted">Sin receta</span><span class="d-core">Toquen para elegir</span>`}
        ${"salad" in s ? `<span class="d-salad">${icon(c.salad?.src === "ai" ? "spark" : "leaf", 16)} ${c.salad ? esc(c.salad.recipe.name) : "Sin ensalada"}</span>` : ""}
        ${c.locked ? `<span class="d-lock">${icon("check", 14)} Elegido a mano</span>` : ""}
      </button>`;
    };
    const days = [...byDay].map(([day, list]) => `
      <section class="menu-day wiz-day"><h2>${esc(cap(dayOf(day).toLocaleDateString("es", { weekday: "long" })))} <small>${dayOf(day).getDate()}</small></h2>
        <div class="dishes" style="--n:${cols.length}">${list.map(card).join("")}</div></section>`).join("");
    const mixBox = err?.noKey
      ? `<div class="mix off"><p>${icon("spark", 20)} Para mezclar con ideas nuevas de la IA, configúrenla en Ajustes → Casa. Por ahora, todo es de la casa.</p></div>`
      : `<div class="mix ${loading ? "busy" : ""}">
          <div class="mix-ends"><span>${icon("home", 20)} De la casa</span><span>Ideas nuevas ${icon("spark", 20)}</span></div>
          <input type="range" id="w-mix" min="0" max="4" step="1" value="${wiz.mix}" ${loading || err || !wiz.ideas ? "disabled" : ""}
            aria-label="De la casa o ideas nuevas" aria-valuetext="${MIX[wiz.mix]}">
          <div class="mix-ticks">${MIX.map((t, n) => `<button data-mix="${n}" class="${n === wiz.mix ? "on" : ""}" ${loading || err || !wiz.ideas ? "disabled" : ""}>${t}</button>`).join("")}</div>
          <p class="mix-note">${loading ? `<span class="spin" aria-hidden="true"></span> La IA está pensando ideas con lo que hay. Puede tardar un minuto; mientras, ya pueden ver la semana.`
            : err ? `No llegaron las ideas nuevas: ${esc(err.message)} <button class="btn-soft" id="w-retry">${icon("undo", 18)} Intentar de nuevo</button>`
            : `<b>${nHouse}</b> de la casa · <b>${nAi}</b> ${nAi === 1 ? "idea nueva" : "ideas nuevas"}${wiz.ideas?.errors?.length ? ` · Algunas comidas se quedaron sin ideas` : ""}`}</p>
        </div>`;
    frame(`${mixBox}<p class="wiz-help">Toquen un plato para cambiarlo.</p><div class="week">${days}</div>`,
      `<button id="w-back" aria-label="Atrás">${icon("back")}<span class="lbl"> Atrás</span></button>
       <button class="primary big" id="w-next">Siguiente ${icon("chevron")}</button>`);
    const setMix = (n) => { wiz.mix = n; wizSave(); draw(); };
    $("#w-mix")?.addEventListener("change", (e) => setMix(+e.target.value));
    $$("[data-mix]", app).forEach((b) => b.onclick = () => setMix(+b.dataset.mix));
    $("#w-retry")?.addEventListener("click", () => { wiz.ideasKey = null; wiz.ideasError = null; draw(); });
    $$(".dish[data-k]", app).forEach((b) => b.onclick = () => dishModal(wizSlots().find((s) => slotKey(s) === b.dataset.k), draw));
    $("#w-next").onclick = () => go("sunday", { step: 3 });
  };
  draw();
}

// Cambiar un plato: la idea nueva (y pedir otra), las recetas de la casa y la ensalada del almuerzo.
function dishModal(s, redraw) {
  const k = slotKey(s);
  const cur = chosen(s);
  const sel = {
    main: cur.main ? (cur.main.src === "ai" ? { src: "ai" } : { src: "house", i: s.main_options.findIndex((o) => o.recipe.id === cur.main.recipe.id) }) : null,
    salad: cur.salad ? (cur.salad.src === "ai" ? { src: "ai" } : { src: "house", i: s.salad_options.findIndex((o) => o.recipe.id === cur.salad.recipe.id) }) : null,
  };
  const same = (a, b) => (a && b ? a.src === b.src && (a.src === "ai" || a.i === b.i) : a === b);
  const row = (kind, c, choice) => `
    <button class="pick-row ${same(sel[kind], choice) ? "on" : ""}" data-kind="${kind}" data-c='${JSON.stringify(choice)}'>
      <span class="pr-ic">${same(sel[kind], choice) ? icon("check", 22) : icon(choice?.src === "ai" ? "spark" : kind === "salad" ? "leaf" : "pot", 22)}</span>
      <span class="pr-txt"><b>${esc(c ? c.recipe.name : "Sin ensalada")}</b>
        ${c ? `<small class="${c.can_cook ? "ok" : "miss"}">${[c.protein, c.starch].filter(Boolean).map(esc).join(" · ")}${c.protein || c.starch ? " · " : ""}${
          c.can_cook ? "Tenemos todo" : `Falta: ${esc(c.missing.map((x) => x.name).join(", "))}`}</small>` : ""}</span>
      ${c?.repeat ? `<span class="ago recent">Semana pasada</span>` : c?.again ? `<span class="ago">Ya está esta semana</span>` : ""}
    </button>`;
  const body = () => {
    const idea = wiz.idea[k] ?? {};
    return `<p class="m-text">${esc(dayName(s.day))} · ${esc(peopleText(s.adults, s.kids))}</p>
      ${wiz.ideas || wiz.idea[k] ? `<h3 class="pick-h">${icon("spark", 20)} Idea nueva</h3>
        <div class="pick-list short">${idea.main ? row("main", idea.main, { src: "ai" }) : `<p class="empty-note">No hay idea para esta comida.</p>`}</div>
        <button class="btn-soft" id="d-more">${icon("undo", 18)} Pedir otra idea</button>` : ""}
      <h3 class="pick-h">${icon("home", 20)} De la casa</h3>
      <div class="pick-list short">${s.main_options.map((c, i) => row("main", c, { src: "house", i })).join("") || `<p class="empty-note">No hay recetas de la casa para esta comida.</p>`}</div>
      ${"salad" in s ? `<h3 class="pick-h">${icon("leaf", 20)} Ensalada</h3>
        <div class="pick-list short">${idea.salad ? row("salad", idea.salad, { src: "ai" }) : ""}
          ${s.salad_options.map((c, i) => row("salad", c, { src: "house", i })).join("")}${row("salad", null, null)}</div>` : ""}`;
  };
  const m = modal({
    title: `${esc(MEAL_LABEL[s.meal])} del ${esc(dayName(s.day).toLowerCase())}`, size: "wide", body: `<div id="dm">${body()}</div>`,
    actions: [
      ...(wiz.pick[k] ? [{ label: "Como diga el deslizador", icon: "undo", value: "auto" }] : []),
      { label: "Listo", tone: "primary", icon: "check", value: "ok" },
    ],
  });
  const box = $("#dm", m.el);
  const bind = () => {
    $$("[data-kind]", box).forEach((b) => b.onclick = () => {
      sel[b.dataset.kind] = JSON.parse(b.dataset.c);
      wiz.pick[k] = { ...sel };
      wizSave();
      box.innerHTML = body();
      bind();
    });
    $("#d-more", box)?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      const res = await safe(() => api("/api/menu/ideas", { method: "POST", json: {
        start: wiz.start, slots: [{ day: s.day, meal: s.meal, servings: s.adults, kids: s.kids }], avoid: wiz.seenIdeas[k] ?? [],
      } }));
      const got = res?.slots?.[0];
      if (!got?.main) return res && toast("La IA no dio otra idea; intenten de nuevo");
      wiz.idea[k] = { main: got.main, salad: got.salad ?? wiz.idea[k]?.salad ?? null };
      wiz.seenIdeas[k] = [...(wiz.seenIdeas[k] ?? []), got.main.recipe.name, got.salad?.recipe.name].filter(Boolean);
      sel.main = { src: "ai" };
      if (got.salad) sel.salad = { src: "ai" };
      wiz.pick[k] = { ...sel };
      wizSave();
      box.innerHTML = body();
      bind();
    }));
  };
  bind();
  m.done.then((v) => {
    if (v === "auto") { delete wiz.pick[k]; wizSave(); }
    redraw();
  });
}

// ---------------------------------------------------------------- paso 4: listo

async function wizDone(frame) {
  if (!wiz.plan) return go("sunday", { step: 2 });
  const today = await api("/api/today").catch(() => null);
  const rows = [];
  const buy = new Map();
  const used = new Set();
  let nAi = 0;
  let nHouse = 0;
  for (const s of wizSlots()) {
    if (s.fixed) continue;
    const c = chosen(s);
    if (!c.main) continue;
    if (c.main.src === "ai") nAi += 1; else nHouse += 1;
    for (const d of [c.main, c.salad].filter(Boolean)) {
      d.missing.forEach((x) => buy.set(x.name, x));
      d.uses_expiring?.forEach((n) => used.add(n.toLowerCase()));
      d.draft?.ingredients.forEach((i) => used.add(i.name.toLowerCase()));
    }
    rows.push({ s, c });
  }
  const wasted = (today?.expiring ?? []).filter((e) => !used.has(e.name.toLowerCase()));
  const empty = freeSlots().filter((s) => !chosen(s).main);
  frame(`<div class="wiz-sum">
      <div class="sum-tile"><b>${rows.length}</b><span>${rows.length === 1 ? "comida" : "comidas"}</span></div>
      <div class="sum-tile"><b>${nHouse}</b><span>de la casa</span></div>
      <div class="sum-tile ai"><b>${nAi}</b><span>${nAi === 1 ? "idea nueva" : "ideas nuevas"}</span></div>
      <div class="sum-tile buy"><b>${buy.size}</b><span>para comprar</span></div>
    </div>
    ${buy.size ? `<section class="sheet wiz-note"><h3>${icon("basket", 20)} Pasa a la lista de compras</h3><p>${esc([...buy.keys()].join(", "))}</p></section>` : ""}
    ${wasted.length ? `<section class="sheet wiz-note warn"><h3>${icon("clock", 20)} Se vence y no quedó en el menú</h3><p>${esc(wasted.map((e) => e.name).join(", "))}</p></section>` : ""}
    ${empty.length ? `<section class="sheet wiz-note warn"><h3>${icon("warn", 20)} Quedan sin receta</h3><p>${esc(empty.map((s) => `${MEAL_LABEL[s.meal]} del ${dayName(s.day).toLowerCase()}`).join(", "))}. Se pueden llenar después en el menú.</p></section>` : ""}
    <section class="sheet wiz-list">${rows.map(({ s, c }) => `
      <div class="wl-row"><span class="wl-day">${DAY_SHORT[dayOf(s.day).getDay()]} ${dayOf(s.day).getDate()}</span>
        <span class="wl-meal">${icon(MEAL_ICON[s.meal], 18)} ${esc(MEAL_LABEL[s.meal])}</span>
        <span class="wl-dish">${esc(c.main.recipe.name)}${c.salad ? ` <small>+ ${esc(c.salad.recipe.name)}</small>` : ""}
          ${c.main.src === "ai" ? `<span class="src ai">${icon("spark", 14)} Idea nueva</span>` : ""}</span></div>`).join("")}</section>
    ${nAi ? `<p class="wiz-help">Las ideas nuevas quedan como recetas de prueba: se pueden ver y cocinar como cualquier otra.</p>` : ""}`,
  `<button id="w-back" aria-label="Atrás">${icon("back")}<span class="lbl"> Atrás</span></button>
   <button class="primary big" id="w-save" ${rows.length ? "" : "disabled"}>${icon("check")} Guardar el menú</button>`);
  $("#w-save").onclick = (e) => safe(async () => {
    const entries = [];
    for (const { s, c } of rows) {
      for (const d of [c.main, c.salad].filter(Boolean)) {
        entries.push({ day: s.day, meal_type: s.meal, servings: s.adults, kids: s.kids,
          ...(d.src === "ai" ? { new_recipe: d.draft } : { recipe_id: d.recipe.id }) });
      }
    }
    const replace = freeSlots().map((s) => ({ day: s.day, meal: s.meal }));
    await withBusy(e.currentTarget, () => api("/api/menu/week", { method: "POST", json: { entries, replace } }));
    const start = wiz.start;
    wizClear();
    wiz = null;
    await doneModal("¡Menú listo!", buy.size ? "Lo que falta ya está en la lista de compras." : "Tienen todo lo que hace falta.");
    go("menu", { start });
  });
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

async function renderInvGroup({ key, back = null }) {
  const out = () => (back ? go(back) : go("inventory"));
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
    app.innerHTML = `${head(esc(g.label), back ? "Volver al menú de la semana" : "Volver a los grupos")}
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
    out();
  };

  // Volver sin tocar «Listo»: si marcaron algo, se guarda igual (nada se pierde).
  const leave = () => safe(async () => {
    if (changes.size) await save($("#save"));
    else out();
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
    // Era una idea nueva de la IA: ¿les gustó? Así pasa a las de la casa o no se vuelve a proponer.
    const verdict = r.trial ? await likedModal(r) : null;
    await doneModal("¡Buen provecho!", verdict === "yes" ? `«${r.name}» ya es una receta de la casa.`
      : verdict === "no" ? "No se las volvemos a proponer." : "Se descontó lo que se usó de la nevera y la alacena.");
    home();
  });
}

function likedModal(r) {
  const m = modal({
    size: "narrow", title: `¿Les gustó «${esc(r.name)}»?`,
    body: `<p class="m-text">Era una idea nueva. Si les gustó, queda entre las recetas de la casa.</p>
      <div class="liked-opts">
        <button class="primary big" data-v="yes">${icon("heart", 26)} ¡Sí! Guardarla</button>
        <button class="big" data-v="meh">Más o menos</button>
        <button class="big" data-v="no">${icon("close", 24)} No nos gustó</button>
      </div>`,
  });
  $$("[data-v]", m.el).forEach((b) => b.onclick = () => withBusy(b, async () => {
    const ok = await safe(() => api(`/api/recipes/${r.id}/verdict`, { method: "POST", json: { verdict: b.dataset.v } }));
    if (ok) m.close(b.dataset.v);
  }));
  return m.done;
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
  // Falta algo del recordatorio («¿para qué día?», «¿a qué hora?»): se vuelve a escuchar sola.
  if (res.intent === "agenda_ask" && res.data?.pending && !ui.closed) return listenForAnswer(ui);
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

// Escucha la respuesta a una pregunta de la casa. Si nadie contesta, no se anota nada.
async function listenForAnswer(ui) {
  wakeHold("answer");
  try {
    ui.title("Te escucho…");
    $(".mic-wave", ui.m.el).classList.remove("idle");
    ui.heard("…");
    let text = "";
    try { text = await listenOnce({ onInterim: (t) => ui.heard(`«${t}»`) }); } catch { text = ""; }
    if (ui.closed) { voicePending = null; return; }
    if (!text) {
      voicePending = null;
      ui.idle();
      ui.title("No escuché nada");
      ui.heard("No lo anoté. Pueden decirlo de nuevo cuando quieran.");
      await say("No escuché nada, así que no lo anoté.");
      setTimeout(() => ui.close(), 2500);
      return;
    }
    await processUtterance(text, ui);
  } finally {
    wakeRelease("answer");
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
// (botón Hablar, manos libres) y vuelve sola. Se activa por aparato en Ajustes → Casa.

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

// Recordatorio a medias que espera una respuesta («¿para qué día?»). Vence al minuto.
let voicePending = null;
let voicePendingAt = 0;

async function handleVoiceText(text, { box = null, handsFree: hf = false } = {}) {
  const context = { screen, handsfree: hf, ...(COOK ? { recipe_id: COOK.recipeId, servings: COOK.servings, kids: COOK.kids } : {}) };
  if (voicePending && Date.now() - voicePendingAt < 60 * 1000) context.pending = voicePending;
  let res;
  try {
    res = await api("/api/voice", { method: "POST", json: { text, context } });
  } catch (e) {
    toast(e.message, 4000);
    return null;
  }
  if (hf && res.intent === "unknown") return null; // en manos libres se ignora lo que no es comando
  voicePending = res.intent === "agenda_ask" && res.data?.pending ? res.data.pending : null;
  voicePendingAt = Date.now();
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
