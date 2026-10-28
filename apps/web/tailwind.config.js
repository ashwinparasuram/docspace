import typography from '@tailwindcss/typography';

/**
 * Design tokens. Grays are true neutrals (the `slate` scale is remapped to zinc so the whole UI
 * shares one gray), the accent is a restrained cobalt used for links, focus and selection only,
 * and primary actions use ink (near-black / white in dark mode).
 */
const neutral = {
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#d4d4d8',
  400: '#a1a1aa',
  500: '#71717a',
  600: '#52525b',
  700: '#3f3f46',
  800: '#27272a',
  900: '#18181b',
  950: '#0b0b0d',
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: neutral,
        gray: neutral,
        brand: {
          50: '#eff4ff',
          100: '#dbe6fe',
          200: '#bfd3fe',
          300: '#93b4fd',
          400: '#6090fa',
          500: '#3b6ef5',
          600: '#2557d6',
          700: '#1e46b0',
          800: '#1d3c8f',
          900: '#1c3474',
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', '"JetBrains Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '16px'],
        sm: ['13px', '20px'],
        base: ['14px', '22px'],
      },
      borderRadius: {
        lg: '6px',
        xl: '8px',
        '2xl': '10px',
      },
      boxShadow: {
        pop: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -6px rgba(0,0,0,0.12)',
      },
    },
  },
  plugins: [typography],
};
