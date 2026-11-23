import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served behind the Caddy HTTPS front (one origin for web, /api, /auth and /livekit).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Caddy forwards the original Host; allow the LAN names it is reached by.
    allowedHosts: true,
    hmr: { clientPort: 8443, protocol: 'wss' },
  },
  build: { sourcemap: false },
});
