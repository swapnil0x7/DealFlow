import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'grid',
              test: /node_modules[\\/]ag-grid-(community|react)[\\/]/,
              includeDependenciesRecursively: true,
            },
          ],
        },
      },
    },
  },
})
