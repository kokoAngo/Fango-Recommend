import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'

interface House {
  id: string
  filename: string
  content: string
}

interface Recommendation {
  id: string
  house_id: string
  round: number
  rating: string | null
  notes: string
  filename: string
}

interface Project {
  id: string
  name: string
  created_at: string
  user_requirements: string
  user_profile: string
  current_round: number
  houses: House[]
  recommendations: Recommendation[]
}

interface RatingState {
  [houseId: string]: {
    rating: string | null
    notes: string
  }
}

function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [currentTab, setCurrentTab] = useState(-1) // -1 = 基本情報, 0 = ランダム選択, 1-3 = 推薦ラウンド
  const [roundHouses, setRoundHouses] = useState<House[]>([])
  const [ratings, setRatings] = useState<RatingState>({})
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [editingRequirements, setEditingRequirements] = useState(false)
  const [requirementsText, setRequirementsText] = useState('')
  const [searchingProperties, setSearchingProperties] = useState(false)

  useEffect(() => {
    if (projectId) {
      fetchProject()
    }
  }, [projectId])

  useEffect(() => {
    if (project && currentTab >= 0) {
      fetchRoundData(currentTab)
    }
  }, [currentTab, project?.id])

  const fetchProject = async () => {
    try {
      const res = await axios.get(`/api/projects/${projectId}`)
      setProject(res.data)
      setRequirementsText(res.data.user_requirements || '')
      // Start at 基本情報 tab if no rounds started, otherwise go to current round
      if (res.data.current_round === 0 && (!res.data.recommendations || res.data.recommendations.length === 0)) {
        setCurrentTab(-1)
      } else {
        setCurrentTab(res.data.current_round)
      }
      setLoading(false)
    } catch (err) {
      console.error('Failed to fetch project:', err)
      setLoading(false)
    }
  }

  const fetchRoundData = async (round: number) => {
    try {
      const res = await axios.get(`/api/projects/${projectId}/rounds/${round}`)
      const recs = res.data.recommendations as Recommendation[]

      // Extract houses from recommendations
      const houses = recs.map(r => ({
        id: r.house_id,
        filename: r.filename,
        content: ''
      }))
      setRoundHouses(houses)

      // Initialize ratings from existing data
      const initialRatings: RatingState = {}
      recs.forEach(r => {
        initialRatings[r.house_id] = {
          rating: r.rating,
          notes: r.notes || ''
        }
      })
      setRatings(initialRatings)
    } catch (err) {
      console.error('Failed to fetch round data:', err)
      setRoundHouses([])
    }
  }

  const startRandomSample = async () => {
    setProcessing(true)
    try {
      const res = await axios.post(`/api/projects/${projectId}/random-sample`)
      setRoundHouses(res.data.houses)
      // Initialize empty ratings
      const initialRatings: RatingState = {}
      res.data.houses.forEach((h: House) => {
        initialRatings[h.id] = { rating: null, notes: '' }
      })
      setRatings(initialRatings)
    } catch (err) {
      console.error('Failed to get random sample:', err)
      alert('ランダムサンプルの取得に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  const handleRatingChange = (houseId: string, rating: string) => {
    setRatings(prev => ({
      ...prev,
      [houseId]: {
        ...prev[houseId],
        rating: prev[houseId]?.rating === rating ? null : rating
      }
    }))
  }

  const submitRatingsAndNextRound = async () => {
    // Check if all houses are rated
    const allRated = roundHouses.every(h => ratings[h.id]?.rating)
    if (!allRated) {
      alert('すべての物件を評価してください')
      return
    }

    setProcessing(true)
    try {
      // Submit ratings
      const ratingsData = roundHouses.map(h => ({
        houseId: h.id,
        rating: ratings[h.id].rating,
        notes: ratings[h.id].notes
      }))

      await axios.post(`/api/projects/${projectId}/rate`, {
        ratings: ratingsData,
        round: currentTab
      })

      if (currentTab < 3) {
        // Get next round recommendations
        const res = await axios.post(`/api/projects/${projectId}/next-round`)
        setRoundHouses(res.data.houses)

        // Initialize ratings for new houses
        const initialRatings: RatingState = {}
        res.data.houses.forEach((h: House) => {
          initialRatings[h.id] = { rating: null, notes: '' }
        })
        setRatings(initialRatings)

        // Move to next tab
        setCurrentTab(prev => prev + 1)
        await fetchProject() // Refresh project data
      } else {
        alert('推薦プロセスが完了しました')
        await fetchProject()
      }
    } catch (err) {
      console.error('Failed to process:', err)
      alert('処理に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  const downloadAll = () => {
    window.open(`/api/projects/${projectId}/download/${currentTab}`, '_blank')
  }

  const searchProperties = async () => {
    if (!project?.user_requirements) {
      alert('お客様の要望を入力してください')
      return
    }

    setSearchingProperties(true)
    try {
      const res = await axios.post(`/api/projects/${projectId}/search-properties`, {
        userRequirements: project.user_requirements
      })
      alert(res.data.message || '物件を取得しました')
      await fetchProject() // Refresh to show new houses
    } catch (err: any) {
      console.error('Failed to search properties:', err)
      const errorMsg = err.response?.data?.error || err.response?.data?.details || '物件検索に失敗しました'
      alert(errorMsg)
    } finally {
      setSearchingProperties(false)
    }
  }

  const getTabLabel = (round: number) => {
    switch (round) {
      case -1: return '基本情報'
      case 0: return 'ランダム選択'
      case 1: return '第1ラウンド推薦'
      case 2: return '第2ラウンド推薦'
      case 3: return '第3ラウンド推薦'
      default: return ''
    }
  }

  const getNextButtonLabel = (round: number) => {
    switch (round) {
      case 0: return '第1ラウンド推薦へ'
      case 1: return '第2ラウンド推薦へ'
      case 2: return '第3ラウンド推薦へ'
      case 3: return '完了'
      default: return ''
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
        <p>AI駆動の物件推薦システム</p>
      </header>

      <button
        className="btn btn-secondary"
        style={{ marginBottom: '20px' }}
        onClick={() => navigate('/')}
      >
        ← ホームに戻る
      </button>

      {/* Tabs */}
      <div className="tabs">
        {[-1, 0, 1, 2, 3].map(round => (
          <button
            key={round}
            className={`tab ${currentTab === round ? 'active' : ''}`}
            onClick={() => setCurrentTab(round)}
            disabled={round > project.current_round && round !== -1}
          >
            {getTabLabel(round)}
          </button>
        ))}
      </div>

      {/* 基本情報 Tab Content */}
      {currentTab === -1 && (
        <div className="card">
          <h3 style={{ marginBottom: '20px' }}>お客様基本情報</h3>

          {editingRequirements ? (
            <>
              <textarea
                className="textarea"
                style={{ minHeight: '300px', fontFamily: 'monospace', fontSize: '0.9rem' }}
                value={requirementsText}
                onChange={(e) => setRequirementsText(e.target.value)}
                placeholder="お客様の基本情報を入力..."
              />
              <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    try {
                      await axios.put(`/api/projects/${projectId}/requirements`, {
                        requirements: requirementsText
                      })
                      setProject(prev => prev ? { ...prev, user_requirements: requirementsText } : null)
                      setEditingRequirements(false)
                      alert('保存しました')
                    } catch (err) {
                      console.error('Failed to save:', err)
                      alert('保存に失敗しました')
                    }
                  }}
                >
                  保存
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setRequirementsText(project.user_requirements || '')
                    setEditingRequirements(false)
                  }}
                >
                  キャンセル
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{
                background: '#f8f9fa',
                padding: '20px',
                borderRadius: '8px',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
                fontSize: '0.9rem',
                lineHeight: '1.8',
                minHeight: '200px'
              }}>
                {project.user_requirements || '（情報なし）'}
              </div>
              <button
                className="btn btn-secondary"
                style={{ marginTop: '15px' }}
                onClick={() => setEditingRequirements(true)}
              >
                編集
              </button>
            </>
          )}

          {/* Property Search Section */}
          <div style={{
            marginTop: '30px',
            padding: '20px',
            background: '#e8f5e9',
            borderRadius: '8px'
          }}>
            <h4 style={{ marginBottom: '15px', color: '#2e7d32' }}>🔍 物件を検索</h4>
            <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '15px' }}>
              お客様の要望に基づいて、外部APIから物件PDFを自動取得します。
            </p>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button
                className="btn btn-primary"
                style={{ background: '#2e7d32' }}
                onClick={searchProperties}
                disabled={searchingProperties || !project.user_requirements}
              >
                {searchingProperties ? '検索中...' : '物件を検索して取得'}
              </button>
              {project.houses.length > 0 && (
                <span style={{ fontSize: '0.9rem', color: '#666' }}>
                  現在 {project.houses.length} 件の物件があります
                </span>
              )}
            </div>
          </div>

          <div style={{ marginTop: '30px', textAlign: 'center' }}>
            <p style={{ color: '#666', marginBottom: '15px' }}>
              {project.houses.length > 0
                ? '物件の準備ができました。ランダム選択に進んでください。'
                : '物件を検索するか、PDFをアップロードしてください。'}
            </p>
            <button
              className="btn btn-primary"
              onClick={() => setCurrentTab(0)}
              disabled={project.houses.length === 0}
            >
              ランダム選択へ進む →
            </button>
          </div>
        </div>
      )}

      {/* Requirements Section (shown on other tabs) */}
      {currentTab >= 0 && project.user_requirements && (
        <div className="requirements-section">
          <h3>お客様の要望</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{project.user_requirements}</p>
        </div>
      )}

      {/* User Profile (if analyzed) */}
      {project.user_profile && currentTab > 0 && (
        <div className="requirements-section" style={{ background: '#fff8e1' }}>
          <h3>ユーザープロフィール分析</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{project.user_profile}</p>
        </div>
      )}

      {/* Initial Random Sample Start */}
      {currentTab === 0 && roundHouses.length === 0 && (
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ marginBottom: '20px' }}>ランダムサンプリングを開始</h3>
          <p style={{ marginBottom: '20px', color: '#666' }}>
            アップロードされた{project.houses.length}件の物件から10件をランダムに選択します
          </p>
          {project.houses.length === 0 ? (
            <p style={{ color: '#dc2626' }}>
              まず物件PDFをアップロードしてください
            </p>
          ) : (
            <button
              className="btn btn-primary"
              onClick={startRandomSample}
              disabled={processing}
            >
              {processing ? '処理中...' : 'ランダム選択を開始'}
            </button>
          )}
        </div>
      )}

      {/* Houses Grid */}
      {currentTab >= 0 && roundHouses.length > 0 && (
        <div className="houses-grid">
          {roundHouses.map((house) => (
            <div key={house.id} className="house-card">
              <div className="house-pdf">
                <iframe
                  src={`/uploads/${projectId}/${encodeURIComponent(house.filename)}`}
                  title={house.filename}
                />
              </div>
              <div className="house-rating">
                <h4>{house.filename}</h4>

                <label
                  className={`rating-option good ${ratings[house.id]?.rating === 'good' ? 'selected' : ''}`}
                  onClick={() => handleRatingChange(house.id, 'good')}
                >
                  <span style={{ fontSize: '1.2rem' }}>👍</span>
                  良い
                </label>

                <label
                  className={`rating-option question ${ratings[house.id]?.rating === 'question' ? 'selected' : ''}`}
                  onClick={() => handleRatingChange(house.id, 'question')}
                >
                  <span style={{ fontSize: '1.2rem' }}>🤔</span>
                  疑問
                </label>

                <label
                  className={`rating-option bad ${ratings[house.id]?.rating === 'bad' ? 'selected' : ''}`}
                  onClick={() => handleRatingChange(house.id, 'bad')}
                >
                  <span style={{ fontSize: '1.2rem' }}>👎</span>
                  悪い
                </label>

                <textarea
                  className="textarea"
                  style={{ marginTop: '10px', minHeight: '60px' }}
                  placeholder="メモ（任意）"
                  value={ratings[house.id]?.notes || ''}
                  onChange={(e) => setRatings(prev => ({
                    ...prev,
                    [house.id]: {
                      ...prev[house.id],
                      notes: e.target.value
                    }
                  }))}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action Bar */}
      {currentTab >= 0 && roundHouses.length > 0 && (
        <div className="action-bar">
          <button className="btn btn-secondary" onClick={downloadAll}>
            一括ダウンロード
          </button>

          {currentTab <= 3 && currentTab === project.current_round && (
            <button
              className="btn btn-primary"
              onClick={submitRatingsAndNextRound}
              disabled={processing}
            >
              {processing ? (
                '処理中...'
              ) : currentTab === 3 ? (
                '評価を保存して完了'
              ) : (
                getNextButtonLabel(currentTab)
              )}
            </button>
          )}
        </div>
      )}

      {/* Processing Indicator */}
      {processing && (
        <div className="loading" style={{ marginTop: '30px' }}>
          <div className="loading-spinner"></div>
          <p>AIが分析中です。しばらくお待ちください...</p>
        </div>
      )}
    </>
  )
}

export default ProjectPage
