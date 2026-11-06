(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    var kids = Array.prototype.slice.call(arguments, 2);
    (function add(list) {
      list.forEach(function (c) {
        if (c == null || c === false) return;
        if (Array.isArray(c)) return add(c);
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    })(kids);
    return el;
  }

  /* ---------- Estado ---------- */
  var online = true, initDone = false, loaded = false, ocrMode = null, localOk = false, fellBack = false, motor = '', provName = '', fbReason = '', arcaUrl = '';
  var records = [], rev = null;
  var editing = null, saving = false;
  var clienteId = null, suggTok = 0, suggT, docTok = 0, docT, docKey = '';
  var eqKey = '', eqTok = 0, eqT;
  var MAXF = 3;
  var fotosEq = [], fotosRep = [], MAXR = 8, preparingRep = 0;
  var openIds = new Set();
  var acces = new Set();
  var ACCESORIOS = ['Cable de alimentación', 'Cargador / fuente', 'Batería', 'Maletín o funda', 'Manual'], TECNICOS = [];
  var query = '', onlyPending = false, onlyFlex = false;
  var pendientes = [], openOt = new Set();

  var FIELDS = { tipo: 'f-tipo', marca: 'f-marca', modelo: 'f-modelo', serie: 'f-serie', nombre: 'f-nombre', doc: 'f-doc', tel: 'f-tel', dir: 'f-dir', ot: 'f-ot', nota: 'f-nota', falla: 'f-falla', accesTxt: 'f-acces', por: 'f-por', iva: 'f-iva', rep: 'f-rep', repfecha: 'f-repfecha', tecnico: 'f-tecnico', notasInt: 'f-int' };

  /* ---------- Servidor ---------- */
  function api(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        opts.body = body;
        opts.headers['Content-Type'] = body.type || 'application/octet-stream';
      } else {
        opts.body = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
      }
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) {
          var e = new Error(b.error || 'http');
          e.code = b.error || ('http_' + r.status);
          e.status = r.status;
          throw e;
        }
        return b;
      });
    });
  }

  function setOnline(v) {
    online = v;
    var b = $('#banner');
    if (v) {
      b.hidden = true;
    } else {
      b.textContent = 'Sin conexión con el servidor. Revisá que la PC del servidor esté encendida y que estés en la misma red Wi-Fi. Mientras tanto no se puede guardar.';
      b.hidden = false;
    }
    updateSaveBar();
  }

  function refresh() {
    return Promise.all([
      api('GET', '/api/recepciones'),
      api('GET', '/api/pendientes').catch(function () { return { items: pendientes }; })
    ]).then(function (res) {
      var r = res[0];
      records = r.items || [];
      pendientes = res[1].items || [];
      rev = r.rev;
      loaded = true;
      setOnline(true);
      var a = document.activeElement;
      // si alguien está escribiendo una nota en la lista, no la volvemos a dibujar para no cortarle lo que escribe
      if (!(a && a.tagName === 'TEXTAREA' && a.closest && a.closest('#rows'))) renderList();
      refreshDerived();
    });
  }

  function poll() {
    if (saving) return;
    api('GET', '/api/rev').then(function (r) {
      var was = online;
      setOnline(true);
      if (r.rev !== rev || !was) { loadPrev(); return refresh(); }
    }).catch(function () { setOnline(false); });
  }

  /* ---------- Utilidades ---------- */
  function normText(s) { return (s == null ? '' : String(s)).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function normSerie(s) { return (s == null ? '' : String(s)).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function digits(s) { return (s == null ? '' : String(s)).replace(/\D/g, ''); }

  function cuitValido(n) {
    if (!/^\d{11}$/.test(n)) return false;
    var w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2], s = 0, i;
    for (i = 0; i < 10; i++) s += w[i] * Number(n[i]);
    var m = s % 11, dv = Number(n[10]);
    if (m === 0) return dv === 0;
    if (m === 1) return false;
    return dv === 11 - m;
  }
  function cuitDv(base10) {
    var w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2], s = 0, i;
    for (i = 0; i < 10; i++) s += w[i] * Number(base10[i]);
    var m = s % 11;
    if (m === 0) return 0;
    if (m === 1) return null;
    return 11 - m;
  }
  /* CUIL posibles a partir del DNI: 20 (varón) y 27 (mujer); 23 si el dígito no cierra. */
  function cuilCandidatos(dni) {
    var d = ('00000000' + digits(dni)).slice(-8), out = [];
    [['20', 'varón'], ['27', 'mujer']].forEach(function (p) {
      var dv = cuitDv(p[0] + d), pre = p[0];
      if (dv === null) { pre = '23'; dv = cuitDv('23' + d); }
      if (dv !== null) out.push({ cuil: pre + d + dv, sexo: p[1] });
    });
    return out;
  }
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return false; });
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      var ok = document.execCommand('copy'); ta.remove();
      return Promise.resolve(ok);
    } catch (e) { return Promise.resolve(false); }
  }
  function docTools() {
    var n = digits(val('doc')), box = $('#doc-tools');
    var key = (n.length >= 7 && n.length <= 8) || (n.length === 11 && cuitValido(n)) ? n : '';
    if (box.dataset.key === key) return; /* no rehacer los botones mientras se tocan */
    box.dataset.key = key;
    box.replaceChildren();
    if (n.length >= 7 && n.length <= 8) {
      box.append(h('span', { text: 'Posible CUIL (elegí según corresponda):' }));
      cuilCandidatos(n).forEach(function (c) {
        box.append(h('button', { type: 'button', class: 'btn sm', text: fmtDoc(c.cuil) + ' · ' + c.sexo, onclick: function () { setField('doc', fmtDoc(c.cuil), false); refreshDerived(); } }));
      });
      box.hidden = false;
    } else if (n.length === 11 && cuitValido(n)) {
      var pre = n.slice(0, 2), tipo = (pre === '30' || pre === '33' || pre === '34') ? 'Persona jurídica' : ((pre === '20' || pre === '23' || pre === '24' || pre === '27') ? 'Persona física' : '');
      if (tipo) box.append(h('span', { text: tipo + '.' }));
      box.append(h('button', { type: 'button', class: 'btn sm', text: 'Consultar en ARCA', onclick: function () {
        copyText(n).then(function (ok) {
          toast(ok ? 'CUIT ' + n + ' copiado: pegalo en la página de ARCA.' : 'Pegá este CUIT en la página de ARCA: ' + n);
          if (arcaUrl) window.open(arcaUrl, '_blank', 'noopener');
        });
      } }));
      box.hidden = false;
    } else box.hidden = true;
  }

  function fmtDoc(raw) {
    var n = digits(raw);
    if (n.length === 11) return n.slice(0, 2) + '-' + n.slice(2, 10) + '-' + n.slice(10);
    if (n.length >= 7 && n.length <= 8) return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return raw == null ? '' : String(raw).trim();
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); }
    catch (e) { return ''; }
  }
  function savedPor() {
    try { return localStorage.getItem('recepcion_por') || ''; } catch (e) { return ''; }
  }

  var el = function (k) { return document.getElementById(FIELDS[k]); };
  var OT_PRE = '10000';
  // el N.º de OT de Flexxus siempre empieza igual: en pantalla solo se completan los últimos 4 dígitos
  function otGet(i) { var v = i.value.trim(); return i.dataset.full === '1' ? v : (v ? OT_PRE + v : ''); }
  function otSet(i, v) {
    v = String(v || '').trim();
    var corto = v.length === 9 && v.indexOf(OT_PRE) === 0;
    i.dataset.full = v && !corto ? '1' : '0';
    i.maxLength = v && !corto ? 30 : 9;
    i.previousElementSibling.hidden = i.dataset.full === '1';
    i.value = corto ? v.slice(OT_PRE.length) : v;
  }
  function otBind(i, alCambiar) {
    i.addEventListener('input', function () {
      if (i.dataset.full === '1') return;
      var d = i.value.replace(/\D/g, '');
      if (d.length >= 9 && d.indexOf(OT_PRE) === 0) d = d.slice(OT_PRE.length);   // pegaron el número completo
      i.value = d.slice(0, 4);
    }, true);
    if (alCambiar) i.addEventListener('input', alCambiar);
  }
  var val = function (k) {
    if (k === 'ot') return otGet(el(k));
    return el(k).value.trim();
  };
  function setField(k, v, auto) {
    var i = el(k);
    if (k === 'ot') {
      otSet(i, v);
      i.closest('.field').classList.toggle('auto', !!auto);
      return;
    }
    i.value = v;
    i.closest('.field').classList.toggle('auto', !!auto);
  }

  var toastT;
  function toast(msg, tone) {
    var t = $('#toast');
    t.textContent = msg;
    t.dataset.tone = tone || '';
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 4500);
  }

  /* ---------- Fotos ---------- */
  function prepareImage(file) {
    var max = 1600;
    if (!window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var w = Math.round(bmp.width * s), hh = Math.round(bmp.height * s);
      var c = document.createElement('canvas');
      c.width = w; c.height = hh;
      c.getContext('2d').drawImage(bmp, 0, 0, w, hh);
      if (bmp.close) bmp.close();
      return new Promise(function (res) { c.toBlob(function (b) { res(b || file); }, 'image/jpeg', 0.86); });
    }).catch(function () { return file; });
  }

  function setStatus(tone, text) {
    var s = $('#eq-status');
    s.dataset.tone = tone || '';
    s.replaceChildren();
    if (!text) return;
    if (tone === 'busy') s.append(h('span', { class: 'spin', 'aria-hidden': 'true' }));
    s.append(h('span', { text: text }));
  }

  function renderThumbs() {
    var box = $('#thumbs'), n = fotosEq.length;
    box.hidden = !n;
    box.replaceChildren.apply(box, fotosEq.map(function (p, i) {
      return h('div', { class: 'thumb' },
        h('img', { src: p.url, alt: 'Foto ' + (i + 1) + ' del equipo' }),
        h('button', { type: 'button', 'aria-label': 'Quitar la foto ' + (i + 1), text: '×', onclick: function () { removePhoto(p); } }));
    }));
    $('#cam-label').textContent = n === 0 ? 'Sacar foto del equipo' : (n >= MAXF ? 'Ya hay ' + MAXF + ' fotos' : 'Sacar otra foto (' + n + ' de ' + MAXF + ')');
    $('#btn-cam').disabled = $('#btn-gal').disabled = n >= MAXF;
    $('#btn-reread').hidden = !(ocrMode && fotosEq.some(function (p) { return p.blob; }));
  }

  function removePhoto(p) {
    var i = fotosEq.indexOf(p);
    if (i === -1) return;
    fotosEq.splice(i, 1);
    if (p.blob) URL.revokeObjectURL(p.url);
    if (!fotosEq.length) setStatus('', '');
    renderThumbs();
  }

  function clearPhotos() {
    fotosEq.forEach(function (p) { if (p.blob) URL.revokeObjectURL(p.url); });
    fotosEq = [];
    setStatus('', '');
    renderThumbs();
  }

  var preparing = 0;
  function takePhoto(file) {
    if (fotosEq.length + preparing >= MAXF) { toast('Ya hay ' + MAXF + ' fotos. Quitá una para sacar otra.'); return Promise.resolve(); }
    preparing++;
    setStatus('busy', 'Preparando la foto…');
    return prepareImage(file).then(function (blob) {
      preparing--;
      var p = { blob: blob, orig: file, url: URL.createObjectURL(blob), id: null, read: false };
      fotosEq.push(p);
      renderThumbs();
      if (!ocrMode) { setStatus('warn', 'Foto lista. Este navegador no puede leer fotos solo: cargá los datos a mano.'); return; }
      return runOcr(p, fotosEq.some(function (q) { return q !== p && q.read; }));
    }).catch(function () { preparing = Math.max(0, preparing - 1); });
  }

  /* ---------- Fotos de la reparación ---------- */
  function renderThumbsRep() {
    var box = $('#thumbs-rep'), n = fotosRep.length;
    box.hidden = !n;
    box.replaceChildren.apply(box, fotosRep.map(function (p, i) {
      return h('div', { class: 'thumb' },
        h('img', { src: p.url, alt: 'Foto ' + (i + 1) + ' de la reparación' }),
        h('button', { type: 'button', 'aria-label': 'Quitar la foto ' + (i + 1) + ' de la reparación', text: '×', onclick: function () { removePhotoRep(p); } }));
    }));
    $('#cam-rep-label').textContent = n === 0 ? 'Sacar foto' : (n >= MAXR ? 'Ya hay ' + MAXR + ' fotos' : 'Sacar otra (' + n + ' de ' + MAXR + ')');
    $('#btn-cam-rep').disabled = $('#btn-gal-rep').disabled = n >= MAXR;
  }
  function removePhotoRep(p) {
    var i = fotosRep.indexOf(p);
    if (i === -1) return;
    fotosRep.splice(i, 1);
    if (p.blob) URL.revokeObjectURL(p.url);
    renderThumbsRep();
  }
  function clearPhotosRep() {
    fotosRep.forEach(function (p) { if (p.blob) URL.revokeObjectURL(p.url); });
    fotosRep = [];
    renderThumbsRep();
  }
  function takePhotoRep(file) {
    if (fotosRep.length + preparingRep >= MAXR) { toast('Ya hay ' + MAXR + ' fotos de la reparación. Quitá una para sacar otra.'); return Promise.resolve(); }
    preparingRep++;
    return prepareImage(file).then(function (blob) {
      preparingRep--;
      fotosRep.push({ blob: blob, url: URL.createObjectURL(blob), id: null });
      renderThumbsRep();
    }).catch(function () { preparingRep = Math.max(0, preparingRep - 1); });
  }
  function savedTecnico() {
    try { return localStorage.getItem('recepcion_tecnico') || ''; } catch (e) { return ''; }
  }

  function ocrError(e) {
    var c = e && e.code;
    if (c === 'sin_clave') return 'La lectura automática no está configurada en el servidor. Cargá los datos a mano.';
    if (c === 'clave_invalida') return 'La clave de la API que tiene el servidor no es válida. Avisale a quien administra el servidor.';
    if (c === 'sin_credito') return 'La cuenta de la API no tiene saldo. Avisale a quien administra el servidor.';
    if (c === 'limite') return 'Se llegó al límite de pedidos. Esperá un momento y tocá “Leer de nuevo”.';
    if (c === 'sin_internet') return 'El servidor no tiene internet para leer la foto. Cargá los datos a mano.';
    if (c === 'servicio') return 'El servicio de lectura no responde ahora. Probá de nuevo en un momento.';
    if (c === 'formato' || c === 'imagen') return 'No se pudo abrir esa imagen. Sacá la foto de nuevo.';
    if (c === 'ilegible') return 'No pude interpretar la foto. Acercate, con buena luz, y sacala de nuevo.';
    if (c === 'muy_grande') return 'La foto es demasiado grande. Sacala de nuevo.';
    return 'No se pudo conectar con el servidor. Tocá “Leer de nuevo” o cargá los datos a mano.';
  }

  function cleanStr(v) {
    if (typeof v !== 'string') return '';
    v = v.trim();
    return /^(null|n\/a|-|—)$/i.test(v) ? '' : v;
  }

  function knownBrands() {
    var seen = {}, out = [];
    records.forEach(function (r) {
      var m = r.equipo && r.equipo.marca;
      if (m && !seen[m.toLowerCase()]) { seen[m.toLowerCase()] = 1; out.push(m); }
    });
    return out;
  }

  function leerFoto(p) {
    fellBack = false; fbReason = ''; motor = provName || 'servidor';
    if (ocrMode === 'api') {
      return api('POST', '/api/leer?tipo=equipo', p.blob).then(function (res) { motor = (res && res.motor) || motor; return res && res.datos; }).catch(function (e) {
        var c = e && e.code;
        var retry = c === 'sin_internet' || c === 'limite' || c === 'servicio' || c === 'clave_invalida' || c === 'sin_credito' || c === 'sin_clave' || c === 'ilegible' || !c || c.indexOf('http_') === 0 || c === 'Failed to fetch';
        if (!(retry && localOk && window.Lector)) throw e;
        fellBack = true; fbReason = ocrError(e); motor = 'local';
        return leerLocal(p);
      });
    }
    return leerLocal(p);
  }

  function leerLocal(p) {
    if (!window.Lector) return Promise.reject({ code: 'motor' });
    motor = 'local';
    Lector.onProgress = function (m) {
      if (m && m.status === 'recognizing text' && typeof m.progress === 'number') setStatus('busy', 'Leyendo la foto… ' + Math.round(m.progress * 100) + '%');
    };
    return Lector.leer(p.orig || p.blob, 'equipo', { marcas: knownBrands() }).then(function (r) { return r.datos; });
  }

  function runOcr(p, onlyEmpty) {
    setStatus('busy', ocrMode === 'local' ? 'Leyendo la foto (la primera vez tarda unos segundos)…' : 'Leyendo la foto…');
    return leerFoto(p).then(function (d) {
      if (fotosEq.indexOf(p) === -1) return;
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw { code: 'ilegible' };
      var out = applyOcr('equipo', d, onlyEmpty);
      p.read = true;
      refreshDerived();
      var extra = '';
      if (ocrMode === 'local' || fellBack) extra = ' La lectura gratuita se equivoca más: revisá la serie letra por letra.';
      if (out.n === 0) {
        setStatus('warn', (fellBack ? provName + ' falló (' + fbReason + '). ' : '') + 'No encontré datos nuevos en esta foto. Si no se ve la etiqueta, sacá otra de más cerca y con buena luz.');
        return;
      }
      var tag = motor === 'gemini' ? 'Leído con Gemini. ' : (motor === 'claude' ? 'Leído con Claude. ' : 'Leído con la lectura gratuita del celular. ');
      var msg = tag + 'Completé ' + out.n + (out.n === 1 ? ' campo' : ' campos') + '. Revisá los marcados antes de guardar.';
      if (out.skipped) msg += ' ' + out.skipped + (out.skipped === 1 ? ' ya tenía datos y no lo cambié.' : ' ya tenían datos y no los cambié.');
      if (out.dudas) msg += ' Ojo: ' + out.dudas;
      if (fellBack) msg += ' ATENCIÓN: ' + provName + ' falló (' + fbReason + ') y se usó la lectura gratuita.';
      msg += extra;
      setStatus((out.dudas || extra || fellBack) ? 'warn' : 'ok', msg);
    }).catch(function (e) {
      if (fotosEq.indexOf(p) === -1) return;
      setStatus('err', e && e.code === 'motor' ? 'No se pudo cargar el lector de fotos. Cargá los datos a mano.' : ocrError(e));
    });
  }

  function applyOcr(kind, res, onlyEmpty) {
    var keys = ['serie', 'marca', 'modelo', 'tipo'];
    var n = 0, skipped = 0;
    keys.forEach(function (key) {
      var v = cleanStr(res[key]);
      if (key === 'doc') { var d = digits(v); v = d ? fmtDoc(d) : ''; }
      if (key === 'serie') v = v.toUpperCase().replace(/\s+/g, '');
      if (!v) return;
      var field = el(key).closest('.field');
      if (onlyEmpty && val(key)) return;
      if (val(key) && !field.classList.contains('auto')) { skipped++; return; }
      setField(key, v, true);
      n++;
    });
    return { n: n, skipped: skipped, dudas: cleanStr(res.dudas) };
  }

  /* ---------- Validaciones y avisos ---------- */
  function docHint() {
    docTools();
    var n = digits(val('doc')), box = $('#doc-hint');
    if (!n) { box.textContent = ''; box.dataset.tone = ''; return; }
    if (n.length === 11) {
      if (cuitValido(n)) { box.textContent = 'CUIL/CUIT válido.'; box.dataset.tone = 'ok'; }
      else { box.textContent = 'Los dígitos no cierran como CUIL/CUIT. Revisá el papel o la foto.'; box.dataset.tone = 'warn'; }
    } else if (n.length === 7 || n.length === 8) {
      box.textContent = 'Se toma como DNI.'; box.dataset.tone = '';
    } else {
      box.textContent = 'Un DNI tiene 7 u 8 dígitos y un CUIL/CUIT tiene 11. Este tiene ' + n.length + '.'; box.dataset.tone = 'warn';
    }
  }

  function checkDup() {
    var box = $('#dup'), sn = normSerie(val('serie'));
    var m = sn.length >= 4 ? records.filter(function (r) { return r.serieNorm === sn && (!editing || r.id !== editing.id); }) : [];
    if (!m.length) { box.hidden = true; box.replaceChildren(); return; }
    var last = m[0];
    box.replaceChildren(
      h('strong', { text: m.length === 1 ? 'Este equipo ya ingresó una vez.' : 'Este equipo ya ingresó ' + m.length + ' veces.' }),
      h('span', { text: 'Última: ' + fmtDate(last.ts) + ', ' + ((last.cliente && last.cliente.nombre) || 'sin cliente') + '.' }),
      h('button', { type: 'button', class: 'link', text: 'Ver historial', onclick: function () { showInList(val('serie')); } })
    );
    box.hidden = false;
  }

  /* ---------- Reparaciones anteriores del equipo y vínculo con la OT de Flexxus ---------- */
  var histKey = '', histTok = 0, histT, histItems = [], dismissed = {}, baseInfo = null;
  function isoHoyMenos(dias) { var d = new Date(); d.setDate(d.getDate() - dias); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  // misma serie: igual, o una contiene a la otra (Flexxus a veces guarda "SN 12345" o agrega prefijos)
  function mismaSerie(a, sn) { a = normSerie(a); return a === sn || (Math.min(a.length, sn.length) >= 5 && (a.indexOf(sn) >= 0 || sn.indexOf(a) >= 0)); }
  var otKey = '', otTok = 0, otT, otItems = [], otDone = false;
  function renderOtInfo() {
    var box = $('#otinfo'), ot = val('ot'), sn = normSerie(val('serie'));
    box.replaceChildren();
    if (ot.length < 4) { box.hidden = true; return; }
    var ex = otItems.filter(function (o) { return o.origen === 'flexxus' && o.ot === ot; })[0];
    if (!ex) {
      var sug = otItems.filter(function (o) { return o.origen === 'flexxus' && o.ot.slice(-ot.length) === ot; });
      if (sug.length === 1) {
        box.className = 'note warn wide';
        box.append(h('span', null, h('strong', { text: 'Encontré la OT ' + sug[0].ot + ' en Flexxus' }), ' (' + (sug[0].cliente || 'sin cliente') + (sug[0].descripcion ? ', ' + sug[0].descripcion : '') + '). Para que se unan tiene que estar el número completo.'),
          h('button', { type: 'button', class: 'btn primary sm', text: 'Usar ' + sug[0].ot, onclick: function () { setField('ot', sug[0].ot, false); refreshDerived(); } }));
      } else if (otKey === ot && otDone) {
        box.className = 'note warn wide';
        box.append(h('span', null, h('strong', { text: 'Esa OT no está en el listado de Flexxus cargado.' }), ' Puede ser que el listado esté desactualizado: subí el último en Buscar OT. Igual se guarda el número y se une cuando aparezca.'));
      } else { box.hidden = true; return; }
      box.hidden = false; return;
    }
    box.className = 'note wide';
    box.append(h('span', null, h('strong', { text: 'OT ' + ex.ot + ' de Flexxus: ' }), (ex.cliente || 'sin cliente') + ' · ' + (ex.descripcion || ex.tipo || 'equipo sin dato') + (ex.serie ? ' · serie ' + ex.serie : '') + ' · ingreso ' + (ex.fecha ? fmtIso(ex.fecha) : 's/f') + (ex.estado ? ' · ' + ex.estado : '') + '. Este ingreso queda unido a esa orden.'));
    if (sn.length >= 4 && ex.serie && !mismaSerie(ex.serie, sn)) {
      box.className = 'note warn wide';
      box.append(h('div', { text: 'Ojo: la serie de esa OT (' + ex.serie + ') no coincide con la que cargaste. Revisá que sea la OT correcta.' }));
    }
    if (!sn && ex.serie) {
      box.append(h('button', { type: 'button', class: 'btn sm', text: 'Usar la serie ' + ex.serie, onclick: function () { setField('serie', ex.serie, false); refreshDerived(); } }));
    }
    box.hidden = false;
  }
  function checkOtFlexxus() {
    var ot = val('ot');
    if (ot.length < 4) { otKey = ''; otItems = []; renderOtInfo(); return; }
    if (otKey === ot) { renderOtInfo(); return; }
    otKey = ot; otDone = false;
    var tok = ++otTok;
    clearTimeout(otT);
    otT = setTimeout(function () {
      api('GET', '/api/ordenes?ot=' + encodeURIComponent(ot)).then(function (r) {
        if (tok !== otTok) return;
        otItems = (r && r.items) || []; otDone = true;
        renderOtInfo();
      }).catch(function () { if (tok === otTok) { otItems = []; otDone = false; renderOtInfo(); } });
    }, 350);
  }
  function renderFlexBase(sn, hay) {
    var b = $('#flexbase');
    if (sn.length < 4 || !baseInfo || hay) { b.hidden = true; b.replaceChildren(); return; }
    var f = h('input', { type: 'file', accept: '.csv,.xls,.xlsx', hidden: true });
    var st = h('span', { class: 'hint' });
    f.addEventListener('change', function () {
      if (!f.files.length) return;
      st.textContent = 'Cargando listado…';
      fetch('/api/ordenes/importar?nombre=' + encodeURIComponent(f.files[0].name), { method: 'POST', body: f.files[0] })
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (d) { toast('Listado cargado: ' + d.nuevas + ' OT nuevas.'); histKey = ''; checkHistorial(); })
        .catch(function () { st.textContent = 'No pude leer ese archivo: tiene que ser el listado de reparaciones de Flexxus.'; });
    });
    b.className = 'note wide';
    b.replaceChildren(h('span', null, h('strong', { text: 'No hay OT de Flexxus de los últimos 30 días con esta serie. ' }),
      'Listado cargado el ' + fmtDate(baseInfo.actualizado) + (baseInfo.ultima ? ' (OT más nueva: ' + fmtIso(baseInfo.ultima) + ')' : '') + '. Si la OT es más reciente, subí el listado actualizado y se vuelve a buscar.'),
      h('button', { type: 'button', class: 'btn sm', text: 'Subir listado de Flexxus', onclick: function () { f.click(); } }), f, st);
    b.hidden = false;
  }
  function renderHist() {
    var sn = normSerie(val('serie')), box = $('#hist'), vinc = $('#vinc');
    var ownId = editing ? editing.id : null;
    var items = histItems.filter(function (o) { return mismaSerie(o.serie, sn) && !(o.origen === 'app' && ownId && o.id === ownId); });
    var otAct = val('ot');
    var linked = otAct && items.filter(function (o) { return o.origen === 'flexxus' && o.ot === otAct; })[0];
    var desde = isoHoyMenos(30);
    var cand = sn.length < 4 ? [] : items.filter(function (o) {
      return o.origen === 'flexxus' && o.fecha && o.fecha >= desde && o.ot !== otAct && !o.numero && !dismissed[sn + '|' + o.ot];
    });
    // aviso: ¿es la misma OT?
    vinc.replaceChildren();
    if (linked) {
      vinc.className = 'note wide';
      vinc.append(h('span', null, h('strong', { text: 'Este ingreso queda vinculado a la OT ' + linked.ot + ' de Flexxus.' }), ' Se muestra como una sola orden.'),
        h('button', { type: 'button', class: 'link', text: 'Desvincular', onclick: function () { setField('ot', '', false); dismissed[sn + '|' + linked.ot] = 1; refreshDerived(); } }));
      vinc.hidden = false;
    } else if (cand.length) {
      vinc.className = 'note warn wide';
      vinc.append(h('strong', { text: cand.length === 1 ? 'Este equipo tiene una OT reciente en Flexxus (menos de 30 días).' : 'Este equipo tiene ' + cand.length + ' OT recientes en Flexxus (menos de 30 días).' }),
        h('span', { text: '¿Este ingreso corresponde a ' + (cand.length === 1 ? 'esa OT' : 'una de esas OT') + '? Si es la misma, se unen y no queda duplicada.' }));
      cand.forEach(function (o) {
        var opts = h('div', { class: 'opts' },
          h('button', { type: 'button', class: 'btn primary sm', text: 'Sí, es la OT ' + o.ot, onclick: function () { setField('ot', o.ot, false); refreshDerived(); toast('Ingreso vinculado a la OT ' + o.ot + '.'); } }),
          h('button', { type: 'button', class: 'btn sm', text: 'No, es otro ingreso', onclick: function () { dismissed[sn + '|' + o.ot] = 1; renderHist(); } }));
        vinc.append(h('div', { class: 'hist-i' },
          h('div', { class: 'l1' }, h('span', { text: 'OT ' + o.ot }), h('span', { text: 'Ingreso ' + fmtIso(o.fecha) }), h('span', { text: o.estado || '' })),
          o.observaciones || o.defecto ? h('div', { class: 'l2', text: o.observaciones || o.defecto }) : null, opts));
      });
      vinc.hidden = false;
    } else { vinc.hidden = true; }
    renderFlexBase(sn, cand.length || linked);
    // historial
    if (!items.length) { box.hidden = true; box.replaceChildren(); return; }
    var orden = items.slice().sort(function (x, y) { return (y.fecha || '').localeCompare(x.fecha || ''); });
    var head = h('div', { class: 'hist-h' }, h('span', { text: 'Reparaciones anteriores de este equipo (' + items.length + ')' }),
      h('button', { type: 'button', class: 'link', text: 'Ver todas en Buscar OT', onclick: function () {
        $('#o-serie').value = val('serie'); $('#o-cliente').value = ''; $('#o-q').value = ''; $('#o-ant').checked = true; setTab('ot'); } }));
    box.replaceChildren.apply(box, [head].concat(orden.slice(0, 5).map(function (o) {
      var tag = o.origen === 'flexxus' ? 'OT ' + o.ot + ' · Flexxus' : o.origen === 'app' ? 'Ingreso #' + o.numero + ' · Postventa' : 'Guía ' + o.guia + ' · Sistema anterior';
      var txt = o.origen === 'app' ? [o.defecto, o.reparacion && o.reparacion.texto].filter(Boolean).join(' → ') : (o.observaciones || o.defecto || '');
      return h('div', { class: 'hist-i' },
        h('div', { class: 'l1' }, h('span', { text: tag }), h('span', { text: o.fecha ? fmtIso(o.fecha) : '' }), h('span', { text: o.origen === 'app' ? '' : (o.estado || '') })),
        txt ? h('div', { class: 'l2', text: txt }) : null);
    })));
    if (orden.length > 5) box.append(h('div', { class: 'hint', text: 'Y ' + (orden.length - 5) + ' más anteriores.' }));
    box.hidden = false;
  }
  function checkHistorial() {
    var sn = normSerie(val('serie'));
    if (sn.length < 4) { histKey = ''; histItems = []; renderHist(); return; }
    if (histKey === sn) { renderHist(); return; }
    histKey = sn;
    var tok = ++histTok;
    clearTimeout(histT);
    histT = setTimeout(function () {
      api('GET', '/api/ordenes?serie=' + encodeURIComponent(sn) + '&anterior=1&amplia=1').then(function (r) {
        if (tok !== histTok) return;
        histItems = (r && r.items) || [];
        baseInfo = r ? { actualizado: r.actualizado, ultima: r.ultima } : null;
        renderHist();
      }).catch(function () { if (tok === histTok) { histItems = []; renderHist(); } });
    }, 350);
  }

  function selectCliente(c) {
    clienteId = c.id;
    setField('nombre', c.nombre || '', false);
    var doc = c.cuit || c.dni || '';
    setField('doc', doc ? fmtDoc(doc) : val('doc'), false);
    if (c.tel) setField('tel', c.tel, false);
    if (c.dir) setField('dir', c.dir, false);
    if (c.iva) setField('iva', c.iva, false);
    $('#sugg').hidden = true; $('#sugg').replaceChildren();
    $('#known').hidden = true; $('#known').replaceChildren();
    docKey = '';
    showLink(c);
    refreshDerived();
  }

  function showLink(c) {
    var box = $('#cl-link');
    if (!clienteId) { box.hidden = true; box.replaceChildren(); return; }
    box.replaceChildren(
      h('strong', { text: c && c.codigo ? 'Cliente N.º ' + c.codigo + ' de la base.' : 'Cliente vinculado.' }),
      h('span', { text: 'El equipo queda asociado a este cliente.' }),
      h('button', { type: 'button', class: 'link', text: 'Quitar vínculo', onclick: function () { clienteId = null; showLink(null); docKey = ''; checkKnown(); } })
    );
    box.hidden = false;
  }

  function unlinkCliente() {
    if (!clienteId) return;
    clienteId = null; showLink(null);
  }

  function clienteBtn(c) {
    var det = [c.codigo ? 'N.º ' + c.codigo : '', c.cuit ? 'CUIT ' + fmtDoc(c.cuit) : (c.dni ? 'DNI ' + fmtDoc(c.dni) : ''), c.dir, c.tel].filter(Boolean).join(' · ');
    return h('button', { type: 'button', onclick: function () { selectCliente(c); } },
      h('span', { class: 's1', text: c.nombre + (c.fantasia ? ' (' + c.fantasia + ')' : '') }),
      h('span', { class: 's2', text: det }));
  }

  function suggest() {
    var q = val('nombre'), box = $('#sugg');
    clearTimeout(suggT);
    if (clienteId || q.length < 2) { box.hidden = true; box.replaceChildren(); return; }
    var tok = ++suggTok;
    suggT = setTimeout(function () {
      api('GET', '/api/clientes?q=' + encodeURIComponent(q)).then(function (r) {
        if (tok !== suggTok || clienteId) return;
        var items = (r && r.items) || [];
        box.replaceChildren.apply(box, items.map(clienteBtn));
        box.hidden = !items.length;
      }).catch(function () { /* sin sugerencias */ });
    }, 180);
  }

  function checkKnown() {
    var box = $('#known'), dn = digits(val('doc'));
    var ok = !clienteId && (dn.length === 11 || dn.length === 7 || dn.length === 8);
    if (!ok) { docKey = ''; box.hidden = true; box.replaceChildren(); return; }
    if (docKey === dn) return;
    docKey = dn;
    var tok = ++docTok;
    clearTimeout(docT);
    docT = setTimeout(function () {
      api('GET', '/api/clientes?doc=' + dn).then(function (r) {
        if (tok !== docTok || clienteId) return;
        var items = (r && r.items) || [];
        if (!items.length) { box.hidden = true; box.replaceChildren(); return; }
        box.replaceChildren.apply(box, [h('strong', { text: items.length === 1 ? 'Cliente en la base con este documento:' : 'Clientes en la base con este documento:' })].concat(items.map(clienteBtn)));
        box.hidden = false;
      }).catch(function () { box.hidden = true; });
    }, 250);
  }

  function fmtIso(f) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  function useEquipo(it) {
    if (!it.exacto && it.serie) setField('serie', it.serie, false);
    if (it.tipo) setField('tipo', it.tipo, false);
    if (it.marca) setField('marca', it.marca, false);
    if (it.modelo) setField('modelo', it.modelo, false);
    if (it.cliente) selectCliente(it.cliente);
    else if (it.clienteNombre && !val('nombre')) setField('nombre', it.clienteNombre, false);
    $('#eq-known').hidden = true; $('#eq-known').replaceChildren();
    eqKey = normSerie(val('serie'));
    refreshDerived();
  }

  function checkEquipo() {
    var sn = normSerie(val('serie')), box = $('#eq-known');
    if (sn.length < 4 || (editing && normSerie((editing.equipo || {}).serie) === sn)) { eqKey = ''; box.hidden = true; box.replaceChildren(); return; }
    if (eqKey === sn) return;
    eqKey = sn;
    var tok = ++eqTok;
    clearTimeout(eqT);
    eqT = setTimeout(function () {
      api('GET', '/api/equipos?serie=' + encodeURIComponent(sn)).then(function (r) {
        if (tok !== eqTok) return;
        var items = ((r && r.items) || []).slice(0, 3);
        if (!items.length) { box.hidden = true; box.replaceChildren(); return; }
        var exact = items.some(function (i) { return i.exacto; });
        box.replaceChildren.apply(box, [h('strong', { text: exact ? 'Este equipo ya está en la base:' : 'Series parecidas en la base:' })].concat(items.map(function (it) {
          var que = [it.tipo, it.marca, it.modelo].filter(Boolean).join(' · ') || it.descripcion || 'Equipo';
          var det = [it.exacto ? '' : 'Serie ' + it.serie, (it.cliente && it.cliente.nombre) || it.clienteNombre ? 'Cliente: ' + ((it.cliente && it.cliente.nombre) || it.clienteNombre) : '',
            it.ordenes ? it.ordenes + (it.ordenes === 1 ? ' ingreso anterior' : ' ingresos anteriores') : '',
            it.ultimaOt ? 'última OT ' + it.ultimaOt + (it.ultimaFecha ? ' (' + fmtIso(it.ultimaFecha) + ')' : '') : '',
            it.ultimoDefecto ? 'Falla: ' + it.ultimoDefecto : ''].filter(Boolean).join(' · ');
          return h('button', { type: 'button', onclick: function () { useEquipo(it); } },
            h('span', { class: 's1', text: que }), h('span', { class: 's2', text: det }));
        })));
        box.hidden = false;
      }).catch(function () { box.hidden = true; });
    }, 300);
  }

  function missing() {
    var m = [];
    if (!val('nombre')) m.push('nombre del cliente');
    if (!val('serie') && !val('modelo')) m.push('serie o modelo del equipo');
    return m;
  }

  function updateSaveBar() {
    var m = missing(), btn = $('#save'), need = $('#need');
    btn.disabled = saving || m.length > 0 || !online;
    btn.textContent = saving ? 'Guardando…' : (editing ? 'Guardar cambios' : 'Guardar ingreso');
    if (!initDone) need.textContent = 'Conectando…';
    else if (!online) need.textContent = 'Sin conexión con el servidor';
    else if (m.length) need.textContent = 'Falta: ' + m.join(' y ');
    else need.textContent = 'Listo para guardar';
  }

  function refreshDerived() { docHint(); checkDup(); checkKnown(); checkEquipo(); checkHistorial(); checkOtFlexxus(); updateSaveBar(); }

  /* ---------- Formulario ---------- */
  /* ---------- Listas compartidas: accesorios y técnicos ---------- */
  function cargarListas() {
    return api('GET', '/api/listas').then(aplicarListas).catch(function () { /* se usan los valores por defecto */ });
  }
  function aplicarListas(l) {
    if (!l) return;
    if (l.accesorios && l.accesorios.length) ACCESORIOS = l.accesorios;
    if (l.tecnicos) TECNICOS = l.tecnicos;
    renderAcces();
    renderTecnicos(val('tecnico'));
  }
  function agregarAcc() {
    var i = $('#acces-add'), n = i.value.replace(/\s+/g, ' ').trim();
    if (!n) return;
    n = n.charAt(0).toUpperCase() + n.slice(1);
    var ya = ACCESORIOS.filter(function (a) { return normText(a) === normText(n); })[0];
    acces.add(ya || n);
    i.value = '';
    if (!ya) { ACCESORIOS.push(n); api('POST', '/api/listas/accesorio', { nombre: n }).then(aplicarListas).catch(function () { /* queda en este ingreso */ }); }
    renderAcces();
  }
  function renderTecnicos(sel) {
    var s = el('tecnico'), lista = TECNICOS.slice();
    if (sel && sel !== '__nuevo' && lista.indexOf(sel) < 0) lista.push(sel);
    s.replaceChildren.apply(s, [h('option', { value: '', text: 'Elegir' })]
      .concat(lista.map(function (t) { return h('option', { value: t, text: t }); }))
      .concat([h('option', { value: '__nuevo', text: '+ Agregar técnico…' })]));
    s.value = sel && sel !== '__nuevo' ? sel : '';
  }
  function guardarTecnicoSel() { try { localStorage.setItem('recepcion_tecnico', val('tecnico')); } catch (e) { /* sin almacenamiento */ } }
  function agregarTecnico() {
    var n = (window.prompt('Nombre y apellido del técnico') || '').replace(/\s+/g, ' ').trim();
    if (!n) { renderTecnicos(savedTecnico()); return; }
    api('POST', '/api/listas/tecnico', { nombre: n }).then(function (l) {
      var k = normText(n), t = (l.tecnicos || []).filter(function (x) { return normText(x) === k; })[0] || n;
      TECNICOS = l.tecnicos || TECNICOS; renderTecnicos(t); guardarTecnicoSel();
    }).catch(function () { renderTecnicos(n); guardarTecnicoSel(); });
  }

  /* ---------- Audio: el técnico cuenta lo que hizo y se pasa a texto ---------- */
  function bindAudio(ids) {
    ids = ids || { btn: 'btn-audio', lbl: 'audio-lbl', st: 'audio-st', inp: 'in-audio', txt: 'f-rep' };
    var btn = $('#' + ids.btn), lbl = $('#' + ids.lbl), st = $('#' + ids.st), inp = $('#' + ids.inp);
    var rec = null, chunks = [], stream = null;
    function msg(t, tono) { st.textContent = t || ''; st.dataset.tone = tono || ''; }
    function enviar(blob, mime) {
      msg('Pasando el audio a texto…', 'busy'); btn.disabled = true;
      fetch('/api/transcribir?mime=' + encodeURIComponent(mime || blob.type || 'audio/webm'), { method: 'POST', body: blob })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          btn.disabled = false;
          if (!x.ok) {
            var m = { sin_clave_audio: 'Pasar audio a texto necesita la clave de Gemini en config.json.', sin_internet: 'No hay conexión a internet para transcribir.', clave_invalida: 'La clave de Gemini no es válida.', limite: 'Se alcanzó el límite de uso de Gemini. Probá en un rato.', audio_grande: 'El audio es demasiado largo.', formato: 'Ese formato de audio no se pudo leer.', imagen: 'No se pudo leer ese audio.', ilegible: 'No se entendió el audio. Probá de nuevo.' };
            msg(m[x.d.error] || 'No se pudo pasar el audio a texto.', 'err'); return;
          }
          var t = $('#' + ids.txt), cur = t.value.trim();
          t.value = (cur ? cur + '\n' : '') + x.d.texto;
          msg('Listo: revisá el texto antes de guardar.', 'ok');
          refreshDerived();
        })
        .catch(function () { btn.disabled = false; msg('No se pudo conectar con el servidor.', 'err'); });
    }
    function detener() { if (rec && rec.state !== 'inactive') rec.stop(); }
    btn.addEventListener('click', function () {
      if (rec && rec.state === 'recording') { detener(); return; }
      // si el navegador deja grabar acá (https o localhost) se graba en la página; si no, se usa la grabadora del teléfono
      if (window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
          stream = s; chunks = [];
          rec = new MediaRecorder(s);
          rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
          rec.onstop = function () {
            stream.getTracks().forEach(function (t) { t.stop(); });
            lbl.textContent = 'Grabar audio'; btn.classList.remove('rec');
            var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            if (blob.size) enviar(blob, blob.type);
          };
          rec.start(); lbl.textContent = 'Detener y pasar a texto'; btn.classList.add('rec'); msg('Grabando…', 'busy');
        }).catch(function () { msg('No se pudo usar el micrófono. Revisá el permiso.', 'err'); });
      } else {
        inp.click();
      }
    });
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; inp.value = '';
      if (f) enviar(f, f.type || 'audio/mp4');
    });
  }

  function renderAcces() {
    var box = $('#acces');
    var todos = ACCESORIOS.concat(Array.from(acces).filter(function (a) { return ACCESORIOS.indexOf(a) < 0; }));
    box.replaceChildren.apply(box, todos.map(function (a) {
      var b = h('button', { type: 'button', class: 'chip', 'aria-pressed': acces.has(a) ? 'true' : 'false', text: a });
      b.addEventListener('click', function () {
        if (acces.has(a)) acces.delete(a); else acces.add(a);
        b.setAttribute('aria-pressed', acces.has(a) ? 'true' : 'false');
      });
      return b;
    }));
  }

  function clearForm() {
    Object.keys(FIELDS).forEach(function (k) { setField(k, '', false); });
    setField('por', savedPor(), false);
    setField('repfecha', hoyIso(), false);
    renderTecnicos(savedTecnico());
    clearPhotos(); clearPhotosRep();
    eqKey = ''; $('#eq-known').hidden = true;
    histKey = ''; histItems = []; dismissed = {}; otKey = ''; otItems = [];
    clienteId = null; showLink(null); $('#sugg').hidden = true; docKey = '';
    acces.clear(); renderAcces();
    editing = null;
    $('#editing').hidden = true;
    refreshDerived();
  }

  function editRecord(r) {
    clearForm();
    editing = r;
    var e = r.equipo || {}, c = r.cliente || {};
    setField('serie', e.serie || '', false); setField('tipo', e.tipo || '', false);
    setField('marca', e.marca || '', false); setField('modelo', e.modelo || '', false);
    setField('nombre', c.nombre || '', false); setField('doc', fmtDoc(c.doc), false);
    setField('tel', c.tel || '', false); setField('dir', c.dir || '', false); setField('iva', c.iva || '', false);
    setField('ot', r.ot || '', false); setField('nota', r.nota || '', false);
    setField('falla', r.falla || '', false); setField('accesTxt', r.accesoriosTxt || '', false);
    setField('por', r.por || savedPor(), false);
    (r.accesorios || []).forEach(function (a) { acces.add(a); });
    renderAcces();
    (r.fotos || []).forEach(function (id) { fotosEq.push({ blob: null, url: '/fotos/' + id, id: id, read: false }); });
    renderThumbs();
    var rp = r.reparacion || {};
    setField('rep', rp.texto || '', false); setField('repfecha', rp.fecha || hoyIso(), false);
    renderTecnicos(rp.tecnico || savedTecnico()); setField('notasInt', r.notasInt || '', false);
    (rp.fotos || []).forEach(function (id) { fotosRep.push({ blob: null, url: '/fotos/' + id, id: id }); });
    renderThumbsRep();
    clienteId = (c && c.id) || null;
    showLink(clienteId ? { codigo: c.codigo } : null);
    $('#editing').replaceChildren(
      h('strong', { text: 'Editando el ingreso de ' + (e.serie || 'equipo sin serie') + '.' }),
      h('button', { type: 'button', class: 'link', text: 'Cancelar edición', onclick: function () { clearForm(); } })
    );
    $('#editing').hidden = false;
    setTab('new');
    refreshDerived();
  }

  function errMessage(e) {
    var c = e && e.code;
    if (c === 'datos') return 'Faltan datos: poné el nombre del cliente y la serie o el modelo del equipo.';
    if (c === 'no_encontrado') return 'Ese ingreso ya no existe. Alguien lo eliminó.';
    if (c === 'muy_grande') return 'La foto es demasiado grande. Sacala de nuevo.';
    if (c === 'formato') return 'Esa foto no es compatible. Sacala de nuevo.';
    if (c === 'interno') return 'El servidor tuvo un error. Probá de nuevo.';
    return 'No se pudo conectar con el servidor. Probá de nuevo en unos segundos.';
  }

  function save(opts) {
    opts = opts || {};
    if (saving || !online || missing().length) { if (opts.win) opts.win.close(); return; }
    saving = true; updateSaveBar();
    var photoFailed = false;
    var fotos = [], fotosR = [];
    var chain = Promise.resolve();
    fotosRep.slice().forEach(function (p) {
      chain = chain.then(function () {
        if (!p.blob) { fotosR.push(p.id); return; }
        return api('POST', '/api/fotos', p.blob).then(function (r) { fotosR.push(r.id); })
          .catch(function () { photoFailed = true; });
      });
    });
    fotosEq.slice().forEach(function (p) {
      chain = chain.then(function () {
        if (!p.blob) { fotos.push(p.id); return; }
        return api('POST', '/api/fotos', p.blob).then(function (r) { fotos.push(r.id); })
          .catch(function () { photoFailed = true; });
      });
    });
    return chain.then(function () {
      var serie = val('serie').toUpperCase();
      var data = {
        cargado: editing ? !!editing.cargado : false,
        ot: val('ot'),
        por: val('por'),
        cliente: { id: clienteId, nombre: val('nombre'), doc: digits(val('doc')), tel: val('tel'), dir: val('dir'), iva: val('iva') },
        equipo: { tipo: val('tipo'), marca: val('marca'), modelo: val('modelo'), serie: serie },
        nota: val('nota'),
        falla: val('falla'),
        accesorios: Array.from(acces),
        accesoriosTxt: val('accesTxt'),
        fotos: fotos,
        reparacion: { texto: val('rep'), fecha: (val('rep') || fotosR.length) ? (val('repfecha') || hoyIso()) : '', tecnico: val('tecnico'), fotos: fotosR },
        notasInt: val('notasInt')
      };
      var wasEditing = !!editing;
      var req = wasEditing ? api('PUT', '/api/recepciones/' + editing.id, data) : api('POST', '/api/recepciones', data);
      return req.then(function (saved) {
        var label = serie || val('modelo');
        if (wasEditing) openIds.add(saved.id);
        return refresh().catch(function () {}).then(function () {
          if (opts.informe) {
            editRecord(saved);
            var url = '/informe/' + saved.id;
            if (opts.win && !opts.win.closed) opts.win.location = url; else window.open(url, '_blank');
            toast(photoFailed ? 'Guardado, pero alguna foto no se pudo subir.' : 'Guardado. Informe técnico abierto en otra pestaña.');
            return;
          }
          clearForm();
          if (wasEditing) setTab('list'); else window.scrollTo(0, 0);
          showSaved(saved);
          toast(photoFailed ? 'Guardado, pero alguna foto no se pudo subir.' : (wasEditing ? 'Cambios guardados.' : 'Ingreso N.º ' + saved.numero + ' guardado: ' + label));
        });
      });
    }).catch(function (e) {
      if (opts.win) opts.win.close();
      toast(errMessage(e), 'err');
    }).then(function () { saving = false; updateSaveBar(); });
  }

  function generarInforme() {
    var m = missing();
    if (m.length) { toast('Para generar el informe falta: ' + m.join(' y ') + '.', 'err'); return; }
    var w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    save({ informe: true, win: w });
  }

  /* ---------- Listado ---------- */
  function matches(r, q) {
    if (!q) return true;
    var e = r.equipo || {}, c = r.cliente || {};
    var hay = normText(['#' + r.numero, r.numero, (r.cliente && r.cliente.codigo) || '', e.serie, e.marca, e.modelo, e.tipo, c.nombre, c.doc, c.tel, c.dir, r.ot, r.nota, (r.reparacion && r.reparacion.texto) || '', r.notasInt || '', r.docNorm, r.falla, (r.accesorios || []).join(' '), r.accesoriosTxt, r.por].join(' '));
    var sn = (r.serieNorm || '').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(function (t) {
      var nt = normText(t), ns = normSerie(t).toLowerCase();
      return hay.indexOf(nt) !== -1 || (ns && sn.indexOf(ns) !== -1);
    });
  }
  function filtered() {
    if (onlyFlex) return [];
    return records.filter(function (r) { return (!onlyPending || !r.cargado) && matches(r, query); });
  }
  function filteredFlex() {
    if (onlyPending) return [];
    var words = query.split(/\s+/).filter(Boolean);
    return pendientes.filter(function (o) {
      if (!words.length) return true;
      var hay = normText([o.ot, o.serie, o.tipo, o.marca, o.modelo, o.descripcion, o.cliente, o.defecto, o.observaciones, o.estado, o.extra && o.extra.notas].join(' '));
      var sn = normSerie([o.serie].join('')).toLowerCase();
      return words.every(function (t) { var ns = normSerie(t).toLowerCase(); return hay.indexOf(normText(t)) !== -1 || (ns && sn.indexOf(ns) !== -1); });
    });
  }
  function setMode(m) {
    onlyPending = m === 'pend'; onlyFlex = m === 'flex';
    $('#chip-all').setAttribute('aria-pressed', String(m === 'all'));
    $('#chip-pend').setAttribute('aria-pressed', String(m === 'pend'));
    $('#chip-flex').setAttribute('aria-pressed', String(m === 'flex'));
  }

  function kv(rows) {
    var d = h('dl', { class: 'kv' });
    rows.forEach(function (p) { if (p[1]) { d.append(h('dt', { text: p[0] }), h('dd', { text: p[1] })); } });
    return d;
  }

  function rowEl(r) {
    var e = r.equipo || {}, c = r.cliente || {}, f = r.fotos || {};
    var d = h('details', { class: 'row', id: 'row-' + r.id, open: openIds.has(r.id) });
    d.addEventListener('toggle', function () { if (d.open) openIds.add(r.id); else openIds.delete(r.id); });
    d.append(h('summary', null,
      h('div', { class: 'r-top' },
        h('span', { class: 'serie mono', text: (e.serie || 'Sin serie') }),
        h('span', { class: 'num', text: '#' + r.numero }),
        h('span', { class: 'pill ' + (r.cargado ? 'ok' : 'warn'), text: r.cargado ? 'Cargado' : 'Sin cargar' })),
      h('div', { class: 'r-eq', text: [e.marca, e.modelo].filter(Boolean).join(' ') || e.tipo || 'Equipo sin identificar' }),
      r.falla ? h('div', { class: 'r-falla', text: 'Falla: ' + r.falla }) : null,
      r.reparacion && r.reparacion.texto ? h('div', { class: 'r-falla', text: 'Reparación: ' + r.reparacion.texto }) : null,
      h('div', { class: 'r-cl', text: [c.nombre || 'Sin cliente', fmtDate(r.ts)].join(' · ') })));

    var photosEl = h('div', { class: 'photos' });
    (r.fotos || []).forEach(function (id, i) {
      photosEl.append(h('a', { class: 'ph', href: '/fotos/' + id, target: '_blank', rel: 'noopener' },
        h('img', { src: '/fotos/' + id, alt: 'Foto ' + (i + 1) + ' del equipo', loading: 'lazy' }), h('span', { text: 'Foto ' + (i + 1) })));
    });
    if (r.fotoCliente) photosEl.append(h('a', { class: 'ph', href: '/fotos/' + r.fotoCliente, target: '_blank', rel: 'noopener' },
      h('img', { src: '/fotos/' + r.fotoCliente, alt: 'Papel del cliente', loading: 'lazy' }), h('span', { text: 'Papel del cliente' })));

    var chk = h('input', { type: 'checkbox', id: 'cg-' + r.id, checked: !!r.cargado });
    chk.addEventListener('change', function () {
      api('PATCH', '/api/recepciones/' + r.id, { cargado: chk.checked }).then(refresh)
        .catch(function (er) { toast(errMessage(er), 'err'); chk.checked = !chk.checked; });
    });
    var ot = h('input', { type: 'text', class: 'ot', id: 'ot-' + r.id, value: r.ot || '', placeholder: 'N.º de OT', 'aria-label': 'Número de OT' });
    ot.addEventListener('change', function () {
      api('PATCH', '/api/recepciones/' + r.id, { ot: ot.value.trim() }).then(refresh)
        .catch(function (er) { toast(errMessage(er), 'err'); });
    });

    var armed = false, armT;
    var del = h('button', { type: 'button', class: 'btn sm danger', text: 'Eliminar' });
    del.addEventListener('click', function () {
      if (!armed) {
        armed = true; del.textContent = 'Tocá de nuevo para eliminar';
        armT = setTimeout(function () { armed = false; del.textContent = 'Eliminar'; }, 4000);
        return;
      }
      clearTimeout(armT);
      api('DELETE', '/api/recepciones/' + r.id).then(function () {
        openIds.delete(r.id);
        toast('Ingreso eliminado.');
        return refresh();
      }).catch(function (er) { toast(errMessage(er), 'err'); });
    });

    d.append(h('div', { class: 'r-body' },
      kv([['Tipo', e.tipo], ['Marca', e.marca], ['Modelo', e.modelo], ['Cliente', c.nombre], ['Código de cliente', c.codigo], ['DNI / CUIL / CUIT', fmtDoc(c.doc)], ['Teléfono', c.tel], ['Dirección', c.dir], ['Condición IVA', c.iva], ['Falla', r.falla], ['Accesorios', [(r.accesorios || []).join(', '), r.accesoriosTxt].filter(Boolean).join(' · ')], ['Otras observaciones', r.nota], ['Recibió', r.por]]),
      photosEl.children.length ? photosEl : null,
      h('div', { class: 'ctrl' }, h('label', { class: 'chk', for: 'cg-' + r.id }, chk, 'Cargado en el sistema'), ot),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn sm', text: 'Imprimir hoja', onclick: function () { printRecord(r); } }),
        h('button', { type: 'button', class: 'btn sm', text: 'Informe técnico', onclick: function () { window.open('/informe/' + r.id, '_blank'); } }),
        h('button', { type: 'button', class: 'btn sm', text: 'Editar', onclick: function () { editRecord(r); } }), del)));
    return d;
  }

  function renderList() {
    var box = $('#rows');
    $('#count').textContent = String(records.length + pendientes.length);
    var pend = records.filter(function (r) { return !r.cargado; }).length;
    $('#list-meta').textContent = loaded ? records.length + (records.length === 1 ? ' ingreso' : ' ingresos') + ' · ' + pend + ' sin cargar · ' + pendientes.length + ' pendientes del sistema' : '';
    $('#export').hidden = !loaded;
    if (!loaded) {
      box.replaceChildren(h('div', { class: 'empty', text: initDone ? 'No se pudieron cargar los ingresos. Revisá la conexión con el servidor.' : 'Cargando ingresos…' }));
      return;
    }
    if (!records.length && !pendientes.length) {
      box.replaceChildren(h('div', { class: 'empty' },
        h('strong', { text: 'Todavía no hay ingresos' }),
        h('span', { text: 'Cuando guardes el primer equipo aparece acá, con su serie y su cliente.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Cargar un ingreso', onclick: function () { setTab('new'); } })));
      return;
    }
    var rows = filtered(), flex = filteredFlex();
    if (!rows.length && !flex.length) {
      box.replaceChildren(h('div', { class: 'empty', text: query ? 'Ningún ingreso coincide con “' + query + '”.' : (onlyFlex ? 'No hay equipos pendientes del sistema.' : 'No quedan ingresos sin cargar.') }));
      return;
    }
    var out = rows.map(rowEl);
    if (flex.length) {
      out.push(h('div', { class: 'sec-h' }, h('strong', { text: 'Pendientes del sistema (Flexxus)' }),
        h('span', { class: 'meta', text: flex.length + ' · esperando reparación, repuestos o presupuesto' })));
      flex.forEach(function (o) { out.push(otRow(o)); });
    }
    box.replaceChildren.apply(box, out);
  }

  function showInList(q) {
    $('#q').value = q; query = q.trim(); onlyPending = false;
    setMode('all');
    setTab('list'); renderList();
  }

  function exportCsv() {
    var rows = filtered();
    if (!rows.length) { toast('No hay ingresos para exportar.'); return; }
    var esc = function (v) { v = v == null ? '' : String(v); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var head = ['N.º de ingreso', 'Código de cliente', 'Fecha', 'Serie', 'Tipo', 'Marca', 'Modelo', 'Cliente', 'DNI/CUIL/CUIT', 'Teléfono', 'Dirección', 'Condición IVA', 'Falla', 'Accesorios', 'Otras observaciones', 'N.º de OT', 'Recibió', 'Cargado en el sistema'];
    var lines = [head.map(esc).join(';')].concat(rows.map(function (r) {
      var e = r.equipo || {}, c = r.cliente || {};
      return [r.numero, c.codigo, fmtDate(r.ts), e.serie, e.tipo, e.marca, e.modelo, c.nombre, fmtDoc(c.doc), c.tel, c.dir, c.iva, r.falla, [(r.accesorios || []).join(', '), r.accesoriosTxt].filter(Boolean).join(' · '), r.nota, r.ot, r.por, r.cargado ? 'Sí' : 'No'].map(esc).join(';');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ingresos-' + new Date().toLocaleDateString('sv-SE') + '.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* ---------- Hoja para pegar en el equipo ---------- */
  function showSaved(rec) {
    var box = $('#saved');
    if (!rec || editing) { box.hidden = true; return; }
    box.replaceChildren(
      h('strong', { text: 'Ingreso N.º ' + rec.numero + ' guardado.' }),
      h('button', { type: 'button', class: 'btn sm primary', text: 'Imprimir hoja', onclick: function () { printRecord(rec); } }),
      h('button', { type: 'button', class: 'link', text: 'Cerrar', onclick: function () { box.hidden = true; } })
    );
    box.hidden = false;
  }

  function qrSvg(text) {
    try {
      var q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createSvgTag({ scalable: true, margin: 0 });
    } catch (e) { return ''; }
  }

  function printRecord(r) {
    var e = r.equipo || {}, c = r.cliente || {};
    var url = location.origin + '/#' + r.numero;
    var acc = [(r.accesorios || []).join(', '), r.accesoriosTxt].filter(Boolean).join(' · ');
    var root = $('#print-sheet');
    var fila = function (lab, v, big) { return v ? h('div', { class: 'ps-row' + (big ? ' big' : '') }, h('small', { text: lab }), v) : null; };
    var qr = h('div', { class: 'ps-qr' });
    qr.innerHTML = qrSvg(url);
    qr.append(h('div', { text: 'Escaneá para abrir el ingreso' }));
    root.replaceChildren(h('div', { class: 'ps' },
      h('div', { class: 'ps-top' },
        h('div', null,
          h('div', { class: 'ps-num' }, 'INGRESO N.º', h('b', { text: String(r.numero) })),
          h('div', { class: 'ps-date', text: fmtDate(r.ts) })),
        qr),
      h('div', { class: 'ps-serie' }, h('small', { text: 'N.º de serie' }), h('b', { text: e.serie || 'SIN SERIE' })),
      fila('Equipo', [e.tipo, e.marca, e.modelo].filter(Boolean).join(' · '), true),
      fila('Cliente', c.nombre, true),
      fila('Teléfono', c.tel),
      fila('Falla', r.falla),
      fila('Accesorios', acc),
      fila('Otras observaciones', r.nota),
      (r.fotos || []).length ? h('div', { class: 'ps-fotos' }, (r.fotos || []).map(function (id) { return h('img', { src: '/fotos/' + id, alt: '' }); })) : null,
      h('div', { class: 'ps-foot' }, h('span', { text: r.ot ? 'OT: ' + r.ot : 'OT: ____________' }), h('span', { text: r.por ? 'Recibió: ' + r.por : '' }))
    ));
    var done = function () { root.replaceChildren(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    var imgs = $$('img', root);
    var esperar = Promise.all(imgs.map(function (im) {
      return im.decode ? im.decode().catch(function () {}) : new Promise(function (ok) { im.onload = im.onerror = ok; });
    }));
    Promise.race([esperar, new Promise(function (ok) { setTimeout(ok, 4000); })]).then(function () { window.print(); });
  }

  function openFromHash() {
    var n = parseInt((location.hash || '').replace('#', ''), 10);
    if (!n || !loaded) return;
    var r = records.filter(function (x) { return x.numero === n; })[0];
    if (!r) { toast('No hay un ingreso N.º ' + n + '.', 'err'); return; }
    query = ''; setMode('all'); $('#q').value = '';
    openIds.add(r.id);
    setTab('list');
    var row = document.getElementById('row-' + r.id);
    if (row) row.scrollIntoView({ block: 'start' });
    history.replaceState(null, '', location.pathname);
  }

  /* ---------- Buscar OT ---------- */
  var otTok = 0, otT;
  function fmtIso(f) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  /* Notas internas y fotos de una OT del listado (se guardan en el servidor, por N.º de OT) */
  function syncPend(ot, extra) {
    pendientes.forEach(function (p) { if (p.ot === ot) p.extra = { notas: extra.notas, fotos: extra.fotos.slice() }; });
  }
  function extrasEl(o, tag) {
    var ex = o.extra || (o.extra = { notas: '', fotos: [] });
    var MAXO = 10, chain = Promise.resolve();
    var thumbs = h('div', { class: 'thumbs' });
    var ta = h('textarea', { rows: 3, maxlength: 4000, placeholder: 'Notas internas de esta OT (quedan solo en el taller)', 'aria-label': 'Notas internas de la OT ' + o.ot });
    ta.value = ex.notas || '';
    var st = h('span', { class: 'meta ex-st', 'aria-live': 'polite' });
    var inCam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    var inGal = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    var bCam = h('button', { type: 'button', class: 'btn sm', text: 'Sacar foto', onclick: function () { inCam.click(); } });
    var bGal = h('button', { type: 'button', class: 'btn sm', text: 'Elegir de la galería', onclick: function () { inGal.click(); } });
    var bSave = h('button', { type: 'button', class: 'btn sm primary', text: 'Guardar nota', onclick: function () { save(); } });

    function paint() {
      thumbs.hidden = !ex.fotos.length;
      thumbs.replaceChildren.apply(thumbs, ex.fotos.map(function (id, i) {
        return h('div', { class: 'thumb' },
          h('a', { href: '/fotos/' + id, target: '_blank', rel: 'noopener' }, h('img', { src: '/fotos/' + id, alt: 'Foto ' + (i + 1) + ' de la OT ' + o.ot, loading: 'lazy' })),
          h('button', { type: 'button', 'aria-label': 'Quitar la foto ' + (i + 1), text: '×', onclick: function () {
            ex.fotos = ex.fotos.filter(function (x) { return x !== id; }); paint(); save();
          } }));
      }));
      bCam.disabled = bGal.disabled = ex.fotos.length >= MAXO;
      bSave.disabled = ta.value.trim() === (ex.notas || '').trim();
      if (tag) {
        var parts = [];
        if ((ex.notas || '').trim()) parts.push('nota');
        if (ex.fotos.length) parts.push(ex.fotos.length + (ex.fotos.length === 1 ? ' foto' : ' fotos'));
        tag.textContent = parts.join(' · ');
        tag.hidden = !parts.length;
      }
    }
    function enqueue(fn) {
      chain = chain.then(fn).catch(function () {});
      return chain;
    }
    function doSave() {
      st.textContent = 'Guardando…';
      return api('PUT', '/api/ot-extra/' + encodeURIComponent(o.ot), { notas: ta.value.trim(), fotos: ex.fotos }).then(function (r) {
        ex.notas = r.extra.notas; ex.fotos = r.extra.fotos.slice();
        if (rev != null && r.rev === rev + 1) rev = r.rev;
        syncPend(o.ot, ex);
        st.textContent = 'Guardado';
        paint();
      }).catch(function (er) { st.textContent = 'No se pudo guardar. Probá de nuevo.'; toast(errMessage(er), 'err'); });
    }
    function save() { return enqueue(doSave); }
    function agregar(files) {
      files = Array.prototype.slice.call(files || []).slice(0, MAXO - ex.fotos.length);
      if (!files.length) return;
      st.textContent = 'Subiendo ' + (files.length === 1 ? 'la foto…' : files.length + ' fotos…');
      enqueue(function () {
        return files.reduce(function (p, f) {
          return p.then(function () {
            return prepareImage(f).then(function (blob) { return api('POST', '/api/fotos', blob); }).then(function (r) { ex.fotos.push(r.id); });
          });
        }, Promise.resolve()).catch(function () { st.textContent = 'Una foto no se pudo subir.'; });
      });
      enqueue(function () { paint(); return doSave(); });
    }
    inCam.addEventListener('change', function () { agregar(inCam.files); inCam.value = ''; });
    inGal.addEventListener('change', function () { agregar(inGal.files); inGal.value = ''; });
    ta.addEventListener('input', function () { bSave.disabled = ta.value.trim() === (ex.notas || '').trim(); st.textContent = ''; });
    ta.addEventListener('blur', function () { if (ta.value.trim() !== (ex.notas || '').trim()) save(); });
    paint();
    return h('div', { class: 'extras' },
      h('strong', { class: 'ex-h', text: 'Notas internas y fotos' }),
      h('div', { class: 'field' }, ta),
      h('div', { class: 'ctrl' }, bSave, bCam, bGal, st),
      thumbs, inCam, inGal);
  }

  function estadoPend(e) { return /^(esp|reparacion|service)/i.test(normText(e).replace(/[^a-z]/g, ' ').trim()); }

  function guiaRow(o) {
    var eq = [o.tipo, o.marca, o.modelo].filter(Boolean).join(' ');
    var kv = h('dl', { class: 'kv' });
    [['Cliente', o.cliente || (o.codCliente ? 'Cód. ' + o.codCliente + ' (sistema anterior)' : '')], ['CUIT', o.clienteCuit], ['Dirección', o.clienteDir], ['Teléfono', o.clienteTel],
     ['Equipo', eq], ['Serie', o.serie], ['Datos del equipo', o.aparatoObs],
     ['Falla', o.defecto], ['Informe técnico (reparación)', o.observaciones], ['Accesorios', o.accesorios], ['Observaciones', o.obs], ['Informe interno', o.informeInt],
     ['Fecha de ingreso', fmtIso(o.fecha)], ['Fecha de reparación', fmtIso(o.fin)], ['Fecha de entrega', fmtIso(o.entrega)], ['Origen', 'Sistema anterior · guía N.º ' + o.guia]].forEach(function (p) {
      if (p[1]) kv.append(h('dt', { text: p[0] }), h('dd', { text: p[1] }));
    });
    return h('details', { class: 'row' },
      h('summary', null,
        h('div', { class: 'r-top' }, h('span', { class: 'serie mono', text: 'Guía ' + o.guia }), h('span', { class: 'pill ok', text: o.estado })),
        h('div', { class: 'r-eq', text: eq || 'Equipo del sistema anterior' }),
        o.serie ? h('div', { class: 'r-cl mono', text: 'Serie ' + o.serie }) : null,
        o.defecto ? h('div', { class: 'r-falla', text: o.defecto.slice(0, 140) }) : null,
        h('div', { class: 'r-cl', text: [o.cliente || (o.codCliente ? 'Cliente cód. ' + o.codCliente : ''), o.fecha ? 'Ingreso ' + fmtIso(o.fecha) : '', 'Sistema anterior'].filter(Boolean).join(' · ') })),
      h('div', { class: 'r-body' }, kv));
  }
  function otRow(o) {
    if (o.origen === 'anterior') return guiaRow(o);
    var eq = [o.tipo, o.marca, o.modelo].filter(Boolean).join(' ') || o.descripcion || 'Equipo sin identificar';
    var kv = h('dl', { class: 'kv' });
    // En Flexxus la falla real y la reparación hecha se escriben en "Observaciones"; "Defecto" suele traer solo el tipo de servicio.
    [['Cliente', o.cliente], ['Equipo', o.descripcion && o.descripcion !== eq ? o.descripcion : ''], ['Serie', o.serie],
     [o.origen === 'app' ? 'Falla' : 'Falla / reparación (observaciones)', o.origen === 'app' ? o.defecto : o.observaciones], [o.origen === 'app' ? 'Observaciones' : 'Tipo de servicio (defecto)', o.origen === 'app' ? o.observaciones : o.defecto], ['Trabajo a realizar', o.trabajo],
     ['Fecha de ingreso', fmtIso(o.fecha)], ['Fecha de finalización', fmtIso(o.fin)], ['Origen', o.origen === 'app' ? 'Ingreso hecho en esta app' : 'Listado de reparaciones']].forEach(function (p) {
      if (p[1]) kv.append(h('dt', { text: p[0] }), h('dd', { text: p[1] }));
    });
    var body = h('div', { class: 'r-body' }, kv);
    var tag = h('span', { class: 'ex-tag' });
    if (o.numero) body.append(h('div', null, h('button', { type: 'button', class: 'btn sm', text: 'Ver ingreso N.º ' + o.numero,
      onclick: function () { location.hash = '#' + o.numero; } })));
    if (o.origen !== 'app' && o.ot) body.append(extrasEl(o, tag));
    var d = h('details', { class: 'row', open: !!o.ot && openOt.has(o.ot) },
      h('summary', null,
        h('div', { class: 'r-top' },
          h('span', { class: 'serie mono', text: o.ot ? 'OT ' + o.ot : 'Sin OT' }),
          h('span', { class: 'pill ' + ((o.origen === 'app' && !/^Cargado/.test(o.estado)) || (o.origen !== 'app' && estadoPend(o.estado)) ? 'warn' : 'ok'), text: o.estado || '—' })),
        h('div', { class: 'r-eq', text: eq }),
        o.serie ? h('div', { class: 'r-cl mono', text: 'Serie ' + o.serie }) : null,
        (o.observaciones || (o.origen === 'app' && o.defecto)) ? h('div', { class: 'r-falla', text: ((o.origen === 'app' ? o.defecto : o.observaciones) || '').slice(0, 140) + (((o.origen === 'app' ? o.defecto : o.observaciones) || '').length > 140 ? '…' : '') }) : null,
        h('div', { class: 'r-cl' }, [o.cliente || 'Sin cliente', o.fecha ? 'Ingreso ' + fmtIso(o.fecha) : ''].filter(Boolean).join(' · '), ' ', tag)),
      body);
    d.addEventListener('toggle', function () { if (!o.ot) return; if (d.open) openOt.add(o.ot); else openOt.delete(o.ot); });
    return d;
  }
  function buscarOt() {
    var v = function (id) { return $(id).value.trim(); };
    var qs = ['anterior=' + ($('#o-ant').checked ? '1' : '0'), 'q=' + encodeURIComponent(v('#o-q')), 'cliente=' + encodeURIComponent(v('#o-cliente')), 'serie=' + encodeURIComponent(v('#o-serie')),
      'ot=' + encodeURIComponent(v('#o-ot')), 'tipo=' + encodeURIComponent(v('#o-tipo')), 'marca=' + encodeURIComponent(v('#o-marca')), 'modelo=' + encodeURIComponent(v('#o-modelo')), 'desde=' + encodeURIComponent(v('#o-desde')), 'hasta=' + encodeURIComponent(v('#o-hasta'))].join('&');
    var tok = ++otTok, rows = $('#o-rows'), meta = $('#o-meta');
    if (['#o-q', '#o-cliente', '#o-serie', '#o-ot', '#o-tipo', '#o-marca', '#o-modelo', '#o-desde', '#o-hasta'].some(function (i) { return v(i); })) meta.textContent = 'Buscando…';
    api('GET', '/api/ordenes?' + qs).then(function (r) {
      if (tok !== otTok) return;
      rows.textContent = '';
      $('#o-base').textContent = r.actualizado
        ? 'Base de OT actualizada el ' + fmtDate(r.actualizado) + ' · ' + r.cantidad + ' órdenes' + (r.guias ? ' · ' + r.guias + ' guías del sistema anterior' : '')
        : 'Base de OT sin cargar: falta el archivo reparaciones.csv';
      if (r.vacio) { meta.textContent = "Escribí en la búsqueda general (cliente, serie, equipo, marca, modelo u OT) para buscar."; return; }
      meta.textContent = r.total === 0 ? 'No se encontraron órdenes con esos datos.' :
        (r.total > r.items.length ? 'Mostrando las ' + r.items.length + ' más recientes de ' + r.total + '. Agregá más datos para acotar.' : r.total + (r.total === 1 ? ' orden encontrada.' : ' órdenes encontradas.'));
      r.items.forEach(function (o) { rows.append(otRow(o)); });
      if (r.items.length === 1) rows.firstChild.open = true;
    }).catch(function (er) {
      if (tok !== otTok) return;
      rows.textContent = '';
      meta.textContent = (er && er.status === 404)
        ? 'El servidor no tiene la búsqueda de OT: está corriendo una versión anterior. Cerrá la ventana negra del servidor y abrí de nuevo iniciar.bat.'
        : 'No se pudo buscar (' + ((er && er.code) || 'sin conexión') + '). Probá de nuevo.';
    });
  }
  function setAvanzada(open) {
    $('#o-adv').hidden = !open;
    $('#o-avanzada').setAttribute('aria-expanded', String(open));
    $('#o-avanzada').textContent = 'Búsqueda avanzada ' + (open ? '▴' : '▾');
  }
  function bindOt() {
    $('#o-avanzada').addEventListener('click', function () { setAvanzada($('#o-adv').hidden); });
    $('#o-ant').addEventListener('change', buscarOt);
    ['#o-q', '#o-cliente', '#o-serie', '#o-ot', '#o-tipo', '#o-marca', '#o-modelo'].forEach(function (id) {
      $(id).addEventListener('input', function () { clearTimeout(otT); otT = setTimeout(buscarOt, 250); });
    });
    ['#o-desde', '#o-hasta'].forEach(function (id) { $(id).addEventListener('change', buscarOt); });
    $('#o-limpiar').addEventListener('click', function () {
      ['#o-q', '#o-cliente', '#o-serie', '#o-ot', '#o-tipo', '#o-marca', '#o-modelo', '#o-desde', '#o-hasta'].forEach(function (id) { $(id).value = ''; });
      $('#o-ant').checked = false;
      setAvanzada(false);
      buscarOt();
    });
  }

  /* ---------- Alquiler (contrato en Word) ---------- */
  var alq = { items: [], siguiente: 0, anio: '', loaded: false };
  var alqEq = [{ tipo: '', marca: '', modelo: '', serie: '' }];
  var alqRefs = [], alqT = [], alqTok = [];
  var fraseEdit = false, datosEdit = false, numeroEdit = false, prevTok = 0, prevT;
  var MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hoyIso() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function sumarMeses(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m || !(n >= 1)) return '';
    var t = Number(m[2]) - 1 + n, a = Number(m[1]) + Math.floor(t / 12), mes = t % 12;
    var ult = new Date(a, mes + 1, 0).getDate();
    return a + '-' + pad2(mes + 1) + '-' + pad2(Math.min(Number(m[3]), ult));
  }
  function fraseEquipo(items) {
    var tipos = items.map(function (i) { return (i.tipo || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    if (!tipos.length) return '';
    var w = tipos[0].split(' ')[0].toLowerCase();
    var art = (/a$/.test(w) && w !== 'cpap' && w !== 'bipap') ? 'una ' : 'un ';
    return [art + tipos[0]].concat(tipos.slice(1)).join(' mas ');
  }
  function datosEquipo(items) {
    return items.map(function (i) {
      var t = [i.tipo, i.marca, i.modelo].map(function (x) { return (x || '').trim(); }).filter(Boolean).join(' ');
      if ((i.serie || '').trim()) t = (t + ' N/S ' + i.serie.trim()).trim();
      return t;
    }).filter(Boolean).join(' – ');
  }
  function updateFin() {
    var f = sumarMeses($('#a-inicio').value, parseInt($('#a-meses').value, 10));
    $('#a-fin').textContent = f ? fmtIso(f) : '—';
  }
  function updateAuto() {
    if (!fraseEdit) $('#a-frase').value = fraseEquipo(alqEq);
    if (!datosEdit) $('#a-datos').value = datosEquipo(alqEq);
  }

  function renderAlqEquipos() {
    var box = $('#a-equipos');
    alqRefs = [];
    box.replaceChildren.apply(box, alqEq.map(function (it, i) {
      var known = h('div', { class: 'alq-known', hidden: true });
      var inp = function (campo, ph, extra) {
        var el = h('input', Object.assign({ autocomplete: 'off', placeholder: ph, value: it[campo] || '' }, extra || {}));
        el.addEventListener('input', function () {
          alqEq[i][campo] = el.value;
          if (campo === 'serie') lookupAlq(i, known);
          updateAuto();
        });
        return el;
      };
      var ref = { serie: inp('serie', 'N.º de serie', { class: 'serie-in', autocapitalize: 'characters', spellcheck: 'false' }),
                  tipo: inp('tipo', 'Concentrador de O2', { list: 'dl-tipo' }), marca: inp('marca', 'Philips', { list: 'dl-marca' }), modelo: inp('modelo', 'EverFlo') };
      alqRefs[i] = ref;
      return h('div', { class: 'alq-eq' },
        h('div', { class: 'alq-eq-h' }, h('span', { text: alqEq.length > 1 ? 'Equipo ' + (i + 1) : 'Equipo' }),
          alqEq.length > 1 ? h('button', { type: 'button', class: 'btn sm', text: 'Quitar', onclick: function () { alqEq.splice(i, 1); renderAlqEquipos(); updateAuto(); } }) : null),
        h('div', { class: 'field' }, h('label', { text: 'N.º de serie' }), ref.serie),
        known,
        h('div', { class: 'grid' },
          h('div', { class: 'field' }, h('label', { text: 'Tipo de equipo' }), ref.tipo),
          h('div', { class: 'field' }, h('label', { text: 'Marca' }), ref.marca),
          h('div', { class: 'field wide' }, h('label', { text: 'Modelo' }), ref.modelo)));
    }));
    $('#a-add-eq').hidden = alqEq.length >= 6;
  }

  function lookupAlq(i, known) {
    var sn = normSerie(alqEq[i].serie);
    clearTimeout(alqT[i]);
    if (sn.length < 4) { known.hidden = true; known.replaceChildren(); return; }
    var tok = alqTok[i] = (alqTok[i] || 0) + 1;
    alqT[i] = setTimeout(function () {
      api('GET', '/api/equipos?serie=' + encodeURIComponent(sn)).then(function (r) {
        if (tok !== alqTok[i]) return;
        var items = ((r && r.items) || []).slice(0, 3);
        if (!items.length) { known.hidden = true; known.replaceChildren(); return; }
        known.replaceChildren.apply(known, [h('strong', { text: items.some(function (x) { return x.exacto; }) ? 'Este equipo está en la base:' : 'Series parecidas en la base:' })].concat(items.map(function (it) {
          var que = [it.tipo, it.marca, it.modelo].filter(Boolean).join(' · ') || it.descripcion || 'Equipo';
          var det = [it.exacto ? '' : 'Serie ' + it.serie, it.ordenes ? it.ordenes + (it.ordenes === 1 ? ' paso por el taller' : ' pasos por el taller') : '',
            it.ultimaOt ? 'última OT ' + it.ultimaOt : ''].filter(Boolean).join(' · ');
          return h('button', { type: 'button', onclick: function () {
            alqEq[i] = { tipo: it.tipo || '', marca: it.marca || '', modelo: it.modelo || '', serie: it.serie || alqEq[i].serie };
            var ref = alqRefs[i];
            ref.serie.value = alqEq[i].serie; ref.tipo.value = alqEq[i].tipo; ref.marca.value = alqEq[i].marca; ref.modelo.value = alqEq[i].modelo;
            known.hidden = true; known.replaceChildren(); updateAuto();
          } }, h('span', { class: 's1', text: que }), h('span', { class: 's2', text: det }));
        })));
        known.hidden = false;
      }).catch(function () { known.hidden = true; });
    }, 300);
  }

  function alqPrevio() {
    var dni = digits($('#a-dni').value), nom = normText($('#a-nombre').value).trim(), box = $('#a-prev');
    var hit = null;
    if (dni.length >= 7 || nom.length >= 5) {
      hit = alq.items.filter(function (c) {
        var p = (c.datos && c.datos.paciente) || {};
        return (dni.length >= 7 && digits(p.dni) === dni) || (nom.length >= 5 && normText(p.nombre).trim() === nom);
      })[0];
    }
    var p = hit && hit.datos.paciente;
    var igual = p && p.nombre === $('#a-nombre').value.trim() && p.dir === $('#a-dir').value.trim() && p.ciudad === $('#a-ciudad').value.trim() && p.tel === $('#a-tel').value.trim() && digits(p.dni) === dni;
    if (!hit || igual) { box.hidden = true; box.replaceChildren(); return; }
    box.replaceChildren(
      h('strong', { text: 'Ya tiene el contrato N.º ' + hit.numero + '-' + hit.anio + ':' }),
      h('span', { text: [p.nombre, p.dir, p.ciudad].filter(Boolean).join(' · ') }),
      h('button', { type: 'button', class: 'btn sm', text: 'Usar estos datos', onclick: function () {
        $('#a-trato').value = p.trato || 'Sr'; $('#a-nombre').value = p.nombre || ''; $('#a-dni').value = p.dni || '';
        $('#a-tel').value = p.tel || ''; $('#a-dir').value = p.dir || ''; $('#a-ciudad').value = p.ciudad || '';
        box.hidden = true; box.replaceChildren();
      } }));
    box.hidden = false;
  }

  function alqMessage(er) {
    var c = er && er.code;
    return ({
      falta_nombre: 'Falta el nombre y apellido del paciente.',
      falta_domicilio: 'Faltan la dirección y la ciudad del paciente.',
      falta_dni: 'Falta el DNI del paciente.',
      falta_equipo: 'Falta cargar el equipo (tipo, marca, modelo o serie).',
      numero_repetido: 'Ya existe un contrato con ese número y año. Cambiá el número.',
      numero: 'El número de contrato y el año (2 cifras) tienen que estar completos.',
      plazo: 'El plazo tiene que ser entre 1 y 120 meses.',
      fecha_inicio: 'Falta la fecha de inicio.',
      fecha_firma: 'La fecha de firma no es válida.',
      plantilla_distinta: 'El modelo de contrato (carpeta plantillas) cambió y la app ya no sabe dónde poner los datos. Hay que adaptarla.',
      falta_plantilla: 'No se encontró el modelo del contrato en la carpeta plantillas.'
    })[c] || 'No se pudo generar el contrato. Probá de nuevo.';
  }

  function alqCollect() {
    return {
      numero: $('#a-numero').value.trim(), anio: $('#a-anio').value.trim(),
      paciente: { trato: $('#a-trato').value, nombre: $('#a-nombre').value.trim(), dni: $('#a-dni').value.trim(), tel: $('#a-tel').value.trim(),
        dir: $('#a-dir').value.trim(), ciudad: $('#a-ciudad').value.trim() },
      equipos: alqEq.filter(function (e) { return e.tipo || e.marca || e.modelo || e.serie; }),
      frase: $('#a-frase').value.trim(), datos: $('#a-datos').value.trim(),
      meses: $('#a-meses').value.trim(), inicio: $('#a-inicio').value, firma: $('#a-firma').value || $('#a-inicio').value,
      incluir_contacto: $('#a-contacto').checked,
      iapos: $('#a-iapos').checked
    };
  }

  function alqReset() {
    ['#a-nombre', '#a-dni', '#a-tel', '#a-dir', '#a-ciudad'].forEach(function (id) { $(id).value = ''; });
    $('#a-trato').value = 'Sr'; $('#a-contacto').checked = true; $('#a-iapos').checked = false;
    $('#a-frase').value = ''; $('#a-datos').value = '';
    fraseEdit = datosEdit = numeroEdit = false;
    alqEq = [{ tipo: '', marca: '', modelo: '', serie: '' }];
    renderAlqEquipos(); $('#a-prev').hidden = true;
    $('#a-meses').value = '12'; $('#a-inicio').value = hoyIso(); $('#a-firma').value = hoyIso(); updateFin();
  }

  function generarAlq() {
    var d = alqCollect(), err = $('#a-err'), btn = $('#a-generar');
    err.hidden = true; $('#a-ok').hidden = true;
    btn.disabled = true; btn.textContent = 'Generando…';
    api('POST', '/api/alquileres', d).then(function (r) {
      var url = '/api/alquileres/' + r.id + '/docx';
      var a = document.createElement('a'); a.href = url; a.download = ''; document.body.append(a); a.click(); a.remove();
      $('#a-ok').replaceChildren(h('strong', { text: 'Contrato N.º ' + r.numero + '-' + r.anio + ' generado.' }),
        h('span', { text: 'Se descargó el Word. Imprimilo y hacelo firmar.' }),
        h('a', { class: 'btn sm', href: url, download: '', text: 'Descargar de nuevo' }));
      $('#a-ok').hidden = false;
      alqReset();
      return loadAlq();
    }).catch(function (er) {
      err.textContent = alqMessage(er); err.hidden = false;
      err.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }).then(function () { btn.disabled = false; btn.textContent = 'Generar contrato (Word)'; });
  }

  function alqUsarComoBase(c) {
    var p = (c.datos && c.datos.paciente) || {}, dd = c.datos || {};
    $('#a-trato').value = p.trato || 'Sr'; $('#a-nombre').value = p.nombre || ''; $('#a-dni').value = p.dni || '';
    $('#a-tel').value = p.tel || ''; $('#a-dir').value = p.dir || ''; $('#a-ciudad').value = p.ciudad || '';
    alqEq = (dd.equipos && dd.equipos.length ? dd.equipos : [{}]).map(function (e) { return { tipo: e.tipo || '', marca: e.marca || '', modelo: e.modelo || '', serie: e.serie || '' }; });
    renderAlqEquipos();
    fraseEdit = datosEdit = false; updateAuto();
    if (dd.frase && dd.frase !== $('#a-frase').value) { $('#a-frase').value = dd.frase; fraseEdit = true; }
    if (dd.datos && dd.datos !== $('#a-datos').value) { $('#a-datos').value = dd.datos; datosEdit = true; }
    $('#a-meses').value = dd.meses || 12; $('#a-inicio').value = hoyIso(); $('#a-firma').value = hoyIso(); updateFin();
    $('#a-contacto').checked = !!dd.incluir_contacto; $('#a-iapos').checked = !!dd.iapos;
    numeroEdit = false; $('#a-numero').value = alq.siguiente || '';
    $('#a-err').hidden = true; $('#a-ok').hidden = true; $('#a-prev').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Datos cargados del contrato N.º ' + c.numero + '-' + c.anio + '. Revisá el plazo y las fechas.');
  }

  function renderAlqList() {
    var q = normText($('#a-q').value).trim().split(/\s+/).filter(Boolean), box = $('#a-rows');
    var items = alq.items.filter(function (c) {
      var p = (c.datos && c.datos.paciente) || {};
      var hay = normText([c.numero + '-' + c.anio, c.numero, c.paciente, c.dni, c.equipo, p.tel, p.dir, p.ciudad].join(' ') + ' ' + ((c.datos && c.datos.equipos) || []).map(function (e) { return e.serie; }).join(' '));
      return q.every(function (t) { return hay.indexOf(t) !== -1; });
    });
    $('#a-meta').textContent = alq.loaded ? (alq.items.length ? alq.items.length + (alq.items.length === 1 ? ' contrato generado' : ' contratos generados') : 'Todavía no se generó ningún contrato.') : 'Cargando…';
    if (!items.length) { box.replaceChildren(alq.items.length ? h('div', { class: 'empty', text: 'Ningún contrato coincide con la búsqueda.' }) : ''); return; }
    box.replaceChildren.apply(box, items.map(function (c) {
      var dd = c.datos || {}, p = dd.paciente || {};
      var fin = sumarMeses(c.inicio, Number(dd.meses));
      var armed = false, armT;
      var del = h('button', { type: 'button', class: 'btn sm danger', text: 'Eliminar' });
      del.addEventListener('click', function () {
        if (!armed) { armed = true; del.textContent = 'Tocá de nuevo para eliminar'; armT = setTimeout(function () { armed = false; del.textContent = 'Eliminar'; }, 4000); return; }
        clearTimeout(armT);
        api('DELETE', '/api/alquileres/' + c.id).then(function () { toast('Contrato eliminado.'); return loadAlq(); })
          .catch(function (er) { toast(errMessage(er), 'err'); });
      });
      return h('details', { class: 'row' },
        h('summary', null,
          h('div', { class: 'r-top' }, h('span', { class: 'serie mono', text: 'N.º ' + c.numero + '-' + c.anio }),
            dd.iapos ? h('span', { class: 'pill', text: 'IAPOS' }) : null, h('span', { class: 'pill ok', text: dd.meses ? dd.meses + (Number(dd.meses) === 1 ? ' mes' : ' meses') : '' })),
          h('div', { class: 'r-eq', text: c.paciente || 'Sin nombre' }),
          h('div', { class: 'r-cl', text: c.equipo || '' }),
          h('div', { class: 'r-cl', text: [c.inicio ? 'Desde ' + fmtIso(c.inicio) : '', fin ? 'hasta ' + fmtIso(fin) : ''].filter(Boolean).join(' ') })),
        h('div', { class: 'r-body' },
          kv([['DNI', fmtDoc(p.dni)], ['Teléfono', p.tel], ['Dirección', [p.dir, p.ciudad].filter(Boolean).join(', ')], ['Equipo', c.equipo],
            ['Firma', fmtIso(dd.firma)], ['Generado', fmtDate(c.creado)]]),
          h('div', { class: 'ctrl' },
            h('a', { class: 'btn sm primary', href: '/api/alquileres/' + c.id + '/docx', download: '', text: 'Descargar Word' }),
            h('button', { type: 'button', class: 'btn sm', text: 'Usar como base (renovar)', onclick: function () { alqUsarComoBase(c); } }),
            del)));
    }));
  }

  function loadAlq() {
    return api('GET', '/api/alquileres').then(function (r) {
      alq.items = r.items || []; alq.siguiente = r.siguiente; alq.anio = r.anio; alq.loaded = true;
      if (!numeroEdit) $('#a-numero').value = String(alq.siguiente);
      if (!$('#a-anio').value) $('#a-anio').value = alq.anio;
      renderAlqList();
    }).catch(function () { $('#a-meta').textContent = 'No se pudo cargar la lista de contratos.'; });
  }

  function bindAlq() {
    $('#a-inicio').value = hoyIso(); $('#a-firma').value = hoyIso(); updateFin();
    renderAlqEquipos();
    $('#a-add-eq').addEventListener('click', function () { alqEq.push({ tipo: '', marca: '', modelo: '', serie: '' }); renderAlqEquipos(); });
    $('#a-frase').addEventListener('input', function (e) { fraseEdit = e.target.value.trim() !== ''; if (!fraseEdit) updateAuto(); });
    $('#a-datos').addEventListener('input', function (e) { datosEdit = e.target.value.trim() !== ''; if (!datosEdit) updateAuto(); });
    $('#a-numero').addEventListener('input', function () { numeroEdit = true; });
    ['#a-inicio', '#a-meses'].forEach(function (id) { $(id).addEventListener('input', updateFin); });
    $('#a-inicio').addEventListener('change', function () { if ($('#a-firma').dataset.tocada !== '1') $('#a-firma').value = $('#a-inicio').value; });
    $('#a-firma').addEventListener('change', function () { $('#a-firma').dataset.tocada = '1'; });
    // IAPOS: el modelo es por 6 meses; al destildar vuelve a los 12 de siempre (solo si el plazo no se tocó a mano)
    $('#a-iapos').addEventListener('change', function () {
      var m = $('#a-meses'), esta = $('#a-iapos').checked;
      if (esta && m.value.trim() === '12') m.value = '6'; else if (!esta && m.value.trim() === '6') m.value = '12';
      updateFin();
    });
    ['#a-dni', '#a-nombre'].forEach(function (id) { $(id).addEventListener('input', function () { clearTimeout(prevT); prevT = setTimeout(alqPrevio, 300); }); });
    $('#a-generar').addEventListener('click', generarAlq);
    $('#a-q').addEventListener('input', renderAlqList);
  }

  /* ---------- Cargar un listado de OT nuevo ---------- */
  function bindImportOt() {
    var f = $('#o-file'), b = $('#o-subir'), st = $('#o-imp-st'), det = $('#o-imp-det');
    f.addEventListener('change', function () { b.disabled = !f.files.length; st.textContent = ''; det.textContent = ''; });
    b.addEventListener('click', function () {
      var file = f.files[0]; if (!file) return;
      b.disabled = true; st.dataset.tone = 'busy'; st.textContent = 'Cargando…'; det.textContent = '';
      fetch('/api/ordenes/importar?nombre=' + encodeURIComponent(file.name), { method: 'POST', body: file })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) {
            var m = { listado_invalido: 'No pude leer ese archivo: tiene que ser el listado de reparaciones del sistema (.csv o .xls).', sin_filas: 'El archivo no tiene órdenes.', vacio: 'El archivo está vacío.', muy_grande: 'El archivo es demasiado grande.' };
            st.dataset.tone = 'err'; st.textContent = m[x.d.error] || 'No se pudo cargar el listado.'; b.disabled = false; return;
          }
          var d = x.d;
          st.dataset.tone = 'ok';
          st.textContent = 'Listo: ' + d.filas + ' órdenes leídas · ' + d.nuevas + ' nuevas · ' + d.cambiaron + ' con estado cambiado. La base tiene ' + d.total + ' órdenes.';
          det.className = 'imp-det';
          (d.cambios || []).forEach(function (c) { det.append(h('div', { text: 'OT ' + c.ot + ': ' + c.antes + ' → ' + c.ahora })); });
          f.value = '';
          buscarOt();
          refresh();
        })
        .catch(function () { st.dataset.tone = 'err'; st.textContent = 'No se pudo conectar con el servidor.'; b.disabled = false; });
    });
  }

  /* ---------- Modo claro / oscuro ---------- */
  function temaOscuro() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function pintarTema() {
    var osc = temaOscuro(), b = $('#tema');
    b.setAttribute('aria-label', osc ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', osc ? '#172236' : '#F2F4F2');
  }
  function bindTema() {
    pintarTema();
    $('#tema').addEventListener('click', function () {
      var osc = !temaOscuro();
      document.documentElement.setAttribute('data-theme', osc ? 'dark' : 'light');
      try { localStorage.setItem('recepcion_tema', osc ? 'oscuro' : 'claro'); } catch (e) { /* sin almacenamiento */ }
      pintarTema();
    });
  }

  /* ---------- Pestañas ---------- */
  function setTab(name) {
    var isNew = name === 'new', isOt = name === 'ot', isAlq = name === 'alq', isPrev = name === 'prev';
    $('#view-prev').hidden = !isPrev; $('#tab-prev').setAttribute('aria-selected', String(isPrev));
    $('#view-new').hidden = !isNew; $('#view-list').hidden = name !== 'list'; $('#view-ot').hidden = !isOt; $('#view-alq').hidden = !isAlq;
    $('#tab-new').setAttribute('aria-selected', String(isNew)); $('#tab-list').setAttribute('aria-selected', String(name === 'list'));
    $('#tab-ot').setAttribute('aria-selected', String(isOt)); $('#tab-alq').setAttribute('aria-selected', String(isAlq));
    document.body.classList.toggle('ot', isOt);
    document.body.classList.toggle('alq', isAlq);
    $('#savebar').hidden = !isNew;
    if (name === 'list') renderList();
    if (isOt) buscarOt();
    if (isAlq) loadAlq();
    if (isPrev) { if ($('#pv-reg').hidden) pvVista($('#pv-rec').hidden ? 'prox' : 'rec'); loadPrev(); }
    window.scrollTo(0, 0);
  }


  /* ---------- Preventivos ---------- */
  var pvEdTareas, pvEdUnicos, pvEdProx;
  var pv = { items: [], regItems: [], regTareas: null, filtro: 'all', q: '', editId: null, reg: null, regHist: null, fotos: [], hist: {}, abiertos: new Set(), preparando: 0, otTok: 0, otT: 0 };
  function diasHasta(iso) { return Math.round((Date.parse(iso + 'T00:00:00') - Date.parse(hoyIso() + 'T00:00:00')) / 864e5); }
  function sumarMeses(iso, n) {
    var p = iso.split('-').map(Number), m = p[1] - 1 + n, a = p[0] + Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var ult = new Date(a, m + 1, 0).getDate();
    return a + '-' + pad2(m + 1) + '-' + pad2(Math.min(p[2], ult));
  }
  function pvEquipo(x) { return [x.tipo, x.marca, x.modelo].filter(Boolean).join(' ') || 'Equipo sin descripción'; }
  function pvFrec(n) { return n === 1 ? 'Cada mes' : n === 12 ? 'Cada año' : n === 24 ? 'Cada 2 años' : 'Cada ' + n + ' meses'; }
  function pvPill(iso) {
    var d = diasHasta(iso);
    if (d < 0) return h('span', { class: 'pill bad', text: 'Vencido hace ' + (-d) + (d === -1 ? ' día' : ' días') });
    if (d === 0) return h('span', { class: 'pill warn', text: 'Hoy' });
    return h('span', { class: 'pill ' + (d <= 7 ? 'warn' : d <= 30 ? 'neutro' : 'ok'), text: 'En ' + d + (d === 1 ? ' día' : ' días') });
  }
  // lista de items que se van agregando de a uno
  function itemsEditor(box, placeholder) {
    var lista = [], ul = h('div', { class: 'items' }), inp = h('input', { autocomplete: 'off', placeholder: placeholder, 'aria-label': placeholder });
    function add() { var t = inp.value.replace(/\s+/g, ' ').trim(); if (!t) return; if (lista.indexOf(t) < 0) lista.push(t); inp.value = ''; render(); if (ed.alCambiar) ed.alCambiar(); }
    var btn = h('button', { type: 'button', class: 'btn sm', text: 'Agregar', onclick: add });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    function render() {
      ul.replaceChildren.apply(ul, lista.map(function (t, i) {
        return h('div', { class: 'it' }, h('span', { text: t }), h('button', { type: 'button', 'aria-label': 'Quitar ' + t, text: '×', onclick: function () { lista.splice(i, 1); render(); if (ed.alCambiar) ed.alCambiar(); } }));
      }));
    }
    var ed = { get: function () { var t = inp.value.replace(/\s+/g, ' ').trim(); return t && lista.indexOf(t) < 0 ? lista.concat([t]) : lista.slice(); },
               set: function (l) { lista = (l || []).slice(); inp.value = ''; render(); } };
    box.replaceChildren(ul, h('div', { class: 'addrow' }, inp, btn));
    return ed;
  }
  function pvCuenta() {
    var n = pv.items.filter(function (x) { return diasHasta(x.proximo) <= 7; }).length, b = $('#prev-count');
    b.hidden = !n; b.textContent = String(n);
  }
  function loadPrev() {
    return api('GET', '/api/preventivos').then(function (r) {
      pv.items = r.items || []; pvCuenta(); renderPrev(); renderPlanes();
    }).catch(function () { $('#pv-meta').textContent = 'No se pudo cargar la lista.'; });
  }
  function pvFiltrados() {
    var q = normText(pv.q).split(/\s+/).filter(Boolean);
    return pv.items.filter(function (x) {
      var d = diasHasta(x.proximo);
      if (pv.filtro === 'venc' && d >= 0) return false;
      if (pv.filtro === '30' && d > 30) return false;
      if (pv.filtro === '90' && d > 90) return false;
      var t = normText([x.cliente, x.tipo, x.marca, x.modelo, x.serie].join(' '));
      return q.every(function (w) { return t.indexOf(w) >= 0; });
    });
  }
  function pvLinea(x) {
    return [h('div', { class: 'r-top' }, h('div', { class: 'r-eq', text: pvEquipo(x) }), pvPill(x.proximo)),
      x.serie ? h('div', { class: 'serie', text: x.serie }) : null,
      h('div', { class: 'r-cl', text: x.cliente }),
      h('div', { class: 'r-cl', text: 'Próximo: ' + fmtIso(x.proximo) + ' · ' + pvFrec(x.cadaMeses) + (x.ultima ? ' · Último: ' + fmtIso(x.ultima) + (x.ultimaOt ? ' (OT ' + x.ultimaOt + ')' : ' (sin OT cargada)') : ' · Todavía sin mantenimientos registrados') })];
  }
  function renderPrev() {
    var lista = pvFiltrados(), box = $('#pv-rows');
    $('#pv-meta').textContent = lista.length + (lista.length === 1 ? ' mantenimiento' : ' mantenimientos');
    if (!lista.length) { box.replaceChildren(h('p', { class: 'hint', text: pv.items.length ? 'No hay mantenimientos con ese filtro.' : 'Todavía no hay mantenimientos cargados. Agregalos en "Mantenimientos recurrentes".' })); return; }
    box.replaceChildren.apply(box, lista.map(function (x) {
      var d = diasHasta(x.proximo);
      var row = h('div', { class: 'pv-row' + (d < 0 ? ' vencido' : d <= 7 ? ' pronto' : '') });
      pvLinea(x).forEach(function (n) { if (n) row.append(n); });
      if (x.tareas.length) row.append(h('div', { class: 'r-cl', text: 'Items: ' + x.tareas.join(' · ') }));
      if (x.pendientes.length) row.append(h('div', { class: 'pv-pend' }, h('strong', { text: 'Solo para este mantenimiento: ' }), x.pendientes.join(' · ')));
      row.append(h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn primary sm', text: 'Registrar mantenimiento', onclick: function () { abrirReg(x, null); } }),
        h('button', { type: 'button', class: 'btn sm', text: x.cantidad ? 'Historial (' + x.cantidad + ')' : 'Historial', onclick: function () { toggleHist(x.id); } })));
      if (pv.abiertos.has(x.id)) row.append(histBox(x));
      return row;
    }));
  }
  function renderPlanes() {
    var box = $('#pv-plans');
    if (!pv.items.length) { box.replaceChildren(); return; }
    box.replaceChildren.apply(box, [h('h2', { class: 'lbl', text: 'Cargados (' + pv.items.length + ')' })].concat(pv.items.map(function (x) {
      var row = h('div', { class: 'pv-row' });
      row.append(h('div', { class: 'r-eq', text: pvEquipo(x) }));
      if (x.serie) row.append(h('div', { class: 'serie', text: x.serie }));
      row.append(h('div', { class: 'r-cl', text: x.cliente + ' · ' + pvFrec(x.cadaMeses) + ' · próximo ' + fmtIso(x.proximo) }));
      row.append(h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn sm', text: 'Editar', onclick: function () { editarPlan(x); } }),
        h('button', { type: 'button', class: 'btn sm danger', text: 'Eliminar', onclick: function () {
          if (!window.confirm('¿Eliminar este mantenimiento recurrente y todo su historial (incluidas las fotos)?')) return;
          api('DELETE', '/api/preventivos/' + x.id).then(function () { toast('Mantenimiento eliminado.'); loadPrev(); }).catch(function () { toast('No se pudo eliminar.', 'err'); });
        } })));
      return row;
    })));
  }
  function toggleHist(id) {
    if (pv.abiertos.has(id)) { pv.abiertos.delete(id); renderPrev(); return; }
    pv.abiertos.add(id);
    api('GET', '/api/preventivos/' + id + '/historial').then(function (r) { pv.hist[id] = r.items || []; renderPrev(); }).catch(function () { pv.abiertos.delete(id); renderPrev(); });
    renderPrev();
  }
  function histBox(x) {
    var l = pv.hist[x.id], box = h('div', { class: 'pv-hist' });
    if (!l) { box.append(h('p', { class: 'hint', text: 'Cargando…' })); return box; }
    if (!l.length) { box.append(h('p', { class: 'hint', text: 'Todavía no se registró ningún mantenimiento.' })); return box; }
    l.forEach(function (e) {
      var c = h('div', { class: 'pv-h' },
        h('div', { class: 'r-top' }, h('strong', { text: fmtIso(e.fecha) + (e.tecnico ? ' · ' + e.tecnico : '') }),
          h('span', { class: 'pill ' + (e.ot ? 'ok' : 'warn'), text: e.ot ? 'OT ' + e.ot : 'Sin OT en Flexxus' })));
      if (e.items.length) c.append(h('ul', null, e.items.map(function (i) {
        return h('li', null, (i.ok ? '✓ ' : '✗ ') + i.t + ' ', i.unico ? h('span', { class: 'uni', text: 'solo esa vez' }) : null);
      })));
      if (e.trabajo) c.append(h('div', { class: 't', text: e.trabajo }));
      if (e.proximos.length) c.append(h('div', { class: 't' }, h('strong', { text: 'Para el siguiente: ' }), e.proximos.join(' · ')));
      if (e.notasInt) c.append(h('div', { class: 'int' }, h('strong', { text: 'Nota interna: ' }), e.notasInt));
      if (e.fotos.length) c.append(h('div', { class: 'thumbs' }, e.fotos.map(function (f) {
        return h('a', { class: 'thumb', href: '/fotos/' + f, target: '_blank', rel: 'noopener' }, h('img', { src: '/fotos/' + f, alt: 'Foto del mantenimiento' }));
      })));
      c.append(h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn sm', text: 'Editar', onclick: function () { abrirReg(x, e); } }),
        h('button', { type: 'button', class: 'btn sm danger', text: 'Borrar', onclick: function () {
          if (!window.confirm('¿Borrar este mantenimiento del historial?')) return;
          api('DELETE', '/api/preventivos/hist/' + e.id).then(function () { toast('Mantenimiento borrado.'); delete pv.hist[x.id]; pv.abiertos.delete(x.id); loadPrev(); }).catch(function () { toast('No se pudo borrar.', 'err'); });
        } })));
      box.append(c);
    });
    return box;
  }

  /* --- alta / edición del mantenimiento recurrente --- */
  function pvCadaMeses() { var c = $('#pv-cada').value; return Number(c) === 0 ? Number($('#pv-cada-otro').value) : Number(c); }
  function pvLimpiarForm() {
    ['#pv-serie', '#pv-tipo', '#pv-marca', '#pv-modelo', '#pv-cliente', '#pv-notas', '#pv-cada-otro'].forEach(function (i) { $(i).value = ''; });
    $('#pv-cada').value = '6'; $('#pv-cada-otro-f').hidden = true; $('#pv-prox-f').value = hoyIso();
    pvEdTareas.set([]); pvEdUnicos.set([]);
    pv.editId = null; $('#h-pv-form').textContent = 'Nuevo mantenimiento recurrente'; $('#pv-guardar').textContent = 'Agregar'; $('#pv-cancelar').hidden = true; $('#pv-err').hidden = true;
  }
  function editarPlan(x) {
    pvLimpiarForm(); pv.editId = x.id;
    $('#pv-serie').value = x.serie; $('#pv-tipo').value = x.tipo; $('#pv-marca').value = x.marca; $('#pv-modelo').value = x.modelo; $('#pv-cliente').value = x.cliente;
    pvEdTareas.set(x.tareas); pvEdUnicos.set(x.pendientes); $('#pv-notas').value = x.notas; $('#pv-prox-f').value = x.proximo;
    var est = [1, 2, 3, 4, 6, 12, 24].indexOf(x.cadaMeses) >= 0;
    $('#pv-cada').value = est ? String(x.cadaMeses) : '0'; $('#pv-cada-otro-f').hidden = est; if (!est) $('#pv-cada-otro').value = x.cadaMeses;
    $('#h-pv-form').textContent = 'Editar mantenimiento recurrente'; $('#pv-guardar').textContent = 'Guardar cambios'; $('#pv-cancelar').hidden = false;
    window.scrollTo(0, 0);
  }
  var pvSerieT;
  function pvBuscarEquipo() {
    clearTimeout(pvSerieT);
    pvSerieT = setTimeout(function () {
      var sn = normSerie($('#pv-serie').value);
      if (sn.length < 4) return;
      api('GET', '/api/equipos?serie=' + encodeURIComponent(sn)).then(function (r) {
        var e = ((r && r.items) || []).filter(function (i) { return i.exacto; })[0];
        if (!e) return;
        [['#pv-tipo', e.tipo], ['#pv-marca', e.marca], ['#pv-modelo', e.modelo], ['#pv-cliente', e.clienteNombre || (e.cliente && e.cliente.nombre)]].forEach(function (p) { if (!$(p[0]).value.trim() && p[1]) $(p[0]).value = p[1]; });
      }).catch(function () { /* se completa a mano */ });
    }, 400);
  }
  var pvBuscarT;
  function pvElegir(e) {
    [['#pv-serie', e.serie], ['#pv-tipo', e.tipo], ['#pv-marca', e.marca], ['#pv-modelo', e.modelo], ['#pv-cliente', e.clienteNombre || (e.cliente && e.cliente.nombre) || '']].forEach(function (p) { $(p[0]).value = p[1] || ''; });
    $('#pv-buscar').value = ''; $('#pv-sug').hidden = true;
  }
  function pvBuscar() {
    clearTimeout(pvBuscarT);
    var q = $('#pv-buscar').value.trim(), box = $('#pv-sug');
    if (q.length < 3) { box.hidden = true; return; }
    pvBuscarT = setTimeout(function () {
      api('GET', '/api/equipos?q=' + encodeURIComponent(q)).then(function (r) {
        if ($('#pv-buscar').value.trim() !== q) return;
        var l = (r && r.items) || [];
        box.replaceChildren.apply(box, l.length ? l.map(function (e) {
          return h('button', { type: 'button', onclick: function () { pvElegir(e); } },
            h('strong', { text: [e.tipo, e.marca, e.modelo].filter(Boolean).join(' ') || e.descripcion || 'Equipo' }),
            h('span', { class: 'sub', text: [e.serie, e.clienteNombre || (e.cliente && e.cliente.nombre)].filter(Boolean).join(' · ') }));
        }) : [h('p', { class: 'hint', text: 'No hay equipos con eso en la base. Completá los datos a mano.' })]);
        box.hidden = false;
      }).catch(function () { box.hidden = true; });
    }, 300);
  }
  function pvErrorGuardar(e) {
    if (e && e.status === 404) return 'El servidor todavía no tiene esta función: reemplazá servidor.py por el nuevo y reiniciá el servidor.';
    var m = { falta_cliente: 'Falta el cliente.', falta_equipo: 'Falta el equipo (tipo, marca, modelo o serie).', frecuencia: 'La frecuencia tiene que ser entre 1 y 120 meses.', fecha: 'Hay una fecha que no es válida.' };
    return m[e && e.code] || ('No se pudo guardar (' + ((e && e.code) || 'sin conexión') + '). Probá de nuevo.');
  }
  function guardarPlan() {
    var err = $('#pv-err'); err.hidden = true;
    var data = { cliente: $('#pv-cliente').value.trim(), tipo: $('#pv-tipo').value.trim(), marca: $('#pv-marca').value.trim(), modelo: $('#pv-modelo').value.trim(),
      serie: $('#pv-serie').value.trim(), cadaMeses: pvCadaMeses(), proximo: $('#pv-prox-f').value, tareas: pvEdTareas.get(), pendientes: pvEdUnicos.get(), notas: $('#pv-notas').value.trim() };
    var m = null;
    if (!data.cliente) m = 'Falta el cliente.'; else if (!(data.tipo || data.marca || data.modelo || data.serie)) m = 'Falta el equipo (tipo, marca, modelo o serie).';
    else if (!(data.cadaMeses >= 1 && data.cadaMeses <= 120)) m = 'La frecuencia tiene que ser entre 1 y 120 meses.'; else if (!data.proximo) m = 'Falta la fecha del próximo mantenimiento.';
    if (m) { err.textContent = m; err.hidden = false; return; }
    var edit = pv.editId;
    (edit ? api('PUT', '/api/preventivos/' + edit, data) : api('POST', '/api/preventivos', data)).then(function () {
      toast(edit ? 'Cambios guardados.' : 'Mantenimiento recurrente agregado.'); pvLimpiarForm(); return loadPrev();
    }).catch(function (e) { err.textContent = pvErrorGuardar(e); err.hidden = false; });
  }

  /* --- registrar un mantenimiento hecho --- */
  function pvVista(cual) {
    var reg = cual === 'reg';
    $('#pv-seg').hidden = reg; $('#pv-prox').hidden = reg || cual !== 'prox'; $('#pv-rec').hidden = reg || cual !== 'rec'; $('#pv-reg').hidden = !reg;
    $('#pv-t-prox').setAttribute('aria-pressed', String(cual === 'prox')); $('#pv-t-rec').setAttribute('aria-pressed', String(cual === 'rec'));
    window.scrollTo(0, 0);
  }
  function pvRenderFotos() {
    var box = $('#pvr-thumbs'), n = pv.fotos.length;
    box.hidden = !n;
    box.replaceChildren.apply(box, pv.fotos.map(function (p, i) {
      return h('div', { class: 'thumb' }, h('img', { src: p.url, alt: 'Foto ' + (i + 1) }),
        h('button', { type: 'button', 'aria-label': 'Quitar la foto ' + (i + 1), text: '×', onclick: function () { pv.fotos.splice(pv.fotos.indexOf(p), 1); if (p.blob) URL.revokeObjectURL(p.url); pvRenderFotos(); } }));
    }));
    $('#pvr-cam').disabled = $('#pvr-gal').disabled = n >= 8;
  }
  function pvTomarFoto(file) {
    if (pv.fotos.length + pv.preparando >= 8) { toast('Ya hay 8 fotos.'); return Promise.resolve(); }
    pv.preparando++;
    return prepareImage(file).then(function (blob) { pv.preparando--; pv.fotos.push({ blob: blob, url: URL.createObjectURL(blob), id: null }); pvRenderFotos(); })
      .catch(function () { pv.preparando = Math.max(0, pv.preparando - 1); });
  }
  function pvRenderTecnicos(sel) {
    var s = $('#pvr-tecnico'), lista = TECNICOS.slice();
    if (sel && lista.indexOf(sel) < 0) lista.push(sel);
    s.replaceChildren.apply(s, [h('option', { value: '', text: 'Elegir' })].concat(lista.map(function (t) { return h('option', { value: t, text: t }); })));
    s.value = sel || '';
  }
  function pvPasan() {
    // los items "solo esta vez" que no se hicieron pasan al siguiente mantenimiento
    return pv.regItems.filter(function (x) { return x.unico && !x.ok; }).map(function (x) { return x.t; });
  }
  function pvRenderChecks() {
    var box = $('#pvr-checks');
    if (!pv.regItems.length) { box.replaceChildren(h('p', { class: 'hint', text: 'Este equipo todavía no tiene items. Agregalos abajo y quedan para todos los mantenimientos.' })); }
    else box.replaceChildren.apply(box, pv.regItems.map(function (x) {
      var c = h('input', { type: 'checkbox' }); c.checked = x.ok;
      var l = h('label', { class: 'ck' + (x.ok ? ' hecho' : '') }, c, h('span', { text: x.t }), x.unico ? h('small', { text: 'solo esta vez' }) : null);
      c.addEventListener('change', function () { x.ok = c.checked; l.classList.toggle('hecho', x.ok); pvRenderPasan(); });
      return l;
    }));
    pvRenderPasan();
  }
  function pvRenderPasan() {
    var p = pvPasan().filter(function (t) { return pvEdProx.get().indexOf(t) < 0; }), b = $('#pvr-pasan');
    b.hidden = !p.length || !!pv.regHist;
    b.textContent = p.length ? 'Pasan al siguiente por no estar hechos: ' + p.join(' · ') : '';
  }
  function pvAgregarCheck() {
    var i = $('#pvr-add'), t = i.value.replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (!pv.regItems.some(function (x) { return x.t === t && !x.unico; })) { pv.regItems.splice(pv.regItems.filter(function (x) { return !x.unico; }).length, 0, { t: t, ok: false, unico: false }); pv.regTareas.push(t); }
    i.value = ''; pvRenderChecks();
  }
  function abrirReg(plan, hist) {
    pv.reg = plan; pv.regHist = hist;
    pv.fotos.forEach(function (p) { if (p.blob) URL.revokeObjectURL(p.url); });
    pv.fotos = hist ? hist.fotos.map(function (id) { return { blob: null, url: '/fotos/' + id, id: id }; }) : [];
    pvRenderFotos();
    $('#h-pv-reg').textContent = hist ? 'Editar mantenimiento' : 'Registrar mantenimiento';
    $('#pvr-info').replaceChildren(h('strong', { text: pvEquipo(plan) + (plan.serie ? ' · ' + plan.serie : '') }), h('div', { text: plan.cliente + ' · ' + pvFrec(plan.cadaMeses) }));
    if (hist) { pv.regItems = hist.items.map(function (x) { return { t: x.t, ok: x.ok, unico: x.unico }; }); pv.regTareas = null; }
    else {
      pv.regTareas = plan.tareas.slice();
      pv.regItems = plan.tareas.map(function (t) { return { t: t, ok: false, unico: false }; }).concat(plan.pendientes.map(function (t) { return { t: t, ok: false, unico: true }; }));
    }
    $('#pvr-add-row').hidden = !!hist;
    pvEdProx.set(hist ? hist.proximos : []);
    $('#pvr-notas').value = hist ? hist.notasInt : '';
    pvRenderChecks();
    $('#pvr-fecha').value = hist ? hist.fecha : hoyIso();
    pvRenderTecnicos(hist ? hist.tecnico : savedTecnico());
    otSet($('#pvr-ot'), hist ? hist.ot : '');
    $('#pvr-trabajo').value = hist ? hist.trabajo : '';
    $('#pvr-prox').value = hist ? plan.proximo : sumarMeses($('#pvr-fecha').value, plan.cadaMeses);
    pv.proxTocado = !!hist;
    $('#pvr-err').hidden = true; $('#pvr-audio-st').textContent = ''; $('#pvr-otinfo').hidden = true;
    pvVista('reg'); pvOtInfo();
  }
  function pvOtInfo() {
    var box = $('#pvr-otinfo'), ot = otGet($('#pvr-ot'));
    if (ot.length < 9) { box.hidden = true; return; }
    var tok = ++pv.otTok;
    clearTimeout(pv.otT);
    pv.otT = setTimeout(function () {
      api('GET', '/api/ordenes?ot=' + encodeURIComponent(ot)).then(function (r) {
        if (tok !== pv.otTok) return;
        var ex = ((r && r.items) || []).filter(function (o) { return o.origen === 'flexxus' && o.ot === ot; })[0];
        box.className = ex ? 'note wide' : 'note warn wide';
        box.replaceChildren(ex ? h('span', null, h('strong', { text: 'OT ' + ot + ' en Flexxus: ' }), (ex.cliente || 'sin cliente') + ' · ' + (ex.descripcion || ex.tipo || '') + (ex.estado ? ' · ' + ex.estado : ''))
          : h('span', { text: 'Esa OT no está en el listado de Flexxus cargado (puede estar desactualizado). Igual se guarda.' }));
        box.hidden = false;
      }).catch(function () { box.hidden = true; });
    }, 350);
  }
  function guardarReg() {
    var err = $('#pvr-err'); err.hidden = true;
    if (!$('#pvr-fecha').value) { err.textContent = 'Falta la fecha del mantenimiento.'; err.hidden = false; return; }
    if (pv.preparando) { err.textContent = 'Esperá a que termine de prepararse la foto.'; err.hidden = false; return; }
    var btn = $('#pvr-guardar'); btn.disabled = true;
    var ids = [];
    pv.fotos.reduce(function (c, p) {
      return c.then(function () {
        if (p.id) { ids.push(p.id); return; }
        return api('POST', '/api/fotos', p.blob).then(function (r) { p.id = r.id; ids.push(r.id); });
      });
    }, Promise.resolve()).then(function () {
      var data = { fecha: $('#pvr-fecha').value, ot: otGet($('#pvr-ot')), tecnico: $('#pvr-tecnico').value, trabajo: $('#pvr-trabajo').value.trim(),
        items: pv.regItems, tareas: pv.regTareas, proximos: pv.regHist ? pvEdProx.get() : pvEdProx.get().concat(pvPasan().filter(function (t) { return pvEdProx.get().indexOf(t) < 0; })),
        notasInt: $('#pvr-notas').value.trim(), fotos: ids, proximo: $('#pvr-prox').value };
      if (data.tecnico) { try { localStorage.setItem('recepcion_tecnico', data.tecnico); } catch (e) { /* sin almacenamiento */ } }
      var h0 = pv.regHist;
      return h0 ? api('PUT', '/api/preventivos/hist/' + h0.id, data) : api('POST', '/api/preventivos/' + pv.reg.id + '/realizar', data);
    }).then(function () {
      toast(pv.regHist ? 'Cambios guardados.' : 'Mantenimiento registrado. Próximo: ' + fmtIso($('#pvr-prox').value) + '.');
      delete pv.hist[pv.reg.id]; pv.abiertos.delete(pv.reg.id); pv.fotos = []; btn.disabled = false;
      pvVista('prox'); return loadPrev();
    }).catch(function (e) { btn.disabled = false; err.textContent = pvErrorGuardar(e); err.hidden = false; });
  }

  function bindPrev() {
    pvEdTareas = itemsEditor($('#pv-tareas-box'), 'Agregar item (se repite en cada mantenimiento)');
    pvEdUnicos = itemsEditor($('#pv-unicos-box'), 'Agregar item solo para el próximo');
    pvEdProx = itemsEditor($('#pvr-prox-box'), 'Agregar item solo para el próximo'); pvEdProx.alCambiar = pvRenderPasan;
    $('#pvr-add-btn').addEventListener('click', pvAgregarCheck);
    $('#pvr-add').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pvAgregarCheck(); } });
    $('#pv-t-prox').addEventListener('click', function () { pvVista('prox'); });
    $('#pv-t-rec').addEventListener('click', function () { pvVista('rec'); });
    $('#pv-q').addEventListener('input', function () { pv.q = this.value; renderPrev(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-pvf]'), function (b) {
      b.addEventListener('click', function () {
        pv.filtro = b.dataset.pvf;
        Array.prototype.forEach.call(document.querySelectorAll('[data-pvf]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        renderPrev();
      });
    });
    $('#pv-cada').addEventListener('change', function () { $('#pv-cada-otro-f').hidden = Number(this.value) !== 0; });
    $('#pv-serie').addEventListener('input', pvBuscarEquipo);
    $('#pv-buscar').addEventListener('input', pvBuscar);
    $('#pv-guardar').addEventListener('click', guardarPlan);
    $('#pv-cancelar').addEventListener('click', pvLimpiarForm);
    $('#pv-prox-f').value = hoyIso();
    // registro
    otBind($('#pvr-ot'), pvOtInfo);
    $('#pvr-prox').addEventListener('input', function () { pv.proxTocado = true; });
    $('#pvr-fecha').addEventListener('change', function () { if (!pv.proxTocado && pv.reg && $('#pvr-fecha').value) $('#pvr-prox').value = sumarMeses($('#pvr-fecha').value, pv.reg.cadaMeses); });
    [['#pvr-cam', '#pvr-in-cam'], ['#pvr-gal', '#pvr-in-gal']].forEach(function (p) {
      $(p[0]).addEventListener('click', function () { $(p[1]).click(); });
      $(p[1]).addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files || []); this.value = '';
        files.reduce(function (c, f) { return c.then(function () { return pvTomarFoto(f); }); }, Promise.resolve());
      });
    });
    bindAudio({ btn: 'pvr-audio', lbl: 'pvr-audio-lbl', st: 'pvr-audio-st', inp: 'pvr-in-audio', txt: 'pvr-trabajo' });
    $('#pvr-guardar').addEventListener('click', guardarReg);
    $('#pvr-cancelar').addEventListener('click', function () { pvVista('prox'); });
  }

  /* ---------- Arranque ---------- */
  function bind() {
    $('#tab-new').addEventListener('click', function () { setTab('new'); });
    $('#tab-list').addEventListener('click', function () { setTab('list'); });
    $('#tab-ot').addEventListener('click', function () { setTab('ot'); });
    $('#tab-alq').addEventListener('click', function () { setTab('alq'); });
    $('#tab-prev').addEventListener('click', function () { setTab('prev'); });
    bindPrev();
    bindOt();
    bindAlq();
    bindImportOt();
    bindTema();
    try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () { /* sin HTTPS no se registra: la app funciona igual */ }); } catch (e) { /* nada */ }
    $('#save').addEventListener('click', save);
    $('#export').addEventListener('click', exportCsv);
    $('#q').addEventListener('input', function (e) { query = e.target.value.trim(); renderList(); });
    $('#chip-all').addEventListener('click', function () { setMode('all'); renderList(); });
    $('#chip-pend').addEventListener('click', function () { setMode('pend'); renderList(); });
    $('#chip-flex').addEventListener('click', function () { setMode('flex'); renderList(); });

    Object.keys(FIELDS).forEach(function (k) {
      el(k).addEventListener('input', function () { el(k).closest('.field').classList.remove('auto'); refreshDerived(); });
    });
    el('nombre').addEventListener('input', function () { unlinkCliente(); suggest(); });
    el('doc').addEventListener('input', function () { unlinkCliente(); });
    document.addEventListener('click', function (ev) { if (!ev.target.closest('#sugg') && ev.target !== el('nombre')) $('#sugg').hidden = true; });
    el('serie').addEventListener('blur', function () { el('serie').value = el('serie').value.trim().toUpperCase(); });
    el('doc').addEventListener('blur', function () { var n = digits(el('doc').value); if (n.length === 11 || n.length === 7 || n.length === 8) el('doc').value = fmtDoc(n); docHint(); });
    el('por').addEventListener('input', function () { try { localStorage.setItem('recepcion_por', val('por')); } catch (e) { /* sin almacenamiento */ } });

    var cam = $('#in-cam'), gal = $('#in-gal');
    $('#btn-cam').addEventListener('click', function () { cam.click(); });
    $('#btn-gal').addEventListener('click', function () { gal.click(); });
    [cam, gal].forEach(function (inp) {
      inp.addEventListener('change', function () {
        var files = Array.prototype.slice.call(inp.files || []); inp.value = '';
        files.reduce(function (c, f) { return c.then(function () { return takePhoto(f); }); }, Promise.resolve());
      });
    });
    gal.multiple = true;
    var camR = $('#in-cam-rep'), galR = $('#in-gal-rep');
    $('#btn-cam-rep').addEventListener('click', function () { camR.click(); });
    $('#btn-gal-rep').addEventListener('click', function () { galR.click(); });
    [camR, galR].forEach(function (inp) {
      inp.addEventListener('change', function () {
        var files = Array.prototype.slice.call(inp.files || []); inp.value = '';
        files.reduce(function (c, f) { return c.then(function () { return takePhotoRep(f); }); }, Promise.resolve());
      });
    });
    galR.multiple = true;
    $('#btn-informe').addEventListener('click', generarInforme);
    el('tecnico').addEventListener('change', function () {
      if (val('tecnico') === '__nuevo') { agregarTecnico(); return; }
      guardarTecnicoSel();
    });
    otBind(el('ot'));
    $('#acces-add-btn').addEventListener('click', agregarAcc);
    $('#acces-add').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); agregarAcc(); } });
    bindAudio();
    cargarListas();
    $('#btn-reread').addEventListener('click', function () {
      var cand = fotosEq.filter(function (p) { return p.blob; });
      if (cand.length && ocrMode) runOcr(cand[cand.length - 1], false);
    });

    window.addEventListener('hashchange', openFromHash);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    setInterval(function () { if (!document.hidden) poll(); }, 5000);
  }

  function init() {
    bind();
    renderThumbs();
    renderAcces();
    setField('por', savedPor(), false);
    refreshDerived(); renderList();
    api('GET', '/api/catalogo').then(function (c) {
      [['dl-tipo', c.tipos], ['dl-marca', c.marcas]].forEach(function (p) {
        var dl = document.getElementById(p[0]), have = {};
        $$('option', dl).forEach(function (o) { have[normText(o.value)] = 1; });
        (p[1] || []).forEach(function (v) { if (!have[normText(v)]) { have[normText(v)] = 1; dl.append(h('option', { value: v })); } });
      });
    }).catch(function () { /* se usan las listas fijas */ });
    api('GET', '/api/estado').then(function (s) {
      var wasm = typeof WebAssembly === 'object' && !!window.Worker && !!window.createImageBitmap;
      localOk = !!(s && s.local && wasm);
      ocrMode = s && s.ocr ? 'api' : (localOk ? 'local' : null);
      arcaUrl = (s && s.arca) || '';
      provName = s && s.proveedor === 'gemini' ? 'Gemini' : (s && s.proveedor === 'claude' ? 'Claude' : '');
    }).catch(function () { /* se reintenta con el listado */ })
      .then(function () { return refresh(); })
      .catch(function () { setOnline(false); })
      .then(function () {
        initDone = true;
        loadPrev();
        openFromHash();
        if (!editing) { if (!val('repfecha')) setField('repfecha', hoyIso(), false); if (!val('tecnico')) renderTecnicos(savedTecnico()); }
        renderThumbs();
        refreshDerived(); renderList();
      });
  }

  init();
})();
