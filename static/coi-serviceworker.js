/*! Cross-origin isolation via a service worker — for static hosts (GitHub Pages) that can't set
    COOP/COEP HTTP headers. WebLLM + Transformers.js need `crossOriginIsolated === true`
    (SharedArrayBuffer / threaded WASM); GitHub Pages serves files with no header control, so this
    worker re-serves every response with the headers, granting isolation client-side. COEP is
    `credentialless` to match the app (ADR-032/039) so cross-origin model shards (HuggingFace) load
    without a CORP header. Adapted from github.com/gzuidhof/coi-serviceworker (MIT). */

if (typeof window === 'undefined') {
  // ---- Service-worker context --------------------------------------------------------------------
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'deregister') {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((c) => c.navigate(c.url)));
    }
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.status === 0) return response; // opaque (no-cors) — pass through untouched
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
          });
        })
        .catch((e) => console.error('coi-serviceworker fetch error:', e))
    );
  });
} else {
  // ---- Page context: register the worker, then reload ONCE to gain isolation ----------------------
  (() => {
    if (window.crossOriginIsolated) return; // already isolated → nothing to do
    if (!window.isSecureContext) {
      console.warn('coi-serviceworker: not a secure context — cross-origin isolation unavailable.');
      return;
    }
    if (!('serviceWorker' in navigator)) return;

    const src = document.currentScript && document.currentScript.src;
    if (!src) return;

    navigator.serviceWorker.register(src).then(
      (registration) => {
        registration.addEventListener('updatefound', () => window.location.reload());
        // One-shot reload guard so an unsupported browser can't loop forever.
        const reloadedKey = 'coiReloaded';
        if (registration.active && !navigator.serviceWorker.controller) {
          if (!sessionStorage.getItem(reloadedKey)) {
            sessionStorage.setItem(reloadedKey, '1');
            window.location.reload();
          }
        }
      },
      (err) => console.error('coi-serviceworker failed to register:', err)
    );
  })();
}
