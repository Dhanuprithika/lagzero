import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { build, defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'build-content-script',
      async writeBundle() {
        // Build content.js as a completely standalone IIFE bundle
        // Chrome Manifest V3 declarative content scripts cannot use ES module `import` syntax
        await build({
          configFile: false,
          build: {
            outDir: 'dist',
            emptyOutDir: false,
            lib: {
              entry: resolve(import.meta.dirname, 'src/content.ts'),
              name: 'LagZeroContent',
              formats: ['iife'],
              fileName: () => 'content.js',
            },
          },
        })
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        background: resolve(import.meta.dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js'
          }
          return 'assets/[name]-[hash].js'
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
