import {defineConfig} from 'vite';

export default defineConfig({
  base: './',
  server: {open: true},
  build: {target: 'baseline-widely-available', copyPublicDir: false},
});
