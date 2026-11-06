# Postventa – Recepción de equipos

Sistema del taller para recepción de equipos, órdenes de trabajo (OT) y alquileres.

- `servidor.py`: servidor en Python (solo biblioteca estándar). Guarda los datos en SQLite (`datos/recepcion.db`) y las fotos en `datos/fotos`.
- `static/`: la aplicación web (PWA) que se abre desde celulares y PC.
- `contrato.py`, `informe.py`, `reparaciones.py`: generación de contratos, informes e importación de reparaciones.
- `lib_py/`: dependencias incluidas (xlrd).

Instrucciones de uso completas en [`LEEME.txt`](LEEME.txt).

## Correr localmente

```
python servidor.py
```

y abrir http://localhost:8080. Para usar claves de Gemini/Claude, copiar `config.ejemplo.json` a `config.json` y completarlas (o usar las variables de entorno `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`).

## Datos que NO están en el repositorio

El repositorio es público, así que no se suben datos de clientes ni del taller (ver `.gitignore`):

- `clientes.ods`, `reparaciones*.csv`, `sistema_anterior.csv`
- `plantillas/*.docx` (contratos con nombres y DNI reales)
- `config.json` (claves de API)
- `datos/` (base de datos y fotos)

Estos archivos se copian a mano en la PC donde corre el servidor.
