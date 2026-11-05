import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 状态与行情语义色（高对比度金融终端标准）
        ok: { DEFAULT: "#10b981", soft: "rgba(16, 185, 129, 0.16)" },
        warn: { DEFAULT: "#fbbf24", soft: "rgba(251, 191, 36, 0.16)" },
        danger: { DEFAULT: "#f43f5e", soft: "rgba(244, 63, 94, 0.16)" },
        amber: { DEFAULT: "#fbbf24", soft: "rgba(251, 191, 36, 0.16)" },

        // 文字层级（全部采用高亮度清晰字色，杜绝暗淡看不清）
        ink: {
          DEFAULT: "#f8fafc", // 主文字：纯亮白
          soft: "#cbd5e1",    // 次级文字：明亮银灰 (slate-300)
          muted: "#94a3b8",   // 辅助说明文字：清晰中灰 (slate-400)
        },
        "ink-deep": "#060911",

        // 背景与容器层级
        surface: {
          DEFAULT: "#060911",
          card: "#0d1422",
          raised: "#131c2e",
          hover: "#19253c",
        },
        "surface-1": "#0d1422",
        "surface-2": "#131c2e",
        "surface-3": "#19253c",

        // 品牌与交互主色（高亮青蓝）
        brand: {
          DEFAULT: "#06b6d4",
          light: "#67e8f9",
          dark: "#0891b2",
        },
        primary: { DEFAULT: "#06b6d4", soft: "rgba(6, 182, 212, 0.16)" },
        "brand-cyan": "#22d3ee",
        "brand-violet": "#38bdf8",
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255, 255, 255, 0.06) inset, 0 10px 30px -12px rgba(0, 0, 0, 0.7)",
        "glow-cyan": "0 0 16px -3px rgba(34, 211, 238, 0.35)",
      },
      fontFamily: {
        num: ["ui-monospace", "SFMono-Regular", "JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
