import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  // Web Bluetooth needs a secure context. localhost counts either way; other
  // origins need HTTPS, so basicSsl() serves a self-signed cert on 0.0.0.0.
  // The cert is untrusted, so every client must click through the interstitial
  // once. If a phone refuses to, use a real HTTPS tunnel instead.
  server: { host: '0.0.0.0' },
  build: { target: 'es2022' },
})
