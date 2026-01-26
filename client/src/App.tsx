import { Routes, Route } from 'react-router-dom'
import HomePage from './pages/HomePage'
import ProjectPage from './pages/ProjectPage'

function App() {
  return (
    <div className="container">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/project/:projectId" element={<ProjectPage />} />
      </Routes>
    </div>
  )
}

export default App
