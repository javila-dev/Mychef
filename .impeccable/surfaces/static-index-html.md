---
version: 1
slug: "static-index-html"
primary_target: "static/index.html"
related_targets: ["static/hub.js","static/hub.css"]
---

# Pantalla de la casa (tablet de la nevera)

Scope: `/` (static/index.html + hub.js + hub.css). Visitor mode: Operate.
Audience: la familia de pie frente a la nevera, sobre todo la esposa (no técnica); lectura a un metro o más, de día y de noche.
Job: ver lo de hoy (menú, tareas, vencimientos) y actuar con un toque (factura, lista, qué cocino, se acabó algo).
Constraints: modales para confirmar y formularios; nada difícil de leer; nada recargado; fotos reales de la familia, nunca inventadas.

## Direction contract

THESIS: La pantalla de nevera Samsung Family Hub hecha en serio: la familia a pantalla completa y lo de hoy en pocos widgets grandes. Rechaza el tablero de tarjetas iguales sobre fondo crema.

OWN-WORLD: Foto de la familia a sangre completa que cambia sola con fundido lento, velo oscuro abajo para leer. Widgets blancos redondeados (esquinas grandes estilo One UI) con desenfoque detrás; bandeja de apps redondas con etiqueta abajo. Una sola familia sans legible (Lexend), números tabulares. Acento verde; fondo gris claro o negro en pantallas internas.

STORY: De lejos se ve quiénes son (la foto), la hora y qué se come hoy; de cerca, a quién le toca qué. Todo lo demás está a un toque en la bandeja.

FIRST VIEWPORT: Tablet horizontal. Izquierda: la foto respira libre con hora gigante y fecha encima. Derecha: columna de dos widgets (Hoy en el menú; Tareas de hoy con botón de marcar). Abajo, sobre el velo: bandeja de cinco apps (Factura, Lista con contador, ¿Qué cocino?, Se acabó, Fotos). Sin fotos: fondo de colinas vectoriales y un widget que invita a subir la primera.

FORM: Canon de la categoría (salida estándar elegida por el usuario), referencia Samsung Family Hub; seed ddc1f9d1 (roll degradado, sin retadores).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
