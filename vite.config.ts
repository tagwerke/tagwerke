import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const SIDECAR = process.env.DO_APP_SIDECAR ?? 'http://localhost:5174'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: SIDECAR,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
