import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../api'

interface Project {
  id: string
  name: string
  created_at: string
  user_requirements: string
}

interface SearchResult {
  reins_id: string
  platform?: string
  success: boolean
  action?: string
}

function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [requirementsText, setRequirementsText] = useState('')
  const [searchingProperties, setSearchingProperties] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (projectId) {
      fetchProject()
    }
  }, [projectId])

  const fetchProject = async () => {
    try {
      const res = await api.get(`/api/projects/${projectId}`)
      setProject(res.data)
      setRequirementsText(res.data.user_requirements || '')
      setLoading(false)
    } catch (err) {
      console.error('Failed to fetch project:', err)
      setLoading(false)
    }
  }

  const saveRequirements = async () => {
    if (!requirementsText.trim()) {
      alert('要望を入力してください')
      return
    }

    setSaving(true)
    try {
      await api.put(`/api/projects/${projectId}/requirements`, {
        requirements: requirementsText
      })
      setProject(prev => prev ? { ...prev, user_requirements: requirementsText } : null)
      alert('保存しました')
    } catch (err) {
      console.error('Failed to save:', err)
      alert('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.endsWith('.txt')) {
      alert('TXTファイルのみ対応しています')
      return
    }

    try {
      const text = await file.text()
      setRequirementsText(prev => prev ? prev + '\n\n' + text : text)
    } catch (err) {
      console.error('Failed to read file:', err)
      alert('ファイルの読み込みに失敗しました')
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const searchProperties = async () => {
    if (!requirementsText.trim()) {
      alert('お客様の要望を入力してください')
      return
    }

    // Save requirements first if changed
    if (requirementsText !== project?.user_requirements) {
      await saveRequirements()
    }

    setSearchingProperties(true)
    setSearchResults([])
    try {
      const res = await api.post(`/api/projects/${projectId}/search-properties`, {
        userRequirements: requirementsText
      }, {
        timeout: 600000 // 10 minutes timeout
      })

      // Store search results (REINS IDs)
      if (res.data.notionSyncResults) {
        setSearchResults(res.data.notionSyncResults)
      }

      alert(res.data.message || '検索完了')
    } catch (err: any) {
      console.error('Failed to search properties:', err)
      const status = err.response?.status
      const data = err.response?.data
      let errorMsg: string
      if (status === 503) {
        errorMsg = `${data?.error || '物件検索APIに接続できません'}\n\n${data?.details || '外部APIが起動しているか確認してください。'}`
      } else if (status === 502) {
        errorMsg = `${data?.error || 'APIエンドポイントエラー'}\n\n${data?.details || 'API設定を確認してください。'}`
      } else {
        errorMsg = data?.error || data?.details || '物件検索に失敗しました'
      }
      alert(errorMsg)
    } finally {
      setSearchingProperties(false)
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner"></div>
        <p>読み込み中...</p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="card">
        <h2>プロジェクトが見つかりません</h2>
        <button className="btn btn-primary" onClick={() => navigate('/')}>
          ホームに戻る
        </button>
      </div>
    )
  }

  return (
    <>
      <header className="header">
        <h1>{project.name}</h1>
        <p>物件推薦システム - Notion連携</p>
      </header>

      <button
        className="btn btn-secondary"
        style={{ marginBottom: '20px' }}
        onClick={() => navigate('/')}
      >
        ← ホームに戻る
      </button>

      {/* User Requirements Input */}
      <div className="card">
        <h3 style={{ marginBottom: '20px' }}>お客様の要望</h3>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
            要望を入力またはTXTファイルをアップロード
          </label>
          <textarea
            className="textarea"
            style={{
              minHeight: '250px',
              fontFamily: 'monospace',
              fontSize: '0.9rem',
              lineHeight: '1.6'
            }}
            value={requirementsText}
            onChange={(e) => setRequirementsText(e.target.value)}
            placeholder="お客様の要望を入力してください...

例:
- 場所: 東京都新宿区周辺
- 予算: 月額15万円以下
- 間取り: 1LDK以上
- 駅徒歩: 10分以内
- その他: ペット可、バストイレ別"
          />
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="btn btn-secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            📄 TXTファイルを追加
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />

          <button
            className="btn btn-primary"
            onClick={saveRequirements}
            disabled={saving || !requirementsText.trim()}
          >
            {saving ? '保存中...' : '保存'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => setRequirementsText('')}
            disabled={!requirementsText}
          >
            クリア
          </button>
        </div>
      </div>

      {/* Search Section */}
      <div className="card" style={{ marginTop: '20px', background: '#e8f5e9' }}>
        <h3 style={{ marginBottom: '15px', color: '#2e7d32' }}>🔍 物件を検索</h3>
        <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '15px' }}>
          上記の要望に基づいてFangoで物件を検索し、REINS IDをNotionに記録します。
        </p>

        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            style={{ background: '#2e7d32', padding: '12px 24px', fontSize: '1rem' }}
            onClick={searchProperties}
            disabled={searchingProperties || !requirementsText.trim()}
          >
            {searchingProperties ? '検索中...' : 'REINS IDを検索してNotionに記録'}
          </button>
        </div>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div style={{ marginTop: '25px' }}>
            <h4 style={{ marginBottom: '15px', color: '#2e7d32' }}>📋 検索結果</h4>
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              overflow: 'hidden',
              border: '1px solid #ddd'
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f5f5f5' }}>
                    <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>#</th>
                    <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>REINS ID</th>
                    <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>User ID</th>
                    <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>Notion同期</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((result, index) => (
                    <tr key={`${result.reins_id}-${index}`} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '12px', color: '#666' }}>{index + 1}</td>
                      <td style={{ padding: '12px', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '1rem' }}>
                        {result.reins_id}
                      </td>
                      <td style={{ padding: '12px', fontFamily: 'monospace', fontSize: '0.85rem', color: '#666' }}>
                        {projectId?.substring(0, 8)}...
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center' }}>
                        {result.success ? (
                          <span style={{ color: '#2e7d32', fontWeight: 'bold' }}>✅ {result.action}</span>
                        ) : (
                          <span style={{ color: '#d32f2f' }}>❌ 失敗</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{
              marginTop: '15px',
              padding: '12px',
              background: '#fff',
              borderRadius: '8px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{ fontSize: '0.9rem', color: '#666' }}>
                {searchResults.filter(r => r.success).length} / {searchResults.length} 件がNotionに同期されました
              </span>
              <a
                href="https://www.notion.so/angojp/33b1c1974dad8048add5c41c7ead9c13"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#2e7d32', textDecoration: 'none', fontWeight: 'bold' }}
              >
                Notionで確認 →
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Project Info */}
      <div className="card" style={{ marginTop: '20px', background: '#f5f5f5' }}>
        <h4 style={{ marginBottom: '10px', color: '#666' }}>プロジェクト情報</h4>
        <p style={{ fontSize: '0.85rem', color: '#888' }}>
          <strong>Project ID:</strong> {projectId}<br />
          <strong>作成日:</strong> {project.created_at}
        </p>
      </div>

      {/* Processing Indicator */}
      {searchingProperties && (
        <div className="loading" style={{ marginTop: '30px' }}>
          <div className="loading-spinner"></div>
          <p>Fangoで物件を検索中...</p>
        </div>
      )}
    </>
  )
}

export default ProjectPage
