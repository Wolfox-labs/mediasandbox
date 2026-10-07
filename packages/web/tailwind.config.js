/** Tailwind 配置。 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 与工作台深色主题配套的语义色板
        ink: {
          900: '#0d1117',
          800: '#12171f',
          700: '#1a212b',
          600: '#232c38',
          500: '#2f3a49',
        },
        accent: {
          DEFAULT: '#4c8dff',
          soft: '#2b4a7d',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
