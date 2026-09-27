// MyChef · Administrar — la vista completa y detallada. Todo el estado vive en el servidor (SQLite).

import {
  $, $$, REASON_TEXT, addDays, api, cap, esc, fmtDay, fmtMoney, fmtQty, isoDate, mondayOf, safe,
  CHORE_ICONS, avatar, choreIcon, compressImage, confirmModal, fmtAmount, fmtUnit, icon, modal as formModal,
  toPantryLine, toast, withBusy,
} from "./common.js";
import { getVoicePrefs, onVoicesReady, setVoicePrefs, speak } from "./voice.js";

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

const VIEWS = { menu: renderMenu, cook: renderCook, recipes: renderRecipes, pantry: renderPantry, shopping: renderShopping, house: renderHouse };
let current = "menu";

function go(name) {
  current = name;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  safe(VIEWS[name]);
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
function refresh() { safe(VIEWS[current]); }

$("#household").addEventListener("change", (e) => safe(async () => {
  const n = parseInt(e.target.value, 10);
  if (!n || n < 1) return;
  await api("/api/settings", { method: "PUT", json: { household_size: n } });
  META.household_size = n;
  toast(`Porciones por defecto: ${n}`);
  refresh();
}));

// ------------------------------------------------------------------ menú semanal

async function renderMenu() {
  const start = isoDate(weekStart);
  const entries = await api(`/api/menu?start=${start}&days=7`);
  const today = isoDate(new Date());
  const days = [...Array(7)].map((_, i) => addDays(weekStart, i));

  view.innerHTML = `
    <div class="row spread" style="margin-bottom:.75rem">
      <div class="row">
        <button id="prev" aria-label="Semana anterior">${icon("back", 20)}</button>
        <strong>Semana del ${weekStart.toLocaleDateString("es", { day: "numeric", month: "long" })}</strong>
        <button id="next" aria-label="Semana siguiente">${icon("chevron", 20)}</button>
        <button class="ghost" id="thisweek">Hoy</button>
      </div>
      <div class="row">
        <button class="primary" id="autoplan">${icon("spark", 20)} Planear con lo que hay</button>
        <button id="to-shopping">${icon("basket", 20)} Lista de compras</button>
      </div>
    </div>
    <div class="week">
      ${days.map((d) => {
        const iso = isoDate(d);
        return `<section class="card day ${iso === today ? "today" : ""}">
          <h3>${esc(fmtDay(d))}</h3>
          ${META.meal_types.map((m) => {
            const list = entries.filter((e) => e.day === iso && e.meal_type === m);
            return `<div class="slot">
              <div class="row spread"><span class="slot-title">${esc(m)}</span>
                <button class="ghost small" data-add="${iso}|${m}" title="Agregar">${icon("plus", 18)}</button></div>
              ${list.map((e) => `
                <div class="entry ${e.cooked ? "cooked" : ""}">
                  <a data-recipe="${e.recipe.id}" data-servings="${e.servings}">${esc(e.recipe.name)}</a>
                  <span class="muted small">${e.servings}p</span>
                  ${e.cooked ? `<span class="badge ok">hecho</span>` : `<button title="Ya lo cociné: descontar de la despensa" data-cook="${e.id}">${icon("check", 18)}</button>`}
                  <button class="ghost danger" title="Quitar" data-del="${e.id}">${icon("close", 18)}</button>
                </div>`).join("")}
            </div>`;
          }).join("")}
        </section>`;
      }).join("")}
    </div>`;

  $("#prev").onclick = () => { weekStart = addDays(weekStart, -7); refresh(); };
  $("#next").onclick = () => { weekStart = addDays(weekStart, 7); refresh(); };
  $("#thisweek").onclick = () => { weekStart = mondayOf(new Date()); refresh(); };
  $("#to-shopping").onclick = () => go("shopping");
  $("#autoplan").onclick = autoplanDialog;
  $$("[data-add]", view).forEach((b) => b.onclick = () => {
    const [day, meal] = b.dataset.add.split("|");
    pickRecipeDialog(day, meal);
  });
  $$("[data-recipe]", view).forEach((a) => a.onclick = () => showRecipe(+a.dataset.recipe, +a.dataset.servings));
  $$("[data-del]", view).forEach((b) => b.onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Quitar del menú?", text: "Solo se quita de ese día; la receta no se borra.", ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/menu/${b.dataset.del}`, { method: "DELETE" });
    refresh();
  }));
  $$("[data-cook]", view).forEach((b) => b.onclick = () => safe(async () => {
    const res = await api(`/api/menu/${b.dataset.cook}/cook`, { method: "POST" });
    toast(res.pantry_changes.length ? `Despensa actualizada (${res.pantry_changes.length} ingredientes)` : "Marcado como cocinado");
    refresh();
  }));
}

function autoplanDialog() {
  openModal(`
    <div class="modal-head"><h2>Planear la semana</h2><button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button></div>
    <p class="muted">Llena los espacios vacíos con sus recetas, priorizando lo que ya hay en la despensa,
      lo que está por vencerse y lo que hace rato no cocinan. No toca lo que ya planearon.</p>
    <div class="stack">
      <div class="row">${META.meal_types.map((m) => `
        <label class="row"><input type="checkbox" name="meal" value="${m}" ${["almuerzo", "cena"].includes(m) ? "checked" : ""}> ${cap(m)}</label>`).join("")}
      </div>
      <label class="field">Porciones<input id="ap-serv" type="number" min="1" value="${META.household_size}"></label>
      <label class="row"><input type="checkbox" id="ap-over"> Reemplazar lo planeado que aún no se ha cocinado</label>
      <div class="row"><button class="primary" id="go">Planear</button></div>
    </div>`);
  $("#x").onclick = closeModal;
  $("#go").onclick = (ev) => safe(() => withBusy(ev.currentTarget, async () => {
    const meals = $$("input[name=meal]:checked", modalBody).map((i) => i.value);
    if (!meals.length) return toast("Elige al menos una comida");
    const created = await api("/api/menu/autoplan", {
      method: "POST",
      json: { start: isoDate(weekStart), days: 7, meal_types: meals, servings: +$("#ap-serv").value || null, overwrite: $("#ap-over").checked },
    });
    closeModal();
    toast(created.length ? `Se agregaron ${created.length} comidas` : "No hay recetas para esos espacios (o ya están llenos)");
    refresh();
  }));
}

async function pickRecipeDialog(day, meal) {
  const sugg = await api(`/api/suggestions?meal_type=${encodeURIComponent(meal)}&limit=50`);
  openModal(`
    <div class="modal-head"><h2>${esc(cap(meal))} · ${esc(fmtDay(new Date(day + "T12:00")))}</h2><button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button></div>
    <label class="field" style="max-width:10rem">Porciones<input id="pk-serv" type="number" min="1" value="${META.household_size}"></label>
    ${sugg.length ? `<ul class="clean" style="margin-top:.5rem">${sugg.map((s) => `
      <li class="row spread">
        <div style="flex:1;min-width:12rem">
          <strong>${esc(s.recipe.name)}</strong> <span class="badge">${esc(s.recipe.dish_type)}</span>
          ${s.uses_expiring.length ? `<span class="badge warn">usa lo que vence</span>` : ""}
          ${coverageBar(s.coverage)}
          <div class="small muted">${s.can_cook ? "Hay todo" : "Falta: " + esc(s.missing.map((m) => m.name).join(", "))}</div>
        </div>
        <button class="primary" data-pick="${s.recipe.id}">Elegir</button>
      </li>`).join("")}</ul>`
      : `<p class="empty">No tienen recetas marcadas para ${esc(meal)}. Agrégalas en la pestaña Recetas.</p>`}`);
  $("#x").onclick = closeModal;
  $$("[data-pick]", modalBody).forEach((b) => b.onclick = () => safe(() => withBusy(b, async () => {
    await api("/api/menu", { method: "POST", json: { day, meal_type: meal, recipe_id: +b.dataset.pick, servings: +$("#pk-serv").value || null } });
    closeModal();
    refresh();
  })));
}

// ------------------------------------------------------------------ ¿qué cocino?

async function renderCook(filters = {}) {
  const meal = filters.meal ?? guessMeal();
  const dish = filters.dish ?? "";
  const servings = filters.servings ?? META.household_size;
  const params = new URLSearchParams({ servings, limit: 30 });
  if (meal) params.set("meal_type", meal);
  if (dish) params.set("dish_type", dish);
  const sugg = await api(`/api/suggestions?${params}`);

  view.innerHTML = `
    <div class="card row" style="margin-bottom:.75rem">
      <label class="field">Comida<select id="f-meal">${options(META.meal_types, meal, "Cualquiera")}</select></label>
      <label class="field">Tipo de plato<select id="f-dish">${options(META.dish_types, dish, "Todos")}</select></label>
      <label class="field">Porciones<input id="f-serv" type="number" min="1" value="${servings}" style="width:5rem"></label>
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
        <div><button data-open="${s.recipe.id}">Ver receta para ${s.servings}</button></div>
      </article>`).join("")}</div>`
      : `<div class="empty card">No hay recetas para ese filtro. Empieza cargando sus recetas en la pestaña <b>Recetas</b>.</div>`}`;

  const reload = () => safe(() => renderCook({ meal: $("#f-meal").value, dish: $("#f-dish").value, servings: +$("#f-serv").value || META.household_size }));
  $("#f-meal").onchange = reload;
  $("#f-dish").onchange = reload;
  $("#f-serv").onchange = reload;
  $$("[data-open]", view).forEach((b) => b.onclick = () => showRecipe(+b.dataset.open, +$("#f-serv").value));
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

const STATUS_ICON = { ok: ["check", "st-ok"], hay: ["check", "st-ok"], poco: ["dot", "st-poco"], falta: ["close", "st-falta"] };
const STATUS_TEXT = { ok: "hay suficiente", hay: "hay, pero en otra unidad: agrega su equivalencia en la despensa", poco: "no alcanza", falta: "no hay" };

async function showRecipe(id, servings) {
  const r = await api(`/api/recipes/${id}${servings ? `?servings=${servings}` : ""}`);
  const byId = Object.fromEntries(r.availability.items.map((i) => [i.ingredient_id, i]));
  openModal(`
    <div class="modal-head">
      <div><h2>${r.favorite ? icon("star", 18) + " " : ""}${esc(r.name)}</h2>
        <div class="row small">${r.meal_types.map((m) => `<span class="badge accent">${esc(m)}</span>`).join("")}
          <span class="badge">${esc(r.dish_type)}</span>
          ${r.prep_minutes ? `<span class="muted">${icon("clock", 16)} ${r.prep_minutes} min</span>` : ""}
          <span class="muted">Receta original: ${r.servings} porciones</span></div></div>
      <button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button>
    </div>
    <div class="row" style="margin:.75rem 0">
      <span>Para</span>
      <button id="minus" aria-label="Menos">${icon("minus", 18)}</button><strong id="serv">${r.scaled_to}</strong><button id="plus" aria-label="Más">${icon("plus", 18)}</button>
      <span>porciones</span>
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
        ${a.have != null ? `<span class="muted small">(hay ${fmtQty(a.have)} ${esc(a.have_unit)})</span>` : ""}</li>`;
    }).join("")}</ul>
    ${r.instructions ? `<h3>Preparación</h3><div class="instructions">${esc(r.instructions)}</div>` : ""}
    ${r.notes ? `<h3>Notas de la casa</h3><div class="instructions muted">${esc(r.notes)}</div>` : ""}
    <div class="row" style="margin-top:1rem">
      <button class="primary" id="cooked">${icon("check", 20)} La cociné (descontar de la despensa)</button>
      <button id="edit">Editar</button>
      <button class="danger" id="del">Eliminar</button>
    </div>`);

  const n = r.scaled_to;
  $("#x").onclick = closeModal;
  $("#minus").onclick = () => n > 1 && safe(() => showRecipe(id, n - 1));
  $("#plus").onclick = () => safe(() => showRecipe(id, n + 1));
  $("#edit").onclick = () => safe(async () => recipeForm(await api(`/api/recipes/${id}`)));
  $("#del").onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Eliminar la receta?", text: `«${esc(r.name)}» se borra y también se quita del menú.`, ok: "Eliminar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/recipes/${id}`, { method: "DELETE" });
    closeModal();
    refresh();
  });
  $("#cooked").onclick = (ev) => safe(() => withBusy(ev.currentTarget, async () => {
    const res = await api(`/api/recipes/${id}/cook`, { method: "POST", json: { servings: n } });
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
        <label class="field">Rinde (porciones)<input name="servings" type="number" min="1" required value="${r.servings}"></label>
        <label class="field">Tiempo (min)<input name="prep_minutes" type="number" min="0" value="${r.prep_minutes ?? ""}"></label>
      </div>
      <div class="row">Se come en: ${META.meal_types.map((m) => `
        <label class="row"><input type="checkbox" name="meal" value="${m}" ${r.meal_types.includes(m) ? "checked" : ""}> ${cap(m)}</label>`).join("")}
        <label class="row" style="margin-left:auto"><input type="checkbox" name="favorite" ${r.favorite ? "checked" : ""}> Favorita</label>
      </div>
      <h3>Ingredientes <span class="muted small">(las cantidades exactas para ${r.servings} porciones como la hacen en casa)</span></h3>
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

async function renderPantry() {
  const items = await api("/api/pantry");
  const expiring = items.filter((i) => i.expiring);
  view.innerHTML = `
    <div class="card stack" style="margin-bottom:.75rem">
      <div class="row spread"><h2 style="margin:0">¿Qué hay en casa?</h2>
        <div class="row"><button id="add-p">${icon("plus", 20)} Agregar</button>
          <button class="primary" id="scan">${icon("camera", 20)} Reconocer con una foto</button></div></div>
      <datalist id="dl-units">${META.units.map((u) => `<option value="${u}">`).join("")}</datalist>
      ${expiring.length ? `<div class="small"><span class="badge warn">Por vencer</span> ${esc(expiring.map((i) => i.name).join(", "))} —
        <a href="#" id="use-exp">ver qué cocinar</a></div>` : ""}
    </div>
    ${items.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Ingrediente</th><th style="width:7rem">Cantidad</th><th style="width:6rem">Unidad</th><th style="width:9.5rem">Vence</th><th style="width:6rem" title="Si baja de aquí, pasa sola a la lista de compras">Mínimo</th><th></th></tr></thead>
      <tbody>${items.map((i, idx) => `
        ${idx === 0 || items[idx - 1].category !== i.category ? `<tr class="cat"><th colspan="6">${esc(cap(i.category))}</th></tr>` : ""}
        <tr class="${i.expiring ? "expiring" : ""}" data-id="${i.id}">
          <td>${esc(i.name)} ${i.quantity <= 0 ? `<span class="badge bad">agotado</span>` : i.low ? `<span class="badge warn">poco</span>` : ""}</td>
          <td><input type="number" step="any" min="0" value="${i.quantity}" data-f="quantity"></td>
          <td><input list="dl-units" value="${esc(i.unit)}" data-f="unit"></td>
          <td><input type="date" value="${i.expires_on ?? ""}" data-f="expires_on"></td>
          <td><input type="number" step="any" min="0" value="${i.min_quantity ?? ""}" placeholder="—" data-f="min_quantity"></td>
          <td class="row" style="flex-wrap:nowrap"><button class="ghost" data-eq="${idx}" title="Equivalencias (cuánto pesa una taza o una unidad)">${icon("sliders", 18)}</button>
            <button class="ghost danger" data-del="${i.id}" title="Quitar">${icon("close", 18)}</button></td>
        </tr>`).join("")}</tbody></table></div>`
      : `<div class="empty card">La despensa está vacía. Agreguen lo que hay a mano o con una foto de la nevera.</div>`}`;

  $("#add-p").onclick = () => {
    const m = formModal({
      title: "Agregar a la despensa",
      body: `<form id="pf" class="stack">
        <label class="field">Ingrediente<input name="name" required autocomplete="off" placeholder="Ej: Leche"></label>
        <div class="form-grid">
          <label class="field">Cantidad<input name="quantity" type="number" step="any" min="0" required></label>
          <label class="field">Unidad<input name="unit" list="dl-units" value="unidad"></label>
          <label class="field">Categoría<select name="category">${options(META.categories, "", "Sin categoría")}</select></label>
          <label class="field">Vence<input name="expires_on" type="date"></label>
          <label class="field">Mínimo (opcional)<input name="min_quantity" type="number" step="any" min="0" placeholder="Avisar si baja de…"></label>
        </div></form>`,
      actions: [
        { label: "Cancelar", value: false },
        { label: "Agregar", tone: "primary", icon: "plus", onClick: async (dlg) => {
          const f = $("#pf", dlg);
          if (!f.reportValidity()) return false;
          return safe(async () => {
            await api("/api/pantry", { method: "POST", json: {
              name: f.name.value, quantity: parseFloat(f.quantity.value), unit: f.unit.value || "unidad",
              category: f.category.value || null, expires_on: f.expires_on.value || null,
              min_quantity: f.min_quantity.value === "" ? null : parseFloat(f.min_quantity.value),
            } });
            toast(`${f.name.value} agregado`);
            return true;
          }).then((ok) => ok ?? false);
        } },
      ],
    });
    m.done.then((ok) => ok && renderPantry());
  };
  $("#scan").onclick = scanDialog;
  $("#use-exp")?.addEventListener("click", (e) => { e.preventDefault(); go("cook"); });
  $$("tr[data-id] input", view).forEach((inp) => inp.onchange = () => safe(async () => {
    const id = inp.closest("tr").dataset.id;
    const f = inp.dataset.f;
    let v = inp.value;
    if (f === "quantity") v = parseFloat(v) || 0;
    if (f === "expires_on") v = v || null;
    if (f === "min_quantity") v = v === "" ? null : parseFloat(v);
    await api(`/api/pantry/${id}`, { method: "PATCH", json: { [f]: v } });
    toast("Actualizado");
  }));
  $$("[data-del]", view).forEach((b) => b.onclick = () => safe(async () => {
    const name = b.closest("tr").querySelector("td").firstChild.textContent.trim();
    if (!await confirmModal({ title: "¿Quitar de la despensa?", text: `«${esc(name)}» deja de aparecer en el inventario.`, ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/pantry/${b.dataset.del}`, { method: "DELETE" });
    renderPantry();
  }));
  $$("[data-eq]", view).forEach((b) => b.onclick = () => equivalenceDialog(items[+b.dataset.eq]));
}

function equivalenceDialog(item) {
  openModal(`
    <div class="modal-head"><h2>${esc(item.name)}</h2><button class="m-x" id="x" aria-label="Cerrar">${icon("close")}</button></div>
    <p class="muted">Si sus recetas piden este ingrediente en tazas o unidades pero lo compran por peso,
      digan cuánto pesa para poder comparar y descontar bien.</p>
    <form id="eqf" class="stack">
      <label class="field">Categoría<select name="category">${options(META.categories, item.category)}</select></label>
      <div class="form-grid">
        <label class="field">1 taza pesa (g)<input name="g_per_cup" type="number" step="any" min="0" value="${item.g_per_cup ?? ""}" placeholder="Ej: arroz 200"></label>
        <label class="field">1 unidad pesa (g)<input name="g_per_unit" type="number" step="any" min="0" value="${item.g_per_unit ?? ""}" placeholder="Ej: zanahoria 80"></label>
      </div>
      <div class="row"><button class="primary" type="submit">Guardar</button></div>
    </form>`);
  $("#x").onclick = closeModal;
  $("#eqf").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    safe(async () => {
      await api(`/api/ingredients/${item.ingredient_id}`, { method: "PATCH", json: {
        category: f.category.value,
        g_per_cup: parseFloat(f.g_per_cup.value) || null,
        g_per_unit: parseFloat(f.g_per_unit.value) || null,
      } });
      closeModal();
      toast("Equivalencias guardadas");
      renderPantry();
    });
  };
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

async function renderHouse() {
  const [members, chores, stats, spend] = await Promise.all([
    api("/api/members"), api("/api/chores"), api("/api/chores/stats"), api("/api/purchases"),
  ]);
  const memberOpts = (sel, rotate) => `
    <option value="">Cualquiera</option>
    <option value="rotate" ${rotate ? "selected" : ""}>Por turnos</option>
    ${members.map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.name)}</option>`).join("")}`;
  const every = (d) => d === 1 ? "todos los días" : d === 7 ? "cada semana" : d === 14 ? "cada 15 días" : d === 30 ? "cada mes" : `cada ${d} días`;

  view.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      <section class="card stack">
        <h2>La casa</h2>
        <div class="row spread"><span style="font-family:var(--serif);font-size:1.3rem">${esc(META.house_name)}</span>
          <button id="house-name">${icon("pencil", 18)} Cambiar nombre</button></div>
        <p class="muted small" style="margin:0">Es el nombre que aparece arriba en la pantalla de la tablet.</p>
        <div class="row spread" style="border-top:1px dashed var(--line);padding-top:.75rem">
          <span>Palabra de activación: <b>«${esc(META.wake_word)}»</b></span>
          <button id="wake-word">${icon("mic", 18)} Cambiar</button></div>
        <p class="muted small" style="margin:0">Se dice antes de un comando de voz, por ejemplo «${esc(META.wake_word)}, se acabó la leche». Se activa en cada tablet con el botón que está junto a la hora.</p>
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
      <section class="card stack">
        <h2>Personas de la casa</h2>
        <ul class="clean">${members.map((m) => `
          <li class="row spread"><span class="row" style="font-size:1.05rem">${avatar(m, 32)} ${esc(m.name)}</span>
            <span class="row"><span class="muted small">${stats.find((s) => s.id === m.id)?.done ?? 0} tareas en 30 días</span>
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
    </div>
    <section class="card stack" style="margin-top:.75rem">
      <h2>Tareas del hogar</h2>
      <table><thead><tr><th></th><th>Tarea</th><th>Frecuencia (días)</th><th>¿A quién le toca?</th><th>Próxima</th><th></th></tr></thead>
        <tbody>${chores.map((c) => `
          <tr data-id="${c.id}">
            <td><span class="row" style="flex-wrap:nowrap;color:var(--green-ink)">${choreIcon(c.emoji, 24)}
              <select data-f="emoji" aria-label="Dibujo">${META.chore_emojis.map((e) => `<option value="${e}" ${e === c.emoji ? "selected" : ""}>${CHORE_ICONS[e]?.[1] ?? e}</option>`).join("")}</select></span></td>
            <td><input data-f="name" value="${esc(c.name)}"></td>
            <td><input data-f="every_days" type="number" min="1" value="${c.every_days}" style="width:5rem" title="${every(c.every_days)}"></td>
            <td><select data-f="who">${memberOpts(c.member_id, c.rotate)}</select></td>
            <td class="small">${c.is_due ? `<span class="badge warn">hoy${c.days_late ? ` (+${c.days_late})` : ""}</span>` : new Date(c.due_on + "T12:00").toLocaleDateString("es")}</td>
            <td><button class="ghost danger" data-del-c="${c.id}" title="Quitar">${icon("close", 18)}</button></td>
          </tr>`).join("")}</tbody></table>
      <div><button class="primary" id="add-c">${icon("plus", 20)} Agregar tarea</button></div>
    </section>`;

  const whoFields = (v) => v === "rotate" ? { member_id: null, rotate: true } : { member_id: v ? +v : null, rotate: false };
  const pickGrid = (name, list, selected, draw = (e) => e) => `<div class="pick">${list.map((e) => `
    <label title="${esc(CHORE_ICONS[e]?.[1] ?? "")}"><input type="radio" name="${name}" value="${e}" ${e === selected ? "checked" : ""}><span>${draw(e)}</span></label>`).join("")}</div>`;

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
        <p class="muted small" style="margin:0">En la tablet aparece con su inicial en un círculo de color.</p></form>`,
      actions: [
        { label: "Cancelar", value: false },
        { label: "Agregar", tone: "primary", icon: "plus", onClick: async (dlg) => {
          const f = $("#mf", dlg);
          if (!f.reportValidity()) return false;
          const ok = await safe(() => api("/api/members", { method: "POST", json: { name: f.name.value } }));
          if (!ok) return false;
          renderHouse();
        } },
      ],
    });
  };
  $("#add-c").onclick = () => {
    formModal({
      title: "Nueva tarea de la casa",
      body: `<form id="cf" class="stack">
        <label class="field">¿Qué hay que hacer?<input name="name" required maxlength="80" autocomplete="off" placeholder="Ej: Sacar la basura"></label>
        <div class="field">Dibujo${pickGrid("emoji", META.chore_emojis, META.chore_emojis[0], (e) => choreIcon(e, 26))}</div>
        <div class="form-grid">
          <label class="field">¿Cada cuánto?<select name="every_days">
            ${[[1, "Todos los días"], [2, "Cada 2 días"], [3, "Cada 3 días"], [7, "Cada semana"], [14, "Cada 15 días"], [30, "Cada mes"]]
              .map(([v, t]) => `<option value="${v}" ${v === 7 ? "selected" : ""}>${t}</option>`).join("")}
          </select></label>
          <label class="field">¿A quién le toca?<select name="who">${memberOpts(null, false)}</select></label>
        </div></form>`,
      actions: [
        { label: "Cancelar", value: false },
        { label: "Agregar tarea", tone: "primary", icon: "plus", onClick: async (dlg) => {
          const f = $("#cf", dlg);
          if (!f.reportValidity()) return false;
          const ok = await safe(() => api("/api/chores", { method: "POST", json: {
            name: f.name.value, emoji: f.emoji.value, every_days: +f.every_days.value || 7, ...whoFields(f.who.value),
          } }));
          if (!ok) return false;
          renderHouse();
        } },
      ],
    });
  };
  $$("tr[data-id] [data-f]", view).forEach((el) => el.onchange = () => safe(async () => {
    const tr = el.closest("tr");
    const get = (f) => $(`[data-f=${f}]`, tr).value;
    await api(`/api/chores/${tr.dataset.id}`, { method: "PUT", json: {
      name: get("name"), emoji: get("emoji"), every_days: +get("every_days") || 7, ...whoFields(get("who")),
    } });
    toast("Tarea actualizada");
    renderHouse();
  }));
  $$("[data-del-c]", view).forEach((b) => b.onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Quitar esta tarea?", text: "Se borra junto con su historial.", ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/chores/${b.dataset.delC}`, { method: "DELETE" });
    renderHouse();
  }));
  $$("[data-del-m]", view).forEach((b) => b.onclick = () => safe(async () => {
    if (!await confirmModal({ title: "¿Quitar a esta persona?", text: "Sus tareas quedan para cualquiera.", ok: "Quitar", tone: "danger", okIcon: "trash" })) return;
    await api(`/api/members/${b.dataset.delM}`, { method: "DELETE" });
    renderHouse();
  }));
}

// ------------------------------------------------------------------ inicio

(async () => {
  await safe(async () => {
    META = await api("/api/meta");
    $("#household").value = META.household_size;
    $("#house-title").textContent = META.house_name;
    $("#home-link").innerHTML = `${icon("home", 20)} Casa`;
    document.title = `${META.house_name} · Administrar`;
    go("menu");
  });
})();
