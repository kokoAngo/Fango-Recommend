import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';
import archiver from 'archiver';
import { PDFDocument } from 'pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3002;

// OpenAI configuration
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

if (!openai) {
  console.warn('Warning: OPENAI_API_KEY not set. AI features will be disabled.');
}

// Middleware
app.use(cors());
app.use(express.json());

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const projectId = req.params.projectId || 'temp';
    const uploadDir = path.join(__dirname, 'uploads', projectId);
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Preserve original filename with UTF-8 encoding
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  }
});

// Database setup
const db = new Database(path.join(__dirname, 'fango.db'));

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_requirements TEXT,
    user_profile TEXT,
    current_round INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS houses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT,
    summary TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    house_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    rating TEXT,
    notes TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (house_id) REFERENCES houses(id)
  );
`);

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes

// Get all projects
app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  res.json(projects);
});

// Create new project
app.post('/api/projects', (req, res) => {
  const id = uuidv4();
  const { name } = req.body;
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name || '新規プロジェクト');

  // Create upload directory for this project
  fs.mkdirSync(path.join(__dirname, 'uploads', id), { recursive: true });

  res.json({ id, name: name || '新規プロジェクト' });
});

// Get project by ID
app.get('/api/projects/:projectId', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const houses = db.prepare('SELECT * FROM houses WHERE project_id = ?').all(req.params.projectId);
  const recommendations = db.prepare('SELECT * FROM recommendations WHERE project_id = ?').all(req.params.projectId);

  res.json({ ...project, houses, recommendations });
});

// Upload files to project - splits multi-page PDFs into single pages
app.post('/api/projects/:projectId/upload', upload.array('files'), async (req, res) => {
  const { projectId } = req.params;
  const files = req.files;
  const { requirements } = req.body;

  // Update project requirements if provided
  if (requirements) {
    db.prepare('UPDATE projects SET user_requirements = ? WHERE id = ?').run(requirements, projectId);
  }

  const houseIds = [];
  const uploadDir = path.join(__dirname, 'uploads', projectId);

  for (const file of files) {
    if (file.mimetype === 'application/pdf') {
      const filePath = file.path;

      try {
        // Load the PDF
        const pdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pageCount = pdfDoc.getPageCount();

        console.log(`Splitting PDF: ${file.filename} (${pageCount} pages)`);

        // Split each page into a separate PDF
        for (let i = 0; i < pageCount; i++) {
          const houseId = uuidv4();
          const newPdfDoc = await PDFDocument.create();
          const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
          newPdfDoc.addPage(copiedPage);

          // Save single page PDF
          const pageFilename = `page_${i + 1}_${file.filename}`;
          const pagePath = path.join(uploadDir, pageFilename);
          const newPdfBytes = await newPdfDoc.save();
          fs.writeFileSync(pagePath, newPdfBytes);

          // Parse text content from single page
          let content = '';
          try {
            const pageData = await pdfParse(Buffer.from(newPdfBytes));
            content = pageData.text;
          } catch (parseErr) {
            console.error(`PDF parse error for page ${i + 1}:`, parseErr.message);
            content = '[PDFの解析に失敗しました]';
          }

          // Save to database
          db.prepare('INSERT INTO houses (id, project_id, filename, content) VALUES (?, ?, ?, ?)')
            .run(houseId, projectId, pageFilename, content);

          houseIds.push(houseId);
        }

        // Delete original multi-page PDF
        fs.unlinkSync(filePath);

      } catch (err) {
        console.error('PDF split error:', err.message);
        // Fallback: save original file as single house
        const houseId = uuidv4();
        db.prepare('INSERT INTO houses (id, project_id, filename, content) VALUES (?, ?, ?, ?)')
          .run(houseId, projectId, file.filename, '[PDFの分割に失敗しました]');
        houseIds.push(houseId);
      }
    }
  }

  res.json({ success: true, houseIds, pageCount: houseIds.length });
});

// Get random sample for initial round
app.post('/api/projects/:projectId/random-sample', (req, res) => {
  const { projectId } = req.params;

  // Get all houses not yet recommended in any round
  const recommendedHouseIds = db.prepare('SELECT house_id FROM recommendations WHERE project_id = ?')
    .all(projectId)
    .map(r => r.house_id);

  const availableHouses = db.prepare('SELECT * FROM houses WHERE project_id = ?')
    .all(projectId)
    .filter(h => !recommendedHouseIds.includes(h.id));

  // Randomly select up to 10 houses from available ones
  const shuffled = availableHouses.sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, Math.min(10, availableHouses.length));

  // Create recommendation entries for round 0
  for (const house of selected) {
    db.prepare('INSERT INTO recommendations (id, project_id, house_id, round) VALUES (?, ?, ?, 0)')
      .run(uuidv4(), projectId, house.id);
  }

  res.json({ houses: selected });
});

// Submit ratings and get recommendations
app.post('/api/projects/:projectId/rate', async (req, res) => {
  const { projectId } = req.params;
  const { ratings, round } = req.body; // ratings: [{houseId, rating, notes}]

  // Save ratings
  for (const r of ratings) {
    db.prepare('UPDATE recommendations SET rating = ?, notes = ? WHERE project_id = ? AND house_id = ? AND round = ?')
      .run(r.rating, r.notes || '', projectId, r.houseId, round);
  }

  // Update project round
  db.prepare('UPDATE projects SET current_round = ? WHERE id = ?').run(round + 1, projectId);

  res.json({ success: true });
});

// GPT Agent: Analyze user profile based on feedback
async function analyzeUserProfile(projectId) {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const recommendations = db.prepare(`
    SELECT r.*, h.content, h.filename
    FROM recommendations r
    JOIN houses h ON r.house_id = h.id
    WHERE r.project_id = ? AND r.rating IS NOT NULL
  `).all(projectId);

  const feedbackSummary = recommendations.map(r =>
    `物件: ${r.filename}\n評価: ${r.rating}\nメモ: ${r.notes || 'なし'}\n内容抜粋: ${r.content?.substring(0, 500) || '不明'}`
  ).join('\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `あなたは不動産の専門家です。ユーザーの物件評価から、ユーザーの好みや要望を分析してください。
以下の観点から分析を行ってください：
- 立地に関する好み
- 価格帯の傾向
- 間取りや広さの好み
- 設備・特徴に関する好み
- その他の重要な要素

日本語で分析結果をまとめてください。`
      },
      {
        role: 'user',
        content: `ユーザーの要望: ${project.user_requirements || '特になし'}\n\n過去の評価:\n${feedbackSummary}`
      }
    ]
  });

  const profile = response.choices[0].message.content;
  db.prepare('UPDATE projects SET user_profile = ? WHERE id = ?').run(profile, projectId);

  return profile;
}

// GPT Agent: Generate recommendations
async function generateRecommendations(projectId, round) {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

  // Get all houses not yet recommended
  const recommendedHouseIds = db.prepare('SELECT house_id FROM recommendations WHERE project_id = ?')
    .all(projectId)
    .map(r => r.house_id);

  const availableHouses = db.prepare('SELECT * FROM houses WHERE project_id = ?')
    .all(projectId)
    .filter(h => !recommendedHouseIds.includes(h.id));

  if (availableHouses.length === 0) {
    return [];
  }

  const houseSummaries = availableHouses.map(h =>
    `ID: ${h.id}\nファイル名: ${h.filename}\n内容: ${h.content?.substring(0, 800) || '内容不明'}`
  ).join('\n\n---\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `あなたは不動産推薦の専門家です。ユーザープロフィールに基づいて、最適な物件を10件選んでください。
回答は以下の形式でIDのみをカンマ区切りで返してください：
id1,id2,id3,...`
      },
      {
        role: 'user',
        content: `ユーザーの要望: ${project.user_requirements || '特になし'}

ユーザープロフィール: ${project.user_profile || '分析なし'}

利用可能な物件:\n${houseSummaries}

最適な物件を最大10件選んでください。`
      }
    ]
  });

  const selectedIds = response.choices[0].message.content.split(',').map(id => id.trim());
  const selectedHouses = availableHouses.filter(h => selectedIds.includes(h.id)).slice(0, 10);

  // If not enough matches, fill with random
  if (selectedHouses.length < 10) {
    const remaining = availableHouses.filter(h => !selectedIds.includes(h.id));
    const shuffled = remaining.sort(() => 0.5 - Math.random());
    selectedHouses.push(...shuffled.slice(0, 10 - selectedHouses.length));
  }

  // Create recommendation entries
  for (const house of selectedHouses) {
    db.prepare('INSERT INTO recommendations (id, project_id, house_id, round) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), projectId, house.id, round);
  }

  return selectedHouses;
}

// Get next round recommendations
app.post('/api/projects/:projectId/next-round', async (req, res) => {
  const { projectId } = req.params;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const nextRound = project.current_round;

  try {
    // First analyze user profile
    await analyzeUserProfile(projectId);

    // Then generate recommendations
    const houses = await generateRecommendations(projectId, nextRound);

    res.json({ houses, round: nextRound });
  } catch (error) {
    console.error('Recommendation error:', error);
    res.status(500).json({ error: 'Failed to generate recommendations' });
  }
});

// Get recommendations for a specific round
app.get('/api/projects/:projectId/rounds/:round', (req, res) => {
  const { projectId, round } = req.params;

  const recommendations = db.prepare(`
    SELECT r.*, h.filename, h.content
    FROM recommendations r
    JOIN houses h ON r.house_id = h.id
    WHERE r.project_id = ? AND r.round = ?
  `).all(projectId, parseInt(round));

  res.json({ recommendations });
});

// Download all PDFs as zip
app.get('/api/projects/:projectId/download/:round', (req, res) => {
  const { projectId, round } = req.params;

  const recommendations = db.prepare(`
    SELECT h.filename
    FROM recommendations r
    JOIN houses h ON r.house_id = h.id
    WHERE r.project_id = ? AND r.round = ?
  `).all(projectId, parseInt(round));

  const archive = archiver('zip', { zlib: { level: 9 } });
  const uploadDir = path.join(__dirname, 'uploads', projectId);

  res.attachment(`round_${round}_houses.zip`);
  archive.pipe(res);

  for (const rec of recommendations) {
    const filePath = path.join(uploadDir, rec.filename);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: rec.filename });
    }
  }

  archive.finalize();
});

// Delete project
app.delete('/api/projects/:projectId', (req, res) => {
  const { projectId } = req.params;

  db.prepare('DELETE FROM recommendations WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM houses WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  // Remove upload directory
  const uploadDir = path.join(__dirname, 'uploads', projectId);
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true });
  }

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
