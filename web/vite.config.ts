import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
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
