# -*- coding: utf-8 -*-
"""
Lee el listado de reparaciones del sistema (CSV con valores tipo ="texto") y arma la lista de equipos:
tipo, marca, modelo y número de serie, con su cliente.

En la descripción del equipo suele ir primero el tipo y después el modelo, o a veces el tipo y después la marca
(por ejemplo "NEBULIZADOR NU320" o "AUTOCLAVE -DEL GIUDICE").
"""
import csv
import io
import re
import unicodedata
from collections import Counter

# encabezado del listado (normalizado) -> clave. Se lee por nombre de columna, así sirve para listados con más o menos columnas.
CLAVES = {"estado": "estado", "n o ext": "ext", "n o int": "ot", "modelo": "descripcion", "n serie": "serie",
          "razon social": "cliente", "zona": "zona", "f ingreso": "ingreso", "f terminado": "terminado",
          "trabajo a realizar": "trabajo", "comunicacion": "comunicacion", "ubicacion": "ubicacion", "gtia": "gtia",
          "f entrega prevista": "entrega", "observaciones": "observaciones", "defecto": "defecto",
          "clase comprobante": "clase"}
CAMPOS = sorted(set(CLAVES.values()))


def norm(x):
    x = unicodedata.normalize("NFD", x or "")
    x = "".join(c for c in x if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", x).strip()


def leer_csv(ruta):
    datos = open(ruta, "rb").read()
    return parsear_csv(datos)


def parsear_csv(datos):
    try:
        txt = datos.decode("utf-8-sig")
    except UnicodeDecodeError:
        txt = datos.decode("cp1252", errors="replace")
    lineas = txt.splitlines()
    if not lineas:
        return []
    cab = [CLAVES.get(norm(c)) for c in lineas[0].split(";")]
    while cab and cab[-1] is None and len(cab) > 1 and not lineas[0].split(";")[len(cab) - 1].strip():
        cab.pop()
    filas = []
    for linea in lineas[1:]:
        if not linea.strip():
            continue
        partes = [p.replace('""', '"').strip() for p in re.findall(r'="((?:[^"]|"")*)"', linea)]
        if len(partes) < 10:
            continue
        fila = {k: "" for k in CAMPOS}
        for k, v in zip(cab, partes):
            if k:
                fila[k] = v
        filas.append(fila)
    return filas


# nombres con los que el sistema titula cada columna en el .xls (además de los del .csv)
CLAVES_XLS = dict(CLAVES, **{"n o interna": "ot", "n de serie": "serie", "n o orden": "ot"})
TITULOS = {"estado": "Estado", "ext": "N.O. EXT.", "ot": "N.O. INT.", "descripcion": "Modelo", "serie": "N° Serie",
           "cliente": "Razón Social", "zona": "Zona", "ingreso": "F.Ingreso", "terminado": "F.Terminado",
           "trabajo": "Trabajo a Realizar", "comunicacion": "Comunicación", "ubicacion": "Ubicación", "gtia": "Gtia",
           "entrega": "F. Entrega Prevista", "observaciones": "Observaciones", "defecto": "Defecto", "clase": "Clase Comprobante"}


def xls_a_csv(datos):
    """Convierte el listado .xls del sistema al mismo formato del .csv. Devuelve (bytes del csv, cantidad de filas)."""
    import os
    import sys
    import tempfile
    aqui = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib_py")
    if aqui not in sys.path:
        sys.path.insert(0, aqui)
    import xlrd
    with tempfile.NamedTemporaryFile(suffix=".xls", delete=False) as t:
        t.write(datos)
        ruta = t.name
    try:
        libro = xlrd.open_workbook(ruta)
        hoja = libro.sheet_by_index(0)
        cab = None
        for r in range(min(hoja.nrows, 40)):
            cols = {}
            for c in range(hoja.ncols):
                k = CLAVES_XLS.get(norm(str(hoja.cell_value(r, c))))
                if k and k not in cols.values():
                    cols[c] = k
            if "ot" in cols.values() and "estado" in cols.values():
                cab, r0 = cols, r
                break
        if not cab:
            raise ValueError("no_es_listado")

        def val(c, r):
            cel = hoja.cell(r, c)
            v = cel.value
            if cel.ctype == xlrd.XL_CELL_DATE:
                f = xlrd.xldate_as_datetime(v, libro.datemode)
                return f.strftime("%d/%m/%Y")
            if isinstance(v, float):
                return str(int(v)) if v == int(v) else str(v)
            return str(v).strip()
        orden = [k for k in TITULOS]
        sal = [";".join(TITULOS[k] for k in orden) + ";", ""]
        n = 0
        for r in range(r0 + 1, hoja.nrows):
            fila = {k: "" for k in orden}
            for c, k in cab.items():
                fila[k] = val(c, r)
            if not re.fullmatch(r"\d{5,}", fila["ot"]):
                continue
            sal.append(";".join('="%s"' % fila[k].replace('"', '""') for k in orden) + ";")
            n += 1
        return ("\r\n".join(sal) + "\r\n").encode("utf-8-sig"), n
    finally:
        try:
            os.unlink(ruta)
        except OSError:
            pass


def _espacios(s):
    return re.sub(r"\s+", " ", s or "").strip()


GENERICOS = {"generico", "generica", "genericos", "genericas"}
JUNK_SERIE = re.compile(r"^(s ?/? ?d|s ?/ ?n|sin( .*)?|n ?/ ?a|na|no( .*)?|-+|0+|\.+|s ?n|ns)$", re.I)


def serie_valida(s):
    n = re.sub(r"[^A-Z0-9]", "", (s or "").upper())
    if len(n) < 4 or len(set(n)) < 2:
        return ""
    if JUNK_SERIE.match(_espacios(s)):
        return ""
    return n


PREP = {"de", "del", "la", "el", "los", "las", "a", "por", "para", "en", "con", "y", "e", "o", "al", "c", "sin"}
ADJ = ("ica", "ico", "icas", "icos", "ora", "ores", "al", "ar", "ivo", "iva", "ado", "ada", "ario", "aria", "ante")
MARCAS_CONOCIDAS = set()


def cargar_marcas(ruta_js):
    """Marcas conocidas: las mismas que usa el lector de fotos."""
    try:
        txt = open(ruta_js, encoding="utf-8").read()
        bloque = re.search(r"MARCAS\s*=\s*\[(.*?)\]", txt, re.S).group(1)
        for m in re.findall(r"'([^']+)'", bloque):
            MARCAS_CONOCIDAS.add(norm(m))
    except Exception:
        pass


def dividir_dash(desc):
    """Devuelve (cabeza, cola) cuando el modelo/marca va después de ' -'. Si no, None."""
    m = re.search(r"\s-\s*(?=\S)", desc)
    if not m:
        return None
    return desc[:m.start()].strip(), desc[m.end():].strip()


def aprender_tipos(descs):
    """Los tipos de equipo son lo que va antes del ' -' en las descripciones; sirven para cortar las demás."""
    cont = Counter()
    for d in descs:
        p = dividir_dash(d)
        if p and p[0] and not re.search(r"\d", p[0]) and len(p[0].split()) <= 7:
            w = norm(p[0]).split()
            for k in range(1, len(w) + 1):
                if w[k - 1] not in PREP:
                    cont[" ".join(w[:k])] += 1
    return cont


def _limpia_cola(t):
    t = t.strip().strip("-").strip()
    return _espacios(t)


def separar(desc, tipos):
    """Devuelve (tipo, marca, modelo) a partir de la descripción del sistema."""
    d = _espacios(desc)
    if not d:
        return "", "", ""
    # marca antes del tipo: "VACCURE - BOMBA DE CICATRIZACION ..."
    m = re.match(r"^(\S+(?: \S+){0,2}) - (.{12,})$", d)
    if m and len(m.group(2).split()) >= 3 and not re.search(r"\d", m.group(1)):
        izq = m.group(1).split()
        return m.group(2), izq[0], " ".join(izq[1:])
    cola = ""
    cab = d
    p = dividir_dash(d)
    if p:
        cab, cola = p
    else:
        toks = d.split()
        nt = [norm(t) for t in toks]
        mejor = 0
        for k in range(len(toks) - 1, 0, -1):
            if tipos.get(" ".join(nt[:k]), 0) >= 1:
                mejor = k
                break
        if mejor == 0:
            idx = next((i for i, t in enumerate(toks) if re.search(r"\d", t)), None)
            mejor = idx if idx else (1 if len(toks) > 1 else len(toks))
        cab, cola = " ".join(toks[:mejor]), " ".join(toks[mejor:])
    cola = _limpia_cola(cola)
    cab = _espacios(cab).strip(" -")
    marca = modelo = ""
    if not cola:
        return cab, "", ""
    if norm(cola) in GENERICOS:
        return cab, "", "Genérico"
    if not p:
        # sin guiones: "BOTA PARA PRESOTERAPIA", "MANTA CALEFACTORA" siguen siendo el tipo
        w = cola.split()
        if any(norm(x) in PREP for x in w):
            return _espacios(cab + " " + cola), "", ""
        while w and len(w) >= 1 and norm(w[0]).endswith(ADJ) and len(norm(w[0])) > 5 and (len(w) == 1 or len(" ".join(w[1:])) >= 2):
            cab += " " + w.pop(0)
        cola = " ".join(w)
        if not cola:
            return cab, "", ""
    if " - " in cola:
        a, b = [x.strip() for x in cola.split(" - ", 1)]
        if re.search(r"\d", a) and not re.search(r"\d", b):
            return cab, b, a
    w = cola.split()
    if re.search(r"\d", cola):
        for k in range(min(2, len(w) - 1), 0, -1):
            if norm(" ".join(w[:k])) in MARCAS_CONOCIDAS:
                return cab, " ".join(w[:k]), " ".join(w[k:])
        return cab, "", cola
    return cab, cola, ""


def fmt_tipo(t):
    t = _espacios(t).lower()
    return t[:1].upper() + t[1:]


def fmt_marca(m):
    m = _espacios(m)
    if not m:
        return ""
    return " ".join(w if (len(w) <= 3 and w.isupper() and "&" in w) else w.capitalize() for w in m.lower().split(" "))


def fecha_iso(f):
    """dd/mm/aaaa -> aaaa-mm-dd. Las fechas vacías del sistema vienen como 30/12/1899: se ignoran."""
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", f or "")
    if not m or int(m.group(3)) < 1990:
        return ""
    return "%s-%s-%s" % (m.group(3), m.group(2), m.group(1))


def leer_reparaciones(rutas):
    """Acepta un archivo o varios: se combinan por N.º de OT y los datos del archivo con más columnas completan o pisan a los otros."""
    if isinstance(rutas, str):
        rutas = [rutas]
    # Orden de aplicación: primero los archivos más viejos y, si no se sabe, los de menos columnas. Gana lo último.
    # La fecha de exportación se toma del nombre del archivo (dd-mm-aaaa o aaaa-mm-dd); un archivo con fecha pisa a los que no la tienen.
    def clave(ruta):
        n = str(ruta).replace("\\", "/").rsplit("/", 1)[-1]
        m = re.search(r"(\d{2})[-_.](\d{2})[-_.](\d{4})", n)
        if m:
            return "%s%s%s" % (m.group(3), m.group(2), m.group(1))
        m = re.search(r"(\d{4})[-_.](\d{2})[-_.](\d{2})", n)
        return "".join(m.groups()) if m else "0"
    pares = [(clave(r), leer_csv(r)) for r in rutas]
    listas = [l for _, l in sorted(pares, key=lambda p: (p[0], len([k for k, v in p[1][0].items() if v]) if p[1] else 0))]
    por_ot = {}
    for lista in listas:
        for f in lista:
            if not f["ot"]:
                continue
            ant = por_ot.setdefault(f["ot"], {})
            ant.update({k: v for k, v in f.items() if v.strip()})
    filas = [dict({k: "" for k in CAMPOS}, **f) for f in por_ot.values()]
    tipos = aprender_tipos([f["descripcion"] for f in filas])
    ordenes = []
    for f in filas:
        if f["estado"].upper().startswith("ANULADO"):
            continue
        tipo, marca, modelo = separar(f["descripcion"], tipos)
        ordenes.append({
            "ot": f["ot"], "estado": f["estado"], "descripcion": _espacios(f["descripcion"]),
            "tipo": fmt_tipo(tipo), "marca": fmt_marca(marca), "modelo": modelo,
            "serie": _espacios(f["serie"]).upper(), "serie_norm": serie_valida(f["serie"]),
            "cliente": _espacios(f["cliente"]), "fecha": fecha_iso(f["ingreso"]), "fin": fecha_iso(f["terminado"]),
            "defecto": _espacios(f["defecto"]), "observaciones": _espacios(f["observaciones"]),
            "trabajo": _espacios(f["trabajo"]),
        })
    for campo in ("tipo", "marca"):
        cuenta = {}
        for o in ordenes:
            if o[campo]:
                cuenta.setdefault(norm(o[campo]), Counter())[o[campo]] += 1
        for o in ordenes:
            if o[campo]:
                c = cuenta[norm(o[campo])]
                # preferimos la variante con acentos y, si no hay, la más usada
                o[campo] = max(c, key=lambda v: (sum(1 for ch in v if not ch.isascii()) > 0, c[v]))
    return ordenes


def agrupar_equipos(ordenes):
    """Un equipo por número de serie válido. Los datos salen de la orden más reciente."""
    por = {}
    for o in sorted(ordenes, key=lambda x: (len(x["ot"]), x["ot"])):
        if not o["serie_norm"]:
            continue
        e = por.setdefault(o["serie_norm"], {"serie_norm": o["serie_norm"], "n": 0, "clientes": Counter(), "descs": set()})
        e["n"] += 1
        e["descs"].add(o["descripcion"])
        e["ultima"] = o
        e["clientes"][o["cliente"]] += 1
    # una "serie" repetida con equipos totalmente distintos no sirve para identificar
    out = []
    for k, e in por.items():
        o = e["ultima"]
        if len({norm(d) for d in e["descs"]}) >= 4:
            continue
        out.append({"serie": o["serie"], "serie_norm": k, "tipo": o["tipo"], "marca": o["marca"], "modelo": o["modelo"],
                    "descripcion": o["descripcion"], "cliente": o["cliente"], "n_ordenes": e["n"],
                    "ultima_ot": o["ot"], "ultima_fecha": o["fecha"], "ultimo_defecto": o["observaciones"] or o["defecto"]})
    return out
