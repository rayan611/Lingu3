import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

export default defineConfig({
  // Baked in at build time and shown at the bottom of Settings. Without a
  // version on screen there is no way to tell, from a phone, whether the
  // service worker has actually picked up a new deploy.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Lingu3 — learn up to 3 languages',
        // What appears under the icon on a home screen, where there is room
        // for about twelve characters and no more.
        short_name: 'Lingu3',
        description: 'Learn up to 3 languages at once, from your own words',
        theme_color: '#1f2933',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell is precached, so review works with no network at all.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // Without these, a bad shell cached by an older service worker (for
        // example a login wall served while deployment protection was on)
        // keeps being served forever and the app looks dead. These make a new
        // deploy take over the page immediately and bin the old caches.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The fallback is for page navigations only; it must never swallow an
        // API call and hand back HTML.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Never cache expansion calls — they must hit the network or fail
            // into the pending queue.
            urlPattern: /\/api\/expand/,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
})
