import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri runs the dev server and shows clean Rust output
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // don't reload the web app when Rust files change
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // h5wasm ships a wasm binary + emscripten glue that esbuild's dep pre-bundler
  // chokes on; exclude it so it's loaded as-is by the (lazy) dynamic import.
  optimizeDeps: { exclude: ['h5wasm'] },
})
