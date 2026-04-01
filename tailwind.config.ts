import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        heading: ["var(--font-cal-sans)", "sans-serif"],
        body: ["var(--font-poppins)", "sans-serif"],
      },
      colors: {
        coral: "#FF385C",
      },
    },
  },
  plugins: [],
};

export default config;
