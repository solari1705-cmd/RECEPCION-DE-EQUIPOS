/* Service worker mínimo: la app necesita al servidor del taller, así que siempre se pide a la red.
   Si no hay conexión con el servidor, se muestra un aviso en vez de la pantalla de error del navegador. */
const AVISO = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión</title>' +
  '<body style="font-family:system-ui,sans-serif;background:#F2F4F2;color:#172236;padding:32px;max-width:520px;margin:auto">' +
  '<h1 style="font-size:22px">No hay conexión con el servidor</h1>' +
  '<p>Revisá que el celular esté en el WiFi del taller y que la PC del servidor esté encendida con la ventana negra abierta.</p>' +
  '<p><button onclick="location.reload()" style="font-size:16px;padding:12px 20px;border-radius:10px;border:0;background:#79E290;color:#172236;font-weight:600">Reintentar</button></p>';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response(AVISO, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
