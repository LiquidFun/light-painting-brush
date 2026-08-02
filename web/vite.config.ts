import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

/**
 * Strips `crossorigin` from our own script and style tags.
 *
 * Vite marks module scripts `crossorigin`, which with no value means
 * `anonymous`: the request goes out in CORS mode *without credentials*. The app
 * is served behind HTTP Basic auth, so those requests come back 401 and the page
 * renders blank after a successful login — with nothing on screen to say why.
 *
 * Every asset here is same-origin, so CORS mode buys nothing. Removing the
 * attribute restores ordinary same-origin credential handling.
 */
function sameOriginAssets(): Plugin {
  return {
    name: 'lightstick:same-origin-assets',
    transformIndexHtml(html) {
      // Whole tag at a time: the attribute order is not fixed, and `src` sits
      // after `crossorigin` in what Vite emits.
      return html.replace(/<(?:script|link)\b[^>]*>/g, (tag) =>
        /\s(?:src|href)="\//.test(tag) ? tag.replace(/\scrossorigin(?=[\s>])/, '') : tag,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl(), sameOriginAssets()],
  // In production the relay serves these files, so HTTPS comes from Caddy. In
  // development basicSsl() serves a self-signed cert on 0.0.0.0, which is what the
  // legacy Web Bluetooth path needs (it requires a secure context) and what makes
  // a phone on the same network able to load the editor at all. The cert is
  // untrusted, so every client clicks through the interstitial once.
  server: {
    host: '0.0.0.0',
    // The editor talks to the relay on the same origin, so development needs it
    // proxied. Start `npm start` in server/ first; without it the device panel
    // simply reports the relay unreachable, which is a supported state.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: { target: 'es2022' },
})
