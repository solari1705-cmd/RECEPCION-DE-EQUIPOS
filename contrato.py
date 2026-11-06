# -*- coding: utf-8 -*-
"""
Genera el contrato de alquiler en Word a partir del modelo original (plantillas/contrato_alquiler.docx).

No se reconstruye el documento: se abre el .docx del modelo y solo se cambia el texto de los datos variables
(N.º de contrato, paciente, equipo, plazo y fechas). Encabezado, pie, logos, fuentes, márgenes, cláusulas y todo
lo demás quedan byte a byte como en el modelo.
"""
import calendar
import datetime
import io
import re
import zipfile
from xml.sax.saxutils import escape

MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre",
         "Octubre", "Noviembre", "Diciembre"]

# (párrafo, corrida) -> texto que tiene que haber en el modelo (None: los datos del paciente del modelo,
# que pueden ser cualquiera; solo se comprueba que exista esa parte). Si el modelo se modificó y esto ya no coincide,
# se avisa en vez de generar un contrato con los datos en lugar equivocado.
ANCLAS = [
    (1, 4, "NR"), (1, 6, "5"), (1, 7, "8"), (1, 8, "8"), (1, 9, "7"), (1, 12, "2"), (1, 13, "6"),
    (3, 25, "Sr"), (3, 26, None), (3, 27, None), (3, 28, " "), (3, 29, "de la loc"), (3, 32, None),
    (3, 35, "F"), (3, 36, None),
    (5, 9, "u"), (5, 10, "n"), (5, 11, " Concentrador "), (5, 12, "mas"), (5, 13, " tubo de O2 "),
    (5, 18, "04 de "), (5, 19, "Febrero"), (5, 24, "202"), (5, 25, "6"),
    (5, 30, "04 de Febrero"), (5, 32, " de 202"), (5, 33, "7"),
    (5, 38, "Concentrador Philips "), (5, 39, "3663"), (5, 40, "– Tubo de O2 "), (5, 41, None),
    (30, 2, "Rafaela"), (30, 7, "04 de "), (30, 8, "Febrero"), (30, 9, " 2026"),
]


# Modelo de IAPOS (el gremio paga el alquiler). Misma idea: (párrafo, corrida) -> texto que tiene que haber en el modelo.
ANCLAS_IAPOS = [
    (0, 1, "964-"), (0, 2, " 26"),
    (2, 1, None), (2, 2, "de la localidad de "), (2, 3, None),
    (3, 1, "CPAP"), (3, 3, " 15 DE SEPTIEMBRE   "), (3, 4, " 2026– "), (3, 5, "15 DE FEBRERO  "), (3, 6, "202"), (3, 7, "7"),
]


class ContratoError(Exception):
    def __init__(self, codigo, detalle=""):
        Exception.__init__(self, codigo)
        self.codigo = codigo
        self.detalle = detalle


def titulo(s):
    """'JUAN PEREZ' o 'juan perez' -> 'Juan Perez'. Si ya viene con mayúsculas y minúsculas, se respeta."""
    s = re.sub(r"\s+", " ", s or "").strip()
    if not s or not (s.isupper() or s.islower()):
        return s
    chicas = {"de", "del", "la", "las", "los", "y", "e", "el"}
    out = []
    for i, w in enumerate(s.lower().split(" ")):
        out.append(w if (i and w in chicas) else w[:1].upper() + w[1:])
    return " ".join(out)


def sumar_meses(f, n):
    m = f.month - 1 + n
    a, m = f.year + m // 12, m % 12 + 1
    return datetime.date(a, m, min(f.day, calendar.monthrange(a, m)[1]))


def fecha_larga(f):
    return "%02d de %s" % (f.day, MESES[f.month - 1])


def fmt_dni(d):
    n = re.sub(r"\D", "", d or "")
    if 7 <= len(n) <= 8:
        return re.sub(r"\B(?=(\d{3})+(?!\d))", ".", n)
    return (d or "").strip()


def _corridas(parrafo):
    return [(m.start(), m.end()) for m in re.finditer(r"<w:r[ >].*?</w:r>", parrafo, flags=re.S)]


def _texto_corrida(r):
    return "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", r))


def _poner(r, texto):
    nuevo = '<w:t xml:space="preserve">%s</w:t>' % escape(texto)
    if re.search(r"<w:t[ >]", r):
        return re.sub(r"<w:t(?: [^>]*)?>[^<]*</w:t>", lambda m: nuevo, r, count=1)
    return r.replace("</w:r>", nuevo + "</w:r>")


class Documento:
    def __init__(self, xml):
        self.xml = xml
        self.p = [(m.start(), m.end()) for m in re.finditer(r"<w:p[ >].*?</w:p>", xml, flags=re.S)]
        self.cambios = {}  # (párrafo, corrida) -> texto

    def corridas(self, i):
        a, b = self.p[i]
        par = self.xml[a:b]
        return par, _corridas(par)

    def texto(self, i, k):
        par, cs = self.corridas(i)
        s, e = cs[k]
        return _texto_corrida(par[s:e])

    def poner(self, i, k, texto):
        self.cambios[(i, k)] = texto

    def resultado(self):
        por_parrafo = {}
        for (i, k), t in self.cambios.items():
            por_parrafo.setdefault(i, {})[k] = t
        partes, pos = [], 0
        for i in sorted(por_parrafo):
            par, cs = self.corridas(i)
            nuevo, q = [], 0
            for k, (s, e) in enumerate(cs):
                if k in por_parrafo[i]:
                    nuevo.append(par[q:s])
                    nuevo.append(_poner(par[s:e], por_parrafo[i][k]))
                    q = e
            nuevo.append(par[q:])
            a, b = self.p[i]
            partes.append(self.xml[pos:a])
            partes.append("".join(nuevo))
            pos = b
        partes.append(self.xml[pos:])
        return "".join(partes)


def frase_equipo(items):
    """'un Concentrador mas tubo de O2' a partir de los tipos de equipo (se puede corregir a mano en la app)."""
    tipos = [re.sub(r"\s+", " ", (i.get("tipo") or "")).strip() for i in items if (i.get("tipo") or "").strip()]
    if not tipos:
        return ""
    def con_articulo(t):
        primera = t.split(" ")[0].lower()
        return ("una " if primera.endswith("a") and primera not in ("cpap", "bipap") else "un ") + t
    return " mas ".join([con_articulo(tipos[0])] + tipos[1:])


def datos_equipo(items):
    """'Concentrador Philips 3663 N/S 123 – Tubo de O2 BW 183764' a partir de tipo, marca, modelo y serie."""
    out = []
    for i in items:
        t = " ".join(x.strip() for x in (i.get("tipo"), i.get("marca"), i.get("modelo")) if (x or "").strip())
        if (i.get("serie") or "").strip():
            t = (t + " N/S " + i["serie"].strip()).strip()
        if t:
            out.append(t)
    return " – ".join(out)


def validar(d):
    """Normaliza y valida los datos del contrato. Devuelve un dict limpio."""
    def s(k, n=200):
        return re.sub(r"\s+", " ", str(d.get(k) or "")).strip()[:n]
    p = d.get("paciente") if isinstance(d.get("paciente"), dict) else {}
    def sp(k, n=200):
        return re.sub(r"\s+", " ", str(p.get(k) or "")).strip()[:n]
    items = []
    for i in (d.get("equipos") if isinstance(d.get("equipos"), list) else [])[:6]:
        if isinstance(i, dict):
            it = {k: re.sub(r"\s+", " ", str(i.get(k) or "")).strip()[:120] for k in ("tipo", "marca", "modelo", "serie")}
            if any(it.values()):
                items.append(it)
    try:
        inicio = datetime.date.fromisoformat(s("inicio", 10))
    except ValueError:
        raise ContratoError("fecha_inicio")
    firma_txt = s("firma", 10)
    try:
        firma = datetime.date.fromisoformat(firma_txt) if firma_txt else inicio
    except ValueError:
        raise ContratoError("fecha_firma")
    try:
        meses = int(d.get("meses"))
    except (TypeError, ValueError):
        raise ContratoError("plazo")
    if not 1 <= meses <= 120:
        raise ContratoError("plazo")
    try:
        numero = int(d.get("numero"))
    except (TypeError, ValueError):
        raise ContratoError("numero")
    anio = re.sub(r"\D", "", str(d.get("anio") or ""))[-2:]
    if numero < 1 or numero > 99999 or len(anio) != 2:
        raise ContratoError("numero")
    out = {
        "numero": numero, "anio": anio,
        "paciente": {"nombre": sp("nombre", 120), "trato": "Sra" if sp("trato", 4).lower().startswith("sra") else "Sr",
                     "dni": sp("dni", 20), "tel": sp("tel", 60), "dir": sp("dir", 160), "ciudad": sp("ciudad", 100)},
        "equipos": items, "frase": s("frase", 240) or frase_equipo(items), "datos": s("datos", 400) or datos_equipo(items),
        "meses": meses, "inicio": inicio.isoformat(), "firma": firma.isoformat(),
        "incluir_contacto": bool(d.get("incluir_contacto")),
        "iapos": bool(d.get("iapos")),
    }
    pa = out["paciente"]
    if not pa["nombre"]:
        raise ContratoError("falta_nombre")
    if not pa["dir"] or not pa["ciudad"]:
        raise ContratoError("falta_domicilio")
    if not pa["dni"]:
        raise ContratoError("falta_dni")
    if not out["frase"] or not out["datos"]:
        raise ContratoError("falta_equipo")
    return out


def generar(plantilla, d):
    """Devuelve los bytes del .docx. `d` ya validado con validar(). `plantilla` es la ruta del modelo que corresponde (común o IAPOS)."""
    if d.get("iapos"):
        return _generar_iapos(plantilla, d)
    with zipfile.ZipFile(plantilla) as z:
        info = z.infolist()
        contenido = {i.filename: z.read(i.filename) for i in info}
    doc = Documento(contenido["word/document.xml"].decode("utf-8"))
    for (i, k, esperado) in ANCLAS:
        try:
            if doc.texto(i, k) != esperado and esperado is not None:
                raise ContratoError("plantilla_distinta", "párrafo %d, parte %d" % (i, k))
        except IndexError:
            raise ContratoError("plantilla_distinta", "párrafo %d, parte %d" % (i, k))

    ini = datetime.date.fromisoformat(d["inicio"])
    fin = sumar_meses(ini, d["meses"])
    firma = datetime.date.fromisoformat(d["firma"])
    pa = d["paciente"]

    # título: NRO 5887– 26
    doc.poner(1, 6, str(d["numero"]))
    for k in (7, 8, 9):
        doc.poner(1, k, "")
    doc.poner(1, 12, d["anio"])
    doc.poner(1, 13, "")

    # el paciente (EL LOCATARIO)
    doc.poner(3, 25, pa["trato"])
    doc.poner(3, 26, " " + titulo(pa["nombre"]))
    doc.poner(3, 27, "")
    # primero el contacto (si se pidió), después la dirección y por último la localidad:
    # "..., DNI N° ..., teléfono ..., con domicilio en Rivadavia 370, de la localidad de Rafaela, en adelante EL LOCATARIO"
    extra = ""
    if d["incluir_contacto"]:
        extra = (", DNI N° " + fmt_dni(pa["dni"])) if pa["dni"] else ""
        extra += (", teléfono " + pa["tel"]) if pa["tel"] else ""
    dom = ("con domicilio en " + titulo(pa["dir"]) + ", ") if pa["dir"] else ""
    if extra:
        doc.poner(3, 28, "")
        doc.poner(3, 29, extra + ", " + dom + "de la loc")
    else:
        doc.poner(3, 28, "")
        doc.poner(3, 29, ", " + dom + "de la loc")
    doc.poner(3, 32, titulo(pa["ciudad"]))
    for k, t in ((33, ""), (34, ","), (35, ""), (36, ""), (38, ""), (39, "")):
        doc.poner(3, k, t)

    # el equipo, el plazo y las fechas
    doc.poner(5, 9, d["frase"].rstrip() + " ")
    for k in (10, 11, 12, 13):
        doc.poner(5, k, "")
    base = doc.texto(5, 14)
    if "12 meses" not in base:
        raise ContratoError("plantilla_distinta", "plazo")
    doc.poner(5, 14, base.replace("12 meses", "1 mes" if d["meses"] == 1 else "%d meses" % d["meses"]))
    doc.poner(5, 18, "%02d de " % ini.day)
    doc.poner(5, 19, MESES[ini.month - 1])
    doc.poner(5, 24, str(ini.year)[:3])
    doc.poner(5, 25, str(ini.year)[3:])
    doc.poner(5, 30, fecha_larga(fin))
    doc.poner(5, 32, " de " + str(fin.year)[:3])
    doc.poner(5, 33, str(fin.year)[3:])
    doc.poner(5, 38, d["datos"])
    for k in (39, 40, 41):
        doc.poner(5, k, "")

    # fecha de firma
    doc.poner(30, 7, "%02d de " % firma.day)
    doc.poner(30, 8, MESES[firma.month - 1])
    doc.poner(30, 9, " %d" % firma.year)

    contenido["word/document.xml"] = doc.resultado().encode("utf-8")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for i in info:  # mismo orden y mismos archivos que el modelo
            z.writestr(i, contenido[i.filename], compress_type=zipfile.ZIP_DEFLATED)
    return out.getvalue()


def _generar_iapos(plantilla, d):
    with zipfile.ZipFile(plantilla) as z:
        info = z.infolist()
        contenido = {i.filename: z.read(i.filename) for i in info}
    doc = Documento(contenido["word/document.xml"].decode("utf-8"))
    for (i, k, esperado) in ANCLAS_IAPOS:
        try:
            if doc.texto(i, k) != esperado and esperado is not None:
                raise ContratoError("plantilla_distinta", "IAPOS: párrafo %d, parte %d" % (i, k))
        except IndexError:
            raise ContratoError("plantilla_distinta", "IAPOS: párrafo %d, parte %d" % (i, k))

    ini = datetime.date.fromisoformat(d["inicio"])
    fin = sumar_meses(ini, d["meses"])
    firma = datetime.date.fromisoformat(d["firma"])
    pa = d["paciente"]
    may = lambda f: "%02d DE %s" % (f.day, MESES[f.month - 1].upper())

    # título: CONTRATO DE ALQUILER NRO 5964- 26 (el "5" del número está en la primera parte del título)
    base = doc.texto(0, 0)
    if not base.endswith("NRO 5"):
        raise ContratoError("plantilla_distinta", "IAPOS: título")
    doc.poner(0, 0, base[:-1] + str(d["numero"])[0])
    doc.poner(0, 1, str(d["numero"])[1:] + "-")
    doc.poner(0, 2, " " + d["anio"])

    # el paciente (EL LOCATARIO); IAPOS figura en el modelo como quien entrega el equipo
    extra = ""
    if d["incluir_contacto"]:
        extra = (", DNI N° " + fmt_dni(pa["dni"])) if pa["dni"] else ""
        extra += (", teléfono " + pa["tel"]) if pa["tel"] else ""
    dom = ("con domicilio en " + titulo(pa["dir"])) if pa["dir"] else ""
    quien = " " + titulo(pa["nombre"]) + extra + ((", " + dom) if dom else "")
    doc.poner(2, 1, quien + ", " if (extra or dom) else quien + " ")
    doc.poner(2, 3, titulo(pa["ciudad"]) + " ")

    # el equipo, el plazo y las fechas
    doc.poner(3, 1, d["datos"])
    base = doc.texto(3, 2)
    if "6 meses" not in base:
        raise ContratoError("plantilla_distinta", "IAPOS: plazo")
    doc.poner(3, 2, base.replace("6 meses", "1 mes" if d["meses"] == 1 else "%d meses" % d["meses"]))
    doc.poner(3, 3, " " + may(ini) + " ")
    doc.poner(3, 4, " %d– " % ini.year)
    doc.poner(3, 5, may(fin) + " ")
    doc.poner(3, 6, str(fin.year)[:3])
    doc.poner(3, 7, str(fin.year)[3:])

    # cláusula 9: los días de vigencia
    k = 1
    t = doc.texto(11, k)
    if "(180 días" not in t:
        raise ContratoError("plantilla_distinta", "IAPOS: cláusula 9")
    doc.poner(11, k, t.replace("(180 días", "(%d días" % (d["meses"] * 30)))

    # cláusula 11: fecha de firma
    t = doc.texto(13, 0)
    nuevo, n = re.subn(r"(, el )\d{1,2}\s+DE\s+[A-ZÁÉÍÓÚ]+\s*(\. -)", lambda m: m.group(1) + may(firma) + m.group(2), t, count=1)
    if n != 1:
        raise ContratoError("plantilla_distinta", "IAPOS: fecha de firma")
    doc.poner(13, 0, nuevo)

    contenido["word/document.xml"] = doc.resultado().encode("utf-8")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for i in info:
            z.writestr(i, contenido[i.filename], compress_type=zipfile.ZIP_DEFLATED)
    return out.getvalue()


def nombre_archivo(d):
    pa = d["paciente"]
    eq = re.sub(r"[^\w]+", " ", (d["equipos"][0].get("tipo") if d["equipos"] else d["frase"]) or "equipo", flags=re.U).strip().upper()
    nom = re.sub(r"[^\w]+", "_", titulo(pa["nombre"]), flags=re.U).strip("_")
    return "%d-%s%s - %s - %s.docx" % (d["numero"], d["anio"], " IAPOS" if d.get("iapos") else "", nom, eq)
