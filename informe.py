# -*- coding: utf-8 -*-
"""Informe técnico para el cliente: una página HTML lista para imprimir o guardar como PDF desde el navegador.
Nunca incluye las notas internas."""
import html
import time

EMPRESA = "Grupo INBIO S.A."
PIE = ["Rivadavia 370, Rafaela, Santa Fe, ARG", "T: 3492 570670", "info@inbio.com.ar", "www.inbio.com.ar"]


def _e(v):
    return html.escape(str(v or ""), quote=True)


def _parrafos(v):
    v = (v or "").strip()
    return "".join("<p>%s</p>" % _e(p).replace("\n", "<br>") for p in v.split("\n\n") if p.strip()) if v else ""


def _fecha(ms=None, iso=None):
    if iso:
        try:
            a, m, d = iso.split("-")
            return "%s/%s/%s" % (d, m, a)
        except ValueError:
            return ""
    if ms:
        return time.strftime("%d/%m/%Y", time.localtime(ms / 1000))
    return ""


def html_informe(r, con_fotos_ingreso=False):
    e, c, rep = r["equipo"], r["cliente"], r.get("reparacion") or {}
    equipo = " ".join(x for x in (e.get("tipo"), e.get("marca"), e.get("modelo")) if x) or "Equipo"
    filas = [("Cliente", c.get("nombre")), ("Equipo", e.get("tipo")), ("Marca", e.get("marca")), ("Modelo", e.get("modelo")),
             ("N.º de serie", e.get("serie")), ("Ingreso N.º", r.get("numero")), ("Orden de trabajo", r.get("ot")),
             ("Fecha de ingreso", _fecha(ms=r.get("ts"))), ("Fecha de reparación", _fecha(iso=rep.get("fecha")))]
    filas = [(k, v) for k, v in filas if v]
    mitad = (len(filas) + 1) // 2
    def _tabla(fs):
        return "<table>%s</table>" % "".join("<tr><th>%s</th><td>%s</td></tr>" % (_e(k), _e(v)) for k, v in fs)
    datos = '<div class="datos">%s%s</div>' % (_tabla(filas[:mitad]), _tabla(filas[mitad:]))
    acc = list(r.get("accesorios") or [])
    if r.get("accesoriosTxt"):
        acc.append(r["accesoriosTxt"])

    def seccion(titulo, cuerpo):
        return '<section><h2>%s</h2>%s</section>' % (_e(titulo), cuerpo) if cuerpo else ""

    total = len(rep.get("fotos") or []) + (len(r.get("fotos") or []) if con_fotos_ingreso else 0)
    tam = "f1" if total <= 4 else "f2" if total <= 8 else "f3"

    def fotos(ids, texto):
        if not ids:
            return ""
        return '<div class="fotos ' + tam + '">%s</div>' % "".join(
            '<figure><img src="/fotos/%s" alt="%s %d"><figcaption>%s %d</figcaption></figure>' % (i, _e(texto), n + 1, _e(texto), n + 1)
            for n, i in enumerate(ids))

    cuerpo = [
        seccion("Falla declarada", _parrafos(r.get("falla"))),
        seccion("Accesorios recibidos", "<p>%s</p>" % _e(", ".join(acc)) if acc else ""),
        seccion("Trabajo realizado", _parrafos(rep.get("texto")) or "<p class='vacio'>Todavía no se cargó el trabajo realizado.</p>"),
        seccion("Fotos de la reparación", fotos(rep.get("fotos"), "Reparación")),
        seccion("Fotos del equipo al ingreso", fotos(r.get("fotos"), "Ingreso") if con_fotos_ingreso else ""),
    ]
    tec = ("<div class='firmas'><div class='firma'>Servicio técnico · %s%s</div>"
           "<div class='firma'>Firma del cliente<br><span>Aclaración y DNI:</span></div></div>") % (
        _e(EMPRESA), ("<br><b>%s</b>" % _e(rep.get("tecnico"))) if rep.get("tecnico") else "")
    num = r.get("numero") or ""
    ing = "checked" if con_fotos_ingreso else ""
    return """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Informe técnico %(num)s - %(equipo)s</title>
<style>
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.4 "Inter", Arial, Helvetica, sans-serif; color: #172236; background: #E3E5E3; }
.barra { position: sticky; top: 0; background: #172236; color: #fff; padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; z-index: 2; }
.barra button { font: inherit; font-weight: 600; min-height: 42px; padding: 0 18px; border-radius: 10px; border: 0; background: #79E290; color: #172236; cursor: pointer; }
.barra label { display: flex; gap: 8px; align-items: center; }
.barra small { opacity: .85; flex-basis: 100%%; }
.hoja { background: #fff; max-width: 210mm; margin: 16px auto; padding: 10mm; box-shadow: 0 2px 12px rgba(0,0,0,.15); }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 3px solid #57b698; padding-bottom: 6px; }
header img { height: 38px; }
header .t { text-align: right; }
header .t b { display: block; font-size: 20px; letter-spacing: .04em; }
header .t span { color: #4B5668; font-size: 13px; }
.datos { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; margin: 8px 0 2px; }
table { width: 100%%; border-collapse: collapse; margin: 0; align-self: start; font-size: 13px; }
th { text-align: left; width: 38%%; font-weight: 600; color: #4B5668; padding: 2px 8px 2px 0; vertical-align: top; }
td { padding: 2px 0; overflow-wrap: anywhere; }
section { margin-top: 9px; break-inside: avoid; }
h2 { font-size: 13px; letter-spacing: .09em; text-transform: uppercase; color: #2B7C66; margin: 0 0 4px; border-bottom: 1px solid #D2D6D3; padding-bottom: 3px; }
p { margin: 0 0 4px; overflow-wrap: anywhere; }
.vacio { color: #9A5408; }
.fotos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 4px; }
figure { margin: 0; break-inside: avoid; }
figure img { width: 100%%; height: 40mm; object-fit: contain; border: 1px solid #D2D6D3; background: #F2F4F2; display: block; }
.f2 figure img { height: 30mm; }
.f3 { grid-template-columns: repeat(6, 1fr); }
.f3 figure img { height: 22mm; }
figcaption { font-size: 10px; color: #4B5668; text-align: center; margin-top: 2px; }
.firmas { display: grid; grid-template-columns: 1fr 1fr; gap: 14mm; margin-top: 16mm; }
.firma { padding-top: 5px; border-top: 1px solid #172236; font-size: 12px; min-height: 12mm; }
.firma span { color: #4B5668; }
footer { margin-top: 8mm; padding-top: 6px; border-top: 1px solid #D2D6D3; font-size: 12px; color: #4B5668; display: flex; flex-wrap: wrap; gap: 2px 14px; justify-content: space-between; }
@media print {
  body { background: #fff; }
  .barra { display: none; }
  .hoja { margin: 0; padding: 0; box-shadow: none; max-width: none; }
  .fotos { grid-template-columns: repeat(4, 1fr) !important; }
  .f3 { grid-template-columns: repeat(6, 1fr) !important; }
  .datos { grid-template-columns: 1fr 1fr !important; }
}
@media (max-width: 560px) { .hoja { padding: 14px; margin: 0; } .datos { grid-template-columns: 1fr; } .fotos { grid-template-columns: repeat(2, 1fr); } header .t b { font-size: 17px; } }
</style></head><body>
<div class="barra">
  <button type="button" onclick="window.print()">Imprimir / Guardar como PDF</button>
  <label><input type="checkbox" id="ing" %(ing)s> Incluir fotos del equipo al ingreso</label>
  <small>Para mandarlo al cliente: tocá el botón, elegí “Guardar como PDF” y compartí el archivo por WhatsApp o mail. Las notas internas no se incluyen.</small>
</div>
<article class="hoja">
  <header><img src="/img/logo.png" alt="Inbio"><div class="t"><b>INFORME TÉCNICO</b><span>N.º %(num)s</span></div></header>
  <table>%(datos)s</table>
  %(cuerpo)s
  %(tec)s
  <footer>%(pie)s</footer>
</article>
<script>document.getElementById('ing').addEventListener('change', function () { var u = new URL(location.href); if (this.checked) u.searchParams.set('ingreso', '1'); else u.searchParams.delete('ingreso'); location.href = u.toString(); });</script>
</body></html>""" % {"num": _e(num), "equipo": _e(equipo), "ing": ing, "datos": datos, "cuerpo": "".join(cuerpo), "tec": tec,
                     "pie": "".join("<span>%s</span>" % _e(x) for x in PIE)}
