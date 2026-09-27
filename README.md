# 🏠 MyChef — nuestra casa

Aplicación web para organizar el menú de la familia **con sus propias recetas**
(con las cantidades y proporciones con que las hacen en casa), que sabe **qué hay en la
despensa** y distingue **el tipo de comida** (desayuno, almuerzo, cena, merienda) y
**el tipo de plato** (plato principal, sopa, ensalada, postre…).

No trae recetas genéricas: todo lo que sugiere sale de las recetas que ustedes cargan.

## Dos pantallas

### 🏠 La pantalla de la casa (`/`) — para la tablet de la nevera

Pensada para que la use cualquiera en la casa, sin saber de tecnología: botones grandes,
pocas palabras, siempre un **← Volver**, y si nadie la toca por 2 minutos vuelve sola al inicio.

- **Hoy comemos**: el desayuno, almuerzo y cena del día, con ✅ si hay todo o qué falta.
  Al tocar un plato se abre en **modo cocina** (letra grande, porciones con − / +, ingredientes y pasos),
  y **Terminé de cocinar** descuenta lo usado de la nevera.
- **Tareas de hoy**: sacar la basura, lavar la loza, regar las plantas… Se toca ✓, se elige
  **¿quién lo hizo?** y listo. Tocar de nuevo deshace. Las tareas por turnos pasan solas a la siguiente persona.
- **Ojo con esto**: lo que se vence pronto y lo que se está acabando.
- **🧾 Escanear factura**: foto de la factura del mercado (si es larga, en varias fotos). La IA entiende
  los nombres abreviados ("LCHE ALQ 1100ML X2" → Leche, 2200 ml), separa comida de aseo, y se revisa con
  un toque antes de guardar. Todo queda en el inventario y se registra cuánto se gastó.
- **🛒 Lista de compras**: lo que falta para el menú de la semana + lo que bajó de su mínimo + lo que
  anotaron a mano. En el supermercado se va marcando ✓ (funciona igual desde el celular).
- **🍳 ¿Qué cocino?**: sus recetas que se pueden hacer ya, aprovechando lo que se vence.
- **🫙 Se acabó algo**: se toca el producto y queda anotado en la lista.

### ⚙️ Administrar (`/admin`) — para cargar y ajustar

| Pestaña | Para qué sirve |
|---|---|
| **Menú** | Semana en cuadrícula día × comida; planear a mano o con **✨ Planear con lo que hay**. |
| **¿Qué cocino?** | Sugerencias por comida, tipo de plato y porciones. |
| **Recetas** | Sus recetas con cantidades exactas, escalables a N porciones. **📷 Importar receta escrita** convierte la foto del cuaderno en receta. |
| **Despensa** | Inventario con vencimientos, **mínimo** (si baja de ahí pasa sola a la lista) y equivalencias ⚖ ("1 taza de arroz = 200 g"). |
| **Compras** | La lista completa de la semana, para copiar o pasar a la despensa. |
| **Casa y tareas** | Personas de la casa, tareas (cada cuántos días, persona fija, cualquiera o por turnos), cuántas tareas hizo cada uno y **gastos del mes** según las facturas. |

## Cómo correrla

Requiere Python 3.10+.

```bash
python -m venv .venv
source .venv/bin/activate          # En Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Abran <http://localhost:8000> (o `http://IP-del-computador:8000` desde la tablet o el celular en la misma red).
La vista detallada está en <http://localhost:8000/admin>.

Para probar con recetas de ejemplo antes de cargar las suyas:

```bash
python -m app.seed
```

### Con Docker

```bash
docker compose up -d
```

Los datos quedan en `./data/mychef.db` (un archivo SQLite; para respaldar basta copiarlo).

### La tablet en la nevera

1. **El servidor tiene que estar siempre prendido.** Opciones, de la más sencilla a la más robusta:
   - Un computador de la casa que no se apague, con la app corriendo (`docker compose up -d` la
     reinicia sola si se reinicia el equipo).
   - Una Raspberry Pi (≈ USD 60) conectada al router: silenciosa, gasta muy poca luz.
   - Un servicio en internet (Render, Railway, un VPS). Así funciona también desde el celular fuera de
     casa. **En ese caso pongan un PIN** (ver abajo).
2. **En la tablet** abran `http://IP-del-servidor:8000` en Chrome → menú ⋮ → **Agregar a pantalla de inicio**.
3. **Que no se apague la pantalla**: en Android, *Ajustes → Pantalla → Tiempo de espera* al máximo, o
   mejor la app gratuita **Fully Kiosk Browser**, que la deja en pantalla completa, siempre encendida y
   sin poder salirse por error. Un soporte magnético para nevera y un cable largo completan el montaje.

### PIN de la casa (recomendado si la app está en internet)

```bash
export MYCHEF_PIN=2580          # el PIN que quieran
export MYCHEF_SECRET=algo-largo-y-aleatorio
```

Cada dispositivo pide el PIN una sola vez y lo recuerda por un año. Tras 8 intentos fallidos se bloquea 5 minutos.

### Reconocimiento con IA: facturas, nevera y recetas (opcional)

Escanear facturas, reconocer la despensa por foto e importar recetas usan Claude. Configuren una clave
de API de Anthropic antes de arrancar:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Sin clave todo lo demás funciona igual; esos botones muestran un aviso. Cada factura cuesta del
orden de unos pocos centavos de dólar en la API. El modelo se puede
cambiar con `MYCHEF_MODEL` (por defecto `claude-opus-5`). Las solicitudes activan el
*fallback* del lado del servidor (`fallbacks: "default"`), así que si el modelo principal
declina una solicitud, la API la reintenta con otro modelo automáticamente.

## Diseño

- **Colores**: verde huerta como color principal, fondo de papel de lino, y acentos en miel, terracota
  y salvia. Tiene modo oscuro automático (útil de noche en la tablet).
- **Letras**: *Alegreya* para títulos (serif caligráfica de Huerta Tipográfica, con aire de recetario
  escrito a mano) y *Atkinson Hyperlegible* para el texto, diseñada para leerse fácil. Ambas vienen
  incluidas en `static/fonts/` (licencia SIL OFL), así que funcionan aunque la tablet no tenga internet.
- **Íconos** dibujados para la app (también los de las tareas), en lugar de emojis.
- Pulida con las guías de [Impeccable](https://impeccable.style): sin sombras decorativas ni adornos,
  botones que muestran "procesando" y no registran dos veces con un doble toque, pantallas de carga
  y de error con lenguaje de la casa, y soporte para "reducir movimiento" del sistema.
- Las **confirmaciones y formularios** se abren en ventanas (modales) que se cierran con la X,
  con Esc o tocando fuera; nunca con los cuadros de diálogo del navegador.
- Las cantidades se muestran como en la cocina: "½ taza", "1 ⅓ unidades".
- En ⚙️ Administrar → Casa y tareas se le puede poner **nombre a la casa** ("Casa Ávila"), que aparece
  en la pantalla de la tablet.

## Desarrollo

```bash
pip install -r requirements-dev.txt
pytest
```

Estructura:

```
app/
  main.py      API (FastAPI) y archivos estáticos
  models.py    Tablas: ingredientes, despensa, recetas, menú, personas, tareas, compras
  household.py Tareas del hogar, facturas, mínimos de inventario y el resumen de "Hoy"
  auth.py      PIN opcional de la casa
  services.py  Escalar recetas, disponibilidad, sugerencias, plan semanal, compras
  units.py     Unidades y conversiones
  vision.py    Reconocimiento con Claude (facturas, despensa y recetas)
  seed.py      Datos de ejemplo
static/        index.html + hub.js/hub.css: pantalla de la casa · admin.html + admin.js: Administrar
               common.js: íconos, modales y utilidades · styles.css: identidad visual · fonts/
tests/         Pruebas
```

La documentación interactiva de la API está en `/docs`.
