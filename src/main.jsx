import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import RainGraphicView from './components/RainGraphicView.jsx'

const rainGraphicId = new URLSearchParams(window.location.search).get('rainGraphic')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {rainGraphicId ? <RainGraphicView graphicId={rainGraphicId} /> : <App />}
  </StrictMode>,
)
