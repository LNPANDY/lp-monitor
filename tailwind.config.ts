import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 状态与行情语义色（高对比度金融终端标准）
        ok: { DEFAULT: "#10b981", soft: "rgba(16, 185, 129, 0.14)" },
        warn: { DEFAULT: "#f43f5e", soft: "rgba(244, 63, 94, 0.14)" },
        amber: { DEFAULT: "#f59e0b", soft: "rgba(245, 158, 11, 0.14)" },
        ink: { DEFAULT: "#f1f5f9", soft: "#94a3b8" },
        "ink-deep": "#060911",
        "surface-1": "#0c121e",
        "surface-2": "#111927",
        "surface-3": "#172234",
        // 品牌与交互主色（剔除陈旧紫色，改用清脆青蓝与翡翠绿）
        primary: { DEFAULT: "#06b6d4", soft: "rgba(6, 182, 212, 0.14)" },
        "brand-cyan": "#22d3ee",
        "brand-violet": "#38bdf8",

        // 兼容旧类名的深色映射
        slate: {
          50: "rgba(255, 255, 255, 0.03)",
          100: "rgba(255, 255, 255, 0.05)",
          200: "rgba(255, 255, 255, 0.09)",
          300: "rgba(255, 255, 255, 0.15)",
          400: "#94a3b8",
          500: "#64748b",
          600: "#cbd5e1",
          700: "#e2e8f0",
          800: "#f1f5f9",
          900: "#f8fafc",
          950: "#ffffff",
        },
      },
      fontFamily: {
        num: ["ui-monospace", "SFMono-Regular", "JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
