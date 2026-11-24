import { defineConfig } from "vite";

// GitHub Pages(하위 경로)와 Netlify(루트) 둘 다에서 열리도록 상대 경로로 빌드한다.
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
