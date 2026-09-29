// MyChef · Administrar — la vista completa y detallada. Todo el estado vive en el servidor (SQLite).

import {
  $, $$, REASON_TEXT, addDays, api, cap, esc, fmtDay, fmtMoney, fmtQty, isoDate, mondayOf, safe,
  CHORE_ICONS, amountForm, avatar, bindAmountForm, choreIcon, compressImage, confirmModal, fmtAmount, fmtUnit, house,
  icon, kidPath, kidStar, modal as formModal, peopleText, prizeArt, prizeForm, prizeRows, readAmountForm, setHouse, toPantryLine, toast, withBusy,
  bindSchedule, readSchedule, scheduleFields, scheduleOf,
} from "./common.js";
import { VOICE_SUPPORTED, getVoicePrefs, onVoicesReady, setVoicePrefs, speak } from "./voice.js";

// «Oye casa» se activa por aparato; la pantalla de la casa lee esta misma marca al abrir.
const WAKE_KEY = "mychef-wake";

const view = $("#view");
const modal = $("#modal");
const modalBody = $("#modal-body");

let META = null;
let weekStart = mondayOf(new Date());

function coverageBar(c) {
  const pct = Math.round(c * 100);
  const cls = pct >= 100 ? "" : pct >= 60 ? "mid" : "low";
  return `<div class="bar ${cls}" title="${pct}% de ingredientes en casa"><span style="width:${pct}%"></span></div>`;
}
function options(list, selected, empty) {
  return (empty ? `<option value="">${esc(empty)}</option>` : "") +
    list.map((v) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(cap(v))}</option>`).join("");
}

function openModal(html) {
  modalBody.innerHTML = html;
  if (!modal.open) modal.showModal();
}
function closeModal() { modal.close(); }
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

// ------------------------------------------------------------------ navegación

const VIEWS = { cook: renderCook, recipes: renderRecipes, pantry: renderPantry, shopping: renderShopping, house: renderHouse, taste: renderTaste, chores: renderChoresAdmin, prizes: renderPrizes };
let current = "recipes";

function go(name) {
  current = name;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  safe(VIEWS[name]);
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
function refresh() { safe(VIEWS[current]); }

// Quiénes comen en casa: adultos y niños (un niño come una porción más pequeña).
function whoFields(prefix, adults, kids) {
  return `<label class="field">Adultos<input id="${prefix}-a" type="number" min="0" value="${adults}" style="width:5rem"></label>
    <label class="field">Niños<input id="${prefix}-k" type="number" min="0" value="${kids}" style="width:5rem"></label>`;
}
function readWho(prefix) {
  const adults = Math.max(0, parseInt($(`#${prefix}-a`).value, 10) || 0);
  const kids = Math.max(0, parseInt($(`#${prefix}-k`).value, 10) || 0);
  return adults + kids ? { servings: adults, kids } : { servings: null, kids: null };
}


// ------------------------------------------------------------------ ¿qué cocino?

async function renderCook(filters = {}) {
  const meal = filters.meal ?? guessMeal();
  const dish = filters.dish ?? "";
  const servings = filters.servings ?? META.household_size;
  const kids = filters.kids ?? META.household_kids;
  const params = new URLSearchParams({ servings, kids, limit: 30 });
  if (meal) params.set("meal_type", meal);
  if (dish) params.set("dish_type", dish);
  const sugg = await api(`/api/suggestions?${params}`);

  view.innerHTML = `
    <div class="card row" style="margin-bottom:.75rem">
      <label class="field">Comida<select id="f-meal">${options(META.meal_types, meal, "Cualquiera")}</select></label>
      <label class="field">Tipo de plato<select id="f-dish">${options(META.dish_types, dish, "Todos")}</select></label>
      ${whoFields("f", servings, kids)}
    </div>
    ${sugg.length ? `<div class="grid">${sugg.map((s) => `
      <article class="card stack">
        <div class="row spread">
          <strong>${esc(s.recipe.name)}</strong>
          ${s.can_cook ? `<span class="badge ok">se puede hacer ya</span>` : `<span class="badge bad">faltan ${s.missing.length}</span>`}
        </div>
        <div class="row small"><span class="badge">${esc(s.recipe.dish_type)}</span>
          ${s.recipe.favorite ? `<span class="badge accent">${icon("star", 14)} favorita</span>` : ""}
          ${s.uses_expiring.length ? `<span class="badge warn">aprovecha: ${esc(s.uses_expiring.join(", "))}</span>` : ""}</div>
        ${coverageBar(s.coverage)}
        ${s.missing.length ? `<div class="small">Falta: ${s.missing.map((m) => `${esc(m.name)} (${fmtQty(m.quantity)} ${esc(fmtUnit(m.quantity, m.unit))})`).join(", ")}</div>` : ""}
        <div class="small muted">${s.last_cooked ? `Última vez: ${new Date(s.last_cooked + "T12:00").toLocaleDateString("es")}` : "Aún no la han registrado"}</div>
        <div><button data-open="${s.recipe.id}">Ver receta para ${esc(peopleText(servings, kids))}</button></div>
      </article>`).join("")}</div>`
      : `<div class="empty card">No hay recetas para ese filtro. Empieza cargando sus recetas en la pestaña <b>Recetas</b>.</div>`}`;

  const reload = () => safe(() => {
    const w = readWho("f");
    return renderCook({ meal: $("#f-meal").value, dish: $("#f-dish").value, servings: w.servings ?? undefined, kids: w.kids ?? undefined });
  });
  $("#f-meal").onchange = reload;
  $("#f-dish").onchange = reload;
  $("#f-a").onchange = reload;
  $("#f-k").onchange = reload;
  $$("[data-open]", view).forEach((b) => b.onclick = () => showRecipe(+b.dataset.open, servings, kids));
}

function guessMeal() {
  const h = new Date().getHours();
  if (h < 10) return "desayuno";
  if (h < 15) return "almuerzo";
  if (h < 18) return "merienda";
  return "cena";
}

// ------------------------------------------------------------------ recetas

async function renderRecipes(filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const recipes = await api(`/api/recipes?${params}`);
  view.innerHTML = `
    <div class="card row spread" style="margin-bottom:.75rem">
      <div class="row">
        <input id="r-q" placeholder="Buscar…" value="${esc(filters.q ?? "")}">
        <select id="r-meal">${options(META.meal_types, filters.meal_type, "Toda comida")}</select>
        <select id="r-dish">${options(META.dish_types, filters.dish_type, "Todo tipo")}</select>
      </div>
      <div class="row">
        <button id="r-import">${icon("camera", 20)} Importar receta escrita</button>
        <button class="primary" id="r-new">${icon("plus", 20)} Nueva receta</button>
      </div>
    </div>
    ${recipes.length ? `<div class="grid">${recipes.map((r) => `
      <article class="card stack" data-open="${r.id}" style="cursor:pointer">
        <div class="row spread"><strong>${r.favorite ? icon("star", 18) + " " : ""}${esc(r.name)}</strong>
          <span class="muted small">${r.servings} porc.</span></div>
        <div class="row small">${r.meal_types.map((m) => `<span class="badge accent">${esc(m)}</span>`).join("")}
          <span class="badge">${esc(r.dish_type)}</span>
          ${r.disliked ? `<span class="badge bad" title="La probaron y no les gustó: la IA no la vuelve a proponer">No les gustó</span>`
            : r.trial ? `<span class="badge warn" title="Idea de la IA que entró al menú: todavía no es receta de la casa">${icon("spark", 14)} De prueba</span>` : ""}
          ${r.prep_minutes ? `<span class="muted">${icon("clock", 16)} ${r.prep_minutes} min</span>` : ""}</div>
        ${coverageBar(r.coverage)}
      </article>`).join("")}</div>`
      : `<div class="empty card">Todavía no hay recetas. Agreguen las que cocinan en casa, con sus cantidades,
          o importen una foto de su cuaderno de recetas.</div>`}`;

  const reload = () => safe(() => renderRecipes({ q: $("#r-q").value, meal_type: $("#r-meal").value, dish_type: $("#r-dish").value }));
  $("#r-q").onchange = reload;
  $("#r-meal").onchange = reload;
  $("#r-dish").onchange = reload;
  $("#r-new").onclick = () => recipeForm();
  $("#r-import").onclick = importDialog;
  $$("[data-open]", view).forEach((c) => c.onclick = () => showRecipe(+c.dataset.open));
}

const STATUS_ICON = { ok: ["check", "st-ok"], hay: ["check", "st-ok"], justo: ["check", "st-ok"], basico: ["check", "st-basic"], poco: ["dot", "st-poco"], falta: ["close", "st-falta"] };
const STATUS_TEXT = { ok: "hay suficiente", hay: "hay, pero en otra unidad: agrega su equivalencia en la despensa", justo: "hay casi todo: alcanza", basico: "básico: se da por hecho que hay", poco: "no alcanza", falta: "no hay" };

async function showRecipe(id, adults, kids) {
  if (adults == null) ({ adults, kids } = house());
  kids = kids || 0;
  const r = await api(`/api/recipes/${id}?servings=${adults}&kids=${kids}`);
  const byId = Object.fromEntries(r.availability.items.map((i) => [i.ingredient_id, i]));
  openModal(`
    <div class="modal-head">
      <div><h2>${r.favorite ? icon("star", 18) + " " : ""}${esc(r.name)}</h2>
        <div class="row small">${r.meal_types.map((m) => `<span class="badge accent">${esc(m)}</span>`).join("")}
          <span class="badge">${esc(r.dish_type)}</span>
          ${r.prep_minutes ? `<span class="muted">${icon("clock", 16)} ${r.prep_minutes} min</span>` : ""}
          <span class="muted">Receta original: ${r.servings} porciones de adulto</span></div></div>
      <button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button>
    </div>
    ${r.trial ? `<div class="row spread trial-note" style="margin-top:.75rem">
      <span>${icon("spark", 18)} ${r.disliked ? "Idea de la IA que no les gustó: no se vuelve a proponer." : "Idea de la IA, de prueba: no se usa para armar el menú hasta que la guarden."}</span>
      <span class="row"><button class="primary" data-verdict="yes">${icon("heart", 18)} Guardar en las recetas de la casa</button>
        ${r.disliked ? "" : `<button data-verdict="no">No nos gustó</button>`}</span></div>` : ""}
    <div class="row" style="margin:.75rem 0">
      <span>Para</span>
      <button data-w="a" data-d="-1" aria-label="Menos adultos">${icon("minus", 18)}</button><strong>${adults}</strong><button data-w="a" data-d="1" aria-label="Más adultos">${icon("plus", 18)}</button>
      <span>adulto${adults === 1 ? "" : "s"}</span>
      <button data-w="k" data-d="-1" aria-label="Menos niños">${icon("minus", 18)}</button><strong>${kids}</strong><button data-w="k" data-d="1" aria-label="Más niños">${icon("plus", 18)}</button>
      <span>niño${kids === 1 ? "" : "s"}</span>
      ${r.factor !== 1 ? `<span class="badge">× ${fmtQty(r.factor)}</span>` : ""}
      ${r.availability.can_cook ? `<span class="badge ok">Hay todo en casa</span>` : `<span class="badge bad">Faltan ${r.availability.missing_count}</span>`}
    </div>
    <h3>Ingredientes</h3>
    <ul class="clean">${r.ingredients.map((i) => {
      const a = byId[i.ingredient_id];
      return `<li><span class="ing-status ${STATUS_ICON[a.status][1]}" title="${STATUS_TEXT[a.status]}">${icon(STATUS_ICON[a.status][0], 20)}</span>
        <strong>${i.quantity ? esc(fmtAmount(i.quantity, i.unit)) : ""}</strong> ${esc(i.name)}
        ${i.note ? `<span class="muted">— ${esc(i.note)}</span>` : ""}
        ${i.optional ? `<span class="badge">opcional</span>` : ""}
        ${a.have != null ? `<span class="muted small">(hay: ${esc(fmtAmount(a.have, a.have_unit).replace(/^Para /, "para "))})</span>` : ""}</li>`;
    }).join("")}</ul>
    ${r.instructions ? `<h3>Preparación</h3><div class="instructions">${esc(r.instructions)}</div>` : ""}
    ${r.notes ? `<h3>Notas de la casa</h3><div class="instructions muted">${esc(r.notes)}</div>` : ""}
    <div class="row" style="margin-top:1rem">
      <button class="primary" id="cooked">${icon("check", 20)} La cociné (descontar de la despensa)</button>
      <button id="edit">Editar</button>
      <button class="danger" id="del">Eliminar</button>
    </div>`);

  $("#x").onclick = closeModal;
  $$("[data-w]", modalBody).forEach((b) => b.onclick = () => {
    const a = Math.max(0, adults + (b.dataset.w === "a" ? +b.dataset.d : 0));
    const k = Math.max(0, kids + (b.dataset.w === "k" ? +b.dataset.d : 0));
    if (a + k >= 1) safe(() => showRecipe(id, a, k));
  });
  $$("[data-verdict]", modalBody).forEach((b) => b.onclick = () => safe(async () => {
    await api(`/api/recipes/${id}/verdict`, { method: "POST", json: { verdict: b.dataset.verdict } });
    toast(b.dataset.verdict === "yes" ? `«${r.name}» ya es una receta de la casa` : "No se vuelve a proponer");
    showRecipe(id, adults, kids);
    refresh();
  }));
  $("#edit").onclick = () => safe(async () => recipeForm(await api(`/api/recipes/${id}`)));
  $("#del").onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Eliminar la receta?", text: `«${esc(r.name)}» se borra y también se quita del menú.`, ok: "Eliminar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/recipes/${id}`, { method: "DELETE" });
    closeModal();
    refresh();
  });
  $("#cooked").onclick = (ev) => safe(() => withBusy(ev.currentTarget, async () => {
    const res = await api(`/api/recipes/${id}/cook`, { method: "POST", json: { servings: adults, kids } });
    toast(`Registrado. Se descontaron ${res.pantry_changes.length} ingredientes de la despensa.`);
    closeModal();
    refresh();
  }));
}

async function recipeForm(recipe = null) {
  const ingredients = await api("/api/ingredients");
  const r = recipe ?? { name: "", meal_types: ["almuerzo"], dish_type: "plato principal", servings: META.household_size, prep_minutes: null, instructions: "", notes: "", favorite: false, ingredients: [] };
  const catByName = Object.fromEntries(ingredients.map((i) => [i.name.toLowerCase(), i.category]));
  openModal(`
    <div class="modal-head"><h2>${recipe?.id ? "Editar receta" : "Nueva receta"}</h2><button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button></div>
    <datalist id="dl-ing">${ingredients.map((i) => `<option value="${esc(i.name)}">`).join("")}</datalist>
    <datalist id="dl-unit">${META.units.concat(["diente", "pizca", "atado", "rama", "lata", "paquete"]).map((u) => `<option value="${u}">`).join("")}</datalist>
    <form id="rf" class="stack">
      <label class="field">Nombre<input name="name" required value="${esc(r.name)}" placeholder="Ej: Sancocho de la abuela"></label>
      <div class="form-grid">
        <label class="field">Tipo de plato<select name="dish_type">${options(META.dish_types, r.dish_type)}</select></label>
        <label class="field">Rinde (porciones de adulto)<input name="servings" type="number" min="1" required value="${r.servings}"></label>
        <label class="field">Tiempo (min)<input name="prep_minutes" type="number" min="0" value="${r.prep_minutes ?? ""}"></label>
      </div>
      <div class="row">Se come en: ${META.meal_types.map((m) => `
        <label class="row"><input type="checkbox" name="meal" value="${m}" ${r.meal_types.includes(m) ? "checked" : ""}> ${cap(m)}</label>`).join("")}
        <label class="row" style="margin-left:auto"><input type="checkbox" name="favorite" ${r.favorite ? "checked" : ""}> Favorita</label>
      </div>
      <h3>Ingredientes <span class="muted small">(las cantidades exactas para ${r.servings} porciones de adulto como la hacen en casa; un niño cuenta como ${fmtQty(META.kid_portion)})</span></h3>
      <div id="ing-rows" class="stack"></div>
      <div><button type="button" id="add-ing">${icon("plus", 18)} Ingrediente</button></div>
      <label class="field">Preparación (un paso por línea)<textarea name="instructions">${esc(r.instructions)}</textarea></label>
      <label class="field">Notas y trucos de la casa<textarea name="notes" style="min-height:3rem">${esc(r.notes)}</textarea></label>
      <div class="row"><button class="primary" type="submit">Guardar</button></div>
    </form>`);

  const rows = $("#ing-rows");
  const addRow = (i = { name: "", quantity: "", unit: "g", note: "", optional: false }) => {
    const div = document.createElement("div");
    div.className = "ing-row";
    div.innerHTML = `
      <input class="ing-name" list="dl-ing" placeholder="Ingrediente" value="${esc(i.name)}">
      <input class="ing-qty" type="number" step="any" min="0" placeholder="Cant." value="${i.quantity}">
      <input class="ing-unit" list="dl-unit" placeholder="Unidad" value="${esc(i.unit)}">
      <input class="ing-note" placeholder="Nota (picado…)" value="${esc(i.note)}">
      <label class="small row" title="Opcional"><input type="checkbox" class="ing-opt" ${i.optional ? "checked" : ""}>opc.</label>
      <button type="button" class="ghost danger" title="Quitar">${icon("close", 18)}</button>`;
    $("button", div).onclick = () => div.remove();
    rows.appendChild(div);
  };
  (r.ingredients.length ? r.ingredients : [undefined, undefined, undefined]).forEach((i) => addRow(i));
  $("#add-ing").onclick = () => addRow();
  $("#x").onclick = closeModal;

  $("#rf").onsubmit = (e) => {
    e.preventDefault();
    safe(() => withBusy($("button[type=submit]", e.target), async () => {
      const f = e.target;
      const lines = $$(".ing-row", rows).map((d) => ({
        name: $(".ing-name", d).value.trim(),
        quantity: parseFloat($(".ing-qty", d).value) || 0,
        unit: $(".ing-unit", d).value.trim() || "unidad",
        note: $(".ing-note", d).value.trim(),
        optional: $(".ing-opt", d).checked,
      })).filter((l) => l.name);
      lines.forEach((l) => { l.category = catByName[l.name.toLowerCase()] ?? null; });
      const meals = $$("input[name=meal]:checked", f).map((i) => i.value);
      if (!meals.length) throw new Error("Marca en qué comida se sirve");
      const body = {
        name: f.name.value.trim(), dish_type: f.dish_type.value, servings: +f.servings.value,
        prep_minutes: f.prep_minutes.value ? +f.prep_minutes.value : null, meal_types: meals,
        favorite: f.favorite.checked, instructions: f.instructions.value, notes: f.notes.value, ingredients: lines,
      };
      const saved = recipe?.id
        ? await api(`/api/recipes/${recipe.id}`, { method: "PUT", json: body })
        : await api("/api/recipes", { method: "POST", json: body });
      toast("Receta guardada");
      if (current === "recipes") await renderRecipes();
      showRecipe(saved.id);
    }));
  };
}

function importDialog() {
  openModal(`
    <div class="modal-head"><h2>Importar receta de la casa</h2><button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button></div>
    <p class="muted">Tomen una foto del cuaderno o peguen el texto. Se respetan sus cantidades;
      podrán revisar todo antes de guardar.</p>
    <form id="imp" class="stack">
      <label class="field">Foto<input type="file" name="photo" accept="image/*" capture="environment"></label>
      <label class="field">…o texto<textarea name="text" placeholder="Arroz con pollo (4 personas)&#10;- 2 tazas de arroz&#10;- 1 kg de pechuga…"></textarea></label>
      <div class="row"><button class="primary" type="submit">Leer receta</button><span id="imp-st" class="muted"></span></div>
    </form>`);
  $("#x").onclick = closeModal;
  $("#imp").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get("text")) fd.delete("text");
    if (!fd.get("photo")?.size) fd.delete("photo");
    else fd.set("photo", await compressImage(fd.get("photo")));
    if (!fd.has("text") && !fd.has("photo")) return toast("Agrega una foto o el texto");
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    $("#imp-st").textContent = "Leyendo la receta…";
    safe(async () => {
      try {
        const draft = await api("/api/recipes/import", { method: "POST", body: fd });
        await recipeForm(draft);
      } finally {
        btn.disabled = false;
        const st = $("#imp-st");
        if (st) st.textContent = "";
      }
    });
  };
}

// ------------------------------------------------------------------ despensa

const INVENTORY_MODES = [
  ["tranquilo", "Tranquilo", "Si hay algo, alcanza. Para no llevar la cuenta exacta."],
  ["normal", "Normal", "Si hay casi todo (tres cuartas partes), alcanza. Recomendado."],
  ["exacto", "Exacto", "Cuenta gramo a gramo y no da nada por hecho."],
];

// Despensa: primero se lee (lo que pide atención y lo que hay, por los grupos de la tablet) y se
// edita con un toque en una ventana. La configuración (modo y básicos) queda en el botón de ajustes.
let pantryQuery = "";

function whenExpires(i) {
  if (i.days_left == null) return "";
  const d = i.days_left;
  return d < 0 ? "ya venció" : d === 0 ? "vence hoy" : d === 1 ? "vence mañana" : d <= 7 ? `vence en ${d} días`
    : `vence el ${new Date(i.expires_on + "T12:00").toLocaleDateString("es-CO", { day: "numeric", month: "short" })}`;
}

async function renderPantry() {
  const [items, ingredients] = await Promise.all([api("/api/pantry"), api("/api/ingredients")]);
  const groups = META.inventory_groups;
  const groupOf = (cat) => groups.find((g) => g.categories.includes(cat)) ?? groups[groups.length - 1];
  const out = items.filter((i) => i.quantity <= 0);
  const low = items.filter((i) => i.quantity > 0 && i.low);
  const expiring = items.filter((i) => i.quantity > 0 && i.expiring);
  const has = items.filter((i) => i.quantity > 0);
  const q = pantryQuery.trim().toLowerCase();
  const match = (i) => !q || i.name.toLowerCase().includes(q);

  const chip = (i, tone, text) => `<button class="p-chip ${tone}" data-item="${i.id}">${esc(i.name)}<small>${esc(text)}</small></button>`;
  const attention = [
    ...out.map((i) => chip(i, "bad", "se acabó")),
    ...low.map((i) => chip(i, "warn", "queda poco")),
    ...expiring.map((i) => chip(i, "warn", whenExpires(i))),
  ];
  const line = (i) => {
    const extra = [whenExpires(i), i.min_quantity != null ? `avisa si baja de ${fmtAmount(i.min_quantity, i.unit)}` : ""].filter(Boolean);
    return `<button class="p-line ${i.expiring ? "soon" : ""} ${i.low ? "low" : ""}" data-item="${i.id}">
      <span class="p-name">${esc(i.name)}</span>
      <span class="p-dots" aria-hidden="true"></span>
      <span class="p-qty">${i.quantity > 0 ? esc(fmtAmount(i.quantity, i.unit)) : "se acabó"}</span>
      ${extra.length ? `<small class="p-extra">${esc(extra.join(" · "))}</small>` : ""}
    </button>`;
  };
  const byGroup = groups.map((g) => ({ g, list: has.filter((i) => groupOf(i.category).key === g.key && match(i)) })).filter((x) => x.list.length);
  const outShown = out.filter(match);

  view.innerHTML = `
    <div class="p-bar">
      <label class="p-search">${icon("search", 20)}<input id="p-q" type="search" placeholder="Buscar en la despensa…" value="${esc(pantryQuery)}" autocomplete="off"></label>
      <button id="add-p">${icon("plus", 20)} Agregar</button>
      <button class="primary" id="scan">${icon("camera", 20)} Foto</button>
      <button class="ghost p-settings" id="p-set" title="Ajustes de la despensa" aria-label="Ajustes de la despensa">${icon("sliders", 22)}</button>
    </div>
    ${!q ? `<section class="card p-attn ${attention.length ? "" : "calm"}">
      ${attention.length ? `<h2>${icon("warn", 22)} Ojo con esto</h2><div class="p-chips">${attention.join("")}</div>
        ${expiring.length ? `<a href="#" id="use-exp" class="small">Ver qué cocinar con lo que se vence</a>` : ""}`
      : `<h2>${icon("check", 22)} Todo en orden</h2><p class="muted small" style="margin:0">Nada agotado, nada por vencer.</p>`}
    </section>` : ""}
    ${byGroup.length ? `<div class="p-groups">${byGroup.map(({ g, list }) => `
      <section class="card p-group g-${g.key}">
        <h3><span class="p-gic">${icon(g.icon, 22)}</span>${esc(g.label)}<small>${list.length}</small></h3>
        ${list.map(line).join("")}
      </section>`).join("")}</div>`
    : `<div class="empty card">${q ? `No hay nada que se llame «${esc(pantryQuery)}».` : "La despensa está vacía. Agreguen lo que hay a mano o con una foto de la nevera."}</div>`}
    ${outShown.length ? `<details class="card p-out" ${q ? "open" : ""}><summary>Se acabaron <small>${outShown.length}</small></summary>
      ${outShown.map(line).join("")}</details>` : ""}`;

  const byId = (id) => items.find((i) => i.id === +id);
  $$("[data-item]", view).forEach((b) => b.onclick = () => pantryItemForm(byId(b.dataset.item)));
  const qInput = $("#p-q");
  qInput.oninput = () => {
    pantryQuery = qInput.value;
    const pos = qInput.selectionStart;
    renderPantry().then(() => { const n = $("#p-q"); n.focus(); n.setSelectionRange(pos, pos); });
  };
  $("#add-p").onclick = () => pantryAddForm();
  $("#scan").onclick = scanDialog;
  $("#p-set").onclick = () => pantrySettings(ingredients);
  $("#use-exp")?.addEventListener("click", (e) => { e.preventDefault(); go("cook"); });
}

function pantryAddForm() {
  const mode = META.inventory_mode ?? "normal";
  const m = formModal({
    title: "Agregar a la despensa",
    body: `<form id="pf" class="stack">
      <label class="field">¿Qué es?<input name="name" required autocomplete="off" placeholder="Ej: Leche"></label>
      <div class="field">¿Cuánto hay?${amountForm(null, null, { withUnit: true, preferPortions: mode === "tranquilo" })}</div>
      <details class="p-more"><summary>Vencimiento, aviso y categoría</summary>
        <div class="form-grid">
          <label class="field">Vence<input name="expires_on" type="date"></label>
          <label class="field">Avisar si baja de<input name="min_quantity" type="number" step="any" min="0" placeholder="Opcional"></label>
          <label class="field">Categoría<select name="category">${options(META.categories, "", "La elige la app")}</select></label>
        </div></details></form>`,
    actions: [
      { label: "Cancelar", value: false },
      { label: "Agregar", tone: "primary", icon: "plus", onClick: async (dlg) => {
        const f = $("#pf", dlg);
        if (!f.reportValidity()) return false;
        const ok = await safe(async () => {
          await api("/api/pantry", { method: "POST", json: {
            name: f.name.value, ...readAmountForm(dlg, null),
            category: f.category.value || null, expires_on: f.expires_on.value || null,
            min_quantity: f.min_quantity.value === "" ? null : parseFloat(f.min_quantity.value),
          } });
          return true;
        });
        if (!ok) return false;
        toast(`${f.name.value} agregado`);
        return true;
      } },
    ],
  });
  bindAmountForm(m.el, null);
  m.done.then((ok) => ok && renderPantry());
}

// Un producto: cuánto hay y, solo si se quiere, vencimiento, aviso de mínimo y lo técnico (categoría y equivalencias).
function pantryItemForm(i) {
  const mode = META.inventory_mode ?? "normal";
  const m = formModal({
    title: esc(i.name),
    body: `<form id="pif" class="stack">
      <div class="field">¿Cuánto hay?${amountForm(i.unit, i.quantity, { withUnit: true, preferPortions: mode === "tranquilo" })}</div>
      <label class="p-toggle"><input type="checkbox" name="has_exp" ${i.expires_on ? "checked" : ""}> Tiene fecha de vencimiento</label>
      <label class="field p-sub" data-for="has_exp" ${i.expires_on ? "" : "hidden"}>Vence<input name="expires_on" type="date" value="${i.expires_on ?? ""}"></label>
      <label class="p-toggle"><input type="checkbox" name="has_min" ${i.min_quantity != null ? "checked" : ""}> Avisarme cuando quede poco</label>
      <label class="field p-sub" data-for="has_min" ${i.min_quantity != null ? "" : "hidden"}>Pasa a la lista de compras si baja de
        <span class="row" style="gap:.5rem;flex-wrap:nowrap"><input name="min_quantity" type="number" step="any" min="0" value="${i.min_quantity ?? ""}" style="max-width:8rem">
        <span class="muted">${esc(i.unit === "porcion" ? "porciones" : i.unit)}</span></span></label>
      <details class="p-more"><summary>Más opciones</summary>
        <label class="field">Categoría<select name="category">${options(META.categories, i.category)}</select></label>
        <p class="muted small" style="margin:.2rem 0">Si las recetas lo piden en tazas o unidades pero se compra por peso, digan cuánto pesa:</p>
        <div class="form-grid">
          <label class="field">1 taza pesa (g)<input name="g_per_cup" type="number" step="any" min="0" value="${i.g_per_cup ?? ""}" placeholder="Ej: arroz 200"></label>
          <label class="field">1 unidad pesa (g)<input name="g_per_unit" type="number" step="any" min="0" value="${i.g_per_unit ?? ""}" placeholder="Ej: zanahoria 80"></label>
        </div></details>
    </form>`,
    onOpen: (dlg) => {
      bindAmountForm(dlg, i.unit);
      $$(".p-toggle input", dlg).forEach((c) => c.onchange = () => { $(`[data-for="${c.name}"]`, dlg).hidden = !c.checked; });
    },
    actions: [
      { label: "Quitar", tone: "danger", icon: "trash", value: "delete" },
      ...(i.quantity > 0 ? [{ label: "Se acabó", value: "out" }] : []),
      { label: "Guardar", tone: "primary", icon: "check", onClick: async (dlg) => {
        const f = $("#pif", dlg);
        const amount = readAmountForm(dlg, i.unit);
        const ok = await safe(async () => {
          await api(`/api/pantry/${i.id}`, { method: "PATCH", json: {
            ...amount,
            expires_on: f.has_exp.checked && f.expires_on.value ? f.expires_on.value : null,
            min_quantity: f.has_min.checked && f.min_quantity.value !== "" ? parseFloat(f.min_quantity.value) : null,
          } });
          const cup = parseFloat(f.g_per_cup.value) || null, unit = parseFloat(f.g_per_unit.value) || null;
          if (f.category.value !== i.category || cup !== i.g_per_cup || unit !== i.g_per_unit) {
            await api(`/api/ingredients/${i.ingredient_id}`, { method: "PATCH", json: { category: f.category.value, g_per_cup: cup, g_per_unit: unit } });
          }
          return true;
        });
        if (!ok) return false;
        toast(`${i.name}: guardado`);
        return true;
      } },
    ],
  });
  m.done.then(async (v) => {
    if (v === "out") {
      await safe(() => api(`/api/pantry/${i.id}`, { method: "PATCH", json: { quantity: 0 } }));
      toast(`${i.name}: se acabó`);
    }
    if (v === "delete") {
      if (!await confirmModal({ title: "¿Quitar de la despensa?", text: `«${esc(i.name)}» deja de aparecer en el inventario.`, ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
      await safe(() => api(`/api/pantry/${i.id}`, { method: "DELETE" }));
    }
    if (v) renderPantry();
  });
}

// Lo que se configura una vez: qué tan exigente es la cuenta y los básicos que siempre hay.
function pantrySettings(ingredients) {
  let mode = META.inventory_mode ?? "normal";
  const draw = (dlg) => {
    const staples = ingredients.filter((i) => i.is_staple);
    $("#pset", dlg).innerHTML = `
      <div class="field">¿Qué tan exigente con lo que hay?
        <div class="modes">${INVENTORY_MODES.map(([k, label, text]) => `
          <label class="mode ${k === mode ? "on" : ""}"><input type="radio" name="inv-mode" value="${k}" ${k === mode ? "checked" : ""}>
            <b>${label}</b><span class="small muted">${text}</span></label>`).join("")}</div></div>
      <div class="field" ${mode === "exacto" ? "hidden" : ""}>Básicos que siempre hay
        <span class="small muted" style="font-weight:400">No hace falta tenerlos en la despensa ni aparecen en la lista de compras, salvo que digan «se acabó».</span>
        <div class="row" style="gap:.4rem;margin-top:.4rem">${staples.map((i) => `
          <span class="badge ok staple">${esc(i.name)}<button type="button" class="ghost" data-unstaple="${i.id}" aria-label="Quitar ${esc(i.name)} de los básicos">${icon("close", 14)}</button></span>`).join("")}</div>
        <div class="row" style="gap:.4rem;margin-top:.5rem"><input id="staple-n" placeholder="Agregar un básico…" list="dl-ing-all" autocomplete="off" style="max-width:16rem">
          <button type="button" id="staple-add">${icon("plus", 18)} Agregar</button></div>
        <datalist id="dl-ing-all">${ingredients.filter((i) => !i.is_staple).map((i) => `<option value="${esc(i.name)}">`).join("")}</datalist>
      </div>`;
    $$("[name=inv-mode]", dlg).forEach((r) => r.onchange = () => safe(async () => {
      const res = await api("/api/settings", { method: "PUT", json: { inventory_mode: r.value } });
      META.inventory_mode = mode = res.inventory_mode;
      toast(`Modo ${INVENTORY_MODES.find(([k]) => k === mode)[1].toLowerCase()}`);
      draw(dlg);
    }));
    const reload = async () => { ingredients = await api("/api/ingredients"); draw(dlg); };
    $$("[data-unstaple]", dlg).forEach((b) => b.onclick = () => safe(async () => {
      await api(`/api/ingredients/${b.dataset.unstaple}`, { method: "PATCH", json: { staple: false } });
      await reload();
    }));
    const add = () => {
      const name = $("#staple-n", dlg).value.trim();
      if (name) safe(async () => { await api("/api/staples", { method: "POST", json: { name } }); await reload(); });
    };
    $("#staple-add", dlg).onclick = add;
    $("#staple-n", dlg).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
  };
  const m = formModal({
    title: "Ajustes de la despensa", size: "wide",
    body: `<div id="pset" class="stack"></div>`,
    onOpen: (dlg) => draw(dlg),
    actions: [{ label: "Listo", tone: "primary", icon: "check" }],
  });
  m.done.then(() => renderPantry());
}

function scanDialog() {
  openModal(`
    <div class="modal-head"><h2>Reconocer lo que hay</h2><button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button></div>
    <p class="muted">Foto de la nevera, la alacena o las compras. Se usan los nombres de sus recetas
      para que todo coincida; podrán corregir antes de guardar.</p>
    <form id="sf" class="row">
      <input type="file" name="photo" accept="image/*" capture="environment" required>
      <button class="primary" type="submit">Reconocer</button><span id="sf-st" class="muted"></span>
    </form>
    <div id="scan-result"></div>`);
  $("#x").onclick = closeModal;
  $("#sf").onsubmit = (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    $("#sf-st").textContent = "Mirando la foto…";
    safe(async () => {
      try {
        const fd = new FormData();
        fd.append("photo", await compressImage(e.target.photo.files[0]));
        const res = await api("/api/pantry/scan", { method: "POST", body: fd });
        showScanResult(res);
      } finally {
        btn.disabled = false;
        const st = $("#sf-st");
        if (st) st.textContent = "";
      }
    });
  };
}

function showScanResult(res) {
  const box = $("#scan-result");
  if (!res.items.length) {
    box.innerHTML = `<p class="empty">No se reconocieron alimentos. ${esc(res.notes)}</p>`;
    return;
  }
  const conf = { alta: "ok", media: "warn", baja: "bad" };
  box.innerHTML = `
    ${res.notes ? `<p class="small muted">${esc(res.notes)}</p>` : ""}
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>Ingrediente</th><th>Cant.</th><th>Unidad</th><th></th></tr></thead>
      <tbody>${res.items.map((i, idx) => `
        <tr data-idx="${idx}">
          <td><input type="checkbox" class="s-ok" ${i.confidence !== "baja" ? "checked" : ""}></td>
          <td><input class="s-name" value="${esc(i.name)}"></td>
          <td><input class="s-qty" type="number" step="any" min="0" value="${i.quantity}" style="width:5rem"></td>
          <td><input class="s-unit" list="dl-units" value="${esc(i.unit)}" style="width:5rem"></td>
          <td><span class="badge ${conf[i.confidence]}">${esc(i.confidence)}</span>
            ${i.known ? "" : `<span class="badge">nuevo</span>`}</td>
        </tr>`).join("")}</tbody>
    </table></div>
    <div class="row" style="margin-top:.75rem">
      <button class="primary" id="s-save">Sumar a la despensa</button>
    </div>`;
  $("#s-save").onclick = (ev) => safe(() => withBusy(ev.currentTarget, async () => {
    const payload = $$("tr[data-idx]", box).filter((tr) => $(".s-ok", tr).checked).map((tr) => ({
      name: $(".s-name", tr).value,
      quantity: parseFloat($(".s-qty", tr).value) || 0,
      unit: $(".s-unit", tr).value || "unidad",
      category: res.items[+tr.dataset.idx].category,
    }));
    if (!payload.length) return toast("No hay nada marcado");
    await api("/api/pantry/bulk", { method: "POST", json: payload });
    closeModal();
    toast(`Se agregaron ${payload.length} ingredientes`);
    renderPantry();
  }));
}

// ------------------------------------------------------------------ compras

async function renderShopping() {
  const start = isoDate(weekStart);
  const list = await api(`/api/shopping-list?start=${start}&days=7`);
  view.innerHTML = `
    <div class="card row spread" style="margin-bottom:.75rem">
      <div class="row">
        <button id="prev" aria-label="Semana anterior">${icon("back", 20)}</button>
        <strong>Compras para la semana del ${weekStart.toLocaleDateString("es", { day: "numeric", month: "long" })}</strong>
        <button id="next" aria-label="Semana siguiente">${icon("chevron", 20)}</button>
      </div>
      <div class="row">
        <button id="copy" ${list.length ? "" : "disabled"}>Copiar lista</button>
        <button class="primary" id="bought" ${list.length ? "" : "disabled"}>Ya lo compré → a la despensa</button>
      </div>
    </div>
    ${list.length ? `<div class="card"><p class="small muted" style="margin-top:0">Lo que falta para el menú
      (descontando la despensa), lo que bajó de su mínimo y lo anotado a mano.</p>
      <ul class="clean">${list.map((i, idx) => `
        ${idx === 0 || list[idx - 1].category !== i.category ? `<li><strong class="muted small">${esc(i.category === "anotado" ? "Anotado a mano" : cap(i.category))}</strong></li>` : ""}
        <li><label class="row">
          <input type="checkbox" data-idx="${idx}">
          ${i.quantity != null ? `<strong>${fmtQty(i.quantity)} ${esc(fmtUnit(i.quantity, i.unit))}</strong>` : ""} ${esc(i.name)}
          <span class="muted small">— ${esc(i.recipes.length ? i.recipes.join(", ") : REASON_TEXT[i.reason])}</span>
          ${i.extra_id ? `<button class="ghost danger" data-rm="${i.extra_id}" title="Quitar">${icon("close", 18)}</button>` : ""}
        </label></li>`).join("")}</ul></div>`
      : `<div class="empty card">No falta nada para el menú de esta semana.<br>
          <span class="small">(Si el menú está vacío, planéenlo primero en la pestaña Menú.)</span></div>`}`;

  $("#prev").onclick = () => { weekStart = addDays(weekStart, -7); refresh(); };
  $("#next").onclick = () => { weekStart = addDays(weekStart, 7); refresh(); };
  $("#copy").onclick = () => {
    const text = list.map((i) => `☐ ${i.quantity != null ? `${fmtQty(i.quantity)} ${i.unit} ` : ""}${i.name}`).join("\n");
    navigator.clipboard?.writeText(text).then(() => toast("Lista copiada"), () => toast("No se pudo copiar"));
  };
  $$("[data-rm]", view).forEach((b) => b.onclick = (e) => safe(async () => {
    e.preventDefault();
    await api(`/api/shopping/extra/${b.dataset.rm}`, { method: "DELETE" });
    refresh();
  }));
  $("#bought").onclick = (ev) => safe(async () => {
    const btn = ev.currentTarget;
    const checked = $$("input[data-idx]:checked", view).map((c) => list[+c.dataset.idx]);
    const items = checked.length ? checked : list;
    if (!await confirmModal({
      title: checked.length ? "¿Pasar lo marcado a la despensa?" : "¿Pasar toda la lista a la despensa?",
      text: checked.length ? `${checked.length} productos se suman a la despensa.` : "No marcaste nada, así que se suma toda la lista.",
      ok: "Pasar a la despensa",
    })) return;
    await withBusy(btn, () => api("/api/pantry/bulk", { method: "POST", json: items.map(toPantryLine) }));
    toast(`${items.length} ingredientes agregados a la despensa`);
    refresh();
  });
}

// ------------------------------------------------------------------ casa: personas, tareas, gastos

// ---------------------------------------------------------------- horario de una tarea

// ---------------------------------------------------------------- modelos de IA

function aiRow(role, label, hint) {
  const a = META.ai[role];
  return `<div class="ai-row" data-role="${role}">
    <div class="row spread"><b>${label} · ${a.provider}</b>
      <span class="badge ${a.configured ? "ok" : "warn"}">${a.configured ? "Clave puesta" : `Falta ${a.key_env}`}</span></div>
    <p class="muted small" style="margin:.1rem 0 .4rem">${hint}</p>
    <label class="field">Modelo
      <input data-ai-model list="dl-ai-${role}" value="${esc(a.model)}" autocomplete="off" spellcheck="false" placeholder="${esc(a.default)}"></label>
    <datalist id="dl-ai-${role}"></datalist>
    <div class="row" style="margin-top:.4rem"><button data-ai-test>${icon("check", 18)} Probar</button>
      <span class="small muted" data-ai-status></span></div>
  </div>`;
}

function bindAI() {
  $$(".ai-row", view).forEach((row) => {
    const role = row.dataset.role;
    const status = (text, tone = "") => { const el = $("[data-ai-status]", row); el.textContent = text; el.className = `small ${tone || "muted"}`; };
    if (META.ai[role].configured) {
      api(`/api/ai/models?role=${role}`).then(({ models }) => {
        $(`#dl-ai-${role}`).innerHTML = models.map((m) => `<option value="${esc(m)}">`).join("");
        if (models.length) status(`${models.length} modelos disponibles con su clave`);
      }).catch((e) => status(e.message, "bad-text"));
    }
    $("[data-ai-model]", row).onchange = (e) => safe(async () => {
      const value = e.target.value.trim() || META.ai[role].default;
      const res = await api("/api/settings", { method: "PUT", json: { [`ai_${role}_model`]: value } });
      const before = META.ai[role].provider;
      META.ai = res.ai;
      e.target.value = META.ai[role].model;
      toast(`Modelo de ${META.ai[role].provider}: ${META.ai[role].model}`);
      if (META.ai[role].provider !== before) renderHouse();  // cambió de proveedor: su clave y su lista
    });
    $("[data-ai-test]", row).onclick = (e) => withBusy(e.currentTarget, async () => {
      status("Probando…");
      try {
        const res = await api("/api/ai/test", { method: "POST", json: { role } });
        status(`Funciona: ${res.model} respondió en ${res.seconds} s`, "ok-text");
      } catch (err) {
        status(err.message, "bad-text");
      }
    });
  });
}

// ---------------------------------------------------------------- calendario de Google

async function renderGCal() {
  const card = $("#gcal-card");
  if (!card) return;
  const g = await api("/api/gcal");
  const synced = g.last_sync ? new Date(g.last_sync) : null;
  const when = synced && !Number.isNaN(synced.getTime()) ? synced.toLocaleString("es", { dateStyle: "medium", timeStyle: "short" }) : null;
  let body;
  if (!g.credentials) {
    body = `<p class="muted small" style="margin:0">La agenda de la tablet se puede sincronizar con el calendario que la familia ya comparte en Google:
        lo que anoten en el celular aparece en la tablet (y se avisa en voz alta), y lo que anoten aquí o por voz aparece en los celulares.</p>
      <ol class="small steps">
        <li>En <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud</a>, creen un proyecto, activen la
          <b>Google Calendar API</b> y creen una <b>cuenta de servicio</b> con una clave JSON.</li>
        <li>Guarden ese archivo en el computador de la casa y pongan su ruta en <code>MYCHEF_GOOGLE_CREDENTIALS</code>. Reinicien la app.</li>
        <li>Vuelvan aquí: les diremos con qué correo compartir el calendario.</li>
      </ol>
      <span class="badge warn">Falta MYCHEF_GOOGLE_CREDENTIALS</span>`;
  } else {
    body = `<div class="field">1. En Google Calendar, abran <b>Configuración y uso compartido</b> del calendario de la familia y compártanlo con este correo,
        con permiso de <b>Hacer cambios en los eventos</b>:
        <div class="row" style="margin-top:.35rem"><code class="g-email">${esc(g.service_email ?? "")}</code>
          <button class="ghost" id="g-copy">${icon("check", 16)} Copiar</button></div></div>
      <label class="field">2. En esa misma página, copien el <b>ID del calendario</b> (en «Integrar el calendario») y péguenlo aquí:
        <input id="g-cal" value="${esc(g.calendar_id)}" placeholder="…@group.calendar.google.com" autocomplete="off" spellcheck="false"></label>
      <div class="row">
        <button class="primary" id="g-connect">${icon("calendar", 18)} ${g.enabled ? "Guardar" : "Conectar"}</button>
        ${g.enabled ? `<button id="g-sync-now">${icon("undo", 18)} Sincronizar ahora</button>
          <button class="ghost danger" id="g-off">Desconectar</button>` : ""}
      </div>
      ${g.enabled ? `<p class="small ${g.error ? "bad-text" : "ok-text"}" style="margin:0">${g.error ? esc(g.error)
        : `Conectado${g.calendar_name ? ` a «${esc(g.calendar_name)}»` : ""}${when ? ` · última sincronización: ${esc(when)}` : ""}`}</p>
        <p class="muted small" style="margin:0">Se sincroniza sola cada 5 minutos mientras la tablet está prendida, y al momento cuando se anota algo aquí.</p>` : ""}`;
  }
  card.innerHTML = `<h2>Calendario de Google</h2>${body}`;
  $("#g-copy", card)?.addEventListener("click", () =>
    navigator.clipboard?.writeText(g.service_email).then(() => toast("Correo copiado"), () => toast("No se pudo copiar")));
  $("#g-connect", card)?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    const ok = await safe(() => api("/api/gcal", { method: "PUT", json: { calendar_id: $("#g-cal", card).value.trim() } }));
    if (ok) toast("Calendario conectado");
    renderGCal();
  }));
  $("#g-sync-now", card)?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    const r = await safe(() => api("/api/gcal/sync", { method: "POST" }));
    if (r) toast(`Listo: ${r.up} subidos, ${r.down} traídos de Google`);
    renderGCal();
  }));
  $("#g-off", card)?.addEventListener("click", async () => {
    if (!await confirmModal({ title: "¿Dejar de sincronizar?", text: "Lo que ya está en la agenda se queda, aquí y en Google. Solo dejan de pasarse los cambios.", ok: "Desconectar", tone: "danger" })) return;
    await safe(() => api("/api/gcal", { method: "DELETE" }));
    renderGCal();
  });
}

async function renderHouse() {
  const [members, stats, spend, kids] = await Promise.all([
    api("/api/members"), api("/api/chores/stats"), api("/api/purchases"), api("/api/kids"),
  ]);
  const kidOf = (m) => kids.find((k) => k.member.id === m.id);

  const portion = [0.25, 0.5, 0.75, 1].includes(META.kid_portion) ? META.kid_portion : 0.5;
  view.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      <section class="card stack">
        <h2>¿Quiénes comen en casa?</h2>
        <div class="form-grid household-card">
          <label class="field">Adultos<input id="household" type="number" min="1" max="50" value="${META.household_size}"></label>
          <label class="field">Niños<input id="household-kids" type="number" min="0" max="20" value="${META.household_kids}"></label>
          <label class="field">Un niño come<select id="kid-portion">${[[0.25, "¼ de porción"], [0.5, "½ porción"], [0.75, "¾ de porción"], [1, "igual que un adulto"]]
            .map(([v, t]) => `<option value="${v}" ${v === portion ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        </div>
        <p class="muted small" style="margin:0">Con esto se calculan las cantidades del menú y de las recetas. Cada comida se puede cambiar aparte.</p>
        ${members.length ? `<div class="stack" style="border-top:1px dashed var(--line);padding-top:.75rem;gap:.6rem">
          <p class="small" style="margin:0"><b>¿Alguna comida es solo de algunos?</b> <span class="muted">Sin marcar a nadie, come toda la casa.</span></p>
          ${META.meal_types.map((meal) => `<div class="field">${esc(cap(meal))}
            <div class="seg" data-meal-people="${meal}">${members.map((m) => `
              <label><input type="checkbox" value="${m.id}" ${(META.meal_people[meal] ?? []).includes(m.id) ? "checked" : ""}><span>${esc(m.name)}</span></label>`).join("")}</div></div>`).join("")}
        </div>` : ""}
      </section>
      <section class="card stack">
        <h2>La casa</h2>
        <div class="row spread"><span style="font-family:var(--serif);font-size:1.3rem">${esc(META.house_name)}</span>
          <button id="house-name">${icon("pencil", 18)} Cambiar nombre</button></div>
        <p class="muted small" style="margin:0">Es el nombre que aparece arriba en la pantalla de la tablet.</p>
        <div class="row spread" style="border-top:1px dashed var(--line);padding-top:.75rem">
          <span>Palabra de activación: <b>«${esc(META.wake_word)}»</b></span>
          <button id="wake-word">${icon("mic", 18)} Cambiar</button></div>
        <p class="muted small" style="margin:0">Se dice antes de un comando de voz, por ejemplo «${esc(META.wake_word)}, se acabó la leche».</p>
        ${VOICE_SUPPORTED ? `<label class="row spread"><span>Escuchar «${esc(META.wake_word)}» en este aparato</span>
          <input type="checkbox" id="wake-on" style="width:1.4rem;height:1.4rem"></label>
        <p class="muted small" style="margin:0">Se activa en cada tablet por separado: háganlo desde la tablet de la nevera.
          Mientras está activo, la pantalla de la casa escucha sin tener que tocarla.</p>` : ""}
        <div id="logout-row"></div>
      </section>
      <section class="card stack" id="voice-card">
        <h2>Voz de esta tablet</h2>
        <p class="muted small" style="margin:0">Cómo contesta en voz alta. Se guarda solo en este aparato: háganlo desde la tablet de la nevera.</p>
        <label class="row spread"><span>Contestar en voz alta</span><input type="checkbox" id="v-on" style="width:1.4rem;height:1.4rem"></label>
        <label class="field">Voz<select id="v-voice"><option value="">Cargando voces…</option></select></label>
        <label class="field">Velocidad<select id="v-rate">
          <option value="0.85">Despacio</option><option value="1">Normal</option><option value="1.15">Más rápido</option></select></label>
        <div><button id="v-test">${icon("speaker", 18)} Probar</button></div>
      </section>
      <section class="card stack" id="ai-card">
        <h2>Inteligencia artificial</h2>
        ${aiRow("photo", "Fotos", "Facturas, nevera, alacena y recetas en foto. Siempre con Gemini.")}
        ${aiRow("text", "Voz", "Frases que la tablet no entendió y la agenda por voz. Mejor un modelo rápido (gemini-2.5-flash-lite).")}
        ${aiRow("menu", "Menú y recetas", "Ideas del menú del domingo, el cuestionario de «Cómo comemos» y recetas escritas. Mejor calidad (gemini-2.5-flash).")}
        <p class="muted small" style="margin:0">Con la clave de Gemini (<code>GEMINI_API_KEY</code>) alcanza para todo. Si prefieren OpenAI para el texto,
          elijan un modelo «gpt-…» y pongan <code>OPENAI_API_KEY</code>. Las claves se ponen en el computador de la casa (variables de entorno), no aquí.</p>
      </section>
      <section class="card stack" id="gcal-card"><h2>Calendario de Google</h2><p class="muted small">Cargando…</p></section>
      <section class="card stack">
        <h2>Personas de la casa</h2>
        <ul class="clean">${members.map((m) => `
          <li class="row spread"><span class="row" style="font-size:1.05rem">${avatar(m, 32)} ${esc(m.name)}</span>
            <span class="row"><span class="muted small">${stats.find((s) => s.id === m.id)?.done ?? 0} tareas en 30 días</span>
            <label class="row small" title="Sus tareas le dan estrellas y tiene su pantalla de logros"><input type="checkbox" data-kid-m="${m.id}" ${m.kid ? "checked" : ""}> Niño/a</label>
            ${kidOf(m) ? `<button class="prize-btn" data-go-prizes title="Su premio está en la pestaña Premios">
              <span class="prize-mini">${prizeArt(kidOf(m).goal, 22)}</span>${kidOf(m).goal ? `${kidOf(m).stars}/${kidOf(m).goal.stars} ★` : "Poner premio"}</button>` : ""}
            <button class="ghost danger" data-del-m="${m.id}" title="Quitar">${icon("close", 18)}</button></span></li>`).join("") || `<li class="muted">Aún no hay nadie.</li>`}
        </ul>
        <div><button id="add-m">${icon("plus", 20)} Agregar persona</button></div>
      </section>
      <section class="card stack">
        <h2>Gastos en compras</h2>
        <div><span style="font-size:1.6rem;font-weight:700">${fmtMoney(spend.month_total)}</span>
          <span class="muted"> este mes · ${spend.month_count} compras</span></div>
        <ul class="clean small">${spend.recent.map((p) => `
          <li class="row spread"><span>${esc(p.store || "Compra")} · ${new Date(p.day + "T12:00").toLocaleDateString("es")}</span>
            <span>${fmtMoney(p.total)} <span class="muted">(${p.items} productos)</span></span></li>`).join("") || `<li class="muted">Escaneen una factura desde la pantalla de la casa.</li>`}</ul>
      </section>
    </div>`;

  $("#house-name").onclick = () => {
    formModal({
      title: "Nombre de la casa", size: "narrow",
      body: `<label class="field">¿Cómo le dicen a su casa?<input id="hn" value="${esc(META.house_name)}" maxlength="60"></label>`,
      actions: [
        { label: "Cancelar", value: false },
        { label: "Guardar", tone: "primary", icon: "check", onClick: async (dlg) => {
          const res = await safe(() => api("/api/settings", { method: "PUT", json: { house_name: $("#hn", dlg).value } }));
          if (!res) return false;
          META.house_name = res.house_name;
          document.title = `${META.house_name} · Administrar`;
          $("#house-title").textContent = META.house_name;
          renderHouse();
        } },
      ],
    });
  };
  $$("#household, #household-kids, #kid-portion", view).forEach((inp) => inp.addEventListener("change", () => safe(async () => {
    const adults = parseInt($("#household").value, 10);
    const kids = parseInt($("#household-kids").value, 10) || 0;
    if (!adults || adults < 1) return toast("Tiene que haber al menos un adulto");
    const res = await api("/api/settings", { method: "PUT", json: {
      household_size: adults, household_kids: kids, kid_portion: parseFloat($("#kid-portion").value),
    } });
    Object.assign(META, res);
    setHouse(META);
    toast(`En casa comen ${peopleText(adults, kids)}`);
  })));
  $$("[data-meal-people] input", view).forEach((inp) => inp.addEventListener("change", () => safe(async () => {
    const meal = inp.closest("[data-meal-people]").dataset.mealPeople;
    const ids = $$(`[data-meal-people="${meal}"] input:checked`, view).map((i) => +i.value);
    const res = await api("/api/settings", { method: "PUT", json: { meal_people: { ...META.meal_people, [meal]: ids } } });
    META.meal_people = res.meal_people;
    const who = ids.map((id) => members.find((m) => m.id === id)?.name).filter(Boolean);
    toast(who.length ? `${cap(meal)}: solo ${who.join(" y ")}` : `${cap(meal)}: toda la casa`);
  })));
  const vp = getVoicePrefs();
  $("#v-on").checked = vp.on;
  $("#v-rate").value = String([0.85, 1, 1.15].includes(vp.rate) ? vp.rate : 1);
  onVoicesReady((voices) => {
    const sel = $("#v-voice");
    if (!sel) return;
    const cur = getVoicePrefs().uri;
    sel.innerHTML = voices.length
      ? `<option value="">Automática (${esc(voices[0].name)})</option>` + voices.map((v) => `
          <option value="${esc(v.voiceURI)}" ${v.voiceURI === cur ? "selected" : ""}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? "" : " · con internet"}</option>`).join("")
      : `<option value="">Este navegador no tiene voces en español</option>`;
  });
  $("#v-on").onchange = (e) => { setVoicePrefs({ on: e.target.checked }); toast(e.target.checked ? "Va a contestar en voz alta" : "Solo va a contestar por escrito"); };
  $("#v-voice").onchange = (e) => { setVoicePrefs({ uri: e.target.value }); speak("Hola, así sueno yo.", { force: true }); };
  $("#v-rate").onchange = (e) => { setVoicePrefs({ rate: +e.target.value }); speak("Hola, así de rápido hablo.", { force: true }); };
  $("#v-test").onclick = () => speak(`Hola, soy ${META.house_name}. Hoy hay arroz con pollo de almuerzo.`, { force: true });
  bindAI();
  renderGCal();
  api("/api/auth").then((a) => {
    if (!a.mode) return;
    const row = $("#logout-row");
    row.className = "row spread";
    row.style.cssText = "border-top:1px dashed var(--line);padding-top:.75rem";
    row.innerHTML = `<span class="muted small">${a.mode === "password" ? "Entraron con usuario y contraseña." : "Entraron con el PIN de la casa."}</span>
      <button class="ghost" id="logout">Cerrar sesión aquí</button>`;
    $("#logout").onclick = async () => {
      if (!await confirmModal({ title: "¿Cerrar sesión en este aparato?", text: "Para volver a entrar se piden otra vez los datos. Los demás aparatos siguen igual.", ok: "Cerrar sesión" })) return;
      await api("/api/logout", { method: "POST" });
      location.reload();
    };
  }).catch(() => {});
  const wakeBox = $("#wake-on");
  if (wakeBox) {
    try { wakeBox.checked = localStorage.getItem(WAKE_KEY) === "1"; } catch { /* sin almacenamiento */ }
    wakeBox.onchange = () => {
      try { localStorage.setItem(WAKE_KEY, wakeBox.checked ? "1" : "0"); } catch { /* sin almacenamiento */ }
      toast(wakeBox.checked ? `Listo: al volver a la pantalla de la casa, digan «${META.wake_word}»` : `«${META.wake_word}» apagado en este aparato`, 4000);
    };
  }
  $("#wake-word").onclick = () => {
    formModal({
      title: "Palabra de activación", size: "narrow",
      body: `<label class="field">¿Cómo le hablan a la casa?<input id="ww" value="${esc(META.wake_word)}" maxlength="40"></label>
        <p class="muted small">Mejor dos palabras que no se digan por casualidad: «Oye casa», «Oye Lupita», «Hola nevera».</p>`,
      actions: [
        { label: "Cancelar", value: false },
        { label: "Guardar", tone: "primary", icon: "check", onClick: async (dlg) => {
          const res = await safe(() => api("/api/settings", { method: "PUT", json: { wake_word: $("#ww", dlg).value } }));
          if (!res) return false;
          META.wake_word = res.wake_word;
          renderHouse();
        } },
      ],
    });
  };
  $("#add-m").onclick = () => {
    formModal({
      title: "Agregar persona",
      body: `<form id="mf" class="stack">
        <label class="field">Nombre<input name="name" required maxlength="40" autocomplete="off" placeholder="Ej: Sofi"></label>
        <label class="row"><input type="checkbox" name="kid"> Es niño o niña</label>
        <p class="muted small" style="margin:0">En la tablet aparece con su inicial en un círculo de color. A los niños sus tareas
          les dan estrellas para juntar un premio (en la tablet: Tareas → Logros).</p></form>`,
      actions: [
        { label: "Cancelar", value: false },
        { label: "Agregar", tone: "primary", icon: "plus", onClick: async (dlg) => {
          const f = $("#mf", dlg);
          if (!f.reportValidity()) return false;
          const ok = await safe(() => api("/api/members", { method: "POST", json: { name: f.name.value, kid: f.kid.checked } }));
          if (!ok) return false;
          renderHouse();
        } },
      ],
    });
  };
  $$("[data-kid-m]", view).forEach((c) => c.onchange = () => safe(async () => {
    const m = members.find((x) => x.id === +c.dataset.kidM);
    await api(`/api/members/${m.id}`, { method: "PUT", json: { name: m.name, emoji: m.emoji, kid: c.checked } });
    toast(c.checked ? `${m.name} gana estrellas con sus tareas` : `${m.name} ya no está en Logros`);
    renderHouse();
  }));
  $$("[data-go-prizes]", view).forEach((b) => b.onclick = () => go("prizes"));
  $$("[data-del-m]", view).forEach((b) => b.onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Quitar a esta persona?", text: "Sus tareas quedan para cualquiera.", ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/members/${b.dataset.delM}`, { method: "DELETE" });
    renderHouse();
  }));
}

// ------------------------------------------------------------------ cómo comemos
// Lo que la IA sabe de la cocina de la casa antes de proponer recetas: dónde viven y compran, qué tanto
// arriesgar y un resumen de gustos que sale de un cuestionario (y que se puede corregir a mano).

const ADV_LABEL = { fija: "Ir a la fija", mezcla: "Un poco de todo", explorar: "Explorar sabores nuevos" };

async function renderTaste() {
  const t = await api("/api/taste");
  const stores = [...t.stores_options, ...t.stores.filter((s) => !t.stores_options.includes(s))];
  const adv = (k) => t.adventure_options.find((a) => a.key === k)?.text ?? "";
  const updated = t.updated_on ? new Date(t.updated_on + "T12:00").toLocaleDateString("es", { dateStyle: "long" }) : null;
  view.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      <section class="card stack">
        <h2>Dónde viven</h2>
        <p class="muted small" style="margin:0">Para que las recetas nuevas usen cosas que se consiguen fácil cerca de la casa.</p>
        <div class="form-grid">
          <label class="field">Ciudad<input id="t-city" value="${esc(t.city)}" maxlength="60" placeholder="Medellín"></label>
          <label class="field">Barrio<input id="t-area" value="${esc(t.area)}" maxlength="60" placeholder="Laureles"></label>
        </div>
        <div class="field">¿Dónde compran?
          <div class="seg" id="t-stores">${stores.map((s) => `
            <label><input type="checkbox" value="${esc(s)}" ${t.stores.includes(s) ? "checked" : ""}><span>${esc(s)}</span></label>`).join("")}</div></div>
        <form class="row" id="t-store-add"><input id="t-store-new" maxlength="40" placeholder="Otro lugar" style="flex:1">
          <button>${icon("plus", 18)} Agregar</button></form>
      </section>
      <section class="card stack">
        <h2>Ideas nuevas</h2>
        <p class="muted small" style="margin:0">Cuando la IA propone recetas para el menú, ¿qué tanto se arriesga?</p>
        <div class="seg" id="t-adv">${t.adventure_options.map((a) => `
          <label><input type="radio" name="adv" value="${a.key}" ${a.key === t.adventure ? "checked" : ""}><span>${ADV_LABEL[a.key]}</span></label>`).join("")}</div>
        <p class="small" id="t-adv-text" style="margin:0">${esc(adv(t.adventure))}</p>
      </section>
      <section class="card stack" style="grid-column:1/-1">
        <h2>Así comen ustedes</h2>
        ${t.summary ? `
          <p class="muted small" style="margin:0">La IA lo tiene en cuenta cada vez que propone recetas. Lo pueden corregir aquí mismo, una idea por línea.</p>
          <textarea id="t-summary" rows="${Math.min(14, t.summary.split("\n").length + 2)}" maxlength="3000">${esc(t.summary)}</textarea>
          <div class="row spread">
            <span class="muted small">${updated ? `Actualizado el ${esc(updated)}` : ""}</span>
            <span class="row"><button id="t-quiz" ${t.ai_ready ? "" : "disabled"}>${icon("spark", 18)} Rehacer el cuestionario</button>
              <button class="primary" id="t-save">${icon("check", 18)} Guardar cambios</button></span>
          </div>` : `
          <p style="margin:0">La IA lee las recetas que ya tienen y les hace unas preguntas cortas sobre cómo comen: lo que no se come en la casa,
            el picante, qué les gusta a los niños, cuánto tiempo hay para cocinar… Con eso escribe un resumen que después pueden corregir.</p>
          <div><button class="primary" id="t-quiz" ${t.ai_ready ? "" : "disabled"}>${icon("spark", 20)} Hacer el cuestionario</button></div>`}
        ${t.ai_ready ? "" : `<p class="small" style="margin:0"><span class="badge warn">Falta ${esc(META.ai.menu.key_env)}</span>
          El cuestionario usa la IA de «Menú y recetas» (Casa → Inteligencia artificial).</p>`}
      </section>
    </div>`;

  const put = (json, msg) => safe(async () => { await api("/api/taste", { method: "PUT", json }); if (msg) toast(msg); });
  $("#t-city").onchange = (e) => put({ city: e.target.value }, "Ciudad guardada");
  $("#t-area").onchange = (e) => put({ area: e.target.value }, "Barrio guardado");
  const readStores = () => $$("#t-stores input:checked").map((i) => i.value);
  $$("#t-stores input").forEach((i) => i.onchange = () => put({ stores: readStores() }));
  $("#t-store-add").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#t-store-new").value.trim();
    if (!name) return;
    await put({ stores: [...readStores(), name] });
    renderTaste();
  };
  $$("#t-adv input").forEach((i) => i.onchange = () => {
    $("#t-adv-text").textContent = adv(i.value);
    put({ adventure: i.value }, `Ideas nuevas: ${ADV_LABEL[i.value].toLowerCase()}`);
  });
  $("#t-save")?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    const ok = await safe(() => api("/api/taste", { method: "PUT", json: { summary: $("#t-summary").value } }));
    if (ok) { toast("Guardado"); renderTaste(); }
  }));
  $("#t-quiz")?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    toast("La IA está leyendo sus recetas…", 6000);
    const res = await safe(() => api("/api/taste/questions", { method: "POST" }));
    if (res) tasteQuiz(res.questions);
  }));
}

// Una pregunta por pantalla, con respuestas grandes para tocar; siempre se puede escribir otra o saltarla.
function tasteQuiz(questions) {
  const answers = questions.map(() => ({ picked: [], other: "" }));
  let i = 0;
  const m = formModal({ title: "Cómo comen ustedes", body: `<div id="quiz"></div>` });
  const box = $("#quiz", m.el);
  const save = () => {
    answers[i].picked = $$(".quiz-opts input:checked", box).map((x) => x.value);
    answers[i].other = $("#quiz-other", box).value.trim();
  };
  const draw = () => {
    const q = questions[i], a = answers[i], last = i === questions.length - 1;
    box.innerHTML = `
      <p class="muted small" style="margin:0 0 .4rem">Pregunta ${i + 1} de ${questions.length}${q.multiple ? " · pueden elegir varias" : ""}</p>
      <p class="quiz-q">${esc(q.text)}</p>
      <div class="seg quiz-opts">${q.options.map((o) => `
        <label><input type="${q.multiple ? "checkbox" : "radio"}" name="qo" value="${esc(o)}" ${a.picked.includes(o) ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>
      <label class="field" style="margin-top:.8rem">Otra respuesta<input id="quiz-other" value="${esc(a.other)}" maxlength="200" autocomplete="off"></label>
      <div class="row spread" style="margin-top:1rem">
        <button id="quiz-back" ${i ? "" : "disabled"}>${icon("back", 18)} Atrás</button>
        <button class="primary" id="quiz-next">${last ? `${icon("check", 18)} Terminar` : `Siguiente ${icon("chevron", 18)}`}</button>
      </div>`;
    $("#quiz-back", box).onclick = () => { save(); i -= 1; draw(); };
    $("#quiz-next", box).onclick = (e) => withBusy(e.currentTarget, async () => {
      save();
      if (!last) { i += 1; draw(); return; }
      const payload = questions.map((q, n) => ({
        question: q.text, answer: [...answers[n].picked, answers[n].other].filter(Boolean).join(", "),
      }));
      if (!payload.some((p) => p.answer)) return toast("Respondan al menos una pregunta");
      toast("La IA está escribiendo el resumen…", 6000);
      const ok = await safe(() => api("/api/taste/summary", { method: "POST", json: { answers: payload } }));
      if (!ok) return;
      m.close(true);
      toast("Listo: así comen ustedes");
      renderTaste();
    });
  };
  draw();
}

// ------------------------------------------------------------------ premios de los niños (pestaña propia)
// Cada tarea hecha les da estrellas; las juntan para el premio que se pone aquí. Para los que aún no
// leen, el premio lleva un ícono a color o una foto: así lo reconocen en la tablet.

async function renderPrizes() {
  const [members, kids] = await Promise.all([api("/api/members"), api("/api/kids")]);
  view.innerHTML = `
    <section class="card stack">
      <h2>Premios de los niños</h2>
      <p class="muted small" style="margin:0">Cada tarea hecha les da estrellas (1, 2 o 3, según se elija en Tareas). Los premios van en
        un mismo camino: por ejemplo a las 10 estrellas un helado, a las 15 el parque y a las 20 la bici. Al llegar a uno, se
        entrega y siguen hacia el próximo; entregar no gasta estrellas. Al entregar el último, el camino empieza otra vuelta.</p>
      ${members.length ? `<div class="kid-checks"><span class="small muted">¿Quiénes son niños?</span>${members.map((m) => `
        <label class="kid-check"><input type="checkbox" data-kid-m="${m.id}" ${m.kid ? "checked" : ""}>${avatar(m, 26)} ${esc(m.name)}</label>`).join("")}</div>`
      : `<p class="muted">Primero agreguen a las personas en la pestaña Casa.</p>`}
    </section>
    <div class="prize-cards">${kids.map((k) => {
      const claim = k.claims[0];
      return `<section class="card prize-card stack ${k.goal?.ready ? "ready" : ""}" data-kid="${k.member.id}">
        <div class="row spread"><span class="row pc-who">${avatar(k.member, 30)} ${esc(k.member.name)}</span>
          <span class="small muted row" style="gap:.3rem"><i class="ks-18">${kidStar()}</i> va en la estrella ${k.stars}${k.path ? ` de ${k.path}` : ""}</span></div>
        ${k.prizes.length ? `${kidPath(k)}${prizeRows(k)}` : `<p class="muted" style="margin:0">Todavía no tiene premios.</p>`}
        <div class="row" style="gap:.5rem;flex-wrap:wrap">
          <button class="${k.prizes.length ? "" : "primary"}" data-add-prize="${k.member.id}">${icon("plus", 18)} Agregar premio</button>
          ${claim ? `<span class="small muted">Último entregado: ${esc(claim.name)} · ${new Date(claim.day + "T12:00").toLocaleDateString("es-CO", { day: "numeric", month: "short" })}</span>
            <button class="ghost" data-unclaim="${k.member.id}">${icon("undo", 16)} Deshacer</button>` : ""}
        </div>
      </section>`;
    }).join("")}</div>`;

  const kidOf = (id) => kids.find((k) => k.member.id === +id);
  $$("[data-kid-m]", view).forEach((c) => c.onchange = () => safe(async () => {
    const m = members.find((x) => x.id === +c.dataset.kidM);
    await api(`/api/members/${m.id}`, { method: "PUT", json: { name: m.name, emoji: m.emoji, kid: c.checked } });
    toast(c.checked ? `${m.name} gana estrellas con sus tareas` : `${m.name} ya no está en Premios`);
    renderPrizes();
  }));
  $$("[data-add-prize]", view).forEach((b) => b.onclick = async () => {
    if (await prizeForm(kidOf(b.dataset.addPrize), META.prizes)) renderPrizes();
  });
  $$(".prize-card", view).forEach((card) => {
    const k = kidOf(card.dataset.kid);
    $$("[data-edit-prize]", card).forEach((b) => b.onclick = async () => {
      if (await prizeForm(k, META.prizes, k.prizes.find((p) => p.id === +b.dataset.editPrize))) renderPrizes();
    });
  });
  $$("[data-claim]", view).forEach((b) => b.onclick = () => safe(async () => {
    const k = kidOf(b.dataset.claim);
    if (!await confirmModal({ title: "¿Entregar el premio?", text: `${esc(k.member.name)} llegó a «${esc(k.goal.name)}». Sus estrellas no bajan: el camino sigue.`, ok: "Sí, entregar", okIcon: "gift" })) return;
    await api(`/api/kids/${k.member.id}/claim`, { method: "POST" });
    toast(`¡A disfrutar, ${k.member.name}!`);
    renderPrizes();
  }));
  $$("[data-unclaim]", view).forEach((b) => b.onclick = () => safe(async () => {
    const k = kidOf(b.dataset.unclaim);
    if (!await confirmModal({ title: "¿Deshacer el último premio?", text: `«${esc(k.claims[0].name)}» vuelve a quedar sin entregar.`, ok: "Sí, deshacer", okIcon: "undo" })) return;
    await api(`/api/kids/${k.member.id}/claim/undo`, { method: "POST" });
    renderPrizes();
  }));
}

// ------------------------------------------------------------------ tareas del hogar (pestaña propia)

async function renderChoresAdmin() {
  const [members, chores] = await Promise.all([api("/api/members"), api("/api/chores")]);
  const memberOpts = (sel, rotate) => `
    <option value="">Cualquiera</option>
    <option value="rotate" ${rotate ? "selected" : ""}>Por turnos</option>
    ${members.map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.name)}</option>`).join("")}`;
  // Estrellas que gana un niño (solo si hay alguien marcado como niño en Casa)
  const kids = members.some((m) => m.kid);
  const STARS = [[1, "★ Fácil"], [2, "★★ Normal"], [3, "★★★ Grande"]];
  const starOpts = (sel) => STARS.map(([n, t]) => `<option value="${n}" ${n === sel ? "selected" : ""}>${t}</option>`).join("");

  view.innerHTML = `
    <section class="card stack" >
      <h2>Tareas del hogar</h2>
      <table><thead><tr><th></th><th>Tarea</th><th>¿Cuándo?</th><th>¿A quién le toca?</th>${kids ? "<th>Estrellas</th>" : ""}<th>Próxima</th><th></th></tr></thead>
        <tbody>${chores.map((c) => `
          <tr data-id="${c.id}">
            <td><span class="row" style="flex-wrap:nowrap;color:var(--green-ink)">${choreIcon(c.emoji, 24)}
              <select data-f="emoji" aria-label="Dibujo">${META.chore_emojis.map((e) => `<option value="${e}" ${e === c.emoji ? "selected" : ""}>${CHORE_ICONS[e]?.[1] ?? e}</option>`).join("")}</select></span></td>
            <td><input data-f="name" value="${esc(c.name)}"></td>
            <td><button class="when-btn" data-when="${c.id}">${icon("calendar", 18)} ${esc(c.when)}${c.remind_at ? `<span class="remind">${icon("speaker", 16)} ${c.remind_at}</span>` : ""}</button></td>
            <td><select data-f="who">${memberOpts(c.member_id, c.rotate)}</select></td>
            ${kids ? `<td><select data-f="stars" aria-label="Estrellas que gana un niño">${starOpts(c.stars ?? 1)}</select></td>` : ""}
            <td class="small">${c.is_due ? `<span class="badge warn">${c.days_late ? `atrasada ${c.days_late} día${c.days_late > 1 ? "s" : ""}` : "hoy"}</span>` : esc(cap(c.due_text))}</td>
            <td><button class="ghost danger" data-del-c="${c.id}" title="Quitar">${icon("close", 18)}</button></td>
          </tr>`).join("")}</tbody></table>
      <div><button class="primary" id="add-c">${icon("plus", 20)} Agregar tarea</button></div>
    </section>
    ${members.length ? "" : `<p class="muted small">Para repartir las tareas, agreguen primero a las personas en la pestaña Casa.</p>`}
    ${members.length && !kids ? `<p class="muted small">Para que las tareas den estrellas a los niños, márquenlos como «Niño/a» en la pestaña Casa.</p>` : ""}`;

  const whoFields = (v) => v === "rotate" ? { member_id: null, rotate: true } : { member_id: v ? +v : null, rotate: false };
  const pickGrid = (name, list, selected, draw = (e) => e) => `<div class="pick">${list.map((e) => `
    <label title="${esc(CHORE_ICONS[e]?.[1] ?? "")}"><input type="radio" name="${name}" value="${e}" ${e === selected ? "checked" : ""}><span>${draw(e)}</span></label>`).join("")}</div>`;

  $("#add-c").onclick = () => {
    formModal({
      title: "Nueva tarea de la casa",
      body: `<form id="cf" class="stack">
        <label class="field">¿Qué hay que hacer?<input name="name" required maxlength="80" autocomplete="off" placeholder="Ej: Sacar la basura"></label>
        <div class="field">Dibujo${pickGrid("emoji", META.chore_emojis, META.chore_emojis[0], (e) => choreIcon(e, 26))}</div>
        <div class="form-grid">
          <label class="field">¿A quién le toca?<select name="who">${memberOpts(null, false)}</select></label>
          ${kids ? `<label class="field">Estrellas que gana un niño<select name="stars">${starOpts(1)}</select></label>` : ""}
        </div>
        ${scheduleFields({})}</form>`,
      onOpen: (dlg) => bindSchedule($("#cf", dlg)),
      actions: [
        { label: "Cancelar", value: false },
        { label: "Agregar tarea", tone: "primary", icon: "plus", onClick: async (dlg) => {
          const f = $("#cf", dlg);
          if (!f.reportValidity()) return false;
          const ok = await safe(() => api("/api/chores", { method: "POST", json: {
            name: f.name.value, emoji: f.emoji.value, ...whoFields(f.who.value), ...readSchedule(f),
            ...(f.stars ? { stars: +f.stars.value } : {}),
          } }));
          if (!ok) return false;
          renderChoresAdmin();
        } },
      ],
    });
  };
  $$("tr[data-id] [data-f]", view).forEach((el) => el.onchange = () => safe(async () => {
    const tr = el.closest("tr");
    const get = (f) => $(`[data-f=${f}]`, tr).value;
    const c = chores.find((x) => x.id === +tr.dataset.id);
    await api(`/api/chores/${tr.dataset.id}`, { method: "PUT", json: {
      ...scheduleOf(c), name: get("name"), emoji: get("emoji"), ...whoFields(get("who")),
      ...(kids ? { stars: +get("stars") } : {}),
    } });
    toast("Tarea actualizada");
    renderChoresAdmin();
  }));
  $$("[data-when]", view).forEach((b) => b.onclick = () => {
    const c = chores.find((x) => x.id === +b.dataset.when);
    formModal({
      title: esc(c.name),
      body: `<form id="sf" class="stack">${scheduleFields(c)}</form>`,
      onOpen: (dlg) => bindSchedule($("#sf", dlg)),
      actions: [
        { label: "Cancelar", value: false },
        { label: "Guardar", tone: "primary", icon: "check", onClick: async (dlg) => {
          const ok = await safe(() => api(`/api/chores/${c.id}`, { method: "PUT", json: {
            name: c.name, emoji: c.emoji, member_id: c.member_id, rotate: c.rotate, ...readSchedule($("#sf", dlg)),
          } }));
          if (!ok) return false;
          toast("Horario guardado");
          renderChoresAdmin();
        } },
      ],
    });
  });
  $$("[data-del-c]", view).forEach((b) => b.onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Quitar esta tarea?", text: "Se borra junto con su historial.", ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/chores/${b.dataset.delC}`, { method: "DELETE" });
    renderChoresAdmin();
  }));
}

// ------------------------------------------------------------------ inicio

(async () => {
  await safe(async () => {
    META = await api("/api/meta");
    setHouse(META);
    $("#house-title").textContent = META.house_name;
    $("#home-link").innerHTML = `${icon("home", 20)} Casa`;
    document.title = `${META.house_name} · Administrar`;
    go("recipes");
  });
})();
