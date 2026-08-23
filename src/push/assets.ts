/**
 * The two files a browser needs before it will treat the console as an installable app that can
 * receive push: a manifest and a service worker.
 *
 * Both are generated per instance rather than shipped as static files, because both carry the
 * instance's identity. Two agents installed on the same phone have to be two distinguishable
 * icons, and a notification saying "something needs you" is useless when you run four of them.
 */


/** Escapes a string for embedding inside a single-quoted JS literal. */
function js(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, ' ')
}

export function renderManifest(opts: { name: string; primary: string }): string {
  const primary = opts.primary
  const background = '#0b0a12'
  return JSON.stringify({
    name: opts.name,
    short_name: opts.name,
    // The console is the whole app; start at the root so a launch lands on the chat.
    start_url: '.',
    scope: '.',
    display: 'standalone',
    background_color: background,
    theme_color: primary,
    icons: [
      // An inline SVG icon keeps this a single self-contained page with no asset pipeline.
      // maskable so iOS/Android can crop it to their own shape without letterboxing.
      {
        src: `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="${background}"/><circle cx="96" cy="96" r="46" fill="none" stroke="${primary}" stroke-width="14"/><circle cx="96" cy="96" r="12" fill="${primary}"/></svg>`,
        )}`,
        sizes: '192x192',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
  })
}

/**
 * The service worker. Its only job is to turn a contentless push into a notification and to
 * bring the console to the front when that notification is tapped.
 *
 * The instance name is baked in at serve time rather than sent in the push. That is the whole
 * point of the payload-free design: the push service learns only that a notification happened,
 * while the device still shows something more useful than "egirl".
 */
export function renderServiceWorker(opts: { name: string }): string {
  const name = js(opts.name)
  return `// egirl console service worker — generated per instance.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Pushes carry no payload on purpose: the push service should not be handed the text of
// everything an agent ever needs you for. The name below was baked in by the server.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('${name}', {
      body: 'Needs you — tap to open the console.',
      tag: 'egirl-attention',      // collapse repeats instead of stacking a wall of them
      renotify: true,
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Focus an already-open console rather than piling up duplicate tabs.
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.registration.scope) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(self.registration.scope);
  })());
});
`
}
