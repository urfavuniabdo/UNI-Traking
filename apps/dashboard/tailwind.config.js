/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2563eb',
          dark: '#1d4ed8',
          light: '#bfdbfe',
          soft: '#eff6ff',
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        ink: '#0f172a',
        'ink-2': '#334155',
        muted: '#64748b',
        line: '#e2e8f0',
        card: '#ffffff',
        'kpi-green': '#e9f8ef',
        'kpi-amber': '#fdf2e6',
        'kpi-violet': '#f1ecfd',
        'kpi-blue': '#d2e4fc',
        'kpi-sky': '#eef4fd',
      },
      fontFamily: {
        cairo: ['Cairo', 'Segoe UI', 'Tahoma', 'sans-serif'],
      },
      boxShadow: {
        card: '0 2px 12px rgba(30,90,180,.06)',
        'nav-glow': '0 8px 20px rgba(59,130,246,.28)',
        float: '0 12px 32px rgba(15,23,42,.18)',
      },
      borderRadius: {
        control: '10px',
      },
    },
  },
  plugins: [],
};
