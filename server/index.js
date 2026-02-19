import 'dotenv/config';
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
import FormData from 'form-data';
import axios from 'axios';
import suumoScraper from './suumo-scraper.js';
import { syncPropertyToNotion, extractPropertyInfo, clearPropertyCache, cleanupDuplicates } from './notion-sync.js';

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

// Vector server configuration
const VECTOR_SERVER_BASE = process.env.VECTOR_SERVER || 'https://greasier-grossly-betty.ngrok-free.dev';
const VECTOR_SERVER = `${VECTOR_SERVER_BASE}/api/hybrid-rag`;
console.log(`Vector server: ${VECTOR_SERVER}`);

// External property search API configuration
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || 'http://localhost:3000';
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || 'fango-api-2024-secret-key-x7k9m2';
console.log(`External API: ${EXTERNAL_API_URL}`);

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

// Add suumo_customer_id column if not exists (for existing databases)
try {
  db.exec('ALTER TABLE projects ADD COLUMN suumo_customer_id TEXT');
  console.log('Added suumo_customer_id column to projects table');
} catch (e) {
  // Column already exists, ignore
}

// Create index after ensuring column exists
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_suumo_customer_id ON projects(suumo_customer_id)');
} catch (e) {
  // Index creation failed, ignore
}

// ============ SUUMO Auto-Sync Configuration ============
const SUUMO_AUTO_SYNC_INTERVAL = parseInt(process.env.SUUMO_SYNC_INTERVAL || '3600000'); // Default: 1 hour (3600000ms)
let suumoAutoSyncEnabled = process.env.SUUMO_AUTO_SYNC !== 'false'; // Enabled by default, can be toggled at runtime

// Parse SUUMO date format (e.g., "2026/1/28 10:21:05") to SQLite format ("2026-01-28 10:21:05")
function parseSuumoDate(dateStr) {
  if (!dateStr) return null;
  try {
    // Match format: YYYY/M/D H:M:S or YYYY/MM/DD HH:MM:SS
    const match = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (match) {
      const [, year, month, day, hour, min, sec] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}`;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Auto-sync function: Import new customers from SUUMO
async function autoSyncSuumoCustomers() {
  console.log('[SUUMO Auto-Sync] Starting automatic customer sync...');

  try {
    // Get current customer list from SUUMO
    const customers = await suumoScraper.getCustomerList();
    console.log(`[SUUMO Auto-Sync] Found ${customers.length} customers in SUUMO`);

    // Get existing SUUMO customer IDs from database
    const existingIds = db.prepare('SELECT suumo_customer_id FROM projects WHERE suumo_customer_id IS NOT NULL')
      .all()
      .map(p => p.suumo_customer_id);

    // Find new customers
    const newCustomers = customers.filter(c => !existingIds.includes(c.id));
    console.log(`[SUUMO Auto-Sync] ${newCustomers.length} new customers to import`);

    // Import each new customer
    let importedCount = 0;
    for (const customer of newCustomers) {
      try {
        console.log(`[SUUMO Auto-Sync] Importing customer ${customer.name} (ID: ${customer.id})...`);

        // Get detailed requirements
        const details = await suumoScraper.getCustomerRequirements(customer.id, customer);

        // Create new project with suumo_customer_id and inquiry date
        const projectId = uuidv4();
        const projectName = details.name || customer.name || `SUUMO顧客 ${customer.id}`;
        const createdAt = parseSuumoDate(details.inquiryDate);

        if (createdAt) {
          db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(projectId, projectName, details.requirements, customer.id, createdAt);
        } else {
          db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id) VALUES (?, ?, ?, ?)')
            .run(projectId, projectName, details.requirements, customer.id);
        }

        // Create upload directory
        fs.mkdirSync(path.join(__dirname, 'uploads', projectId), { recursive: true });

        console.log(`[SUUMO Auto-Sync] Created project ${projectId} for customer ${details.name}`);
        importedCount++;

        // Sync property info to Notion
        if (details.rawDetails) {
          const propertyInfo = extractPropertyInfo(details.rawDetails);
          if (propertyInfo && propertyInfo['物件名']) {
            const notionResult = await syncPropertyToNotion(propertyInfo);
            if (notionResult.success) {
              console.log(`[SUUMO Auto-Sync] Notion sync: ${notionResult.action} "${propertyInfo['物件名']}" (反響数: ${notionResult.newCount})`);
            }
          }
        }

        // Small delay between imports to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (importError) {
        console.error(`[SUUMO Auto-Sync] Failed to import customer ${customer.id}:`, importError.message);
      }
    }

    console.log(`[SUUMO Auto-Sync] Completed. Imported ${importedCount} new customers.`);
    return { total: customers.length, newCount: newCustomers.length, imported: importedCount };
  } catch (error) {
    console.error('[SUUMO Auto-Sync] Error:', error.message);
    throw error;
  }
}

// Start auto-sync timer
let autoSyncTimer = null;
let initialSyncTimeout = null;

function startAutoSync(runInitialSync = true) {
  if (autoSyncTimer) {
    console.log('[SUUMO Auto-Sync] Already running');
    return;
  }

  suumoAutoSyncEnabled = true;
  console.log(`[SUUMO Auto-Sync] Started, interval: ${SUUMO_AUTO_SYNC_INTERVAL / 1000 / 60} minutes`);

  // Run first sync after 10 seconds (give time for server to fully start)
  if (runInitialSync) {
    initialSyncTimeout = setTimeout(() => {
      if (suumoAutoSyncEnabled) {
        autoSyncSuumoCustomers().catch(err => console.error('[SUUMO Auto-Sync] Initial sync failed:', err.message));
      }
    }, 10000);
  }

  // Set up recurring sync
  autoSyncTimer = setInterval(() => {
    if (suumoAutoSyncEnabled) {
      autoSyncSuumoCustomers().catch(err => console.error('[SUUMO Auto-Sync] Scheduled sync failed:', err.message));
    }
  }, SUUMO_AUTO_SYNC_INTERVAL);
}

function stopAutoSync() {
  suumoAutoSyncEnabled = false;

  if (initialSyncTimeout) {
    clearTimeout(initialSyncTimeout);
    initialSyncTimeout = null;
  }

  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }

  console.log('[SUUMO Auto-Sync] Stopped');
}

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

// ============ SUUMO Integration APIs ============

// Manually trigger SUUMO sync
app.post('/api/suumo/sync', async (req, res) => {
  try {
    console.log('[API] Manual SUUMO sync triggered...');
    const result = await autoSyncSuumoCustomers();
    res.json({
      success: true,
      message: `同期完了: ${result.imported}件の新規顧客をインポートしました`,
      ...result
    });
  } catch (error) {
    console.error('[API] Manual SUUMO sync error:', error.message);
    res.status(500).json({ error: 'SUUMO同期に失敗しました', details: error.message });
  }
});

// Get SUUMO sync status
app.get('/api/suumo/status', (req, res) => {
  const totalProjects = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
  const suumoProjects = db.prepare('SELECT COUNT(*) as count FROM projects WHERE suumo_customer_id IS NOT NULL').get().count;

  res.json({
    autoSyncEnabled: suumoAutoSyncEnabled,
    syncIntervalMinutes: SUUMO_AUTO_SYNC_INTERVAL / 1000 / 60,
    totalProjects,
    suumoProjects
  });
});

// Batch sync all existing customers to Notion
app.post('/api/notion/sync-all', async (req, res) => {
  console.log('[API] Starting batch Notion sync for all existing customers...');

  // Clear cache before batch sync to ensure fresh state
  clearPropertyCache();

  try {
    // Get all SUUMO projects with requirements
    const projects = db.prepare(`
      SELECT id, name, user_requirements, suumo_customer_id
      FROM projects
      WHERE suumo_customer_id IS NOT NULL AND user_requirements IS NOT NULL
    `).all();

    console.log(`[Notion Batch] Found ${projects.length} SUUMO customers to sync`);

    let synced = 0;
    let created = 0;
    let incremented = 0;
    let failed = 0;

    for (const project of projects) {
      try {
        // Parse property info from user_requirements
        const requirements = project.user_requirements || '';
        const propertyInfo = {};

        // Extract fields from requirements text
        const fieldMatches = requirements.match(/【([^】]+)】([^\n【]*)/g);
        if (fieldMatches) {
          for (const match of fieldMatches) {
            const fieldMatch = match.match(/【([^】]+)】(.+)/);
            if (fieldMatch) {
              const key = fieldMatch[1].trim();
              const value = fieldMatch[2].trim();
              // Map field names
              if (key === '物件名') propertyInfo['物件名'] = value;
              else if (key === '物件種別') propertyInfo['物件種別'] = value;
              else if (key === '所在地') propertyInfo['所在地'] = value;
              else if (key === '最寄り駅') propertyInfo['最寄り駅'] = value;
              else if (key === '徒歩') propertyInfo['バス／歩'] = value;
              else if (key === '賃料') propertyInfo['賃料'] = value;
              else if (key === '間取り') propertyInfo['間取り'] = value;
              else if (key === '専有面積') propertyInfo['専有面積'] = value;
              else if (key === '物件URL') propertyInfo['物件詳細画面'] = value;
            }
          }
        }

        if (propertyInfo['物件名']) {
          const result = await syncPropertyToNotion(propertyInfo);
          if (result.success) {
            synced++;
            if (result.action === 'created') created++;
            else if (result.action === 'incremented') incremented++;
            console.log(`[Notion Batch] ${result.action}: ${propertyInfo['物件名']} (反響数: ${result.newCount})`);
          } else {
            failed++;
            console.log(`[Notion Batch] Failed: ${propertyInfo['物件名']} - ${result.reason}`);
          }
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        failed++;
        console.error(`[Notion Batch] Error for project ${project.id}:`, err.message);
      }
    }

    console.log(`[Notion Batch] Completed: ${synced} synced (${created} new, ${incremented} updated), ${failed} failed`);

    res.json({
      success: true,
      message: `Notion同期完了: ${synced}件同期 (${created}件新規, ${incremented}件更新)`,
      total: projects.length,
      synced,
      created,
      incremented,
      failed
    });
  } catch (error) {
    console.error('[API] Notion batch sync error:', error.message);
    res.status(500).json({ error: 'Notion同期に失敗しました', details: error.message });
  }
});

// Clean up duplicate entries in Notion
app.post('/api/notion/cleanup', async (req, res) => {
  console.log('[API] Starting Notion duplicate cleanup...');

  try {
    const result = await cleanupDuplicates();

    if (result.success) {
      res.json({
        success: true,
        message: `重複整理完了: ${result.mergedGroups}グループを統合、${result.deletedPages}件の重複を削除`,
        ...result
      });
    } else {
      res.status(500).json({ error: '重複整理に失敗しました', details: result.reason });
    }
  } catch (error) {
    console.error('[API] Notion cleanup error:', error.message);
    res.status(500).json({ error: '重複整理に失敗しました', details: error.message });
  }
});

// Toggle SUUMO auto-sync on/off
app.post('/api/suumo/auto-sync', (req, res) => {
  const { enabled } = req.body;

  if (enabled === true) {
    if (!suumoAutoSyncEnabled) {
      startAutoSync(false); // Don't run initial sync when manually enabling
      res.json({ success: true, autoSyncEnabled: true, message: '自動同期を有効にしました' });
    } else {
      res.json({ success: true, autoSyncEnabled: true, message: '自動同期は既に有効です' });
    }
  } else if (enabled === false) {
    stopAutoSync();
    res.json({ success: true, autoSyncEnabled: false, message: '自動同期を無効にしました' });
  } else {
    res.status(400).json({ error: 'enabled パラメータが必要です (true/false)' });
  }
});

// Get customer list from SUUMO JDS
app.get('/api/suumo/customers', async (req, res) => {
  try {
    console.log('[API] Fetching SUUMO customers...');
    const customers = await suumoScraper.getCustomerList();
    res.json({ customers });
  } catch (error) {
    console.error('[API] SUUMO customer fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch customers from SUUMO', details: error.message });
  }
});

// Import a customer from SUUMO and create a project
app.post('/api/suumo/import/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { customerData } = req.body;

    // Check if this customer is already imported
    const existingProject = db.prepare('SELECT id, name FROM projects WHERE suumo_customer_id = ?').get(customerId);
    if (existingProject) {
      return res.json({
        projectId: existingProject.id,
        name: existingProject.name,
        alreadyExists: true,
        message: 'この顧客は既にインポート済みです'
      });
    }

    console.log(`[API] Importing SUUMO customer ${customerId}...`);

    // Build requirements from customer data (already extracted from list)
    const details = await suumoScraper.getCustomerRequirements(customerId, customerData);

    // Create new project with suumo_customer_id and inquiry date
    const projectId = uuidv4();
    const projectName = details.name || customerData?.name || `SUUMO顧客 ${customerId}`;
    const createdAt = parseSuumoDate(details.inquiryDate);

    if (createdAt) {
      db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, projectName, details.requirements, customerId, createdAt);
    } else {
      db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id) VALUES (?, ?, ?, ?)')
        .run(projectId, projectName, details.requirements, customerId);
    }

    // Create upload directory for this project
    fs.mkdirSync(path.join(__dirname, 'uploads', projectId), { recursive: true });

    console.log(`[API] Created project ${projectId} for customer ${details.name}`);

    // Sync property info to Notion
    let notionSyncResult = null;
    if (details.rawDetails) {
      const propertyInfo = extractPropertyInfo(details.rawDetails);
      if (propertyInfo && propertyInfo['物件名']) {
        notionSyncResult = await syncPropertyToNotion(propertyInfo);
        if (notionSyncResult.success) {
          console.log(`[API] Notion sync: ${notionSyncResult.action} "${propertyInfo['物件名']}" (反響数: ${notionSyncResult.newCount})`);
        }
      }
    }

    res.json({
      projectId,
      name: projectName,
      requirements: details.requirements,
      customerDetails: details,
      notionSync: notionSyncResult
    });
  } catch (error) {
    console.error('[API] SUUMO import error:', error.message);
    res.status(500).json({ error: 'Failed to import customer from SUUMO', details: error.message });
  }
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

// Update project requirements
app.put('/api/projects/:projectId/requirements', (req, res) => {
  const { projectId } = req.params;
  const { requirements } = req.body;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  db.prepare('UPDATE projects SET user_requirements = ? WHERE id = ?').run(requirements, projectId);

  res.json({ success: true, requirements });
});

// Search properties using external API and save PDF
app.post('/api/projects/:projectId/search-properties', async (req, res) => {
  const { projectId } = req.params;
  const { userRequirements, typeId } = req.body;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (!EXTERNAL_API_KEY) {
    return res.status(500).json({ error: 'External API key not configured. Set EXTERNAL_API_KEY environment variable.' });
  }

  try {
    console.log(`[External API] Searching properties for project ${projectId}...`);
    console.log(`[External API] Requirements: ${userRequirements?.substring(0, 100)}...`);

    // Call external API to get PDF
    const response = await axios.post(
      `${EXTERNAL_API_URL}/api/external/search-pdf`,
      {
        userRequirements: userRequirements || project.user_requirements,
        typeId: typeId
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': EXTERNAL_API_KEY
        },
        responseType: 'arraybuffer',
        timeout: 120000 // 2 minutes timeout
      }
    );

    // Save PDF to project directory
    const uploadDir = path.join(__dirname, 'uploads', projectId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const pdfFilename = `search_result_${Date.now()}.pdf`;
    const pdfPath = path.join(uploadDir, pdfFilename);
    fs.writeFileSync(pdfPath, response.data);

    console.log(`[External API] PDF saved: ${pdfFilename} (${response.data.length} bytes)`);

    // Process the PDF (split pages, send to vector server, etc.)
    const pdfBytes = response.data;
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    console.log(`[External API] Processing PDF: ${pageCount} pages`);

    let processedPages = 0;
    const houseIds = [];

    // Try to send to vector server first
    try {
      const formData = new FormData();
      formData.append('file', Buffer.from(pdfBytes), {
        filename: pdfFilename,
        contentType: 'application/pdf'
      });
      formData.append('metadata', JSON.stringify({ project_id: projectId }));
      formData.append('build_immediately', 'true');
      formData.append('user_id', projectId);

      const vectorResponse = await axios.post(
        `${VECTOR_SERVER}/api/v1/pdf/process`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'ngrok-skip-browser-warning': 'true'
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 3000000
        }
      );

      if (vectorResponse.data.page_ids) {
        houseIds.push(...vectorResponse.data.page_ids);
        console.log(`[External API] Vector server processed ${houseIds.length} pages`);
      }
    } catch (vectorErr) {
      console.error('[External API] Vector server error:', vectorErr.message);
    }

    // Split PDF and save each page
    for (let i = 0; i < pageCount; i++) {
      const houseId = houseIds[i] || uuidv4();
      const pageFilename = `page_${i + 1}_${pdfFilename}`;

      const newPdfDoc = await PDFDocument.create();
      const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
      newPdfDoc.addPage(copiedPage);

      const pagePath = path.join(uploadDir, pageFilename);
      const newPdfBytes = await newPdfDoc.save();
      fs.writeFileSync(pagePath, newPdfBytes);

      // Save to database
      db.prepare('INSERT INTO houses (id, project_id, filename, content) VALUES (?, ?, ?, ?)')
        .run(houseId, projectId, pageFilename, `外部API検索結果 - ページ${i + 1}`);

      processedPages++;
    }

    // Delete the original combined PDF
    fs.unlinkSync(pdfPath);

    console.log(`[External API] Processed ${processedPages} pages for project ${projectId}`);

    res.json({
      success: true,
      message: `${processedPages}件の物件を取得しました`,
      processedPages,
      houseIds: houseIds.length > 0 ? houseIds : undefined
    });

  } catch (error) {
    console.error('[External API] Error:', error.message);
    if (error.response) {
      console.error('[External API] Response status:', error.response.status);
    }
    res.status(500).json({
      error: 'Failed to search properties',
      details: error.message
    });
  }
});

// Upload files to project - sends PDF to vector server and uses returned page_ids
app.post('/api/projects/:projectId/upload', upload.array('files'), async (req, res) => {
  const { projectId } = req.params;
  const files = req.files;
  const { requirements } = req.body;

  // Collect all requirements (from form + TXT files)
  let allRequirements = requirements || '';

  // Process TXT files first to collect requirements
  for (const file of files) {
    if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
      try {
        const txtContent = fs.readFileSync(file.path, 'utf-8');
        allRequirements += (allRequirements ? '\n\n' : '') + `【${file.originalname}】\n${txtContent}`;
        // Delete TXT file after reading
        fs.unlinkSync(file.path);
        console.log(`Read TXT file: ${file.originalname}`);
      } catch (err) {
        console.error('TXT read error:', err.message);
      }
    }
  }

  // Update project requirements if any
  if (allRequirements) {
    db.prepare('UPDATE projects SET user_requirements = ? WHERE id = ?').run(allRequirements, projectId);
  }

  const houseIds = [];
  const uploadDir = path.join(__dirname, 'uploads', projectId);

  for (const file of files) {
    if (file.mimetype === 'application/pdf') {
      const filePath = file.path;

      try {
        // Send PDF to vector server first
        console.log(`Sending PDF to vector server: ${file.filename}`);

        // Use axios with form-data for reliable multipart upload
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), {
          filename: file.filename,
          contentType: 'application/pdf'
        });
        formData.append('metadata', JSON.stringify({ project_id: projectId }));
        formData.append('build_immediately', 'true');
        formData.append('user_id', projectId);

        const vectorResponse = await axios.post(
          `${VECTOR_SERVER}/api/v1/pdf/process`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              'ngrok-skip-browser-warning': 'true'
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );

        const vectorResult = vectorResponse.data;
        console.log(`Vector server processed ${vectorResult.processed_pages} pages, page_ids:`, vectorResult.page_ids);

        // Now split PDF locally and use vector server's page_ids
        const pdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pageCount = pdfDoc.getPageCount();

        console.log(`Splitting PDF locally: ${file.filename} (${pageCount} pages)`);

        // Match pages with vector server's page_ids
        for (let i = 0; i < pageCount; i++) {
          // Use vector server's page_id if available, otherwise generate locally
          const houseId = vectorResult.page_ids?.[i] || uuidv4();

          const newPdfDoc = await PDFDocument.create();
          const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
          newPdfDoc.addPage(copiedPage);

          // Save single page PDF locally
          const pageFilename = `page_${i + 1}_${file.filename}`;
          const pagePath = path.join(uploadDir, pageFilename);
          const newPdfBytes = await newPdfDoc.save();
          fs.writeFileSync(pagePath, newPdfBytes);

          // Get content from vector server response or parse locally
          let content = '';
          const pageInfo = vectorResult.pages?.find(p => p.page_number === i + 1);
          if (pageInfo) {
            content = `[Vector server processed] Keywords: ${pageInfo.keywords?.join(', ') || 'none'}`;
          } else {
            try {
              const pageData = await pdfParse(Buffer.from(newPdfBytes));
              content = pageData.text;
            } catch (parseErr) {
              console.error(`PDF parse error for page ${i + 1}:`, parseErr.message);
              content = '[PDFの解析に失敗しました]';
            }
          }

          // Save to local database with vector server's page_id
          db.prepare('INSERT INTO houses (id, project_id, filename, content) VALUES (?, ?, ?, ?)')
            .run(houseId, projectId, pageFilename, content);

          houseIds.push(houseId);
          console.log(`Saved house ${houseId} (page ${i + 1})`);
        }

        // Delete original multi-page PDF
        fs.unlinkSync(filePath);

      } catch (err) {
        console.error('PDF processing error:', err.message);

        // Fallback: process locally without vector server
        try {
          const pdfBytes = fs.readFileSync(filePath);
          const pdfDoc = await PDFDocument.load(pdfBytes);
          const pageCount = pdfDoc.getPageCount();

          for (let i = 0; i < pageCount; i++) {
            const houseId = uuidv4();
            const newPdfDoc = await PDFDocument.create();
            const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
            newPdfDoc.addPage(copiedPage);

            const pageFilename = `page_${i + 1}_${file.filename}`;
            const pagePath = path.join(uploadDir, pageFilename);
            const newPdfBytes = await newPdfDoc.save();
            fs.writeFileSync(pagePath, newPdfBytes);

            let content = '';
            try {
              const pageData = await pdfParse(Buffer.from(newPdfBytes));
              content = pageData.text;
            } catch (parseErr) {
              content = '[PDFの解析に失敗しました]';
            }

            db.prepare('INSERT INTO houses (id, project_id, filename, content) VALUES (?, ?, ?, ?)')
              .run(houseId, projectId, pageFilename, content);
            houseIds.push(houseId);
          }

          fs.unlinkSync(filePath);
        } catch (fallbackErr) {
          console.error('Fallback processing error:', fallbackErr.message);
          const houseId = uuidv4();
          db.prepare('INSERT INTO houses (id, project_id, filename, content) VALUES (?, ?, ?, ?)')
            .run(houseId, projectId, file.filename, '[処理に失敗しました]');
          houseIds.push(houseId);
        }
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

// Map local ratings to vector server ratings
function mapRating(localRating) {
  const ratingMap = {
    'good': 'good',
    'question': 'medium',
    'bad': 'poor'
  };
  return ratingMap[localRating] || 'medium';
}

// Recommendations with fallback: Vector Server → GPT → Random
async function generateRecommendations(projectId, round) {
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

  // Get all rated recommendations for this project
  const ratedRecommendations = db.prepare(`
    SELECT house_id, rating FROM recommendations
    WHERE project_id = ? AND rating IS NOT NULL
  `).all(projectId);

  let selectedHouses = [];
  let vectorServerSuccess = false;

  // ============ 1. Try Vector Server First ============
  if (ratedRecommendations.length > 0) {
    try {
      const ratingsForServer = ratedRecommendations.map(r => ({
        page_id: r.house_id,
        rating: mapRating(r.rating)
      }));

      console.log(`[Vector] Calling /api/v1/recommend with ${ratingsForServer.length} ratings, excluding ${recommendedHouseIds.length} already recommended`);

      const response = await fetch(`${VECTOR_SERVER}/api/v1/recommend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          ratings: ratingsForServer,
          limit: 10,
          exclude_rated: true,
          exclude_page_ids: recommendedHouseIds,
          user_id: projectId
        })
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[Vector] Server returned ${result.total_recommendations} recommendations`);

        for (const rec of result.recommendations || []) {
          const house = db.prepare('SELECT * FROM houses WHERE id = ? AND project_id = ?')
            .get(rec.page_id, projectId);
          if (house && !recommendedHouseIds.includes(house.id)) {
            selectedHouses.push(house);
            if (selectedHouses.length >= 10) break;
          }
        }

        if (selectedHouses.length > 0) {
          vectorServerSuccess = true;
          console.log(`[Vector] Got ${selectedHouses.length} valid recommendations`);
        }
      } else {
        const errorText = await response.text();
        console.error('[Vector] Failed:', response.status, errorText);
      }
    } catch (err) {
      console.error('[Vector] Error:', err.message);
    }
  }

  // ============ 2. Fallback to GPT if Vector Server failed or not enough ============
  if (selectedHouses.length < 10 && openai) {
    try {
      console.log(`[GPT] Trying GPT fallback (have ${selectedHouses.length} from vector)`);

      const selectedIds = selectedHouses.map(h => h.id);
      const remainingHouses = availableHouses.filter(h => !selectedIds.includes(h.id));

      if (remainingHouses.length > 0) {
        const houseSummaries = remainingHouses.map(h =>
          `ID: ${h.id}\nファイル名: ${h.filename}\n内容: ${h.content?.substring(0, 800) || '内容不明'}`
        ).join('\n\n---\n\n');

        const gptResponse = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `あなたは不動産推薦の専門家です。ユーザープロフィールに基づいて、最適な物件を選んでください。
回答は以下の形式でIDのみをカンマ区切りで返してください：
id1,id2,id3,...`
            },
            {
              role: 'user',
              content: `ユーザーの要望: ${project.user_requirements || '特になし'}

ユーザープロフィール: ${project.user_profile || '分析なし'}

利用可能な物件:\n${houseSummaries}

最適な物件を最大${10 - selectedHouses.length}件選んでください。`
            }
          ]
        });

        const gptSelectedIds = gptResponse.choices[0].message.content.split(',').map(id => id.trim());
        const gptHouses = remainingHouses.filter(h => gptSelectedIds.includes(h.id));

        console.log(`[GPT] Selected ${gptHouses.length} houses`);
        selectedHouses.push(...gptHouses.slice(0, 10 - selectedHouses.length));
      }
    } catch (gptErr) {
      console.error('[GPT] Error:', gptErr.message);
    }
  }

  // ============ 3. Final Fallback: Random ============
  if (selectedHouses.length < 10) {
    const selectedIds = selectedHouses.map(h => h.id);
    const remaining = availableHouses.filter(h => !selectedIds.includes(h.id));
    const shuffled = remaining.sort(() => 0.5 - Math.random());
    const fillCount = Math.min(10 - selectedHouses.length, shuffled.length);
    selectedHouses.push(...shuffled.slice(0, fillCount));
    console.log(`[Random] Filled with ${fillCount} random houses`);
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
    // First analyze user profile (optional, may timeout)
    console.log(`Starting next round ${nextRound} for project ${projectId}`);
    try {
      console.log('Analyzing user profile with GPT...');
      await analyzeUserProfile(projectId);
      console.log('User profile analysis complete');
    } catch (profileErr) {
      console.error('Profile analysis failed (continuing without it):', profileErr.message);
    }

    // Then generate recommendations
    console.log('Generating recommendations...');
    const houses = await generateRecommendations(projectId, nextRound);
    console.log(`Generated ${houses.length} recommendations`);

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
app.delete('/api/projects/:projectId', async (req, res) => {
  const { projectId } = req.params;

  // Note: Vector server doesn't have delete API yet
  // Vectors will remain in Milvus (can be cleaned up manually later)
  console.log(`Deleting project ${projectId} (vectors will remain in Milvus)`);

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

  // Start SUUMO auto-sync if enabled by default
  if (process.env.SUUMO_AUTO_SYNC !== 'false') {
    startAutoSync();
  } else {
    console.log('[SUUMO Auto-Sync] Disabled via environment variable');
  }
});
