---
name: MyChef · Nuestra casa
description: La pantalla de la nevera de la familia, al estilo Samsung Family Hub, con sus fotos de fondo.
colors:
  green: "#17804f"
  green-hover: "#126b41"
  green-ink: "#12663f"
  green-soft: "#e2f2e8"
  green-mist: "#eef7f1"
  bg: "#f2f3f5"
  paper: "#ffffff"
  paper-2: "#f6f7f9"
  ink: "#121714"
  muted: "#5b635e"
  line: "#e3e6e8"
  line-strong: "#cdd2d5"
  amber: "#9a4a00"
  amber-soft: "#fff0dc"
  red: "#b3261e"
  red-soft: "#fce4e2"
  tile-list-bg: "#fff0dc"
  tile-list-ink: "#8a4200"
  tile-cook-bg: "#fde2d3"
  tile-cook-ink: "#9a3412"
  tile-photos-bg: "#efe4f7"
  tile-photos-ink: "#6b2f8f"
  tile-inv-bg: "#dcf1ef"
  tile-inv-ink: "#0c5c56"
typography:
  clock:
    fontFamily: "Lexend, Segoe UI, system-ui, sans-serif"
    fontSize: "6.2rem"
    fontWeight: 300
    lineHeight: 0.95
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Lexend, Segoe UI, system-ui, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 600
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Lexend, Segoe UI, system-ui, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 600
  body:
    fontFamily: "Lexend, Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Lexend, Segoe UI, system-ui, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 500
rounded:
  sm: "12px"
  md: "18px"
  lg: "24px"
  widget: "28px"
  pill: "999px"
spacing:
  gap: "16px"
  gutter: "28px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "12px 20px"
  button-primary-hover:
    backgroundColor: "{colors.green-hover}"
  widget:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.widget}"
    padding: "18px 20px"
  action-tile-scan:
    backgroundColor: "{colors.green}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    height: "96px"
  action-tile-list:
    backgroundColor: "{colors.tile-list-bg}"
    textColor: "{colors.tile-list-ink}"
    rounded: "{rounded.lg}"
    height: "96px"
  action-tile-cook:
    backgroundColor: "{colors.tile-cook-bg}"
    textColor: "{colors.tile-cook-ink}"
    rounded: "{rounded.lg}"
    height: "96px"
  action-tile-out:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green-ink}"
    rounded: "{rounded.lg}"
    height: "96px"
  chip-warning:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  tick-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.green}"
    rounded: "{rounded.pill}"
    size: "56px"
---

# Design

## Overview

**Norte (propuesto): "La casa en la puerta de la nevera".** La familia es la protagonista: sus fotos llenan la pantalla y cambian solas. Encima, lo de hoy se lee de lejos y todo se hace con un toque. Referencia elegida por el usuario: la pantalla Samsung Family Hub, ejecutada en serio, combinada con el contenido del inicio anterior (botones grandes con explicación, "Hoy en la mesa", "Ojo con esto").

Dos superficies: la **pantalla de la casa** (`/`, tablet en la nevera y celular) y **Administrar** (`/admin`, carga y ajustes). Comparten tokens, letra, íconos y modales.

## Colors

Estrategia contenida: grises neutros y blanco, un solo acento verde para la acción principal y el estado "hecho". Los botones de acción del inicio tienen cada uno su tono suave (miel, terracota, verde, lila) para distinguirse de un vistazo; su texto es el mismo tono oscurecido (contraste ≥ 5.9:1). Ámbar = avisos (vence, se acaba); rojo = errores y borrar. Modo oscuro automático con las mismas funciones de color.

Sobre la foto: texto blanco con sombra suave y un velo oscuro a la izquierda y abajo; nada de texto gris sobre la foto.

## Typography

Una sola familia, **Lexend** (autoalojada, OFL), elegida por su legibilidad. Reloj en 300 muy grande con números tabulares; saludo en 600; títulos de tarjetas en 600; texto en 400; etiquetas en 500. Cantidades y precios siempre con números tabulares. Sin cursivas (Lexend no las tiene).

## Layout

Tablet horizontal (1280×800) sin desplazamiento: columna izquierda libre sobre la foto (hora, saludo, fecha y casa, invitación a poner fotos y "Ojo con esto" abajo), columna derecha de 360–440 px con tarjetas ("Hoy en la mesa", "Pendientes de hoy"), y abajo una bandeja de dos filas de 4 botones, solo con ícono y título: Lista de compras, ¿Qué cocino?, ¿Qué falta?, ¿Qué hay?, Tareas (verde, con contador de pendientes), Agenda, Fotos y Ajustes. «Escanear» va junto a «Hablar», al lado de la hora; «Oye casa» se activa en Administrar → Casa y tareas. Las tarjetas se desplazan por dentro si no caben; se muestran máximo 3 tareas.

Celular (≤ 760 px): foto arriba (52 vh) con la hora, luego los botones en cuadrícula de 2, luego las tarjetas y al final "Ojo con esto". Pantallas internas: fondo gris, ancho máximo 1180 px, título grande con botón de volver redondo.

## Elevation & Depth

Las superficies internas son planas (blanco sobre gris). Solo lo que flota sobre la foto lleva sombra suave con desplazamiento y un desenfoque detrás del cristal: tarjetas del inicio, botones de acción, ventanas y avisos. Las ventanas (modales) usan una sombra amplia y un fondo oscuro translúcido.

## Shapes

Esquinas amplias: 28 px en tarjetas del inicio y ventanas, 24 px en botones de acción y tarjetas internas, píldora en botones y etiquetas, círculos en avatares, marcar tarea y volver.

## Components

- **Tarjeta del inicio**: blanco al 94 % con desenfoque, título con ícono verde.
- **Hoy en la mesa**: una línea por comida (ícono, plato y estado: ✓, «falta X» / «faltan N» o «ya se cocinó»). La comida que sigue según la hora va resaltada en verde suave y más grande. «Semana ›» arriba a la derecha abre el menú de la semana.
- **Enlace de tarjeta**: en las tarjetas del inicio, el acceso a la pantalla completa va arriba a la derecha junto al título («Semana ›», «Todas ›», «Agenda ›»), no como botón abajo.
- **Tarea**: ícono dibujado en círculo verde claro, nombre, "Le toca a" con avatar (inicial en círculo de color por persona) y botón redondo de 56 px para marcar; tocar de nuevo pide confirmar "Deshacer".
- **Botón de acción**: ícono + nombre, sin explicación (pedido de la familia); contador rojo cuando aplica.
- **Adultos y niños**: donde se elige para cuántos se cocina hay dos contadores (Adultos, Niños). Un niño come una fracción de un adulto (½ por defecto, en Administrar). Las cantidades del inventario se pueden llevar «por porciones» y se leen «Para 2 adultos y 1 niño».
- **Menú de la semana**: página propia de la pantalla de la casa (se entra desde «Hoy en la mesa»). Cada día es una tarjeta con sus cuatro comidas (desayuno, almuerzo, merienda y cena); cada plato dice si hay todo o qué falta, y para quiénes solo si no es la casa completa. Tocar un plato: para quiénes, cocinar, cambiar o quitar. Ya no está en Administrar.
- **¿Qué hay? (revisar la casa)**: tarjetas por grupo (Proteínas, Lácteos y huevos, Verduras…) con ícono en círculo de su tono, cuántas cosas hay y un check verde cuando se revisó hoy; barra de progreso arriba. Dentro de cada grupo, cada cosa con tres botones grandes: Hay (verde), Poco (miel) y Se acabó (rojo). Poco y Se acabó pasan a la lista de compras. El botón del inicio lleva un punto rojo el fin de semana si la casa lleva 6 días o más sin revisar.
- **Ventanas**: título, X redonda, cuerpo y acciones abajo (Cancelar + acción principal). Toda confirmación y formulario va en ventana.
- **Botones que guardan** muestran "procesando" y no aceptan doble toque.
- **Íconos**: dibujados para la app (trazo 1.8, redondeado), nunca emojis en controles.

## Do's and Don'ts

- Sí: que todo lo del inicio quepa en la tablet sin desplazarse; letra grande; lenguaje de la casa ("Toquen…", "Le toca a…").
- Sí: fotos reales de la familia; si no hay, el paisaje de colinas y la invitación a subirlas.
- No: fotos inventadas presentadas como de la familia.
- No: cuadros de diálogo del navegador, paneles laterales, texto gris sobre la foto, fuentes de moda, emojis como íconos de control.
- No: recargar el inicio: máximo 3 tareas y 4 avisos visibles; el resto a un toque.
