import { defineConfig } from 'vite';

export default defineConfig({
  // Base path — cambiar si el sitio va en un subdirectorio
  // Ej: '/inflacion/' si va en tudominio.com/inflacion/
  base: '/',
  
  build: {
    // Carpeta de salida
    outDir: 'dist',
    
    // Generar sourcemaps para debugging (opcional)
    sourcemap: false,
    
    // Tamaño mínimo para inlining en base64 (4kb)
    assetsInlineLimit: 4096,
    
    // Nombres de archivos con hash para cache busting
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('chart.js')) return 'chartjs';
          if (id.includes('@supabase')) return 'supabase';
        }
      }
    }
  },
  
  server: {
    // Solo para desarrollo local
    port: 5173
  }
});
