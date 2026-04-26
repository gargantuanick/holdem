/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          900: "#0a2e22",
          800: "#0b3d2e",
          700: "#0e4f3c",
          600: "#13684f",
          500: "#1a7e62",
        },
        chip: {
          red: "#c0392b",
          blue: "#2c5b8c",
          green: "#1d6e3a",
          black: "#1a1a1a",
          gold: "#d4a93a",
        },
      },
      fontFamily: {
        display: ["ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        "card-deal": {
          "0%": { transform: "translateY(-30px) scale(0.8)", opacity: "0" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        "chip-pop": {
          "0%": { transform: "scale(0)", opacity: "0" },
          "60%": { transform: "scale(1.15)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "winner-glow": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(212, 169, 58, 0)" },
          "50%": { boxShadow: "0 0 24px 6px rgba(212, 169, 58, 0.85)" },
        },
        "wallet-bump": {
          "0%": { transform: "scale(1)" },
          "40%": { transform: "scale(1.18)" },
          "100%": { transform: "scale(1)" },
        },
        "action-pill": {
          "0%": { transform: "translateY(-4px) scale(0.85)", opacity: "0" },
          "12%": { transform: "translateY(0) scale(1.05)", opacity: "1" },
          "20%": { transform: "translateY(0) scale(1)", opacity: "1" },
          "85%": { transform: "translateY(0) scale(1)", opacity: "1" },
          "100%": { transform: "translateY(-6px) scale(0.95)", opacity: "0" },
        },
        "chip-fly": {
          "0%": { transform: "translate(0, 0) scale(1)", opacity: "0" },
          "15%": { transform: "translate(0, 0) scale(1)", opacity: "1" },
          "85%": {
            transform: "var(--chip-fly-end, translate(0, -120px)) scale(0.9)",
            opacity: "1",
          },
          "100%": {
            transform: "var(--chip-fly-end, translate(0, -120px)) scale(0.6)",
            opacity: "0",
          },
        },
      },
      animation: {
        "card-deal": "card-deal 320ms ease-out both",
        "chip-pop": "chip-pop 280ms ease-out both",
        "winner-glow": "winner-glow 1400ms ease-in-out 2",
        "wallet-bump": "wallet-bump 380ms ease-out",
        "action-pill": "action-pill 1800ms ease-in-out forwards",
        "chip-fly": "chip-fly 900ms ease-out forwards",
      },
    },
  },
  plugins: [],
};
