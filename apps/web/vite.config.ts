import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { publicUrlPlugin } from './vite.public-url';

// Served behind the Caddy HTTPS front (one origin for web, /api, /auth and /livekit).
export default defineConfig(({ mode }) => ({
  plugins: [react(), publicUrlPlugin(process.env.VITE_PUBLIC_URL ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_PUBLIC_URL)],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Caddy forwards the original Host; allow the LAN names it is reached by.
    allowedHosts: true,
    hmr: { clientPort: 8443, protocol: 'wss' },
  },
  build: { sourcemap: false },
}));
