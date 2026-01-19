module.exports = {
  darkMode: 'class',
  content: [
    './popup.html',
    './popup.js'
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        brand: {
          yellow: '#FCD228',
          black: '#000000',
          white: '#FFFFFF',
        }
      },
      boxShadow: {
        'brutal': '4px 4px 0px 0px #000000',
        'brutal-lg': '8px 8px 0px 0px #000000',
        'brutal-sm': '2px 2px 0px 0px #000000',
        'brutal-hover': '2px 2px 0px 0px #000000',
        'brutal-white': '4px 4px 0px 0px #FFFFFF',
      },
      borderWidth: {
        '3': '3px',
      },
      animation: {
        'blob': 'blob 7s infinite',
        'spin-slow': 'spin 8s linear infinite',
      }
    }
  },
  plugins: [],
}

