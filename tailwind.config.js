/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#0B1220",
        darkblue: "#0F1C3F",
        midblue: "#1F3B73",
        accent: "#3A7BFF"
      },
      borderRadius: {
        sm: "12px",
        md: "20px",
        lg: "24px",
        pill: "999px"
      },
      backdropBlur: {
        glass: "20px"
      },
      transitionDuration: {
        fast: "180ms",
        normal: "240ms"
      }
    }
  },
  plugins: []
};
