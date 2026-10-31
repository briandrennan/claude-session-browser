import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // `make dev PORT=…` sets CSB_PORT so the proxy follows the backend.
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.CSB_PORT ?? 8484}` } },
})
