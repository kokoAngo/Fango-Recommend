import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'

interface Project {
  id: string
  name: string
  created_at: string
  current_round: number
}

function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [requirements, setRequirements] = useState('')
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragover, setDragover] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    fetchProjects()
  }, [])

  const fetchProjects = async () => {
    try {
      const res = await axios.get('/api/projects')
      setProjects(res.data)
    } catch (err) {
      console.error('Failed to fetch projects:', err)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files))
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragover(false)
    if (e.dataTransfer.files) {
      setFiles(Array.from(e.dataTransfer.files))
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragover(true)
  }

  const handleDragLeave = () => {
    setDragover(false)
  }

  const startNewProject = async () => {
    if (files.length === 0) {
      alert('PDFファイルをアップロードしてください')
      return
    }

    setLoading(true)
    try {
      // Create project
      const projectRes = await axios.post('/api/projects', {
        name: projectName || `プロジェクト ${new Date().toLocaleDateString('ja-JP')}`
      })
      const projectId = projectRes.data.id

      // Upload files
      const formData = new FormData()
      files.forEach(file => formData.append('files', file))
      formData.append('requirements', requirements)

      await axios.post(`/api/projects/${projectId}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })

      // Navigate to project page
      navigate(`/project/${projectId}`)
    } catch (err) {
      console.error('Failed to create project:', err)
      alert('プロジェクトの作成に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getRoundLabel = (round: number) => {
    if (round === 0) return 'ランダム選択待ち'
    if (round === 1) return '第1ラウンド'
    if (round === 2) return '第2ラウンド'
    if (round === 3) return '第3ラウンド'
    return '完了'
  }

  const deleteProject = async (e: React.MouseEvent, projectId: string, projectName: string) => {
    e.stopPropagation()
    if (!confirm(`「${projectName}」を削除しますか？\nこの操作は取り消せません。`)) {
      return
    }
    try {
      await axios.delete(`/api/projects/${projectId}`)
      setProjects(projects.filter(p => p.id !== projectId))
    } catch (err) {
      console.error('Failed to delete project:', err)
      alert('プロジェクトの削除に失敗しました')
    }
  }

  return (
    <>
      <header className="header">
        <h1>Fango Recommend</h1>
        <p>AI駆動の物件推薦システム</p>
      </header>

      <div className="home-grid">
        {/* New Project Section */}
        <div className="card">
          <h2>新規プロジェクト</h2>

          <div className="form-group" style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>
              プロジェクト名
            </label>
            <input
              type="text"
              className="textarea"
              style={{ minHeight: 'auto', padding: '12px' }}
              placeholder="プロジェクト名を入力..."
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>

          <div
            className={`upload-area ${dragover ? 'dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className="upload-icon">📁</div>
            <p>PDFファイルをドラッグ＆ドロップ</p>
            <p style={{ fontSize: '0.9rem', color: '#888' }}>
              またはクリックしてファイルを選択
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
          </div>

          {files.length > 0 && (
            <ul className="file-list">
              {files.map((file, idx) => (
                <li key={idx} className="file-item">
                  <span className="file-icon">📄</span>
                  {file.name}
                </li>
              ))}
            </ul>
          )}

          <div className="form-group" style={{ marginTop: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>
              お客様の要望・条件
            </label>
            <textarea
              className="textarea"
              placeholder="例：駅から徒歩10分以内、2LDK以上、ペット可..."
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
            />
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '20px' }}
            onClick={startNewProject}
            disabled={loading || files.length === 0}
          >
            {loading ? '作成中...' : '新規プロジェクトを開始'}
          </button>
        </div>

        {/* Existing Projects Section */}
        <div className="card">
          <h2>マイプロジェクト</h2>

          {projects.length === 0 ? (
            <div className="empty-state">
              <p>プロジェクトがありません</p>
              <p style={{ fontSize: '0.9rem' }}>
                左側から新規プロジェクトを作成してください
              </p>
            </div>
          ) : (
            <ul className="project-list">
              {projects.map((project) => (
                <li
                  key={project.id}
                  className="project-item"
                  onClick={() => navigate(`/project/${project.id}`)}
                >
                  <div>
                    <div className="project-name">{project.name}</div>
                    <div className="project-date">
                      {formatDate(project.created_at)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      padding: '4px 12px',
                      background: '#f0f3ff',
                      borderRadius: '20px',
                      fontSize: '0.85rem',
                      color: '#667eea'
                    }}>
                      {getRoundLabel(project.current_round)}
                    </div>
                    <button
                      onClick={(e) => deleteProject(e, project.id, project.name)}
                      style={{
                        padding: '6px 10px',
                        background: '#fee2e2',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#dc2626',
                        cursor: 'pointer',
                        fontSize: '0.85rem'
                      }}
                      title="削除"
                    >
                      🗑️
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}

export default HomePage
