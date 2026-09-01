// Two jobs: (1) exist and be active, which Chrome/Android requires before it will ever fire
// "beforeinstallprompt" — no service worker, no native install prompt, regardless of how good
// the manifest is; (2) make the app hold up better on a slow or flaky connection.
//
// Caching strategy, deliberately conservative:
//  - /_next/static/** file names are content-hashed by the build — the same URL never points to
//    different content, so it's safe to cache those forever and serve them straight from cache.
//    That's the biggest win on a slow connection: repeat visits skip re-downloading the JS/CSS
//    bundle entirely.
//  - Everything else same-origin (the HTML shell, /manifest.webmanifest, /icon.svg) is
//    network-first — always try the network so a fresh deploy is never masked by a stale copy —
//    falling back to whatever's cached only if the network request genuinely fails, so a poor
//    connection still gets *something* instead of a browser error page.
//  - Cross-origin requests (Supabase's REST/Auth/Realtime/Storage APIs) are never touched here;
//    the app's own code already handles retries and errors for those.
const SHELL_CACHE = 'dit-shell-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const res = await fetch(request)
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE)
        cache.put(request, res.clone())
      }
      return res
    })())
    return
  }

  event.respondWith((async () => {
    try {
      const res = await fetch(request)
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE)
        cache.put(request, res.clone())
      }
      return res
    } catch {
      const cached = await caches.match(request)
      return cached || caches.match('/') || Response.error()
    }
  })())
})
