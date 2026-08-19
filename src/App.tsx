import { HashRouter, Route, Routes } from 'react-router-dom'
import SelectScreen from './screens/SelectScreen'
import GameScreen from './screens/GameScreen'
import ResultScreen from './screens/ResultScreen'
import EditorScreen from './screens/EditorScreen'
import CalibrationScreen from './screens/CalibrationScreen'

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<SelectScreen />} />
        <Route path="/play/:songId" element={<GameScreen />} />
        <Route path="/result" element={<ResultScreen />} />
        <Route path="/editor" element={<EditorScreen />} />
        <Route path="/calibration" element={<CalibrationScreen />} />
      </Routes>
    </HashRouter>
  )
}

export default App
