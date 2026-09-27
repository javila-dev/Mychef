# 🍲 MyChef — el menú de la casa

Aplicación web para organizar el menú de la familia **con sus propias recetas**
(con las cantidades y proporciones con que las hacen en casa), que sabe **qué hay en la
despensa** y distingue **el tipo de comida** (desayuno, almuerzo, cena, merienda) y
**el tipo de plato** (plato principal, sopa, ensalada, postre…).

No trae recetas genéricas: todo lo que sugiere sale de las recetas que ustedes cargan.

## Qué hace

| Pestaña | Para qué sirve |
|---|---|
| **Menú** | Semana en cuadrícula día × comida. Agregan platos a mano o con **✨ Planear con lo que hay**, que llena los espacios vacíos priorizando lo que ya está en la despensa, lo que está por vencerse y lo que hace rato no cocinan, sin repetir el mismo plato seguido. **✓** marca un plato como cocinado y lo descuenta de la despensa. |
| **¿Qué cocino?** | Elijan comida, tipo de plato y porciones: muestra sus recetas ordenadas por lo que se puede hacer ya, con lo que falta y cantidades exactas. |
| **Recetas** | Sus recetas con ingredientes, cantidades, unidades, notas ("picado"), ingredientes opcionales, pasos y trucos de la casa. Al abrir una se puede **escalar a N porciones** manteniendo las proporciones, y ver al lado de cada ingrediente si hay suficiente (✅ / 🟡 / ❌). **📷 Importar receta escrita** convierte la foto del cuaderno o un texto pegado en una receta editable, respetando sus cantidades. |
| **Despensa** | Lo que hay en casa, con fecha de vencimiento (resalta lo que vence en ≤ 3 días). **📷 Reconocer con una foto** identifica los alimentos de una foto de la nevera o de las compras, usando los nombres de sus recetas para que coincidan; revisan y confirman antes de guardar. **⚖** guarda equivalencias como "1 taza de arroz = 200 g" o "1 zanahoria = 80 g" para comparar recetas en tazas/unidades con compras por peso. |
| **Compras** | Lista de lo que falta para el menú de la semana (descontando la despensa y lo ya cocinado), agrupada por categoría. Se puede copiar, y con **Ya lo compré** pasa a la despensa. |

Además:
- **Personas en casa** (arriba) define las porciones por defecto.
- Las unidades se convierten solas (g/kg/lb/oz, ml/l/taza/cda/cdta, unidad/docena) y se aceptan
  unidades propias ("diente", "pizca", "atado").
- "Tomates", "tomate" y "Tomate" se reconocen como el mismo ingrediente.

## Cómo correrla

Requiere Python 3.10+.

```bash
python -m venv .venv
source .venv/bin/activate          # En Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Abran <http://localhost:8000> (o `http://IP-del-computador:8000` desde el celular en la misma red).

Para probar con recetas de ejemplo antes de cargar las suyas:

```bash
python -m app.seed
```

### Con Docker

```bash
docker compose up -d
```

Los datos quedan en `./data/mychef.db` (un archivo SQLite; para respaldar basta copiarlo).

### Reconocimiento por foto (opcional)

El reconocimiento de la despensa y la importación de recetas usan Claude. Configuren una clave
de API de Anthropic antes de arrancar:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Sin clave todo lo demás funciona igual; esos dos botones muestran un aviso. El modelo se puede
cambiar con `MYCHEF_MODEL` (por defecto `claude-opus-5`). Las solicitudes activan el
*fallback* del lado del servidor (`fallbacks: "default"`), así que si el modelo principal
declina una solicitud, la API la reintenta con otro modelo automáticamente.

## Desarrollo

```bash
pip install -r requirements-dev.txt
pytest
```

Estructura:

```
app/
  main.py      API (FastAPI) y archivos estáticos
  models.py    Tablas: ingredientes, despensa, recetas, menú, historial
  services.py  Escalar recetas, disponibilidad, sugerencias, plan semanal, compras
  units.py     Unidades y conversiones
  vision.py    Reconocimiento con Claude (despensa y recetas)
  seed.py      Datos de ejemplo
static/        Interfaz web (HTML/CSS/JS sin dependencias)
tests/         Pruebas
```

La documentación interactiva de la API está en `/docs`.
