import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import preprocess from 'svelte-preprocess';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    svelte({
      preprocess: preprocess({
        typescript: true
      })
    })
  ],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '$lib': path.resolve(__dirname, './src/renderer/lib'),
      '$components': path.resolve(__dirname, './src/renderer/lib/components'),
      '$stores': path.resolve(__dirname, './src/renderer/lib/stores'),
      '$styles': path.resolve(__dirname, './src/renderer/lib/styles')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});

