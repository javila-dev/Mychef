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
- **🧾 Escanear → La factura**: foto de la factura del mercado (si es larga, en varias fotos). La IA entiende
  los nombres abreviados ("LCHE ALQ 1100ML X2" → Leche, 2200 ml), separa comida de aseo, y se revisa con
  un toque antes de guardar. Todo queda en el inventario y se registra cuánto se gastó.
- **🛒 Lista de compras**: lo que falta para el menú de la semana + lo que bajó de su mínimo + lo que
  anotaron a mano. En el supermercado se va marcando ✓ (funciona igual desde el celular).
- **🍳 ¿Qué cocino?**: sus recetas que se pueden hacer ya, aprovechando lo que se vence.
- **🫙 Se acabó algo**: se toca el producto y queda anotado en la lista.
- **📷 Escanear → La nevera / La alacena**: una o varias fotos (la nevera, la puerta, el congelador).
  La IA dice qué ve y **cuánto queda** (la leche a la mitad = 500 ml) y pone **un número encima de cada cosa
  en la foto**. Tocando un número se corrige ahí mismo qué es y cuánto hay (o «No es eso»); tocando un lugar
  vacío de la foto se agrega algo que no vio. Luego **Poner al día**. Los marcadores son aproximados: la IA
  señala el centro de cada cosa, no la recorta.
  Lo que según el inventario debía estar y no salió en la foto aparece como «¿Se acabó?»: al tocarlo pasa
  a la lista de compras. También por voz: «Oye casa, escanea la nevera».
- **¿Con el celular o con la tablet?** Antes de cada foto (factura, nevera o alacena) la tablet pregunta:
  - **Con el celular**: la tablet muestra un código QR; lo apuntan con la cámara del celular, se abre la
    app directo en la foto, y al guardar la tablet dice «¡Listo!» y se actualiza sola. La tablet no se mueve.
    Para que funcione, la tablet debe tener la app abierta con la dirección de la red
    (`http://192.168.x.x:8000`), no con `localhost`, y el celular estar en el mismo wifi.
  - **Con esta tablet**: la de siempre; hay que despegarla un momento de la nevera.

### Qué tan exigente es con lo que hay

En **Administrar → Despensa** se elige:

| Modo | Cuándo dice «se puede hacer» |
|---|---|
| **Tranquilo** | Si hay algo de cada ingrediente, alcanza. Para quienes no quieren llevar la cuenta. |
| **Normal** (por defecto) | Si hay al menos ¾ de lo que pide la receta («hay, justo»). |
| **Exacto** | Solo si alcanza gramo a gramo, sin dar nada por hecho. |

En Tranquilo y Normal, los **básicos que siempre hay** (sal, aceite, azúcar, agua, condimentos…) no
hace falta tenerlos en el inventario ni se piden en la lista de compras; solo llegan a la lista si alguien
dice «se acabó la sal». La lista de básicos se ajusta en la misma pestaña. La lista de compras, en esos
modos, solo pide algo cuando falta más de una cuarta parte.

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

### Comandos de voz

Toquen **Hablar** (junto a la hora o arriba en cada pantalla) y digan, por ejemplo:

| Para… | Digan |
|---|---|
| Anotar lo que se acabó | «se acabó la leche y los huevos» |
| Agregar a la lista | «agrega pan y jabón a la lista», «necesitamos arepas» |
| Marcar una tarea | «ya saqué la basura», «Sofi ya regó las plantas» |
| Saber qué hay | «¿qué hay de almuerzo?», «¿qué falta comprar?», «¿qué se vence?», «¿qué tareas hay?» |
| Decidir qué cocinar | «¿qué cocino?», «abre la receta de lentejas» |
| Temporizadores | «pon un temporizador de diez minutos para el arroz», «¿cuánto falta?», «cancela el temporizador» |
| Corregir | «deshacer» (o el botón **Deshacer** que aparece) |

**Manos libres**: dentro de una receta, toquen **Manos libres** y la tablet queda escuchando mientras
cocinan: «siguiente», «anterior», «repite», «¿cuánta sal lleva?», «ingredientes», «terminé». La
tablet lee cada paso en voz alta; si le hablan encima, se calla y obedece.

Los temporizadores aparecen arriba en todas las pantallas y, al terminar, suenan y lo dicen en voz alta.

**La voz que contesta**: la tablet responde con las voces en español que trae instaladas. En
**Ajustes → Casa y tareas → Voz de esta tablet** se elige cuál (y se escucha con **Probar**), la velocidad
(despacio, normal, más rápido) y si contesta en voz alta o solo por escrito. Se guarda en cada aparato,
así que conviene hacerlo desde la misma tablet de la nevera. Las alarmas de los temporizadores siempre suenan
y hablan, aunque la voz esté apagada. Para voces más naturales en Android: *Ajustes → Sistema → Idiomas →
Salida de texto a voz → Motor de Google → Instalar datos de voz → Español (Estados Unidos o México)*; las
que dicen «con internet» suelen sonar mejor.

**Palabra de activación («Oye casa»)**: en el inicio, junto a la hora, toquen **Digan «Oye casa»** para
dejar la tablet escuchando sin tocarla (el punto verde parpadea mientras está activa). Luego:
- de una vez: «Oye casa, se acabó la leche», o
- en dos partes: «Oye casa» → suena un tono → «¿qué hay de almuerzo?» (espera unos 8 segundos).

Se activa **en cada tablet por separado** y la tablet lo recuerda aunque se recargue. La palabra se
cambia en **Ajustes → Casa y tareas → Palabra de activación** (mejor dos palabras, como «Oye Lupita»).
Mientras cocinan en **Manos libres** no hace falta decirla.

Tengan en cuenta:
- Con la palabra activada, Chrome escucha todo el tiempo y envía el audio a Google para reconocerlo
  (la app solo reacciona a lo que empieza con la palabra). Si no les gusta, déjenla apagada y usen **Hablar**.
- Gasta algo más de batería: la tablet de la nevera conviene tenerla conectada. En algunos Android
  Chrome hace un pitido cada vez que reinicia el micrófono; se puede silenciar bajando el volumen de notificaciones.
- Cuando la pantalla se oculta o se apaga, deja de escuchar; vuelve sola al regresar.

Requisitos del navegador para la voz:
- **Chrome** (o Fully Kiosk Browser) en la tablet, **con internet**: el reconocimiento de voz de
  Chrome usa los servidores de Google. Las respuestas habladas funcionan sin internet.
- **Conexión segura**: el navegador solo presta el micrófono en `https://` o en `localhost`. En la red
  de la casa la forma más sencilla es, en la tablet, abrir `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
  escribir la dirección de la app (por ejemplo `http://192.168.1.20:8000`), activarlo y reiniciar Chrome.
  Si la app está publicada en internet con HTTPS, no hace falta nada.

La frase se interpreta en el computador de la casa con reglas propias (rápido y gratis). Si alguien
dice algo que no encaja y hay `ANTHROPIC_API_KEY`, Claude la traduce a uno de los comandos conocidos.

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

- **Referencia**: la pantalla de nevera **Samsung Family Hub**, combinada con el contenido del inicio
  anterior. Las **fotos de la familia** llenan la pantalla (cambian solas cada 45 segundos); encima se
  ven la hora y el saludo, "Hoy en la mesa", "Pendientes de hoy" y "Ojo con esto", y abajo los botones
  grandes de colores: Escanear factura, Lista de compras, ¿Qué cocino?, Se acabó algo, Fotos y Ajustes.
- **Fotos**: se suben desde la app **Fotos** del inicio (desde la tablet o el celular). Se guardan en
  `data/photos/` junto a la base de datos. Mientras no haya fotos se ve un paisaje de colinas y un
  widget que invita a ponerlas.
- **Letra**: *Lexend*, una sola familia diseñada para leerse fácil, incluida en `static/fonts/`
  (licencia SIL OFL), así que funciona sin internet.
- **Colores**: grises neutros, superficies blancas y un verde como acento; modo oscuro automático.
- Personas con su inicial en un círculo de color; tareas con íconos dibujados para la app.
- Confirmaciones y formularios en ventanas (modales); nunca los cuadros de diálogo del navegador.
- Rediseñada siguiendo el proceso de [Impeccable](https://impeccable.style): producto en `PRODUCT.md`,
  sistema visual en `DESIGN.md`, dirección en `.impeccable/surfaces/`, detector sin hallazgos y
  revisión final independiente.

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
  vision.py    Reconocimiento con Claude (facturas, despensa, recetas y frases de voz difíciles)
  voice.py     Comandos de voz: entiende la frase y ejecuta la acción
  seed.py      Datos de ejemplo
static/        index.html + hub.js/hub.css: pantalla de la casa · admin.html + admin.js: Administrar
               common.js: íconos, avatares, modales y utilidades · styles.css: base visual
               voice.js: micrófono, voz hablada, manos libres y temporizadores
               wallpaper.svg: fondo sin fotos · fonts/: Lexend
tests/         Pruebas
```

La documentación interactiva de la API está en `/docs`.
