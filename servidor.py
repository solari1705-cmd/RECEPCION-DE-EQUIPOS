#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Postventa - servidor del taller (recepción de equipos, OT y alquileres).

Guarda los ingresos en una base SQLite (datos/recepcion.db) y las fotos en
datos/fotos. Sirve la página a todos los celulares y PC de la red.
Usa solo la biblioteca estándar de Python: no hay nada que instalar.
"""
import base64
import csv
import io
import json
import unicodedata
import zipfile
import zlib
import xml.etree.ElementTree as ET
import reparaciones as REP
import datetime
import contrato as CON
import informe as INF
import urllib.parse
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
DATOS = BASE / "datos"
FOTOS = DATOS / "fotos"
STATIC = BASE / "static"
MAX_BODY = 25 * 1024 * 1024
MAX_IMAGEN_API = 4_500_000

DEFAULTS = {"puerto": 8080, "gemini_api_key": "", "gemini_modelo": "gemini-3.6-flash",
            "anthropic_api_key": "", "modelo": "claude-sonnet-5-5",
            "url_consulta_arca": "https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do",
            "archivo_clientes": "clientes.ods", "archivo_reparaciones": "reparaciones.csv",
            "contrato_numero_inicial": 5888, "plantilla_contrato": "plantillas/contrato_alquiler.docx"}
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"

PROMPTS = {
    "equipo": "\n".join([
        "La imagen muestra la etiqueta, placa o parte trasera de un equipo médico (por ejemplo un monitor de paciente, un ventilador, una estación de anestesia o un esterilizador). Extraé los datos que se lean.",
        "",
        "Respondé solo con un objeto JSON con estas claves. Usá null para lo que no se vea:",
        '{"serie": "número de serie tal como figura (suele estar junto a SN, S/N, Serial No. o SER)", "marca": "fabricante", "modelo": "modelo del equipo, sin la palabra Model", "tipo": "tipo de equipo en español, por ejemplo Monitor de paciente", "dudas": "una frase corta si algún dato es difícil de leer, o null"}',
        "",
        "Reglas: no confundas el número de serie con REF, LOT, PN, el modelo, la fecha de fabricación ni un código UDI o GTIN. Si hay varios números, elegí el que está rotulado como serie. Copiá la serie carácter por carácter; si dudás de un carácter, dá tu mejor lectura y avisalo en dudas.",
    ]),
    "cliente": "\n".join([
        "La imagen es un papel, probablemente escrito a mano, donde una persona anotó sus datos al entregar un equipo para reparar. Extraé los datos.",
        "",
        "Respondé solo con un objeto JSON con estas claves. Usá null para lo que no figure:",
        '{"nombre": "nombre y apellido, o razón social si es una empresa o institución", "doc": "DNI, CUIL o CUIT, solo dígitos, sin puntos ni guiones", "tel": "teléfono tal como figura", "dir": "dirección completa (calle, número, localidad) si figura", "falla": "motivo del ingreso o falla del equipo, solo si el papel la menciona", "dudas": "una frase corta si algo es difícil de leer, o null"}',
        "",
        "Reglas: copiá los números (documento, teléfono, altura de la calle) dígito por dígito; si dudás de un dígito, dá tu mejor lectura y avisalo en dudas. Si el papel trae más de una persona o empresa, usá la que figura como cliente o remitente. Escribí los nombres propios con mayúscula inicial.",
    ]),
}

COLS = [
    "serie", "serie_norm", "tipo", "marca", "modelo", "falla",
    "cliente_nombre", "cliente_doc", "cliente_tel", "cliente_dir", "cliente_iva", "cliente_id", "cliente_codigo",
    "accesorios", "accesorios_txt", "nota", "ot", "cargado", "recibio",
    "fotos", "reparacion", "fecha_rep", "tecnico", "fotos_rep", "notas_int",
]
MAX_FOTOS = 3
MAX_FOTOS_REP = 8
MAX_FOTOS_OT = 10

LOCK = threading.Lock()
ACCESORIOS_BASE = ["Cable de alimentación", "Cargador / fuente", "Batería", "Maletín o funda", "Manual", "Cable de paciente", "Cable de ECG",
                   "Sensor de SpO2", "Manguito de presión", "Sensor de temperatura", "Mascarilla", "Tubuladura / circuito", "Humidificador",
                   "Filtro", "Cánula nasal", "Vaso de nebulizador", "Manguera", "Pieza de mano", "Pedal", "Cable USB", "Control remoto",
                   "Electrodos", "Bolso", "Tapa", "Bandeja"]
TECNICOS_BASE = ["Maximiliano Cabrera", "Guillermo Brown"]
DB = None
CFG = dict(DEFAULTS)


class Err(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


# ---------------------------------------------------------------- configuración
def cargar_config():
    cfg = dict(DEFAULTS)
    ruta = BASE / "config.json"
    if ruta.exists():
        try:
            with open(ruta, encoding="utf-8-sig") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print("No se pudo leer config.json:", e)
            print("Revisá que tenga el formato del ejemplo (comillas dobles y comas).")
            sys.exit(1)
    env = os.environ.get("ANTHROPIC_API_KEY")
    if env:
        cfg["anthropic_api_key"] = env
    env = os.environ.get("GEMINI_API_KEY")
    if env:
        cfg["gemini_api_key"] = env
    for k in ("anthropic_api_key", "gemini_api_key"):
        cfg[k] = (cfg.get(k) or "").strip()
    cfg["gemini_modelo"] = (cfg.get("gemini_modelo") or DEFAULTS["gemini_modelo"]).strip()
    return cfg


def proveedor():
    if CFG["gemini_api_key"]:
        return "gemini"
    if CFG["anthropic_api_key"]:
        return "claude"
    return None


# ---------------------------------------------------------------- base de datos
def abrir_db():
    DATOS.mkdir(exist_ok=True)
    FOTOS.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DATOS / "recepcion.db"), check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        """CREATE TABLE IF NOT EXISTS ingresos (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            actualizado INTEGER NOT NULL,
            serie TEXT, serie_norm TEXT, tipo TEXT, marca TEXT, modelo TEXT, falla TEXT,
            cliente_nombre TEXT, cliente_doc TEXT, cliente_tel TEXT, cliente_dir TEXT,
            accesorios TEXT, accesorios_txt TEXT, nota TEXT, ot TEXT,
            cargado INTEGER NOT NULL DEFAULT 0,
            recibio TEXT,
            foto_etiqueta TEXT, foto_cliente TEXT, foto_estado TEXT
        )"""
    )
    cols = [r[1] for r in db.execute("PRAGMA table_info(ingresos)")]
    if "cliente_iva" not in cols:
        db.execute("ALTER TABLE ingresos ADD COLUMN cliente_iva TEXT")
    if "cliente_id" not in cols:
        db.execute("ALTER TABLE ingresos ADD COLUMN cliente_id INTEGER")
        db.execute("ALTER TABLE ingresos ADD COLUMN cliente_codigo TEXT")
    for col in ("reparacion", "fecha_rep", "tecnico", "fotos_rep", "notas_int"):
        if col not in [r[1] for r in db.execute("PRAGMA table_info(ingresos)")]:
            db.execute("ALTER TABLE ingresos ADD COLUMN %s TEXT" % col)
    db.execute(
        """CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT, cuit TEXT, dni TEXT, nombre TEXT NOT NULL, nombre_norm TEXT, fantasia TEXT,
            tel TEXT, dir TEXT, loc TEXT, zona TEXT, cobrador TEXT, iva TEXT,
            origen TEXT NOT NULL DEFAULT 'app', busqueda TEXT
        )""")
    nuevo_equipos = not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='equipos'").fetchone()
    db.execute(
        """CREATE TABLE IF NOT EXISTS equipos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serie TEXT, serie_norm TEXT NOT NULL UNIQUE, tipo TEXT, marca TEXT, modelo TEXT, descripcion TEXT,
            cliente_id INTEGER, cliente_nombre TEXT, n_ordenes INTEGER NOT NULL DEFAULT 0,
            ultima_ot TEXT, ultima_fecha TEXT, ultimo_defecto TEXT, origen TEXT NOT NULL DEFAULT 'app'
        )""")
    db.execute(
        """CREATE TABLE IF NOT EXISTS ordenes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ot TEXT, estado TEXT, fecha TEXT, serie TEXT, serie_norm TEXT, tipo TEXT, marca TEXT, modelo TEXT,
            descripcion TEXT, cliente TEXT, cliente_norm TEXT, cliente_id INTEGER,
            defecto TEXT, observaciones TEXT, trabajo TEXT
        )""")
    db.execute(
        """CREATE TABLE IF NOT EXISTS guias (
            nro INTEGER PRIMARY KEY, fecha TEXT, fecha_rep TEXT, fecha_entrega TEXT, cod_cliente TEXT, cod_aparato TEXT,
            accesorios TEXT, falla TEXT, obs TEXT, informe TEXT, informe_int TEXT, cod_tec TEXT, busqueda TEXT,
            cliente TEXT, cliente_norm TEXT, cliente_cuit TEXT, cliente_dir TEXT, cliente_tel TEXT,
            tipo TEXT, serie TEXT, serie_norm TEXT, marca TEXT, modelo TEXT, cod_marca TEXT, cod_modelo TEXT, aparato_obs TEXT, equipo_norm TEXT
        )""")
    if "equipo_norm" not in [r[1] for r in db.execute("PRAGMA table_info(guias)")]:
        # versión anterior de la tabla (sin nombre de cliente): son datos derivados, se vuelven a cargar del csv
        db.execute("DROP TABLE guias")
        db.execute("DELETE FROM meta WHERE k='guias_firma'")
        db.execute(
            """CREATE TABLE guias (
                nro INTEGER PRIMARY KEY, fecha TEXT, fecha_rep TEXT, fecha_entrega TEXT, cod_cliente TEXT, cod_aparato TEXT,
                accesorios TEXT, falla TEXT, obs TEXT, informe TEXT, informe_int TEXT, cod_tec TEXT, busqueda TEXT,
                cliente TEXT, cliente_norm TEXT, cliente_cuit TEXT, cliente_dir TEXT, cliente_tel TEXT,
            tipo TEXT, serie TEXT, serie_norm TEXT, marca TEXT, modelo TEXT, cod_marca TEXT, cod_modelo TEXT, aparato_obs TEXT, equipo_norm TEXT
            )""")
        db.execute("CREATE INDEX IF NOT EXISTS ix_guias_serie ON guias(serie_norm)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS alquileres (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero INTEGER NOT NULL, anio TEXT NOT NULL, creado INTEGER NOT NULL, datos TEXT NOT NULL,
            paciente TEXT, dni TEXT, equipo TEXT, inicio TEXT,
            UNIQUE (numero, anio)
        )""")
    db.execute(
        """CREATE TABLE IF NOT EXISTS ot_extra (
            ot TEXT PRIMARY KEY, notas TEXT, fotos TEXT, actualizado INTEGER NOT NULL
        )""")
    if "fecha_fin" not in [r[1] for r in db.execute("PRAGMA table_info(ordenes)")]:
        db.execute("ALTER TABLE ordenes ADD COLUMN fecha_fin TEXT")
    db.execute("CREATE INDEX IF NOT EXISTS ix_ord_serie ON ordenes(serie_norm)")
    db.execute("CREATE INDEX IF NOT EXISTS ix_ord_fecha ON ordenes(fecha)")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_cli_codigo ON clientes(codigo)")
    db.execute("CREATE INDEX IF NOT EXISTS ix_cli_cuit ON clientes(cuit)")
    db.execute("CREATE INDEX IF NOT EXISTS ix_cli_dni ON clientes(dni)")
    if "fotos" not in cols:
        # versión anterior: etiqueta + estado pasan a ser fotos del equipo
        db.execute("ALTER TABLE ingresos ADD COLUMN fotos TEXT")
        for rid, fe, fs in db.execute("SELECT id, foto_etiqueta, foto_estado FROM ingresos").fetchall():
            lista = [x for x in (fe, fs) if x]
            db.execute("UPDATE ingresos SET fotos=?, foto_etiqueta=NULL, foto_estado=NULL WHERE id=?",
                       (json.dumps(lista), rid))
    if "numero" not in cols:
        db.execute("ALTER TABLE ingresos ADD COLUMN numero INTEGER")
        for i, (rid,) in enumerate(db.execute("SELECT id FROM ingresos ORDER BY ts, rowid").fetchall(), 1):
            db.execute("UPDATE ingresos SET numero=? WHERE id=?", (i, rid))
    db.execute("CREATE INDEX IF NOT EXISTS ix_serie ON ingresos(serie_norm)")
    db.execute("CREATE INDEX IF NOT EXISTS ix_doc ON ingresos(cliente_doc)")
    db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS accesorios (nombre_norm TEXT PRIMARY KEY, nombre TEXT NOT NULL, usos INTEGER NOT NULL DEFAULT 0, orden INTEGER NOT NULL DEFAULT 0)")
    db.execute("""CREATE TABLE IF NOT EXISTS preventivos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, creado INTEGER NOT NULL, actualizado INTEGER NOT NULL,
        cliente TEXT, tipo TEXT, marca TEXT, modelo TEXT, serie TEXT, serie_norm TEXT,
        cada_meses INTEGER NOT NULL, proximo TEXT NOT NULL, tareas TEXT, pendientes TEXT, notas TEXT, activo INTEGER NOT NULL DEFAULT 1)""")
    db.execute("""CREATE TABLE IF NOT EXISTS preventivos_hist (
        id INTEGER PRIMARY KEY AUTOINCREMENT, prev_id INTEGER NOT NULL, ts INTEGER NOT NULL, fecha TEXT NOT NULL,
        ot TEXT, tecnico TEXT, trabajo TEXT, proximo_txt TEXT, fotos TEXT)""")
    _ch = {r[1] for r in db.execute("PRAGMA table_info(preventivos_hist)")}
    for _c in ("items", "notas_int"):
        if _c not in _ch:
            db.execute("ALTER TABLE preventivos_hist ADD COLUMN %s TEXT" % _c)
    db.execute("CREATE INDEX IF NOT EXISTS ix_prevh ON preventivos_hist(prev_id)")
    db.execute("CREATE INDEX IF NOT EXISTS ix_prev_prox ON preventivos(proximo)")
    db.execute("CREATE TABLE IF NOT EXISTS tecnicos (nombre_norm TEXT PRIMARY KEY, nombre TEXT NOT NULL, orden INTEGER NOT NULL DEFAULT 0)")
    for i, a in enumerate(ACCESORIOS_BASE):
        db.execute("INSERT OR IGNORE INTO accesorios(nombre_norm, nombre, usos, orden) VALUES (?,?,0,?)", (norm_busq(a), a, i))
    for i, t in enumerate(TECNICOS_BASE):
        db.execute("INSERT OR IGNORE INTO tecnicos(nombre_norm, nombre, orden) VALUES (?,?,?)", (norm_busq(t), t, i))
    db.execute("INSERT OR IGNORE INTO meta(k, v) VALUES ('rev', 0)")
    db.execute("INSERT OR IGNORE INTO meta(k, v) VALUES ('equipos_nuevo', ?)", (1 if nuevo_equipos else 0,))
    db.commit()
    return db


# ---------------------------------------------------------------- clientes
def norm_busq(x):
    x = unicodedata.normalize("NFD", x or "")
    x = "".join(c for c in x if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", x).strip()


def _busqueda(c):
    return norm_busq(" ".join([c.get("codigo") or "", c.get("nombre") or "", c.get("fantasia") or "",
                               c.get("dir") or "", c.get("loc") or "", c.get("tel") or "",
                               c.get("cuit") or "", c.get("dni") or ""]))


def limpiar_dir(d, loc):
    d = re.sub(r"\s+", " ", (d or "")).strip().rstrip("-").strip()
    loc = re.sub(r"\s+", " ", (loc or "")).strip().rstrip("-").strip()
    if loc and norm_busq(loc) not in norm_busq(d):
        d = (d + ", " + loc) if d else loc
    return d


def _celdas_ods(ruta):
    """Lee la primera hoja de un .ods y devuelve una lista de filas (listas de texto)."""
    ns = {"t": "urn:oasis:names:tc:opendocument:xmlns:table:1.0", "x": "urn:oasis:names:tc:opendocument:xmlns:text:1.0"}
    T = "{%s}" % ns["t"]
    with zipfile.ZipFile(ruta) as z:
        raiz = ET.fromstring(z.read("content.xml"))
    tabla = raiz.find(".//t:table", ns)
    filas = []
    for fila in tabla.iter(T + "table-row"):
        celdas = []
        for c in fila:
            if c.tag not in (T + "table-cell", T + "covered-table-cell"):
                continue
            rep_ = int(c.get(T + "number-columns-repeated", "1"))
            txt = " ".join("".join(p.itertext()) for p in c.findall("x:p", ns)).strip()
            celdas.extend([txt] * min(rep_, 60 if not txt else 1000))
        for _ in range(min(int(fila.get(T + "number-rows-repeated", "1")), 1 if not any(celdas) else 1000)):
            filas.append(celdas)
    return filas


ENCAB = [("codigo", ("codigo",)), ("cuit", ("c u i t", "cuit")), ("dni", ("d n i", "dni")),
         ("nombre", ("razon social",)), ("fantasia", ("nombre f",)), ("tel", ("telefono",)),
         ("dir", ("direccion",)), ("loc", ("localidad",)), ("zona", ("zona",)), ("cobrador", ("cobrador",))]


def leer_clientes_ods(ruta):
    filas = _celdas_ods(ruta)
    pos = None
    out = []
    for f in filas:
        norm = [norm_busq(x) for x in f]
        if "codigo" in norm and any(n in ("c u i t", "cuit") for n in norm):
            pos = []
            for clave, pref in ENCAB:
                for i, n in enumerate(norm):
                    if any(n == p or n.startswith(p) for p in pref):
                        pos.append((i, clave))
                        break
            pos.sort()
            continue
        if not pos:
            continue
        reg = {}
        for k, (i, clave) in enumerate(pos):
            fin = pos[k + 1][0] if k + 1 < len(pos) else len(f)
            val = ""
            for j in range(i, min(fin, len(f))):
                v = f[j].strip()
                if v and not re.fullmatch(r"[-\s]+", v):
                    val = v
                    break
            reg[clave] = val
        if not re.fullmatch(r"\d{1,8}", reg.get("codigo", "")):
            continue
        cuit = re.sub(r"\D", "", reg.get("cuit", ""))
        reg["cuit"] = cuit if len(cuit) == 11 else ""
        dni = re.sub(r"\D", "", reg.get("dni", ""))
        reg["dni"] = dni if 6 <= len(dni) <= 9 else ""
        reg["dir"] = limpiar_dir(reg.get("dir"), reg.get("loc"))
        reg["loc"] = re.sub(r"\s*-\s*$", "", reg.get("loc", "")).strip()
        if reg.get("nombre"):
            out.append(reg)
    return out


def importar_clientes():
    ruta = BASE / (CFG.get("archivo_clientes") or "clientes.ods")
    if not ruta.is_file():
        return
    datos = ruta.read_bytes()
    firma = zlib.crc32(datos)
    with LOCK:
        fila = DB.execute("SELECT v FROM meta WHERE k='clientes_firma'").fetchone()
        if fila and fila[0] == firma:
            return
    try:
        regs = leer_clientes_ods(ruta)
    except Exception as e:
        print("No se pudo leer el listado de reparaciones: %s" % e)
        return
    with LOCK:
        for r in regs:
            r["busqueda"] = _busqueda(r)
            r["nombre_norm"] = norm_busq(r["nombre"])
            DB.execute(
                """INSERT INTO clientes (codigo, cuit, dni, nombre, nombre_norm, fantasia, tel, dir, loc, zona, cobrador, origen, busqueda)
                   VALUES (:codigo, :cuit, :dni, :nombre, :nombre_norm, :fantasia, :tel, :dir, :loc, :zona, :cobrador, 'flexxus', :busqueda)
                   ON CONFLICT(codigo) DO UPDATE SET cuit=excluded.cuit, dni=excluded.dni, nombre=excluded.nombre,
                     nombre_norm=excluded.nombre_norm, fantasia=excluded.fantasia, tel=excluded.tel, dir=excluded.dir,
                     loc=excluded.loc, zona=excluded.zona, cobrador=excluded.cobrador, busqueda=excluded.busqueda""",
                {k: r.get(k, "") for k in ("codigo", "cuit", "dni", "nombre", "nombre_norm", "fantasia", "tel", "dir", "loc", "zona", "cobrador", "busqueda")})
        DB.execute("INSERT INTO meta(k, v) VALUES ('clientes_firma', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (firma,))
        DB.commit()
    print("Clientes cargados desde %s: %d" % (ruta.name, len(regs)))


def migrar_clientes_existentes():
    """Ingresos de versiones anteriores: crea/vincula su cliente."""
    with LOCK:
        filas = DB.execute("SELECT * FROM ingresos WHERE cliente_id IS NULL ORDER BY ts").fetchall()
        for f in filas:
            d = {"cliente_doc": f["cliente_doc"] or "", "cliente_nombre": f["cliente_nombre"] or "",
                 "cliente_tel": f["cliente_tel"] or "", "cliente_dir": f["cliente_dir"] or "",
                 "cliente_iva": f["cliente_iva"] or "", "cliente_id": None, "cliente_codigo": ""}
            if not d["cliente_nombre"]:
                continue
            resolver_cliente(d, None)
            DB.execute("UPDATE ingresos SET cliente_id=?, cliente_codigo=? WHERE id=?", (d["cliente_id"], d["cliente_codigo"], f["id"]))
        if filas:
            DB.execute("UPDATE meta SET v = v + 1 WHERE k='rev'")
        flag = DB.execute("SELECT v FROM meta WHERE k='equipos_nuevo'").fetchone()
        if flag and flag[0]:
            for f in DB.execute("SELECT * FROM ingresos ORDER BY ts").fetchall():
                d = {"serie": f["serie"] or "", "tipo": f["tipo"] or "", "marca": f["marca"] or "", "modelo": f["modelo"] or "",
                     "cliente_id": f["cliente_id"], "cliente_nombre": f["cliente_nombre"] or "", "ot": f["ot"] or "",
                     "falla": f["falla"] or ""}
                upsert_equipo(d, True, time.strftime("%Y-%m-%d", time.localtime(f["ts"] / 1000)))
            DB.execute("UPDATE meta SET v=0 WHERE k='equipos_nuevo'")
        DB.commit()


def _clave_nombre(n):
    k = norm_busq(n)
    return k, " ".join(sorted(k.split()))


def archivos_reparaciones():
    """reparaciones.csv y también reparaciones_*.csv (por ejemplo, un listado con fechas). Se combinan por N.º de OT."""
    nombre = Path(CFG.get("archivo_reparaciones") or "reparaciones.csv")
    return sorted(BASE.glob(nombre.stem + "*" + (nombre.suffix or ".csv")))


def importar_listado(nombre, datos):
    """Recibe un listado de OT (.csv o .xls del sistema), lo guarda como reparaciones_dd-mm-aaaa.csv y recarga la base."""
    if not datos:
        raise Err(400, "vacio")
    nombre = (nombre or "").lower()
    es_xls = nombre.endswith(".xls") or datos[:4] in (b"\xd0\xcf\x11\xe0",) or datos[:2] in (b"\x09\x08", b"\x04\x06", b"\x09\x04", b"\x09\x02")
    try:
        if es_xls:
            csv_bytes, n = REP.xls_a_csv(datos)
        else:
            csv_bytes = datos
            n = len([f for f in REP.parsear_csv(datos) if f["ot"]])
    except Exception as e:
        print("Listado no válido:", repr(e))
        raise Err(400, "listado_invalido")
    if n < 1:
        raise Err(400, "sin_filas")
    with LOCK:
        antes = {r["ot"]: r["estado"] for r in DB.execute("SELECT ot, estado FROM ordenes").fetchall()}
    destino = BASE / ("reparaciones_%s.csv" % time.strftime("%d-%m-%Y"))
    tmp = destino.with_suffix(".tmp")
    tmp.write_bytes(csv_bytes)
    tmp.replace(destino)
    importar_equipos()
    with LOCK:
        despues = {r["ot"]: r["estado"] for r in DB.execute("SELECT ot, estado FROM ordenes").fetchall()}
        bump()
        DB.commit()
    nuevas = [k for k in despues if k not in antes]
    cambios = [{"ot": k, "antes": antes[k], "ahora": despues[k]} for k in despues if k in antes and antes[k] != despues[k]]
    return {"ok": True, "archivo": destino.name, "filas": n, "nuevas": len(nuevas), "cambiaron": len(cambios),
            "cambios": cambios[:15], "total": len(despues)}


def importar_guias():
    """Guías del sistema anterior (sistema_anterior.csv, generado desde el Excel viejo). Todas figuran como FINALIZADO."""
    ruta = BASE / (CFG.get("archivo_sistema_anterior") or "sistema_anterior.csv")
    if not ruta.is_file():
        return
    datos = ruta.read_bytes()
    with LOCK:
        rf = DB.execute("SELECT v FROM meta WHERE k='reparaciones_firma'").fetchone()
        # si el sistema anterior no tiene marca o modelo de un equipo y su N.º de serie está en las OT nuevas, se toman de ahí
        conocidos = {r["serie_norm"]: (r["marca"] or "", r["modelo"] or "") for r in
                     DB.execute("SELECT serie_norm, marca, modelo FROM equipos WHERE serie_norm<>'' AND (marca<>'' OR modelo<>'')")}
    firma = zlib.crc32(datos, 2 + (rf[0] if rf else 0) % 100000)
    with LOCK:
        fila = DB.execute("SELECT v FROM meta WHERE k='guias_firma'").fetchone()
        if fila and fila[0] == firma and DB.execute("SELECT 1 FROM guias LIMIT 1").fetchone():
            return
    try:
        filas = list(csv.DictReader(io.StringIO(datos.decode("utf-8-sig"))))
    except Exception as e:
        print("No se pudo leer el sistema anterior: %s" % e)
        return
    reg = []
    for f in filas:
        try:
            nro = int(f["nro"])
        except (KeyError, ValueError):
            continue
        g = lambda k: (f.get(k) or "").strip()
        sn = REP.serie_valida(g("serie"))
        marca, modelo = g("marca"), g("modelo")
        if sn and (not marca or not modelo):
            cm, cmo = conocidos.get(sn, ("", ""))
            marca, modelo = marca or cm, modelo or cmo
        equipo = norm_busq(" ".join([g("tipo"), marca, modelo]))
        busq = norm_busq(" ".join([g("falla"), g("informe"), g("obs"), g("accesorios"), g("informe_int"), g("cliente"),
                                   g("tipo"), g("serie"), marca, modelo]))
        reg.append((nro, g("fecha"), g("fecha_rep"), g("fecha_entrega"), g("cod_cliente"), g("cod_aparato"), g("accesorios"),
                    g("falla"), g("obs"), g("informe"), g("informe_int"), g("cod_tec"), busq,
                    g("cliente"), norm_busq(g("cliente")), g("cliente_cuit"), g("cliente_dir"), g("cliente_tel"),
                    g("tipo"), g("serie"), sn, marca, modelo, g("cod_marca"), g("cod_modelo"), g("aparato_obs"), equipo))
    with LOCK:
        DB.execute("DELETE FROM guias")
        DB.executemany("INSERT OR REPLACE INTO guias (nro, fecha, fecha_rep, fecha_entrega, cod_cliente, cod_aparato, accesorios, falla, obs, informe, informe_int, cod_tec, busqueda, cliente, cliente_norm, cliente_cuit, cliente_dir, cliente_tel, tipo, serie, serie_norm, marca, modelo, cod_marca, cod_modelo, aparato_obs, equipo_norm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", reg)
        DB.execute("INSERT INTO meta(k, v) VALUES ('guias_firma', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (firma,))
        DB.commit()
    print("Guías del sistema anterior cargadas: %d" % len(reg))


def importar_equipos():
    rutas = archivos_reparaciones()
    if not rutas:
        return
    # la semilla (3) cambia cuando cambia lo que se guarda, para forzar una recarga con los mismos archivos
    firma = 3
    for r in rutas:
        firma = zlib.crc32(r.name.encode("utf-8") + r.read_bytes(), firma)
    with LOCK:
        fila = DB.execute("SELECT v FROM meta WHERE k='reparaciones_firma'").fetchone()
        hay_ordenes = DB.execute("SELECT 1 FROM ordenes LIMIT 1").fetchone()
        if fila and fila[0] == firma and hay_ordenes:
            return
    try:
        REP.cargar_marcas(str(STATIC / "lib" / "lector.js"))
        ordenes = REP.leer_reparaciones([str(r) for r in rutas])
        equipos = REP.agrupar_equipos(ordenes)
    except Exception as e:
        print("No se pudo leer el listado de reparaciones: %s" % e)
        return
    with LOCK:
        exacto, tokens = {}, {}
        for c in DB.execute("SELECT id, nombre, fantasia FROM clientes").fetchall():
            for n in (c["nombre"], c["fantasia"]):
                if n:
                    k, t = _clave_nombre(n)
                    exacto.setdefault(k, c["id"])
                    tokens.setdefault(t, c["id"])
        vinc = 0
        for e in equipos:
            k, t = _clave_nombre(e["cliente"])
            cid = exacto.get(k) or tokens.get(t)
            vinc += 1 if cid else 0
            DB.execute(
                """INSERT INTO equipos (serie, serie_norm, tipo, marca, modelo, descripcion, cliente_id, cliente_nombre,
                                        n_ordenes, ultima_ot, ultima_fecha, ultimo_defecto, origen)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'flexxus')
                   ON CONFLICT(serie_norm) DO UPDATE SET serie=excluded.serie, tipo=excluded.tipo, marca=excluded.marca,
                     modelo=excluded.modelo, descripcion=excluded.descripcion, cliente_id=excluded.cliente_id,
                     cliente_nombre=excluded.cliente_nombre, n_ordenes=excluded.n_ordenes, ultima_ot=excluded.ultima_ot,
                     ultima_fecha=excluded.ultima_fecha, ultimo_defecto=excluded.ultimo_defecto
                   WHERE equipos.origen='flexxus'""",
                (e["serie"], e["serie_norm"], e["tipo"], e["marca"], e["modelo"], e["descripcion"], cid, e["cliente"],
                 e["n_ordenes"], e["ultima_ot"], e["ultima_fecha"], e["ultimo_defecto"][:300]))
        DB.execute("DELETE FROM ordenes")
        for o in ordenes:
            k, t = _clave_nombre(o["cliente"])
            DB.execute(
                """INSERT INTO ordenes (ot, estado, fecha, fecha_fin, serie, serie_norm, tipo, marca, modelo, descripcion, cliente,
                                        cliente_norm, cliente_id, defecto, observaciones, trabajo)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (o["ot"], o["estado"], o["fecha"], o["fin"], o["serie"], o["serie_norm"] or re.sub(r"[^A-Z0-9]", "", o["serie"].upper()),
                 o["tipo"], o["marca"], o["modelo"], o["descripcion"], o["cliente"], k,
                 exacto.get(k) or tokens.get(t), o["defecto"][:600], o["observaciones"][:600], o["trabajo"][:300]))
        DB.execute("INSERT INTO meta(k, v) VALUES ('reparaciones_firma', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (firma,))
        DB.execute("INSERT INTO meta(k, v) VALUES ('ordenes_actualizado', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (int(time.time() * 1000),))
        DB.commit()
    print("Órdenes cargadas: %d (archivos: %s)" % (len(ordenes), ", ".join(r.name for r in rutas)))
    print("Equipos cargados desde reparaciones: %d (con cliente de la base: %d)" % (len(equipos), vinc))


def upsert_equipo(d, nuevo_ingreso, fecha_iso):
    """Registra/actualiza el equipo de un ingreso hecho en la app. Se llama con LOCK tomado."""
    sn = REP.serie_valida(d["serie"])
    if not sn:
        return
    desc = " ".join(x for x in (d["tipo"], d["marca"], d["modelo"]) if x)
    fila = DB.execute("SELECT * FROM equipos WHERE serie_norm=?", (sn,)).fetchone()
    if fila is None:
        DB.execute(
            """INSERT INTO equipos (serie, serie_norm, tipo, marca, modelo, descripcion, cliente_id, cliente_nombre,
                                    n_ordenes, ultima_ot, ultima_fecha, ultimo_defecto, origen)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'app')""",
            (d["serie"], sn, d["tipo"], d["marca"], d["modelo"], desc, d["cliente_id"], d["cliente_nombre"],
             1 if nuevo_ingreso else 0, d["ot"], fecha_iso, d["falla"][:300]))
        return
    DB.execute(
        """UPDATE equipos SET serie=?, tipo=?, marca=?, modelo=?, descripcion=?, cliente_id=?, cliente_nombre=?,
                  n_ordenes=n_ordenes+?, ultima_ot=?, ultima_fecha=?, ultimo_defecto=? WHERE id=?""",
        (d["serie"], d["tipo"] or fila["tipo"], d["marca"] or fila["marca"], d["modelo"] or fila["modelo"],
         desc or fila["descripcion"], d["cliente_id"] or fila["cliente_id"], d["cliente_nombre"] or fila["cliente_nombre"],
         1 if nuevo_ingreso else 0, d["ot"] or fila["ultima_ot"], fecha_iso, (d["falla"] or fila["ultimo_defecto"] or "")[:300], fila["id"]))


def a_equipo(r):
    cli = None
    if r["cliente_id"]:
        c = DB.execute("SELECT * FROM clientes WHERE id=?", (r["cliente_id"],)).fetchone()
        cli = a_cliente(c) if c else None
    return {"id": r["id"], "serie": r["serie"] or "", "serieNorm": r["serie_norm"], "tipo": r["tipo"] or "",
            "marca": r["marca"] or "", "modelo": r["modelo"] or "", "descripcion": r["descripcion"] or "",
            "cliente": cli, "clienteNombre": r["cliente_nombre"] or "", "ordenes": r["n_ordenes"],
            "ultimaOt": r["ultima_ot"] or "", "ultimaFecha": r["ultima_fecha"] or "", "ultimoDefecto": r["ultimo_defecto"] or ""}


def buscar_equipos(serie):
    sn = re.sub(r"[^A-Z0-9]", "", (serie or "").upper())
    if len(sn) < 4:
        return []
    with LOCK:
        exacto = DB.execute("SELECT * FROM equipos WHERE serie_norm=?", (sn,)).fetchall()
        otros = []
        if len(sn) >= 5:
            otros = DB.execute("SELECT * FROM equipos WHERE serie_norm LIKE ? AND serie_norm<>? ORDER BY length(serie_norm) LIMIT 5",
                               ("%" + sn + "%", sn)).fetchall()
        return [dict(a_equipo(r), exacto=True) for r in exacto] + [dict(a_equipo(r), exacto=False) for r in otros]


def buscar_equipos_q(q):
    """Busca en la base de equipos por serie, cliente, tipo, marca o modelo (cada palabra tiene que aparecer en alguno)."""
    palabras = norm_busq(q).split()
    if not palabras or sum(len(w) for w in palabras) < 3:
        return []
    out = []
    with LOCK:
        for r in DB.execute("SELECT * FROM equipos ORDER BY ultima_fecha DESC, id DESC").fetchall():
            t = norm_busq(" ".join([r["serie"] or "", r["cliente_nombre"] or "", r["tipo"] or "", r["marca"] or "", r["modelo"] or "", r["descripcion"] or ""]))
            c = t.replace(" ", "")
            if all(w in t or (len(w) >= 3 and w in c) for w in palabras):
                out.append(dict(a_equipo(r), exacto=False))
                if len(out) >= 15:
                    break
    return out


# Estados de Flexxus que se consideran "todavía sin reparar" (esperando reparación, repuestos o presupuesto).
ESTADOS_PEND = ["ESP REPARACION/", "ESP APROB. PRES", "ESP.REPUESTOS", "REPARACION/DIAG", "SERVICE DE TERC"]


def _est_norm(e):
    return re.sub(r"[^a-z0-9]+", " ", norm_busq(e)).strip()


def _extras(ots):
    """Notas internas y fotos por N.º de OT. Se llama con LOCK tomado."""
    ots = [o for o in ots if o]
    out = {}
    for i in range(0, len(ots), 500):
        lote = ots[i:i + 500]
        for r in DB.execute("SELECT * FROM ot_extra WHERE ot IN (%s)" % ",".join("?" * len(lote)), lote):
            try:
                f = json.loads(r["fotos"] or "[]")
            except ValueError:
                f = []
            out[r["ot"]] = {"notas": r["notas"] or "", "fotos": [x for x in f if id_foto(x)]}
    return out


def _item_flexxus(r):
    return {"origen": "flexxus", "ot": r["ot"] or "", "estado": r["estado"] or "", "fecha": r["fecha"] or "",
            "fin": r["fecha_fin"] or "", "serie": r["serie"] or "", "tipo": r["tipo"] or "", "marca": r["marca"] or "",
            "modelo": r["modelo"] or "", "descripcion": r["descripcion"] or "", "cliente": r["cliente"] or "",
            "clienteId": r["cliente_id"], "defecto": r["defecto"] or "", "observaciones": r["observaciones"] or "",
            "trabajo": r["trabajo"] or "", "numero": 0}


def _item_guia(r):
    return {"origen": "anterior", "ot": "", "guia": r["nro"], "estado": "FINALIZADO", "fecha": r["fecha"] or "", "fin": r["fecha_rep"] or "",
            "entrega": r["fecha_entrega"] or "", "serie": r["serie"] or "", "tipo": r["tipo"] or "", "marca": r["marca"] or "", "modelo": r["modelo"] or "", "descripcion": "",
            "aparatoObs": r["aparato_obs"] or "", "cliente": r["cliente"] or "", "clienteCuit": r["cliente_cuit"] or "", "clienteDir": r["cliente_dir"] or "", "clienteTel": r["cliente_tel"] or "",
            "codCliente": r["cod_cliente"] or "", "codAparato": r["cod_aparato"] or "", "clienteId": None,
            "defecto": r["falla"] or "", "observaciones": r["informe"] or "", "trabajo": "", "numero": 0,
            "accesorios": r["accesorios"] or "", "obs": r["obs"] or "", "informeInt": r["informe_int"] or "", "codTec": r["cod_tec"] or ""}


def _poner_extras(items):
    with LOCK:
        ex = _extras({x["ot"] for x in items if x["ot"]})
    for x in items:
        x["extra"] = ex.get(x["ot"]) or {"notas": "", "fotos": []}


def pendientes():
    """Órdenes de Flexxus que todavía no se repararon. No incluye las que ya tienen un ingreso hecho en la app (esas se ven como ingreso)."""
    est = {_est_norm(e) for e in (CFG.get("estados_pendientes") or ESTADOS_PEND)}
    with LOCK:
        filas = DB.execute("SELECT * FROM ordenes").fetchall()
        en_app = {r[0] for r in DB.execute("SELECT ot FROM ingresos WHERE ot<>''")}
    items = [_item_flexxus(r) for r in filas if _est_norm(r["estado"]) in est and r["ot"] not in en_app]
    items.sort(key=lambda x: (x["fecha"], len(x["ot"]), x["ot"]), reverse=True)
    _poner_extras(items)
    return {"items": items}


def guardar_extra(ot, d):
    notas = texto(d.get("notas"), 4000)
    fo = d.get("fotos") if isinstance(d.get("fotos"), list) else []
    nuevas = []
    for x in fo:
        x = id_foto(x)
        if x and x not in nuevas:
            nuevas.append(x)
    nuevas = nuevas[:MAX_FOTOS_OT]
    with LOCK:
        if not (DB.execute("SELECT 1 FROM ordenes WHERE ot=?", (ot,)).fetchone()
                or DB.execute("SELECT 1 FROM ingresos WHERE ot=?", (ot,)).fetchone()):
            raise Err(404, "no_encontrado")
        viejo = _extras([ot]).get(ot) or {"notas": "", "fotos": []}
        if not notas.strip() and not nuevas:
            DB.execute("DELETE FROM ot_extra WHERE ot=?", (ot,))
        else:
            DB.execute(
                """INSERT INTO ot_extra (ot, notas, fotos, actualizado) VALUES (?,?,?,?)
                   ON CONFLICT(ot) DO UPDATE SET notas=excluded.notas, fotos=excluded.fotos, actualizado=excluded.actualizado""",
                (ot, notas, json.dumps(nuevas), int(time.time() * 1000)))
        bump()
        DB.commit()
        rev = DB.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0]
    for x in viejo["fotos"]:
        if x not in nuevas:
            borrar_foto(x)
    return {"ok": True, "rev": rev, "extra": {"notas": notas, "fotos": nuevas}}


def buscar_ordenes(cliente="", serie="", ot="", desde="", hasta="", tipo="", marca="", modelo="", q="", anterior=False, amplia=False):
    """Busca en las órdenes del listado de Flexxus y en los ingresos hechos en la app."""
    cliente = norm_busq(cliente)
    sn = re.sub(r"[^A-Z0-9]", "", (serie or "").upper())
    ot = re.sub(r"\s", "", ot or "")
    ok_f = lambda f: re.fullmatch(r"\d{4}-\d{2}-\d{2}", f or "")
    desde = desde if ok_f(desde) else ""
    hasta = hasta if ok_f(hasta) else ""
    equipo_q = [norm_busq(x).split() for x in (tipo, marca, modelo)]
    equipo_q = [x for x in equipo_q if x]
    general = norm_busq(q).split()
    with LOCK:
        f = DB.execute("SELECT v FROM meta WHERE k='ordenes_actualizado'").fetchone()
        base = {"actualizado": f[0] if f else 0, "cantidad": DB.execute("SELECT count(*) FROM ordenes").fetchone()[0],
                "guias": DB.execute("SELECT count(*) FROM guias").fetchone()[0],
                "ultima": DB.execute("SELECT max(fecha) FROM ordenes").fetchone()[0] or ""}
    if not (cliente or sn or ot or desde or hasta or equipo_q or general):
        return dict(base, items=[], total=0, vacio=True)
    palabras = cliente.split()
    # el tipo/marca/modelo de Flexxus se separa por estimación: se busca en todo el texto del equipo
    def coincide_equipo(texto):
        t = norm_busq(texto)
        return all(all(w in t for w in q) for q in equipo_q)
    # búsqueda general: cada palabra tiene que aparecer en el cliente, la serie, el equipo (tipo, marca, modelo) o el N.º de OT
    def coincide_general(*campos):
        if not general:
            return True
        texto = norm_busq(" ".join(c or "" for c in campos))
        compacto = re.sub(r"[^a-z0-9]", "", texto)
        return all(g in texto or (len(g) >= 3 and g in compacto) for g in general)
    sal = []
    with LOCK:
        cond, par = [], []
        if sn:
            if amplia:
                cond.append("(serie_norm LIKE ? OR (length(serie_norm) >= 5 AND instr(?, serie_norm) > 0))"); par.extend(["%" + sn + "%", sn])
            else:
                cond.append("serie_norm LIKE ?"); par.append("%" + sn + "%")
        if ot:
            cond.append("ot LIKE ?"); par.append("%" + ot + "%")
        if desde:
            cond.append("fecha >= ?"); par.append(desde)
        if hasta:
            cond.append("fecha <> '' AND fecha <= ?"); par.append(hasta)
        w = (" WHERE " + " AND ".join(cond)) if cond else ""
        filas = DB.execute("SELECT * FROM ordenes" + w, par).fetchall()
        for r in filas:
            if palabras and not all(p in (r["cliente_norm"] or "") for p in palabras):
                continue
            if equipo_q and not coincide_equipo(" ".join([r["tipo"] or "", r["marca"] or "", r["modelo"] or "", r["descripcion"] or ""])):
                continue
            if not coincide_general(r["cliente"], r["serie"], r["tipo"], r["marca"], r["modelo"], r["descripcion"], r["ot"]):
                continue
            sal.append(_item_flexxus(r))
        en_flexxus = {x["ot"] for x in sal if x["ot"]}
        cond, par = [], []
        if sn:
            if amplia:
                cond.append("(serie_norm LIKE ? OR (length(serie_norm) >= 5 AND instr(?, serie_norm) > 0))"); par.extend(["%" + sn + "%", sn])
            else:
                cond.append("serie_norm LIKE ?"); par.append("%" + sn + "%")
        if ot:
            cond.append("ot LIKE ?"); par.append("%" + ot + "%")
        if desde:
            cond.append("date(ts/1000,'unixepoch','localtime') >= ?"); par.append(desde)
        if hasta:
            cond.append("date(ts/1000,'unixepoch','localtime') <= ?"); par.append(hasta)
        w = (" WHERE " + " AND ".join(cond)) if cond else ""
        todos = DB.execute("SELECT *, date(ts/1000,'unixepoch','localtime') AS dia FROM ingresos" + w, par).fetchall()
        ingresos_por_ot = {}
        for r in todos:
            if palabras and not all(p in norm_busq(r["cliente_nombre"] or "") for p in palabras):
                continue
            if equipo_q and not coincide_equipo(" ".join([r["tipo"] or "", r["marca"] or "", r["modelo"] or ""])):
                continue
            if not coincide_general(r["cliente_nombre"], r["serie"], r["tipo"], r["marca"], r["modelo"], r["ot"]):
                continue
            if r["ot"] and r["ot"] in en_flexxus:
                ingresos_por_ot[r["ot"]] = r["numero"]
                continue
            sal.append({"origen": "app", "ot": r["ot"] or "", "estado": "Cargado en el sistema" if r["cargado"] else "Sin cargar en el sistema",
                        "fecha": r["dia"] or "", "fin": "", "serie": r["serie"] or "", "tipo": r["tipo"] or "", "marca": r["marca"] or "",
                        "modelo": r["modelo"] or "", "descripcion": "", "cliente": r["cliente_nombre"] or "",
                        "clienteId": r["cliente_id"], "defecto": r["falla"] or "", "observaciones": r["nota"] or "",
                        "trabajo": "", "numero": r["numero"] or 0, "id": r["id"],
                        "reparacion": {"texto": (r["reparacion"] or "")}})
        if anterior:
            cond, par = [], []
            if ot:
                cond.append("CAST(nro AS TEXT) LIKE ?"); par.append("%" + ot + "%")
            if desde:
                cond.append("fecha >= ?"); par.append(desde)
            if hasta:
                cond.append("fecha <> '' AND fecha <= ?"); par.append(hasta)
            for w_ in general:
                cond.append("(busqueda LIKE ? OR CAST(nro AS TEXT) = ?)"); par.extend(["%" + w_ + "%", w_])
            w = (" WHERE " + " AND ".join(cond)) if cond else ""
            for p_ in palabras:
                cond.append("cliente_norm LIKE ?"); par.append("%" + p_ + "%")
            w = (" WHERE " + " AND ".join(cond)) if cond else ""
            if sn:
                cond.append("serie_norm LIKE ?"); par.append("%" + sn + "%")
            for q_ in equipo_q:
                for w_ in q_:
                    cond.append("equipo_norm LIKE ?"); par.append("%" + w_ + "%")
            w = (" WHERE " + " AND ".join(cond)) if cond else ""
            if True:
                for r in DB.execute("SELECT * FROM guias" + w + " ORDER BY fecha DESC, nro DESC LIMIT 1000", par).fetchall():
                    sal.append(_item_guia(r))
    for x in sal:
        if x["origen"] == "flexxus" and x["ot"] in ingresos_por_ot:
            x["numero"] = ingresos_por_ot[x["ot"]]
    total = len(sal)
    sal.sort(key=lambda x: (x["fecha"], len(x["ot"]), x["ot"]), reverse=True)
    sal = sal[:200]
    _poner_extras(sal)
    return dict(base, items=sal, total=total, vacio=False)


def listas():
    with LOCK:
        a = [r[0] for r in DB.execute("SELECT nombre FROM accesorios ORDER BY usos DESC, orden, nombre")]
        t = [r[0] for r in DB.execute("SELECT nombre FROM tecnicos ORDER BY orden, nombre")]
    return {"accesorios": a, "tecnicos": t}


def _nombre_lista(x, n):
    x = re.sub(r"\s+", " ", x or "").strip()[:n]
    return x[:1].upper() + x[1:] if x else ""


def agregar_a_lista(tabla, nombre):
    nombre = _nombre_lista(nombre, 60 if tabla == "tecnicos" else 40)
    k = norm_busq(nombre)
    if not k:
        raise Err(400, "datos")
    with LOCK:
        if DB.execute("SELECT 1 FROM %s WHERE nombre_norm=?" % tabla, (k,)).fetchone() is None:
            o = DB.execute("SELECT COALESCE(MAX(orden),0)+1 FROM %s" % tabla).fetchone()[0]
            if tabla == "accesorios":
                DB.execute("INSERT INTO accesorios(nombre_norm, nombre, usos, orden) VALUES (?,?,0,?)", (k, nombre, o))
            else:
                DB.execute("INSERT INTO tecnicos(nombre_norm, nombre, orden) VALUES (?,?,?)", (k, nombre, o))
            DB.commit()
    return listas()


def _contar_accesorios(lista):
    """Suma un uso a cada accesorio de un ingreso y agrega a la base los que no estaban. Se llama con LOCK tomado."""
    for a in lista:
        k = norm_busq(a)
        if not k:
            continue
        if DB.execute("UPDATE accesorios SET usos=usos+1 WHERE nombre_norm=?", (k,)).rowcount == 0:
            o = DB.execute("SELECT COALESCE(MAX(orden),0)+1 FROM accesorios").fetchone()[0]
            DB.execute("INSERT INTO accesorios(nombre_norm, nombre, usos, orden) VALUES (?,?,1,?)", (k, _nombre_lista(a, 40), o))


# ---------------------------------------------------------------- mantenimientos preventivos
MAX_FOTOS_PREV = 8


def _fecha_iso(x, obligatoria=True):
    x = (x or "").strip()[:10]
    if not x and not obligatoria:
        return ""
    try:
        return datetime.date.fromisoformat(x).isoformat()
    except ValueError:
        raise Err(400, "fecha")


def _lista(v):
    """Lista de ítems (texto) desde una lista, un JSON guardado o un texto con un ítem por línea."""
    if isinstance(v, str):
        t = v.strip()
        try:
            v = json.loads(t) if t[:1] == "[" else [x for x in t.splitlines()]
        except ValueError:
            v = t.splitlines()
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        x = texto(x, 200).strip() if isinstance(x, str) else ""
        if x and x not in out:
            out.append(x)
    return out[:60]


def _limpiar_prev(d):
    try:
        cada = int(d.get("cadaMeses"))
    except (TypeError, ValueError):
        raise Err(400, "frecuencia")
    if not 1 <= cada <= 120:
        raise Err(400, "frecuencia")
    serie = texto(d.get("serie"), 120).upper()
    out = {"cliente": texto(d.get("cliente"), 120), "tipo": texto(d.get("tipo"), 80), "marca": texto(d.get("marca"), 80),
           "modelo": texto(d.get("modelo"), 80), "serie": serie, "serie_norm": norm_serie(serie), "cada_meses": cada,
           "proximo": _fecha_iso(d.get("proximo")), "tareas": json.dumps(_lista(d.get("tareas")), ensure_ascii=False),
           "pendientes": json.dumps(_lista(d.get("pendientes")), ensure_ascii=False), "notas": texto(d.get("notas"), 1000)}
    if not out["cliente"]:
        raise Err(400, "falta_cliente")
    if not (out["tipo"] or out["marca"] or out["modelo"] or out["serie"]):
        raise Err(400, "falta_equipo")
    return out


def _item_prev(r):
    u = DB.execute("SELECT fecha, ot FROM preventivos_hist WHERE prev_id=? ORDER BY fecha DESC, id DESC LIMIT 1", (r["id"],)).fetchone()
    n = DB.execute("SELECT count(*) FROM preventivos_hist WHERE prev_id=?", (r["id"],)).fetchone()[0]
    return {"id": r["id"], "cliente": r["cliente"] or "", "tipo": r["tipo"] or "", "marca": r["marca"] or "", "modelo": r["modelo"] or "",
            "serie": r["serie"] or "", "cadaMeses": r["cada_meses"], "proximo": r["proximo"], "tareas": _lista(r["tareas"] or ""),
            "pendientes": _lista(r["pendientes"] or ""), "notas": r["notas"] or "", "ultima": u["fecha"] if u else "", "ultimaOt": (u["ot"] or "") if u else "",
            "cantidad": n}


def listar_prev():
    with LOCK:
        return {"items": [_item_prev(r) for r in DB.execute("SELECT * FROM preventivos WHERE activo=1 ORDER BY proximo, id").fetchall()]}


def crear_prev(d):
    v = _limpiar_prev(d)
    ahora = int(time.time() * 1000)
    with LOCK:
        cur = DB.execute("""INSERT INTO preventivos (creado, actualizado, cliente, tipo, marca, modelo, serie, serie_norm, cada_meses, proximo, tareas, pendientes, notas)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                         (ahora, ahora, v["cliente"], v["tipo"], v["marca"], v["modelo"], v["serie"], v["serie_norm"], v["cada_meses"], v["proximo"], v["tareas"], v["pendientes"], v["notas"]))
        bump(); DB.commit()
        return _item_prev(DB.execute("SELECT * FROM preventivos WHERE id=?", (cur.lastrowid,)).fetchone())


def editar_prev(id_, d):
    v = _limpiar_prev(d)
    with LOCK:
        if DB.execute("SELECT 1 FROM preventivos WHERE id=? AND activo=1", (id_,)).fetchone() is None:
            raise Err(404, "no_encontrado")
        DB.execute("""UPDATE preventivos SET actualizado=?, cliente=?, tipo=?, marca=?, modelo=?, serie=?, serie_norm=?, cada_meses=?, proximo=?, tareas=?, pendientes=?, notas=? WHERE id=?""",
                   (int(time.time() * 1000), v["cliente"], v["tipo"], v["marca"], v["modelo"], v["serie"], v["serie_norm"], v["cada_meses"], v["proximo"], v["tareas"], v["pendientes"], v["notas"], id_))
        bump(); DB.commit()
        return _item_prev(DB.execute("SELECT * FROM preventivos WHERE id=?", (id_,)).fetchone())


def _fotos_de_hist(r):
    try:
        return [x for x in json.loads(r["fotos"] or "[]") if isinstance(x, str)]
    except ValueError:
        return []


def _items_hist(v):
    try:
        l = json.loads(v or "[]")
    except ValueError:
        l = []
    return [{"t": texto(x.get("t"), 200), "ok": bool(x.get("ok")), "unico": bool(x.get("unico"))}
            for x in l if isinstance(x, dict) and texto(x.get("t"), 200).strip()][:80]


def _item_hist(r):
    return {"id": r["id"], "prevId": r["prev_id"], "fecha": r["fecha"], "ot": r["ot"] or "", "tecnico": r["tecnico"] or "",
            "trabajo": r["trabajo"] or "", "proximos": _lista(r["proximo_txt"] or ""), "notasInt": r["notas_int"] or "",
            "items": _items_hist(r["items"]), "fotos": _fotos_de_hist(r)}


def borrar_prev(id_):
    with LOCK:
        fotos = []
        for r in DB.execute("SELECT * FROM preventivos_hist WHERE prev_id=?", (id_,)).fetchall():
            fotos += _fotos_de_hist(r)
        DB.execute("DELETE FROM preventivos_hist WHERE prev_id=?", (id_,))
        n = DB.execute("DELETE FROM preventivos WHERE id=?", (id_,)).rowcount
        if not n:
            raise Err(404, "no_encontrado")
        bump(); DB.commit()
    for x in fotos:
        borrar_foto(x)
    return {"ok": True}


def historial_prev(id_):
    with LOCK:
        return {"items": [_item_hist(r) for r in DB.execute("SELECT * FROM preventivos_hist WHERE prev_id=? ORDER BY fecha DESC, id DESC", (id_,)).fetchall()]}


def _datos_hist(d):
    fotos = []
    for x in (d.get("fotos") if isinstance(d.get("fotos"), list) else []):
        x = id_foto(x)
        if x and x not in fotos:
            fotos.append(x)
    return {"fecha": _fecha_iso(d.get("fecha") or time.strftime("%Y-%m-%d")), "ot": re.sub(r"[^0-9A-Za-z-]", "", str(d.get("ot") or ""))[:30],
            "tecnico": texto(d.get("tecnico"), 80), "trabajo": texto(d.get("trabajo"), 8000),
            "proximo_txt": json.dumps(_lista(d.get("proximos")), ensure_ascii=False), "notas_int": texto(d.get("notasInt"), 4000),
            "items": json.dumps(_items_hist(json.dumps(d.get("items") if isinstance(d.get("items"), list) else [])), ensure_ascii=False),
            "tareas": _lista(d.get("tareas")) if isinstance(d.get("tareas"), list) else None,
            "fotos": fotos[:MAX_FOTOS_PREV]}


def realizar_prev(id_, d):
    h = _datos_hist(d)
    with LOCK:
        p = DB.execute("SELECT * FROM preventivos WHERE id=? AND activo=1", (id_,)).fetchone()
        if p is None:
            raise Err(404, "no_encontrado")
        ahora = int(time.time() * 1000)
        prox = _fecha_iso(d.get("proximo"), False) or CON.sumar_meses(datetime.date.fromisoformat(h["fecha"]), p["cada_meses"]).isoformat()
        DB.execute("INSERT INTO preventivos_hist (prev_id, ts, fecha, ot, tecnico, trabajo, proximo_txt, fotos, items, notas_int) VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (id_, ahora, h["fecha"], h["ot"], h["tecnico"], h["trabajo"], h["proximo_txt"], json.dumps(h["fotos"]), h["items"], h["notas_int"]))
        DB.execute("UPDATE preventivos SET proximo=?, pendientes=?, actualizado=? WHERE id=?", (prox, h["proximo_txt"], ahora, id_))
        if h["tareas"] is not None:
            DB.execute("UPDATE preventivos SET tareas=? WHERE id=?", (json.dumps(h["tareas"], ensure_ascii=False), id_))
        bump(); DB.commit()
        return _item_prev(DB.execute("SELECT * FROM preventivos WHERE id=?", (id_,)).fetchone())


def editar_hist(hid, d):
    h = _datos_hist(d)
    with LOCK:
        viejo = DB.execute("SELECT * FROM preventivos_hist WHERE id=?", (hid,)).fetchone()
        if viejo is None:
            raise Err(404, "no_encontrado")
        DB.execute("UPDATE preventivos_hist SET fecha=?, ot=?, tecnico=?, trabajo=?, proximo_txt=?, fotos=?, items=?, notas_int=? WHERE id=?",
                   (h["fecha"], h["ot"], h["tecnico"], h["trabajo"], h["proximo_txt"], json.dumps(h["fotos"]), h["items"], h["notas_int"], hid))
        ult = DB.execute("SELECT id FROM preventivos_hist WHERE prev_id=? ORDER BY fecha DESC, id DESC LIMIT 1", (viejo["prev_id"],)).fetchone()
        if ult and ult["id"] == hid:
            DB.execute("UPDATE preventivos SET pendientes=?, actualizado=? WHERE id=?", (h["proximo_txt"], int(time.time() * 1000), viejo["prev_id"]))
        bump(); DB.commit()
        fila = DB.execute("SELECT * FROM preventivos_hist WHERE id=?", (hid,)).fetchone()
    for x in _fotos_de_hist(viejo):
        if x not in h["fotos"]:
            borrar_foto(x)
    return _item_hist(fila)


def borrar_hist(hid):
    with LOCK:
        viejo = DB.execute("SELECT * FROM preventivos_hist WHERE id=?", (hid,)).fetchone()
        if viejo is None:
            raise Err(404, "no_encontrado")
        DB.execute("DELETE FROM preventivos_hist WHERE id=?", (hid,))
        p = DB.execute("SELECT * FROM preventivos WHERE id=?", (viejo["prev_id"],)).fetchone()
        if p is not None:
            ult = DB.execute("SELECT * FROM preventivos_hist WHERE prev_id=? ORDER BY fecha DESC, id DESC LIMIT 1", (p["id"],)).fetchone()
            # sin ese mantenimiento, vuelve a quedar pendiente: la próxima fecha es la anterior más la frecuencia, o la del borrado si no hay otro
            prox = CON.sumar_meses(datetime.date.fromisoformat(ult["fecha"]), p["cada_meses"]).isoformat() if ult else viejo["fecha"]
            DB.execute("UPDATE preventivos SET proximo=?, pendientes=?, actualizado=? WHERE id=?",
                       (prox, (ult["proximo_txt"] or "") if ult else "", int(time.time() * 1000), p["id"]))
        bump(); DB.commit()
    for x in _fotos_de_hist(viejo):
        borrar_foto(x)
    return {"ok": True}


def catalogo():
    with LOCK:
        t = [r[0] for r in DB.execute("SELECT tipo FROM equipos WHERE tipo<>'' GROUP BY tipo ORDER BY count(*) DESC LIMIT 400")]
        m = [r[0] for r in DB.execute("SELECT marca FROM equipos WHERE marca<>'' GROUP BY marca ORDER BY count(*) DESC LIMIT 400")]
    return {"tipos": t, "marcas": m}


def a_cliente(r):
    return {"id": r["id"], "codigo": r["codigo"] or "", "nombre": r["nombre"] or "", "fantasia": r["fantasia"] or "",
            "cuit": r["cuit"] or "", "dni": r["dni"] or "", "tel": r["tel"] or "", "dir": r["dir"] or "",
            "loc": r["loc"] or "", "zona": r["zona"] or "", "iva": r["iva"] or ""}


def buscar_clientes(q="", doc=""):
    with LOCK:
        if doc:
            d = re.sub(r"\D", "", doc)
            if len(d) < 7:
                return []
            padded = d.zfill(8)
            filas = DB.execute(
                "SELECT * FROM clientes WHERE cuit=? OR dni IN (?,?,?) OR (length(?)<=8 AND cuit LIKE ?) LIMIT 8",
                (d, d, padded, d.lstrip("0"), d, "__" + padded + "_")).fetchall()
        else:
            toks = norm_busq(q).split()
            if not toks or sum(len(t) for t in toks) < 2:
                return []
            cond = " AND ".join("busqueda LIKE ?" for _ in toks)
            filas = DB.execute(
                "SELECT * FROM clientes WHERE " + cond + " ORDER BY (nombre_norm LIKE ?) DESC, (codigo = ?) DESC, nombre_norm LIMIT 8",
                ["%" + t + "%" for t in toks] + [toks[0] + "%", toks[0].lstrip("0") or toks[0]]).fetchall()
    return [a_cliente(f) for f in filas]


def resolver_cliente(d, cid):
    """Vincula el ingreso con un cliente de la base; si no existe, lo crea. Se llama con LOCK tomado."""
    fila = None
    if cid:
        fila = DB.execute("SELECT * FROM clientes WHERE id=?", (cid,)).fetchone()
    doc = d["cliente_doc"]
    if fila is None and doc:
        fila = DB.execute("SELECT * FROM clientes WHERE cuit=? OR dni=? LIMIT 1", (doc, doc)).fetchone()
    nn = norm_busq(d["cliente_nombre"])
    if fila is None and nn:
        fila = DB.execute("SELECT * FROM clientes WHERE nombre_norm=? LIMIT 1", (nn,)).fetchone()
    if fila is None:
        c = {"codigo": None, "cuit": doc if len(doc) == 11 else "", "dni": doc if 6 <= len(doc) <= 9 else "",
             "nombre": d["cliente_nombre"], "fantasia": "", "tel": d["cliente_tel"], "dir": d["cliente_dir"], "loc": ""}
        cur = DB.execute(
            """INSERT INTO clientes (codigo, cuit, dni, nombre, nombre_norm, tel, dir, iva, origen, busqueda)
               VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'app', ?)""",
            (c["cuit"], c["dni"], c["nombre"], nn, c["tel"], c["dir"], d["cliente_iva"], _busqueda(c)))
        d["cliente_id"], d["cliente_codigo"] = cur.lastrowid, ""
        return
    # completa solo lo que le falta al cliente
    nuevo = {"tel": fila["tel"] or d["cliente_tel"], "dir": fila["dir"] or d["cliente_dir"],
             "iva": fila["iva"] or d["cliente_iva"],
             "cuit": fila["cuit"] or (doc if len(doc) == 11 else ""), "dni": fila["dni"] or (doc if 6 <= len(doc) <= 9 else "")}
    if any((fila[k] or "") != nuevo[k] for k in nuevo):
        c = dict(a_cliente(fila), **nuevo)
        DB.execute("UPDATE clientes SET tel=?, dir=?, iva=?, cuit=?, dni=?, busqueda=? WHERE id=?",
                   (nuevo["tel"], nuevo["dir"], nuevo["iva"], nuevo["cuit"], nuevo["dni"], _busqueda(c), fila["id"]))
    d["cliente_id"], d["cliente_codigo"] = fila["id"], fila["codigo"] or ""


def texto(v, n=2000):
    return v.strip()[:n] if isinstance(v, str) else ""


def norm_serie(x):
    return re.sub(r"[^A-Z0-9]", "", x.upper())


def solo_digitos(x):
    return re.sub(r"\D", "", x)


def id_foto(v):
    return v if isinstance(v, str) and re.fullmatch(r"[0-9a-f]{32}", v) else None


def limpiar(rec):
    cl = rec.get("cliente") if isinstance(rec.get("cliente"), dict) else {}
    eq = rec.get("equipo") if isinstance(rec.get("equipo"), dict) else {}
    fo = rec.get("fotos") if isinstance(rec.get("fotos"), list) else []
    lista_fotos = []
    for x in fo:
        x = id_foto(x)
        if x and x not in lista_fotos:
            lista_fotos.append(x)
    lista_fotos = lista_fotos[:MAX_FOTOS]
    acc = rec.get("accesorios")
    acc = [texto(a, 80) for a in acc if isinstance(a, str) and a.strip()][:40] if isinstance(acc, list) else []
    serie = texto(eq.get("serie"), 120).upper()
    rp = rec.get("reparacion") if isinstance(rec.get("reparacion"), dict) else {}
    fotos_rep = []
    for x in (rp.get("fotos") if isinstance(rp.get("fotos"), list) else []):
        x = id_foto(x)
        if x and x not in fotos_rep:
            fotos_rep.append(x)
    fecha_rep = texto(rp.get("fecha"), 10)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fecha_rep):
        fecha_rep = ""
    d = {
        "reparacion": texto(rp.get("texto"), 8000),
        "fecha_rep": fecha_rep,
        "tecnico": texto(rp.get("tecnico"), 80),
        "fotos_rep": json.dumps(fotos_rep[:MAX_FOTOS_REP]),
        "notas_int": texto(rec.get("notasInt"), 8000),
        "serie": serie,
        "serie_norm": norm_serie(serie),
        "tipo": texto(eq.get("tipo"), 120),
        "marca": texto(eq.get("marca"), 120),
        "modelo": texto(eq.get("modelo"), 120),
        "falla": texto(rec.get("falla"), 4000),
        "cliente_nombre": texto(cl.get("nombre"), 200),
        "cliente_doc": solo_digitos(texto(cl.get("doc"), 40)),
        "cliente_tel": texto(cl.get("tel"), 80),
        "cliente_dir": texto(cl.get("dir"), 300),
        "cliente_iva": texto(cl.get("iva"), 60),
        "cliente_id": cl.get("id") if isinstance(cl.get("id"), int) else None,
        "cliente_codigo": "",
        "accesorios": json.dumps(acc, ensure_ascii=False),
        "accesorios_txt": texto(rec.get("accesoriosTxt"), 500),
        "nota": texto(rec.get("nota"), 4000),
        "ot": texto(rec.get("ot"), 60),
        "cargado": 1 if rec.get("cargado") else 0,
        "recibio": texto(rec.get("por"), 80),
        "fotos": json.dumps(lista_fotos),
    }
    if not d["cliente_nombre"] or not (d["serie"] or d["modelo"]):
        raise Err(400, "datos")
    return d


def fotos_de(r):
    try:
        v = json.loads(r["fotos"] or "[]")
    except ValueError:
        v = []
    return [x for x in v if id_foto(x)]


def fotos_rep_de(r):
    try:
        v = json.loads(r["fotos_rep"] or "[]")
    except ValueError:
        v = []
    return [x for x in v if id_foto(x)]


def a_registro(r):
    try:
        acc = json.loads(r["accesorios"] or "[]")
    except ValueError:
        acc = []
    return {
        "id": r["id"],
        "numero": r["numero"] or 0,
        "ts": r["ts"],
        "cargado": bool(r["cargado"]),
        "ot": r["ot"] or "",
        "por": r["recibio"] or "",
        "cliente": {
            "nombre": r["cliente_nombre"] or "",
            "doc": r["cliente_doc"] or "",
            "tel": r["cliente_tel"] or "",
            "dir": r["cliente_dir"] or "",
            "iva": r["cliente_iva"] or "",
            "id": r["cliente_id"],
            "codigo": r["cliente_codigo"] or "",
        },
        "equipo": {
            "tipo": r["tipo"] or "",
            "marca": r["marca"] or "",
            "modelo": r["modelo"] or "",
            "serie": r["serie"] or "",
        },
        "nota": r["nota"] or "",
        "falla": r["falla"] or "",
        "accesorios": acc,
        "accesoriosTxt": r["accesorios_txt"] or "",
        "serieNorm": r["serie_norm"] or "",
        "docNorm": r["cliente_doc"] or "",
        "fotos": fotos_de(r),
        "fotoCliente": r["foto_cliente"],
        "reparacion": {"texto": r["reparacion"] or "", "fecha": r["fecha_rep"] or "", "tecnico": r["tecnico"] or "", "fotos": fotos_rep_de(r)},
        "notasInt": r["notas_int"] or "",
    }


def get_rev():
    with LOCK:
        return DB.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0]


def bump():
    DB.execute("UPDATE meta SET v = v + 1 WHERE k='rev'")


def listar():
    with LOCK:
        rev = DB.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0]
        filas = DB.execute("SELECT * FROM ingresos ORDER BY ts DESC LIMIT 5000").fetchall()
    return {"rev": rev, "items": [a_registro(f) for f in filas]}


def crear(rec):
    d = limpiar(rec)
    ahora = int(time.time() * 1000)
    nuevo = uuid.uuid4().hex
    cols = ", ".join(COLS)
    marcas = ", ".join(":" + c for c in COLS)
    with LOCK:
        resolver_cliente(d, d["cliente_id"])
        upsert_equipo(d, True, time.strftime("%Y-%m-%d"))
        _contar_accesorios(json.loads(d["accesorios"] or "[]"))
        numero = DB.execute("SELECT COALESCE(MAX(numero),0)+1 FROM ingresos").fetchone()[0]
        DB.execute(
            "INSERT INTO ingresos (id, numero, ts, actualizado, %s) VALUES (:id, :numero, :ts, :actualizado, %s)" % (cols, marcas),
            dict(d, id=nuevo, numero=numero, ts=ahora, actualizado=ahora),
        )
        bump()
        DB.commit()
        fila = DB.execute("SELECT * FROM ingresos WHERE id=?", (nuevo,)).fetchone()
    return a_registro(fila)


def reemplazar(id_, rec):
    d = limpiar(rec)
    ahora = int(time.time() * 1000)
    asignar = ", ".join("%s=:%s" % (c, c) for c in COLS)
    with LOCK:
        viejo = DB.execute("SELECT * FROM ingresos WHERE id=?", (id_,)).fetchone()
        if viejo is None:
            raise Err(404, "no_encontrado")
        resolver_cliente(d, d["cliente_id"])
        upsert_equipo(d, False, time.strftime("%Y-%m-%d"))
        _antes = set(json.loads(viejo["accesorios"] or "[]"))
        _contar_accesorios([a for a in json.loads(d["accesorios"] or "[]") if a not in _antes])
        DB.execute(
            "UPDATE ingresos SET actualizado=:actualizado, %s WHERE id=:id" % asignar,
            dict(d, id=id_, actualizado=ahora),
        )
        bump()
        DB.commit()
        fila = DB.execute("SELECT * FROM ingresos WHERE id=?", (id_,)).fetchone()
    nuevas = set(fotos_de(fila)) | set(fotos_rep_de(fila))
    for x in fotos_de(viejo) + fotos_rep_de(viejo):
        if x not in nuevas:
            borrar_foto(x)
    return a_registro(fila)


def parchar(id_, cambios):
    sets = []
    params = {"id": id_, "act": int(time.time() * 1000)}
    if "cargado" in cambios:
        sets.append("cargado=:cargado")
        params["cargado"] = 1 if cambios["cargado"] else 0
    if "ot" in cambios:
        sets.append("ot=:ot")
        params["ot"] = texto(cambios.get("ot"), 60)
    if not sets:
        raise Err(400, "datos")
    with LOCK:
        cur = DB.execute("UPDATE ingresos SET actualizado=:act, %s WHERE id=:id" % ", ".join(sets), params)
        if cur.rowcount == 0:
            raise Err(404, "no_encontrado")
        bump()
        DB.commit()
        fila = DB.execute("SELECT * FROM ingresos WHERE id=?", (id_,)).fetchone()
    return a_registro(fila)


def informe_html(id_, con_fotos_ingreso):
    with LOCK:
        fila = DB.execute("SELECT * FROM ingresos WHERE id=?", (id_,)).fetchone()
    if fila is None:
        raise Err(404, "no_encontrado")
    return INF.html_informe(a_registro(fila), con_fotos_ingreso).encode("utf-8")


def borrar(id_):
    with LOCK:
        fila = DB.execute("SELECT * FROM ingresos WHERE id=?", (id_,)).fetchone()
        if fila is None:
            raise Err(404, "no_encontrado")
        DB.execute("DELETE FROM ingresos WHERE id=?", (id_,))
        bump()
        DB.commit()
    for x in fotos_de(fila) + fotos_rep_de(fila) + ([fila["foto_cliente"]] if fila["foto_cliente"] else []):
        borrar_foto(x)
    return {"ok": True}


# ---------------------------------------------------------------- alquileres (contratos en Word)
def _plantilla_contrato(iapos=False):
    if iapos:
        ruta = BASE / (CFG.get("plantilla_contrato_iapos") or "plantillas/contrato_alquiler_iapos.docx")
    else:
        ruta = BASE / (CFG.get("plantilla_contrato") or "plantillas/contrato_alquiler.docx")
    if not ruta.is_file():
        raise Err(500, "falta_plantilla")
    return str(ruta)


def _alquiler(r):
    try:
        datos = json.loads(r["datos"])
    except ValueError:
        datos = {}
    return {"id": r["id"], "numero": r["numero"], "anio": r["anio"], "creado": r["creado"], "datos": datos,
            "paciente": r["paciente"] or "", "dni": r["dni"] or "", "equipo": r["equipo"] or "", "inicio": r["inicio"] or ""}


def _siguiente_contrato():
    f = DB.execute("SELECT max(numero) FROM alquileres").fetchone()[0]
    try:
        inicial = int(CFG.get("contrato_numero_inicial") or 1)
    except (TypeError, ValueError):
        inicial = 1
    return max(inicial, (f or 0) + 1)


def listar_alquileres():
    with LOCK:
        filas = DB.execute("SELECT * FROM alquileres ORDER BY creado DESC, id DESC LIMIT 1000").fetchall()
        sig = _siguiente_contrato()
    return {"items": [_alquiler(r) for r in filas], "siguiente": sig, "anio": time.strftime("%y")}


def _generar_contrato(datos):
    try:
        return CON.generar(_plantilla_contrato(bool(datos.get("iapos"))), datos)
    except CON.ContratoError as e:
        raise Err(500 if e.codigo == "plantilla_distinta" else 400, e.codigo)


def crear_alquiler(body):
    try:
        d = CON.validar(body)
    except CON.ContratoError as e:
        raise Err(400, e.codigo)
    _generar_contrato(d)  # si el modelo de contrato no sirve, se avisa antes de guardar nada
    eq = d["equipos"][0].get("tipo") if d["equipos"] else ""
    with LOCK:
        try:
            cur = DB.execute(
                "INSERT INTO alquileres (numero, anio, creado, datos, paciente, dni, equipo, inicio) VALUES (?,?,?,?,?,?,?,?)",
                (d["numero"], d["anio"], int(time.time() * 1000), json.dumps(d), CON.titulo(d["paciente"]["nombre"]),
                 d["paciente"]["dni"], CON.datos_equipo(d["equipos"]) or d["datos"], d["inicio"]))
        except sqlite3.IntegrityError:
            raise Err(409, "numero_repetido")
        bump()
        DB.commit()
        fila = DB.execute("SELECT * FROM alquileres WHERE id=?", (cur.lastrowid,)).fetchone()
    return _alquiler(fila)


def docx_alquiler(id_):
    with LOCK:
        fila = DB.execute("SELECT * FROM alquileres WHERE id=?", (id_,)).fetchone()
    if fila is None:
        raise Err(404, "no_encontrado")
    try:
        d = CON.validar(json.loads(fila["datos"]))
    except (CON.ContratoError, ValueError):
        raise Err(500, "interno")
    return _generar_contrato(d), CON.nombre_archivo(d)


def borrar_alquiler(id_):
    with LOCK:
        cur = DB.execute("DELETE FROM alquileres WHERE id=?", (id_,))
        if cur.rowcount == 0:
            raise Err(404, "no_encontrado")
        bump()
        DB.commit()
    return {"ok": True}


# ---------------------------------------------------------------- fotos
def tipo_imagen(b):
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def guardar_foto(data):
    if not data or tipo_imagen(data) is None:
        raise Err(400, "formato")
    nuevo = uuid.uuid4().hex
    (FOTOS / nuevo).write_bytes(data)
    return nuevo


def borrar_foto(id_):
    try:
        (FOTOS / id_).unlink()
    except OSError:
        pass


# ---------------------------------------------------------------- lectura de fotos
def extraer_json(t):
    t = t.strip()
    try:
        return json.loads(t)
    except ValueError:
        pass
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except ValueError:
            pass
    i, j = t.find("{"), t.rfind("}")
    if i != -1 and j > i:
        try:
            return json.loads(t[i:j + 1])
        except ValueError:
            pass
    return None


def _post_json(url, headers, cuerpo, etiqueta):
    req = urllib.request.Request(url, data=json.dumps(cuerpo).encode("utf-8"),
                                 headers=dict(headers, **{"content-type": "application/json"}), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            detalle = json.loads(e.read().decode("utf-8")).get("error", {})
            detalle = detalle.get("message", "") if isinstance(detalle, dict) else str(detalle)
        except Exception:
            detalle = ""
        print("[lectura %s] la API respondió %s: %s" % (etiqueta, e.code, detalle[:200]))
        bajo = detalle.lower()
        if e.code in (401, 403) or "api key" in bajo:
            raise Err(502, "clave_invalida")
        if e.code == 429:
            raise Err(429, "limite")
        if "credit balance" in bajo:
            raise Err(402, "sin_credito")
        if e.code == 400:
            raise Err(400, "imagen")
        raise Err(502, "servicio")
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        print("[lectura %s] sin conexión con la API: %s" % (etiqueta, e))
        raise Err(502, "sin_internet")


def leer_imagen(tipo, data):
    try:
        return _leer_imagen(tipo, data)
    except Err as e:
        print("%s [lectura] ERROR %s (%s)" % (time.strftime("%H:%M:%S"), e.code, proveedor()))
        raise


def _leer_imagen(tipo, data):
    prov = proveedor()
    if not prov:
        raise Err(501, "sin_clave")
    if tipo not in PROMPTS:
        raise Err(400, "tipo")
    media = tipo_imagen(data)
    if media is None:
        raise Err(400, "formato")
    if len(data) > MAX_IMAGEN_API:
        raise Err(400, "imagen")
    b64 = base64.b64encode(data).decode("ascii")
    if prov == "gemini":
        resp = _post_json(
            CFG.get("gemini_url") or GEMINI_URL % CFG["gemini_modelo"],
            {"x-goog-api-key": CFG["gemini_api_key"]},
            {"contents": [{"parts": [{"inline_data": {"mime_type": media, "data": b64}},
                                     {"text": PROMPTS[tipo]}]}],
             "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}},
            "gemini")
        partes = []
        for c in (resp.get("candidates") or [])[:1]:
            partes = (c.get("content") or {}).get("parts") or []
        salida = "".join(p.get("text", "") for p in partes if isinstance(p, dict))
    else:
        resp = _post_json(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": CFG["anthropic_api_key"], "anthropic-version": "2023-06-01"},
            {"model": CFG["modelo"], "max_tokens": 1024,
             "messages": [{"role": "user", "content": [
                 {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}},
                 {"type": "text", "text": PROMPTS[tipo]}]}]},
            "claude")
        salida = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    datos = extraer_json(salida)
    if isinstance(datos, list) and datos and isinstance(datos[0], dict):
        datos = datos[0]
    if not isinstance(datos, dict):
        raise Err(502, "ilegible")
    print("%s [lectura] %s OK (%s): %s" % (time.strftime("%H:%M:%S"), prov, tipo,
          ", ".join(k for k, v in datos.items() if v)))
    return {"datos": datos, "motor": prov}


MAX_AUDIO = 14_000_000
PROMPT_AUDIO = ("Transcribí este audio en español rioplatense. Es un técnico de equipos médicos que cuenta qué revisó y qué reparó en un equipo. "
                "Devolvé solamente el texto, ordenado en oraciones claras y con puntuación, sin agregar nada que no se haya dicho ni comentarios tuyos. "
                "Conservá los nombres de piezas, modelos y números tal como se dicen.")


def transcribir_audio(mime, data):
    if proveedor() != "gemini":
        raise Err(501, "sin_clave_audio")
    if not data:
        raise Err(400, "vacio")
    if len(data) > MAX_AUDIO:
        raise Err(413, "audio_grande")
    mime = (mime or "audio/webm").split(";")[0].strip().lower()
    if not re.fullmatch(r"audio/[a-z0-9.+-]{2,20}|video/(webm|mp4|3gpp)", mime):
        raise Err(400, "formato")
    resp = _post_json(
        CFG.get("gemini_url") or GEMINI_URL % CFG["gemini_modelo"],
        {"x-goog-api-key": CFG["gemini_api_key"]},
        {"contents": [{"parts": [{"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode("ascii")}},
                                 {"text": PROMPT_AUDIO}]}],
         "generationConfig": {"temperature": 0}},
        "gemini-audio")
    partes = []
    for c in (resp.get("candidates") or [])[:1]:
        partes = (c.get("content") or {}).get("parts") or []
    texto_ = "".join(p.get("text", "") for p in partes if isinstance(p, dict)).strip()
    if not texto_:
        raise Err(502, "ilegible")
    print("%s [audio] transcripción OK (%d caracteres)" % (time.strftime("%H:%M:%S"), len(texto_)))
    return {"texto": texto_[:8000]}


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "Postventa/1.0"

    def log_message(self, fmt, *args):
        pass

    def _enviar(self, status, cuerpo, tipo, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(cuerpo)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(cuerpo)

    def _json(self, status, obj):
        self._enviar(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                     "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise Err(400, "datos")
        if n < 0 or n > MAX_BODY:
            raise Err(413, "muy_grande")
        return self.rfile.read(n) if n else b""

    def _json_body(self):
        try:
            d = json.loads(self._body().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise Err(400, "json")
        if not isinstance(d, dict):
            raise Err(400, "json")
        return d

    def _estatico(self, nombre, tipo):
        ruta = STATIC / nombre
        if not ruta.is_file():
            raise Err(404, "no_encontrado")
        self._enviar(200, ruta.read_bytes(), tipo, {"Cache-Control": "no-cache"})

    def _lib(self, rel):
        base = (STATIC / "lib").resolve()
        ruta = (base / rel).resolve()
        if base not in ruta.parents or not ruta.is_file():
            raise Err(404, "no_encontrado")
        ext = ruta.suffix.lower()
        tipos = {".js": "application/javascript; charset=utf-8", ".wasm": "application/wasm",
                 ".gz": "application/octet-stream", ".json": "application/json"}
        if ext not in tipos:
            raise Err(404, "no_encontrado")
        self._enviar(200, ruta.read_bytes(), tipos[ext], {"Cache-Control": "public, max-age=86400"})

    def _foto(self, id_):
        ruta = FOTOS / id_
        if not ruta.is_file():
            raise Err(404, "no_encontrado")
        datos = ruta.read_bytes()
        self._enviar(200, datos, tipo_imagen(datos) or "application/octet-stream",
                     {"Cache-Control": "public, max-age=31536000, immutable"})

    def _despachar(self, metodo):
        try:
            url = urlparse(self.path)
            ruta = url.path
            qs = parse_qs(url.query)
            if metodo != "GET":
                print("%s %s %s" % (time.strftime("%H:%M:%S"), metodo, ruta))
            if metodo == "GET":
                if ruta in ("/", "/index.html"):
                    return self._estatico("index.html", "text/html; charset=utf-8")
                if ruta == "/app.js":
                    return self._estatico("app.js", "application/javascript; charset=utf-8")
                if ruta.startswith("/lib/"):
                    return self._lib(ruta[5:])
                if ruta in ("/img/logo.png", "/img/logo-blanco.png", "/img/icono.png", "/img/icon-192.png", "/img/icon-512.png", "/img/icon-maskable.png"):
                    return self._estatico(ruta[1:], "image/png")
                if ruta == "/manifest.webmanifest":
                    return self._estatico("manifest.webmanifest", "application/manifest+json; charset=utf-8")
                if ruta == "/sw.js":
                    return self._estatico("sw.js", "application/javascript; charset=utf-8")
                if ruta == "/favicon.ico":
                    return self._estatico("img/icono.png", "image/png")
                if ruta == "/api/estado":
                    return self._json(200, {"ocr": bool(proveedor()), "proveedor": proveedor(),
                                            "local": (STATIC / "lib" / "tesseract.min.js").exists(),
                                            "arca": CFG.get("url_consulta_arca") or ""})
                if ruta == "/api/clientes":
                    return self._json(200, {"items": buscar_clientes((qs.get("q") or [""])[0][:80], (qs.get("doc") or [""])[0][:20])})
                if ruta == "/api/equipos":
                    if qs.get("q"):
                        return self._json(200, {"items": buscar_equipos_q(qs["q"][0][:80])})
                    return self._json(200, {"items": buscar_equipos((qs.get("serie") or [""])[0][:60])})
                if ruta == "/api/alquileres":
                    return self._json(200, listar_alquileres())
                m = re.fullmatch(r"/api/alquileres/(\d{1,9})/docx", ruta)
                if m:
                    datos, nombre = docx_alquiler(int(m.group(1)))
                    seguro = re.sub(r"[^A-Za-z0-9._-]+", "_", unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode() or "contrato.docx")
                    return self._enviar(200, datos, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                        {"Content-Disposition": "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (seguro, urllib.parse.quote(nombre)),
                                         "Cache-Control": "no-store"})
                if ruta == "/api/pendientes":
                    return self._json(200, pendientes())
                if ruta == "/api/ordenes":
                    g = lambda k, n: (qs.get(k) or [""])[0][:n]
                    return self._json(200, buscar_ordenes(g("cliente", 80), g("serie", 60), g("ot", 30), g("desde", 10), g("hasta", 10),
                                                         g("tipo", 60), g("marca", 60), g("modelo", 60), g("q", 120), g("anterior", 1) == "1", g("amplia", 1) == "1"))
                if ruta == "/api/preventivos":
                    return self._json(200, listar_prev())
                m = re.fullmatch(r"/api/preventivos/(\d{1,9})/historial", ruta)
                if m:
                    return self._json(200, historial_prev(int(m.group(1))))
                if ruta == "/api/listas":
                    return self._json(200, listas())
                if ruta == "/api/catalogo":
                    return self._json(200, catalogo())
                if ruta == "/api/rev":
                    return self._json(200, {"rev": get_rev()})
                if ruta == "/api/recepciones":
                    return self._json(200, listar())
                m = re.fullmatch(r"/fotos/([0-9a-f]{32})", ruta)
                if m:
                    return self._foto(m.group(1))
                m = re.fullmatch(r"/informe/([0-9a-f]{32})", ruta)
                if m:
                    return self._enviar(200, informe_html(m.group(1), (qs.get("ingreso") or [""])[0] == "1"), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
            elif metodo == "POST":
                if ruta == "/api/recepciones":
                    return self._json(201, crear(self._json_body()))
                if ruta == "/api/alquileres":
                    return self._json(201, crear_alquiler(self._json_body()))
                if ruta == "/api/fotos":
                    return self._json(201, {"id": guardar_foto(self._body())})
                if ruta == "/api/ordenes/importar":
                    return self._json(200, importar_listado((qs.get("nombre") or [""])[0][:120], self._body()))
                if ruta == "/api/preventivos":
                    return self._json(201, crear_prev(self._json_body()))
                m = re.fullmatch(r"/api/preventivos/(\d{1,9})/realizar", ruta)
                if m:
                    return self._json(201, realizar_prev(int(m.group(1)), self._json_body()))
                if ruta in ("/api/listas/accesorio", "/api/listas/tecnico"):
                    return self._json(200, agregar_a_lista("accesorios" if ruta.endswith("accesorio") else "tecnicos", str(self._json_body().get("nombre") or "")))
                if ruta == "/api/transcribir":
                    return self._json(200, transcribir_audio((qs.get("mime") or [""])[0][:60], self._body()))
                if ruta == "/api/leer":
                    tipo = (qs.get("tipo") or [""])[0]
                    return self._json(200, leer_imagen(tipo, self._body()))
            else:
                m = re.fullmatch(r"/api/preventivos/(\d{1,9})", ruta)
                if m and metodo == "PUT":
                    return self._json(200, editar_prev(int(m.group(1)), self._json_body()))
                if m and metodo == "DELETE":
                    return self._json(200, borrar_prev(int(m.group(1))))
                m = re.fullmatch(r"/api/preventivos/hist/(\d{1,9})", ruta)
                if m and metodo == "PUT":
                    return self._json(200, editar_hist(int(m.group(1)), self._json_body()))
                if m and metodo == "DELETE":
                    return self._json(200, borrar_hist(int(m.group(1))))
                m = re.fullmatch(r"/api/alquileres/(\d{1,9})", ruta)
                if m and metodo == "DELETE":
                    return self._json(200, borrar_alquiler(int(m.group(1))))
                m = re.fullmatch(r"/api/ot-extra/([\w.\-]{1,40})", ruta)
                if m and metodo == "PUT":
                    return self._json(200, guardar_extra(m.group(1), self._json_body()))
                m = re.fullmatch(r"/api/recepciones/([0-9a-f]{32})", ruta)
                if m:
                    if metodo == "PUT":
                        return self._json(200, reemplazar(m.group(1), self._json_body()))
                    if metodo == "PATCH":
                        return self._json(200, parchar(m.group(1), self._json_body()))
                    if metodo == "DELETE":
                        return self._json(200, borrar(m.group(1)))
            raise Err(404, "no_encontrado")
        except Err as e:
            self._json(e.status, {"error": e.code})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print("Error inesperado:", repr(e))
            try:
                self._json(500, {"error": "interno"})
            except Exception:
                pass

    def do_GET(self):
        self._despachar("GET")

    def do_POST(self):
        self._despachar("POST")

    def do_PUT(self):
        self._despachar("PUT")

    def do_PATCH(self):
        self._despachar("PATCH")

    def do_DELETE(self):
        self._despachar("DELETE")


def ips_locales():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            ips.add(ip)
    except Exception:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


def main():
    global DB, CFG
    CFG = cargar_config()
    DB = abrir_db()
    importar_clientes()
    migrar_clientes_existentes()
    importar_equipos()
    importar_guias()
    puerto = int(CFG["puerto"])
    try:
        servidor = ThreadingHTTPServer(("0.0.0.0", puerto), Handler)
    except OSError as e:
        print("No se pudo abrir el puerto %d: %s" % (puerto, e))
        print("Si ya hay otra ventana del servidor abierta, cerrala. O cambiá el puerto en config.json.")
        sys.exit(1)
    servidor.daemon_threads = True
    print("=" * 62)
    print(" Postventa - servidor funcionando")
    print("=" * 62)
    print(" En esta PC:                 http://localhost:%d" % puerto)
    for ip in ips_locales():
        print(" Desde celulares y otras PC: http://%s:%d" % (ip, puerto))
    print()
    print(" Datos guardados en:", DATOS)
    if proveedor() == "gemini":
        print(" Lectura de fotos: GEMINI (modelo %s)" % CFG["gemini_modelo"])
    elif proveedor() == "claude":
        print(" Lectura de fotos: CLAUDE (modelo %s)" % CFG["modelo"])
    else:
        print(" Lectura automática de fotos: GRATUITA (se hace en el celular, sin internet)")
    print()
    print(" Dejá esta ventana abierta. Para apagar el servidor, cerrala.")
    print("=" * 62)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
