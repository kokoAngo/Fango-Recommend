import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'

interface Project {
  id: string
  name: string
  created_at: string
  current_round: number
}

interface SuumoCustomer {
  id: string
  name: string
  date: string
  phone: string
  email: string
  propertyName: string
  hasDetailPage: boolean
}

function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [requirements, setRequirements] = useState('')
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragover, setDragover] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // SUUMO integration state
  const [suumoCustomers, setSuumoCustomers] = useState<SuumoCustomer[]>([])
  const [showSuumoModal, setShowSuumoModal] = useState(false)
  const [suumoLoading, setSuumoLoading] = useState(false)
  const [importingCustomerId, setImportingCustomerId] = useState<string | null>(null)

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

  const filterValidFiles = (fileList: File[]) => {
    return fileList.filter(file =>
      file.name.endsWith('.pdf') || file.name.endsWith('.txt')
    )
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const validFiles = filterValidFiles(Array.from(e.target.files))
      setFiles(prev => [...prev, ...validFiles])
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragover(false)
    if (e.dataTransfer.files) {
      const validFiles = filterValidFiles(Array.from(e.dataTransfer.files))
      setFiles(prev => [...prev, ...validFiles])
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
    const pdfFiles = files.filter(f => f.name.endsWith('.pdf'))
    if (pdfFiles.length === 0) {
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

  // Fetch customers from SUUMO
  const fetchSuumoCustomers = async () => {
    setSuumoLoading(true)
    try {
      const res = await axios.get('/api/suumo/customers')
      setSuumoCustomers(res.data.customers || [])
      setShowSuumoModal(true)
    } catch (err) {
      console.error('Failed to fetch SUUMO customers:', err)
      alert('SUUMOからの顧客取得に失敗しました')
    } finally {
      setSuumoLoading(false)
    }
  }

  // Import a customer from SUUMO and create a project
  const importSuumoCustomer = async (customer: SuumoCustomer) => {
    setImportingCustomerId(customer.id)
    try {
      const res = await axios.post(`/api/suumo/import/${customer.id}`, {
        customerData: customer
      })
      setShowSuumoModal(false)
      navigate(`/project/${res.data.projectId}`)
    } catch (err) {
      console.error('Failed to import SUUMO customer:', err)
      alert('顧客のインポートに失敗しました')
    } finally {
      setImportingCustomerId(null)
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ margin: 0 }}>新規プロジェクト</h2>
            <button
              className="btn btn-secondary"
              onClick={fetchSuumoCustomers}
              disabled={suumoLoading}
              style={{ fontSize: '0.85rem' }}
            >
              {suumoLoading ? '取得中...' : '📥 SUUMOから取得'}
            </button>
          </div>

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
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className="upload-icon">📁</div>
            <p>PDF・TXTファイルをドラッグ＆ドロップ</p>
            <p style={{ fontSize: '0.9rem', color: '#888', marginBottom: '15px' }}>
              または下のボタンからアップロード
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '0.85rem' }}
                onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click() }}
              >
                📂 フォルダを選択
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '0.85rem' }}
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}
              >
                📄 ファイルを選択
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.txt"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <input
              ref={folderInputRef}
              type="file"
              // @ts-ignore
              webkitdirectory=""
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
          </div>

          {files.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '15px' }}>
                <span style={{ fontSize: '0.9rem', color: '#666' }}>
                  PDF: {files.filter(f => f.name.endsWith('.pdf')).length}件 /
                  TXT: {files.filter(f => f.name.endsWith('.txt')).length}件
                </span>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '0.85rem' }}
                  onClick={() => setFiles([])}
                >
                  すべてクリア
                </button>
              </div>
              <ul className="file-list">
                {files.map((file, idx) => (
                  <li key={idx} className="file-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span className="file-icon">{file.name.endsWith('.pdf') ? '📄' : '📝'}</span>
                      {file.name}
                    </div>
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', padding: '2px 6px' }}
                      onClick={() => setFiles(files.filter((_, i) => i !== idx))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </>
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

      {/* SUUMO Customer Modal */}
      {showSuumoModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '800px',
            width: '95%',
            maxHeight: '80vh',
            overflow: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0 }}>SUUMO 顧客一覧</h3>
              <button
                onClick={() => setShowSuumoModal(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {suumoCustomers.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
                <p>顧客が見つかりませんでした</p>
                <p style={{ fontSize: '0.9rem' }}>SUUMOで「検索する」を実行してから再度お試しください</p>
              </div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {suumoCustomers.map((customer) => (
                  <li
                    key={customer.id}
                    style={{
                      padding: '16px',
                      borderBottom: '1px solid #eee',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: '500', marginBottom: '4px' }}>
                        {customer.name || `顧客 ${customer.id}`}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '2px' }}>
                        {customer.date && <span>📅 {customer.date} </span>}
                        {customer.propertyName && <span>🏠 {customer.propertyName}</span>}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#888' }}>
                        {customer.phone && <span>📞 {customer.phone} </span>}
                        {customer.email && <span>✉️ {customer.email}</span>}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.85rem', padding: '8px 16px' }}
                      onClick={() => importSuumoCustomer(customer)}
                      disabled={importingCustomerId === customer.id}
                    >
                      {importingCustomerId === customer.id ? 'インポート中...' : 'インポート'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default HomePage
