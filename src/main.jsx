import './devRafShim.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import RainGraphicView from './components/RainGraphicView.jsx'
import SatelliteView from './components/SatelliteView.jsx'

const searchParams = new URLSearchParams(window.location.search)
const rainGraphicId = searchParams.get('rainGraphic')
// 위성 영상 뷰는 작업 중 — URL 게이트로만 진입 (일반 UI에는 미노출)
const isSatelliteView = searchParams.get('satellite') === '1'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isSatelliteView ? (
      <SatelliteView />
    ) : rainGraphicId ? (
      <RainGraphicView graphicId={rainGraphicId} />
    ) : (
      <App />
    )}
  </StrictMode>,
)
