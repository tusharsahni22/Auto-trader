/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#050607",
          panel: "#0b0d10",
          raised: "#13171c",
          border: "#1e242c",
        },
        ink: {
          DEFAULT: "#e8ecef",
          muted: "#93a1ad",
          faint: "#606c78",
        },
        // Green is the primary accent — this is a trading surface, not a
        // general-purpose app, so "action" and "long" share a colour.
        accent: {
          DEFAULT: "#16c784",
          soft: "#0c2b22",
        },
        bull: {
          DEFAULT: "#16c784",
          bright: "#2ce69b",
          soft: "#0c2b22",
        },
        bear: {
          DEFAULT: "#ea3943",
          bright: "#ff5c66",
          soft: "#2e1013",
        },
        warn: {
          DEFAULT: "#f0b90b",
          soft: "#2e2608",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        bull: "0 0 0 1px rgba(22,199,132,0.35), 0 0 18px -6px rgba(22,199,132,0.55)",
        bear: "0 0 0 1px rgba(234,57,67,0.35), 0 0 18px -6px rgba(234,57,67,0.55)",
      },
    },
  },
  plugins: [],
};
