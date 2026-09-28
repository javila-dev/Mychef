# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Una familia en su casa. Quien más la usa en el día a día es la esposa, a quien no le gusta mucho la tecnología: tiene que entender la pantalla de un vistazo y actuar con un toque. El esposo carga recetas, inventario y tareas desde Administrar, y usa la app sobre todo para no olvidar las tareas del hogar. También hay hijos que marcan sus tareas.

## Product Purpose

Organizar la casa alrededor de lo que la familia de verdad cocina y hace: el menú de la semana con sus propias recetas (cantidades y proporciones de la casa), lo que hay en la nevera y la alacena, lo que falta comprar y las tareas del hogar. Éxito: que la tablet de la nevera se use todos los días sin que nadie tenga que explicar cómo.

## Positioning

No trae recetas genéricas: todo sale de las recetas, el inventario y las rutinas de esta familia. El inventario se llena escaneando las facturas del mercado con IA, no escribiendo.

## Operating Context

- Una tablet pegada a la nevera, en la cocina, prendida todo el día: se lee de pie, a un metro o más, con luz de día y de noche.
- También se abre desde el celular (por ejemplo en el supermercado para la lista).
- La pantalla de la tablet vuelve sola al inicio después de 2 minutos sin uso.
- Rituales: cocinar el almuerzo y la cena, hacer mercado y guardar la factura, marcar tareas (basura, loza, plantas…), y el sábado o domingo revisar la nevera y la alacena.

## Capabilities and Constraints

- Pantalla de la casa (`/`): menú de hoy, tareas del día, vencimientos, escanear factura, lista de compras, ¿qué cocino?, "se acabó algo", ¿qué hay? (revisar la casa por grupos), menú de la semana, tareas, modo cocina.
- Administrar (`/admin`): recetas, despensa, compras, personas, tareas y gastos. El menú semanal y las tareas del día a día se manejan desde la pantalla de la casa.
- Servidor FastAPI + SQLite en un equipo de la casa; interfaz HTML/CSS/JS sin framework ni paso de compilación. Debe funcionar sin internet salvo la lectura de facturas con IA.
- Idioma: español (Colombia), tratamiento de "ustedes".

## Brand Commitments

- Confirmaciones y formularios en ventanas (modales), no paneles laterales.
- Nada de estética genérica "hecha con IA" ni de tipografías de moda.
- El verde fue el color pedido originalmente; hoy es preferencia, no obligación.
- Estilo de referencia elegido por el usuario: la pantalla de nevera **Samsung Family Hub**, ejecutada en serio (el estándar de la categoría, sin ironía). Su nivel de acabado es el listón.
- Fotos de la familia rotando como fondo del inicio (las suben ellos; nunca fotos inventadas presentadas como suyas).
- Nada difícil de leer de lejos y nada recargado.

## Evidence on Hand

- Recetas, personas y tareas de ejemplo en `app/seed.py` (sintéticas; se reemplazan por las de la familia).
- No hay fotos reales de la familia en el repositorio: las suben ellos desde la app. No inventar fotos presentadas como de la familia.

## Product Principles

1. Se entiende de lejos y de un vistazo: lo de hoy primero, todo lo demás a un toque.
2. Tranquilo, nunca recargado: pocas cosas en pantalla, cada una grande y clara.
3. Es de la casa, no un programa: la familia y sus fotos son protagonistas.
4. Nada se pierde por un toque equivocado: todo se puede deshacer o confirma antes.

## Accessibility & Inclusion

Lectura cómoda a distancia (letra grande y de alto contraste), objetivos táctiles grandes, y texto sin jerga técnica.
