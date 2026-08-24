import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './app.css'
import { ThemeProvider } from './theme'

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing from index.html')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
