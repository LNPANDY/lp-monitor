import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ok: { DEFAULT: "#16a34a", soft: "#dcfce7" },
        warn: { DEFAULT: "#dc2626", soft: "#fee2e2" },
        ink: { DEFAULT: "#0f172a", soft: "#475569" },
      },
    },
  },
  plugins: [],
};
export default config;
