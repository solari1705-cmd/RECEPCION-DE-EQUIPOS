/* Lectura gratuita de fotos: reconocimiento de texto (Tesseract, corre en el celular)
   más reglas que buscan los datos en el texto. No usa internet ni cuentas. */
(function (root) {
  'use strict';

  var MARCAS = ['Mindray', 'Philips', 'GE Healthcare', 'Dräger', 'Medtronic', 'Nihon Kohden', 'Welch Allyn', 'Edan', 'Spacelabs',
    'Getinge', 'Maquet', 'Siemens', 'Leex', 'Fresenius Kabi', 'B. Braun', 'Baxter', 'Hill-Rom', 'Stryker', 'Zoll', 'Masimo',
    'Contec', 'Comen', 'Biocare', 'Heal Force', 'Bionet', 'Fukuda Denshi', 'Smiths Medical', 'Terumo', 'CareFusion',
    'Hospira', 'ICU Medical', 'Natus', 'Olympus', 'Fujifilm', 'Samsung Medison', 'Esaote', 'Mortara', 'Datex-Ohmeda', 'Ohmeda',
    'Carestation', 'Skyline', 'Fanem', 'Lumiar', 'Sensormedics', 'Vyaire', 'Hamilton Medical', 'Resmed', 'Respironics'];

  var TIPOS = [
    [/infusion\s*pump|bomba\s*de\s*infusi[oó]n|bomba\s*infusora/i, 'Bomba de infusión'],
    [/syringe\s*pump|bomba\s*de\s*jeringa/i, 'Bomba de jeringa'],
    [/anesthesia|anestesia/i, 'Estación de anestesia'],
    [/ventilator|ventilador|respirador/i, 'Ventilador'],
    [/autoclave|steriliz|esteriliz/i, 'Autoclave / esterilizador'],
    [/defibrillator|desfibrilador/i, 'Desfibrilador'],
    [/electrocardiograph|electrocardi[oó]grafo|\bECG\b|\bEKG\b/i, 'Electrocardiógrafo'],
    [/pulse\s*oximeter|ox[ií]metro/i, 'Oxímetro de pulso'],
    [/ultrasound|ecograf|ec[oó]grafo/i, 'Ecógrafo'],
    [/electrosurgical|electrobistur/i, 'Electrobisturí'],
    [/suction|aspirador/i, 'Aspirador quirúrgico'],
    [/incubator|incubadora/i, 'Incubadora neonatal'],
    [/patient\s*monitor|monitor\s*(?:de\s*)?paciente|monitor\s*multi|\bmonitor\b/i, 'Monitor de paciente']
  ];

  function sinAcentos(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function lineas(t) {
    return String(t || '').replace(/\r/g, '').split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).filter(Boolean);
  }
  function limpiarValor(v) {
    return v.replace(/^[\s:#：=\-.|_]+/, '').replace(/[\s:;,|_\-.]+$/, '').trim();
  }

  /* ---------- Etiqueta del equipo ---------- */
  var ETIQ_SERIE = '(?:\\bS\\s*[\\/.\\-]\\s*N\\b|\\bSN\\b|\\bSERIAL\\b(?:\\s*(?:NO|NUMBER|NUM|N[°º])\\b\\.?)?|\\bSER\\b\\.?|\\bN[°º]\\.?\\s*(?:DE\\s*)?SERIE\\b|\\bNRO\\.?\\s*(?:DE\\s*)?SERIE\\b|\\bN[UÚ]MERO\\s*DE\\s*SERIE\\b|\\bSERIE\\b)';
  var RE_SERIE = new RegExp(ETIQ_SERIE + '\\s*[:#：=\\-.]*\\s*([A-Z0-9][A-Z0-9\\-\\/\\.]{3,30})', 'i');
  var RE_SERIE_SOLO = new RegExp(ETIQ_SERIE + '\\s*[:#：=\\-.]*\\s*$', 'i');

  function serieValida(v) {
    v = limpiarValor(v || '');
    return v.length >= 4 && /\d/.test(v) && !/^(NO|NUM|NUMBER)$/i.test(v) ? v : '';
  }

  function buscarSerie(ls) {
    var i, m, v;
    for (i = 0; i < ls.length; i++) {
      m = RE_SERIE.exec(ls[i]);
      if (m && (v = serieValida(m[1]))) return v.toUpperCase();
      if (RE_SERIE_SOLO.test(ls[i]) && ls[i + 1]) {
        m = /^([A-Z0-9][A-Z0-9\-\/.]{3,30})/i.exec(ls[i + 1]);
        if (m && (v = serieValida(m[1]))) return v.toUpperCase();
      }
    }
    return '';
  }

  var CORTE_MODELO = /\s{2,}|\s(?:REF|LOT|SN|S\/N|SERIAL|P\/N|PN|IP\s?\d|FCC|MFG|DATE|REV|FW|SW|IEC|CE)\b.*$|\s\d{1,3}\s*V\b.*$|\s\d+\s*HZ\b.*$|\s\d+\s*VA\b.*$/i;

  function buscarModelo(ls) {
    var prioridad = [/\bMODEL(?:O)?\b\.?\s*(?:N[°º.]|NO\.?|NUMBER)?\s*[:#：=\-.]?\s*(.{2,60})$/i, /\b(?:TYPE|TIPO|TYP)\b\s*[:#：=\-.]\s*(.{2,60})$/i];
    var p, i, m, v;
    for (p = 0; p < prioridad.length; p++) {
      for (i = 0; i < ls.length; i++) {
        m = prioridad[p].exec(ls[i]);
        if (!m) continue;
        v = limpiarValor(m[1].replace(CORTE_MODELO, ''));
        if (v.length < 2 || v.length > 40) continue;
        if (/^(B|BF|CF)\b/i.test(v) && v.length <= 3) continue;
        if (/serial|^no\.?$/i.test(v)) continue;
        return v;
      }
    }
    return '';
  }

  function buscarMarca(texto, extra) {
    var lista = MARCAS.concat(extra || []);
    var plano = ' ' + sinAcentos(texto).toUpperCase().replace(/[^A-Z0-9]+/g, ' ') + ' ';
    var junto = plano.replace(/ /g, '');
    var mejor = '', pos = Infinity, i, b, norm, idx;
    for (i = 0; i < lista.length; i++) {
      b = String(lista[i] || '').trim();
      if (b.length < 2) continue;
      norm = sinAcentos(b).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
      idx = plano.indexOf(' ' + norm + ' ');
      if (idx === -1 && norm.replace(/ /g, '').length >= 6) {
        idx = junto.indexOf(norm.replace(/ /g, ''));
      }
      if (idx !== -1 && idx < pos) { pos = idx; mejor = b; }
    }
    return mejor;
  }

  function buscarTipo(texto) {
    var i;
    for (i = 0; i < TIPOS.length; i++) if (TIPOS[i][0].test(texto)) return TIPOS[i][1];
    return '';
  }

  function parseEquipo(texto, marcasExtra) {
    var ls = lineas(texto);
    return {
      serie: buscarSerie(ls) || null,
      marca: buscarMarca(texto, marcasExtra) || null,
      modelo: buscarModelo(ls) || null,
      tipo: buscarTipo(texto) || null,
      dudas: null
    };
  }

  /* ---------- Papel del cliente ---------- */
  function cuitOk(n) {
    if (!/^\d{11}$/.test(n)) return false;
    var w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2], s = 0, i;
    for (i = 0; i < 10; i++) s += w[i] * Number(n[i]);
    var m = s % 11, dv = Number(n[10]);
    if (m === 0) return dv === 0;
    if (m === 1) return false;
    return dv === 11 - m;
  }

  var ETIQUETAS_CLIENTE = /^(?:NOMBRE|APELLIDO|RAZ[OÓ]N|CLIENTE|EMPRESA|REMITENTE|DNI|D\.?N\.?I|CUIL|CUIT|TEL|CEL|WHATSAPP|CONTACTO|DIRECCI|DOMICILIO|DIR\b|FALLA|MOTIVO|PROBLEMA|LOCALIDAD|EMAIL|MAIL)/i;

  function valorEtiqueta(ls, re) {
    var i, m, v;
    for (i = 0; i < ls.length; i++) {
      m = re.exec(ls[i]);
      if (!m) continue;
      v = limpiarValor(m[1] || '');
      if (!v && ls[i + 1] && !ETIQUETAS_CLIENTE.test(ls[i + 1])) v = limpiarValor(ls[i + 1]);
      if (v) return v;
    }
    return '';
  }

  function parseCliente(texto) {
    var ls = lineas(texto), res = { nombre: null, doc: null, tel: null, dir: null, falla: null, dudas: null };
    var nombre = valorEtiqueta(ls, /\b(?:APELLIDO\s*Y\s*NOMBRE|NOMBRE\s*Y\s*APELLIDO|NOMBRE|RAZ[OÓ]N\s*SOCIAL|CLIENTE|EMPRESA|REMITENTE)\b\s*[:\-]?\s*(.*)$/i);
    nombre = nombre.replace(/\s+(?:DNI|CUIL|CUIT|TEL|CEL)\b.*$/i, '');
    if (nombre) res.nombre = nombre;

    var doc = '', m;
    for (var i = 0; i < ls.length && !doc; i++) {
      m = /\b(?:D\.?\s?N\.?\s?I\.?|CUIL|CUIT|C\.?U\.?I\.?[LT]\.?)\b\.?\s*(?:N[°º.]?)?\s*[:\-]?\s*([\d][\d.\-\s]{5,14}\d)/i.exec(ls[i]);
      if (m) doc = m[1].replace(/\D/g, '');
    }
    if (!doc) {
      var todo = ls.join(' ');
      m = todo.match(/\b\d{2}-?\d{8}-?\d\b/g);
      if (m) {
        var valido = m.map(function (x) { return x.replace(/\D/g, ''); }).filter(cuitOk);
        if (valido.length) doc = valido[0];
      }
      if (!doc) {
        m = /\b(\d{1,2}\.?\d{3}\.?\d{3})\b/.exec(todo);
        if (m) doc = m[1].replace(/\D/g, '');
      }
    }
    if (doc) res.doc = doc;

    var tel = valorEtiqueta(ls, /\b(?:TEL[EÉ]?F?O?N?O?|CEL(?:ULAR)?|WHATSAPP|CONTACTO)\b\.?\s*[:\-]?\s*([\d\s\-().+]{6,25})/i);
    if (tel && /\d{6,}/.test(tel.replace(/\D/g, ''))) res.tel = tel;

    var dir = valorEtiqueta(ls, /\b(?:DIRECCI[OÓ]N|DOMICILIO|DIR)\b\.?\s*[:\-]?\s*(.*)$/i);
    if (dir) res.dir = dir;

    var falla = valorEtiqueta(ls, /\b(?:FALLA|MOTIVO(?:\s*DE\s*INGRESO)?|PROBLEMA)\b\s*[:\-]?\s*(.*)$/i);
    if (falla) res.falla = falla;
    return res;
  }

  /* ---------- Reconocimiento de texto (en el navegador) ---------- */
  var workerPromise = null, cola = Promise.resolve();
  var api = { parseEquipo: parseEquipo, parseCliente: parseCliente, onProgress: null };

  function cargarScript(src) {
    return new Promise(function (ok, mal) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { mal({ code: 'motor' }); };
      document.head.append(s);
    });
  }

  function obtenerWorker() {
    if (!workerPromise) {
      workerPromise = (root.Tesseract ? Promise.resolve() : cargarScript('/lib/tesseract.min.js'))
        .then(function () {
          return root.Tesseract.createWorker('eng', 1, {
            workerPath: '/lib/worker.min.js',
            corePath: '/lib/core',
            langPath: '/lib/lang',
            gzip: true,
            workerBlobURL: false,
            logger: function (m) { if (api.onProgress) api.onProgress(m); }
          });
        })
        .then(function (w) {
          return w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' }).then(function () { return w; });
        })
        .catch(function () { workerPromise = null; throw { code: 'motor' }; });
    }
    return workerPromise;
  }

  function prepararImagen(archivo) {
    var abrir = root.createImageBitmap
      ? root.createImageBitmap(archivo, { imageOrientation: 'from-image' }).catch(function () { return root.createImageBitmap(archivo); })
      : Promise.reject({ code: 'imagen' });
    return abrir.then(function (bmp) {
      var lado = Math.max(bmp.width, bmp.height);
      var esc = lado > 2000 ? 2000 / lado : (lado < 1400 ? 1400 / lado : 1);
      var w = Math.round(bmp.width * esc), h = Math.round(bmp.height * esc);
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      var img = ctx.getImageData(0, 0, w, h), d = img.data, hist = new Uint32Array(256), i, g;
      for (i = 0; i < d.length; i += 4) {
        g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        d[i] = d[i + 1] = d[i + 2] = g; hist[g]++;
      }
      var total = w * h, acum = 0, lo = 0, hi = 255;
      for (i = 0; i < 256; i++) { acum += hist[i]; if (acum >= total * 0.01) { lo = i; break; } }
      acum = 0;
      for (i = 255; i >= 0; i--) { acum += hist[i]; if (acum >= total * 0.01) { hi = i; break; } }
      if (hi - lo > 20) {
        var k = 255 / (hi - lo);
        for (i = 0; i < d.length; i += 4) {
          g = (d[i] - lo) * k; g = g < 0 ? 0 : (g > 255 ? 255 : g);
          d[i] = d[i + 1] = d[i + 2] = g;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    });
  }

  /* leer(archivo, 'equipo' | 'cliente', {marcas: [...]}) -> {texto, datos} */
  api.leer = function (archivo, tipo, opciones) {
    var tarea = cola.then(function () {
      return Promise.all([obtenerWorker(), prepararImagen(archivo)]).then(function (r) {
        return r[0].recognize(r[1]);
      }).then(function (res) {
        var texto = (res && res.data && res.data.text) || '';
        var datos = tipo === 'equipo' ? parseEquipo(texto, opciones && opciones.marcas) : parseCliente(texto);
        return { texto: texto, datos: datos };
      });
    });
    cola = tarea.catch(function () {});
    return tarea;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Lector = api;
})(typeof window !== 'undefined' ? window : globalThis);
