import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
});
