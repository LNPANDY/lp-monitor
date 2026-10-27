import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 涨跌/状态色（暗色下提高亮度保证可读）
        ok: { DEFAULT: "#4ade80", soft: "rgba(74, 222, 128, 0.12)" },
        warn: { DEFAULT: "#f87171", soft: "rgba(248, 113, 113, 0.12)" },
        ink: { DEFAULT: "#f1f5f9", soft: "#94a3b8" },
        // 深底（body/卡片基色）
        "ink-deep": "#020617",
        // 品牌强调色（青→紫渐变的两端，也可单独使用）
        "brand-cyan": "#22d3ee",
        "brand-violet": "#a78bfa",

        // ===== 亮色时代遗留色的暗色映射 =====
        // 业务代码里大量 bg-white / bg-slate-50 / border-slate-200 等
        // 硬编码，暗色主题下通过重定义这些色值原地变暗，业务零改动。
        // 注意：slate 全系重定义只影响本项目（未用 slate 的预设其他档位照常）。
        slate: {
          50: "rgba(255, 255, 255, 0.04)",    // 曾是浅底 → 变半透明行底
          100: "rgba(255, 255, 255, 0.06)",   // 曾是浅灰底 → 半透明
          200: "rgba(255, 255, 255, 0.10)",   // 曾是边框 → 暗描边
          300: "rgba(255, 255, 255, 0.16)",   // 曾是深边框/按钮底 → 亮一点的描边
          400: "#94a3b8",
          500: "#94a3b8",
          600: "#cbd5e1",
          700: "#e2e8f0",
          800: "#f1f5f9",
          900: "#f8fafc",
          950: "#ffffff",
        },
      },
      // 数字等宽字体栈（余额/价格读数用）
      fontFamily: {
        num: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
