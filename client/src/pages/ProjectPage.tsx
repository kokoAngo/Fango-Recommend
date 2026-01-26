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
  const [currentTab, setCurrentTab] = useState(0)
  const [roundHouses, setRoundHouses] = useState<House[]>([])
  const [ratings, setRatings] = useState<RatingState>({})
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)

  useEffect(() => {
    if (projectId) {
      fetchProject()
    }
  }, [projectId])

  useEffect(() => {
    if (project) {
      fetchRoundData(currentTab)
    }
  }, [currentTab, project?.id])

  const fetchProject = async () => {
    try {
      const res = await axios.get(`/api/projects/${projectId}`)
      setProject(res.data)
      setCurrentTab(res.data.current_round)
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

  const getTabLabel = (round: number) => {
    switch (round) {
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
        {[0, 1, 2, 3].map(round => (
          <button
            key={round}
            className={`tab ${currentTab === round ? 'active' : ''}`}
            onClick={() => setCurrentTab(round)}
            disabled={round > project.current_round}
          >
            {getTabLabel(round)}
          </button>
        ))}
      </div>

      {/* Requirements Section */}
      {project.user_requirements && (
        <div className="requirements-section">
          <h3>お客様の要望</h3>
          <p>{project.user_requirements}</p>
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
          <button
            className="btn btn-primary"
            onClick={startRandomSample}
            disabled={processing}
          >
            {processing ? '処理中...' : 'ランダム選択を開始'}
          </button>
        </div>
      )}

      {/* Houses Grid */}
      {roundHouses.length > 0 && (
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
      {roundHouses.length > 0 && (
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
