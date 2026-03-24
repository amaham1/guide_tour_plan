import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sand: "#f6eddc",
        coral: "#ff7f50",
        ink: "#12212d",
        lagoon: "#0d6e6e",
        sunrise: "#f4ad63",
      },
      boxShadow: {
        tide: "0 24px 60px rgba(18, 33, 45, 0.16)",
      },
      backgroundImage: {
        grain:
          "radial-gradient(circle at 15% 20%, rgba(255,255,255,0.6) 0 8%, transparent 9%), radial-gradient(circle at 80% 35%, rgba(255,255,255,0.35) 0 6%, transparent 7%), linear-gradient(135deg, rgba(244,173,99,0.22), rgba(13,110,110,0.16))",
      },
    },
  },
  plugins: [],
};

export default config;
