import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    // `npm run dev` proxies the API to the running orchestrator (log in at http://localhost:4777 first)
    proxy: { '/api': 'http://localhost:4777', '/login': 'http://localhost:4777' },
  },
})
