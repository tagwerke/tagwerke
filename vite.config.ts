import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = process.env.DO_APP_BACKEND ?? 'http://127.0.0.1:5174'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Backend mounts routes under /api/... — forward the prefix as-is.
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        // Proxy the WebSocket upgrade (/api/ws) to the backend too — live updates.
        ws: true,
      },
    },
  },
})
