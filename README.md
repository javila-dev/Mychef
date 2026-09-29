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
  Cada tarea tiene su horario de calendario: **días de la semana** («los lunes y jueves», cuando pasa el
  camión), **cada ciertos días** o **un día del mes** («el 1 de cada mes»; si el mes es más corto, el último día).
  Si nadie la hace, sigue apareciendo como atrasada hasta que se marque.
- **Logros de los niños** (Tareas → Logros): a quien se marque como niño o niña, cada tarea le da estrellas
  (1, 2 o 3 según lo grande que sea) y lo celebra con confeti, sonido y la tablet diciéndolo en voz alta.
  Juntan estrellas para un **premio pactado** con los papás (mejor experiencias: ir al parque, elegir la
  película), llenan su **semana de stickers**, suben de nivel y ganan **insignias**. Nunca se quitan estrellas
  por no hacer algo; la racha perdona un día de descanso. Poner el premio y canjearlo pide una cuenta de adulto.
- **Premios** (Administrar → Premios, o en la tablet desde Logros): varios premios en **un mismo camino de
  estrellas** (a las 10 un helado, a las 15 el parque, a las 20 la bici). Al llegar a uno, un adulto lo entrega y
  el niño sigue hacia el próximo; entregar no gasta estrellas y al entregar el último empieza otra vuelta. Cada
  premio lleva un **ícono a color** o una **foto** para los niños que aún no leen. Trae 24 íconos
  incluidos (Fluent Emoji, MIT) y un buscador en español que consulta Fluent y Noto Emoji por internet (Iconify);
  el ícono elegido se guarda en la casa, así que la tablet lo sigue mostrando sin internet.
- **Recordatorio en voz alta**: a la hora que se le ponga a una tarea (p. ej. 7:30 p. m.), si nadie la ha
  hecho, la tablet suena y dice «Recordatorio: sacar la basura. Hoy le toca a Papá.». Se responde
  **Ya la hicimos**, **En 30 minutos** o **Hoy no**. Solo avisa la pantalla de la casa (no el celular), y si
  estuvo apagada no avisa más de 4 horas tarde.
- **Armar el menú (el ritual del domingo)**: desde «Hoy en la mesa» (del viernes al domingo, para la semana
  que viene) o desde el menú de la semana. Cuatro pasos: **¿Qué hay?** (revisar la nevera por grupos,
  primero proteínas y harinas), **¿Cuándo comen en casa?** (la semana en cuadrícula; viene marcada como la
  semana pasada), **El menú** y **Listo**. En «El menú», un deslizador de cinco posiciones va de
  **Todo de la casa** a **Todo ideas nuevas** de la IA: las recetas de la casa no repiten lo de la semana
  pasada y reparten las proteínas; las ideas nuevas giran alrededor de la proteína que hay, sin especias raras
  y con lo que se consigue en la tienda. Tocando un plato se cambia por otra receta de la casa, se pide otra
  idea o se elige la ensalada del almuerzo. Al guardar, lo que falta pasa a la lista de compras y las ideas
  quedan como recetas de prueba. Lo elegido se guarda en la tablet: si vuelve sola al inicio, se sigue donde iba.
  Cuando se termina de cocinar una idea nueva, la tablet pregunta **¿Les gustó?**: «¡Sí!» la pasa a las recetas
  de la casa, «No nos gustó» hace que la IA no la vuelva a proponer (y aprende de las dos cosas). También se
  decide en Administrar → Recetas, donde las de prueba llevan su marca.
- **Ojo con esto**: lo que se vence pronto y lo que se está acabando.
- **📅 Agenda de la familia**: citas médicas, cosas del colegio (lo de Benja), cumpleaños, pagos y planes.
  Cada cosa tiene día, hora (opcional), para quién es y si se repite (cada semana, cada mes, cada año).
  Se elige **cuándo avisar en voz alta**: el día antes (a las 7:30 p. m.), 2 horas antes, 1 hora antes o a la
  hora; lo que no tiene hora se avisa ese día a las 7:30 a. m. En el inicio se ven los próximos días.
  Por voz: «Oye casa, **recuérdame la cita de Benja con la pediatra el jueves a las 3**», «anota en la
  agenda que mañana Benja lleva el uniforme de educación física», «recuérdame pagar el arriendo el 5
  cada mes», «¿qué hay en la agenda?». La frase se entiende en la casa; si es muy enredada y hay clave de
  OpenAI, la IA ayuda. Lo que no se repite se marca ✓ cuando ya pasó.
  Se ve como un **calendario**: el mes (con los eventos de cada día y el día elegido al lado), la semana
  o la lista de lo que viene; se desliza el dedo para cambiar de mes. Lo que dura varios días (un viaje)
  se ve en todos sus días. Si se conecta el **calendario de Google** que la familia ya comparte, lo que
  se anota en el celular aparece en la tablet (y se avisa en voz alta), y al revés (ver abajo).
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
| **Tareas** | Tareas del hogar: días de la semana, cada N días o un día del mes; persona fija, cualquiera o por turnos; hora del recordatorio en voz alta. También se agregan y cambian desde la tablet. |
| **Cómo comemos** | Dónde viven y dónde compran, un **cuestionario hecho por la IA** (lee sus recetas y pregunta lo que falta) que termina en un resumen de «así comen ustedes» que se puede corregir a mano, y si las recetas nuevas de la IA van **a la fija** o a **explorar sabores nuevos**. |
| **Casa** | Personas de la casa, cuántas tareas hizo cada uno, voz, «Oye casa», IA y **gastos del mes** según las facturas. |

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

### Desde el celular, sin computador (GitHub Codespaces)

1. En el navegador del celular abran el repositorio en github.com, elijan la rama, y toquen
   **Code → Codespaces → Create codespace**.
2. Esperen unos 2 minutos: instala todo, carga las recetas de ejemplo y arranca la app sola.
3. Abran la pestaña **Ports** (o el aviso «Open in browser») del puerto **8000**. La dirección es `https://…app.github.dev`,
   privada a su cuenta de GitHub, y como es HTTPS el micrófono funciona.

El codespace se apaga solo si no se usa (los datos se conservan mientras no lo borren). Las cuentas
personales de GitHub traen horas gratis al mes. Para la IA, guarden `GEMINI_API_KEY` (y, si la usan, `OPENAI_API_KEY`) en
*Settings → Codespaces → Secrets*.

### Con Docker

```bash
docker compose up -d
```

### Con PostgreSQL

Por defecto la app guarda todo en un archivo SQLite (`data/mychef.db`), sin instalar nada. Si ya tienen
PostgreSQL en su servidor, creen una base vacía y denle la dirección:

```bash
createdb mychef
export MYCHEF_DATABASE_URL=postgresql://usuario:clave@servidor:5432/mychef
uvicorn app.main:app --host 0.0.0.0 --port 8000     # crea las tablas sola
```

¿Ya tenían datos en SQLite? Cópienlos una vez a la base nueva (debe estar vacía):

```bash
MYCHEF_DATABASE_URL=postgresql://… python -m app.copy_to_postgres data/mychef.db
```

Las fotos de la familia no van en la base: quedan en `data/photos` (o `MYCHEF_PHOTOS`), o en MinIO (abajo). Para correr las pruebas contra PostgreSQL:
`MYCHEF_TEST_DATABASE_URL=postgresql://…/mychef_test pytest`.

### Fotos de la familia en MinIO (o cualquier S3)

```bash
export MYCHEF_S3_ENDPOINT=https://minio.midominio.com    # o http://minio:9000 dentro de Docker
export MYCHEF_S3_ACCESS_KEY=...
export MYCHEF_S3_SECRET_KEY=...
export MYCHEF_S3_BUCKET=mychef                           # se crea solo; puede (y debe) ser privado
python -m app.storage     # una vez: sube a MinIO las fotos que ya estaban en data/photos
```

Las fotos siempre pasan por la app (`/api/photos/{id}/file`), así el bucket no necesita ser público y el
PIN de la casa las sigue protegiendo. Con PostgreSQL + MinIO, el contenedor de la app no guarda nada en disco.

### La agenda con el calendario de Google de la familia (opcional)

La agenda se sincroniza en los dos sentidos con un calendario de Google (el que la familia ya comparte).
Se usa una **cuenta de servicio**: no hay que iniciar sesión con Google en la tablet.

1. En [Google Cloud](https://console.cloud.google.com/): creen un proyecto, activen **Google Calendar API**,
   creen una **cuenta de servicio** (IAM → Cuentas de servicio) y descárguenle una **clave JSON**.
2. Guarden el archivo (p. ej. `data/google.json`) y díganle a la app dónde está:
   ```bash
   export MYCHEF_GOOGLE_CREDENTIALS=data/google.json   # también sirve el JSON pegado
   ```
   Con Docker no hace falta la variable: basta con dejar el archivo en `data/google.json`.
3. En **Administrar → Casa → Calendario de Google** aparece el correo de la cuenta de servicio. En Google
   Calendar, compartan el calendario de la familia con ese correo con permiso **Hacer cambios en los eventos**,
   copien el **ID del calendario** (Configuración → Integrar el calendario) y péguenlo ahí. Listo.

Cómo funciona:
- Se sincroniza sola cada 5 minutos mientras la tablet está prendida, y al momento cuando se anota, cambia
  o borra algo en la tablet (o por voz). En la agenda está el botón para sincronizar ya.
- Lo que viene de Google sin categoría ni persona se adivina por el título («Cita de Benja con la pediatra»
  → Salud, Benja) y se avisa en voz alta como lo que se anota en la tablet. Lo que se anota en la tablet
  guarda su categoría, persona y avisos dentro del evento de Google, así no se pierden.
- Lo que se repite de formas que la agenda no maneja (cada 2 semanas, lunes y miércoles…) llega como fechas
  sueltas: cambiar una de esas en la tablet cambia solo ese día. Las series completas se cambian en Google.
- Si lo cambian al mismo tiempo en los dos lados, gana lo de la tablet. «Listo / ya pasó» es solo de la tablet.
- Se trae desde un mes atrás hasta un año adelante. Desconectar no borra nada, ni aquí ni en Google.

### Probar en local con PostgreSQL y MinIO

`docker-compose.dev.yml` levanta la app junto con un PostgreSQL y un MinIO propios, ya conectados:

```bash
cp .env.example .env      # opcional: claves de IA, PIN, usuario de MinIO
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

App en http://localhost:8001, consola de MinIO en http://localhost:9003 (usuario `mychef`, clave
`mychef-secret` salvo que las cambien en `.env`) y PostgreSQL en `localhost:5433` (`mychef` / `mychef`).
Los puertos son distintos a los de siempre para no chocar con otros proyectos; se cambian en `.env`.
Los datos quedan en volúmenes de Docker; `docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v`
los borra y empiezan de cero.

**Zona horaria**: la app usa la hora de Colombia (`America/Bogota`) para saber qué día es, aunque el
computador o el servidor estén en otra hora. Para cambiarla: `MYCHEF_TZ=America/Mexico_City` (o la que sea).

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
| Agenda | «recuérdame la cita de Benja el jueves a las 3», «¿qué hay en la agenda?», «¿qué tenemos mañana?» |
| Corregir | «deshacer» (o el botón **Deshacer** que aparece) |

**Manos libres**: dentro de una receta, toquen **Manos libres** y la tablet queda escuchando mientras
cocinan: «siguiente», «anterior», «repite», «¿cuánta sal lleva?», «ingredientes», «terminé». La
tablet lee cada paso en voz alta; si le hablan encima, se calla y obedece.

Los temporizadores aparecen arriba en todas las pantallas y, al terminar, suenan y lo dicen en voz alta.

**La voz que contesta**: la tablet responde con las voces en español que trae instaladas. En
**Ajustes → Casa → Voz de esta tablet** se elige cuál (y se escucha con **Probar**), la velocidad
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
cambia en **Ajustes → Casa → Palabra de activación** (mejor dos palabras, como «Oye Lupita»).
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
dice algo que no encaja y hay IA configurada, el modelo de «Voz» la traduce a uno de los comandos conocidos.

### Entrar con usuario y contraseña (obligatorio si la app está en internet)

```bash
export MYCHEF_USER=casa
export MYCHEF_PASSWORD=una-clave-larga-de-verdad   # 12 caracteres o más
export MYCHEF_SECRET=$(openssl rand -hex 32)        # firma las sesiones
```

Cada aparato (la tablet, los celulares) entra una sola vez y **la sesión no vence**: se renueva sola cada
vez que el aparato usa la app, y reiniciar o actualizar el servidor no la cierra. Solo se cierra si cambian
la contraseña o `MYCHEF_SECRET` (en todos los aparatos: por eso, una vez puestos, no los cambien sin
necesidad), con *Administrar → Casa → Cerrar sesión aquí* (solo ese aparato) o si se borran los datos del
navegador. Tras 8 intentos fallidos se bloquea 5 minutos. Queda cerrado todo lo
que tiene datos (`/api/…`) y la documentación de la API (`/docs`); la pantalla en sí carga y pide entrar.

Si la app está detrás de un proxy con https (Caddy, Traefik, nginx), la cookie de la sesión se marca como
segura sola (por el encabezado `X-Forwarded-Proto`).

Solo dentro de la red de la casa, en vez de usuario y contraseña puede usarse un PIN (`MYCHEF_PIN=2580`):
es más cómodo en la tablet, pero un PIN corto no aguanta estar publicado en internet.

### Inteligencia artificial: Gemini (opcional; OpenAI también sirve para el texto)

Con una sola clave de Gemini funciona todo. Tiene capa gratuita, que para una casa suele alcanzar;
con la capa gratuita Google puede usar lo que se le manda para mejorar sus productos, así que si les
importa activen la facturación (para una casa son centavos al mes).

| Para qué | Modelo por defecto | Variable |
|---|---|---|
| **Fotos**: facturas, nevera y alacena (con los números encima), recetas en foto | `gemini-3.8-flash` (siempre Gemini) | `MYCHEF_PHOTO_MODEL` |
| **Voz**: frases que la tablet no entendió y la agenda por voz (tiene que ser rápido) | `gemini-3.5-flash-lite` | `MYCHEF_TEXT_MODEL` |
| **Menú y recetas**: ideas del menú del domingo, cuestionario de «Cómo comemos», recetas escritas | `gemini-3.8-flash` | `MYCHEF_MENU_MODEL` |

```bash
export GEMINI_API_KEY=...      # https://aistudio.google.com/apikey
export OPENAI_API_KEY=sk-...   # opcional: https://platform.openai.com/api-keys
```

**El modelo de cada uso se elige en Ajustes → Casa → Inteligencia artificial**, y el proveedor sale
del nombre: `gemini-…` va a Gemini y `gpt-…` a OpenAI (con OpenAI, la voz le pide pensar poco para
contestar rápido). Ahí se ve si la clave está lista, aparece la lista de modelos que sus claves pueden
usar (se puede escribir cualquier otro) y el botón **Probar** confirma que funciona. Si la casa solo
tiene `OPENAI_API_KEY`, el texto usa `gpt-5-mini` como antes.

Sin claves todo lo demás funciona igual; esos botones muestran un aviso. Las claves se guardan en el
computador de la casa (variables de entorno o secretos de Codespaces), nunca en la base de datos.

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
  rewards.py   Logros de los niños: estrellas, premio, racha, niveles e insignias
  prize_icons.py Íconos a color de los premios: los incluidos y la búsqueda en Iconify (español → inglés)
  auth.py      PIN opcional de la casa
  clock.py     La hora y el día de la casa (MYCHEF_TZ)
  agenda.py    Agenda familiar: repeticiones, avisos en voz alta y frases como «recuérdame…»
  gcal.py      Sincronización de la agenda con el calendario de Google (MYCHEF_GOOGLE_CREDENTIALS)
  db.py        SQLite o PostgreSQL (MYCHEF_DATABASE_URL); copy_to_postgres.py pasa los datos
  storage.py   Fotos de la familia en disco o en MinIO / S3 (MYCHEF_S3_*)
  services.py  Escalar recetas, disponibilidad, sugerencias, plan semanal, compras
  units.py     Unidades y conversiones
  ai.py        Proveedores de IA: Gemini (fotos) y OpenAI (texto), claves y modelos
  vision.py    Qué se le pide a la IA: facturas, despensa, recetas y frases de voz difíciles
  voice.py     Comandos de voz: entiende la frase y ejecuta la acción
  seed.py      Datos de ejemplo
static/        index.html + hub.js/hub.css: pantalla de la casa · admin.html + admin.js: Administrar
               common.js: íconos, avatares, modales y utilidades · styles.css: base visual
               voice.js: micrófono, voz hablada, manos libres y temporizadores
               wallpaper.svg: fondo sin fotos · fonts/: Lexend
tests/         Pruebas
```

La documentación interactiva de la API está en `/docs`.
