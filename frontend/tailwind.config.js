/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0e14",
          panel: "#11151d",
          raised: "#161b26",
          border: "#232936",
        },
        ink: {
          DEFAULT: "#e6e9ef",
          muted: "#8b93a7",
          faint: "#5b6273",
        },
        accent: {
          DEFAULT: "#3d8bfd",
          soft: "#1e2a44",
        },
        bull: {
          DEFAULT: "#26a69a",
          soft: "#0f2b28",
        },
        bear: {
          DEFAULT: "#ef5350",
          soft: "#3a1616",
        },
        warn: {
          DEFAULT: "#eab308",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
