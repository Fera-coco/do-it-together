// Minimal service worker. Its only job is to be registered and active, which is one of
// Chrome/Android's requirements before it will fire "beforeinstallprompt" — without any
// service worker at all, the native install/"Download app" prompt never appears, no matter
// how good the manifest is. It doesn't cache anything or intercept requests.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // no-op: fall through to the network for every request
})
