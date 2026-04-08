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
import { syncPropertyToNotion, extractPropertyInfo, clearPropertyCache, cleanupDuplicates, syncRecommendationToNotion } from './notion-sync.js';
import crypto from 'crypto';
import lineHandler from './line-handler.js';
import createAuth from './auth.js';
import bcrypt from 'bcryptjs';

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
// Skip JSON parsing for LINE webhook (needs raw body for signature verification)
app.use((req, res, next) => {
  if (req.path === '/api/line/webhook') {
    return next();
  }
  express.json()(req, res, next);
});

// Auth - initialized after db setup, wrapper allows deferred binding
let _authMiddleware, _loginHandler;
app.use((req, res, next) => _authMiddleware ? _authMiddleware(req, res, next) : next());

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
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

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

// Add owner_id column to projects if not exists
try {
  db.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id)');
  console.log('Added owner_id column to projects table');
} catch (e) {
  // Column already exists
}

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id)');
} catch (e) {
  // Index creation failed
}

// Seed admin user from .env
(function seedAdminUser() {
  const adminUsername = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'admin';
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
  if (!existing) {
    const id = uuidv4();
    const hash = bcrypt.hashSync(adminPass, 10);
    db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
      .run(id, adminUsername, hash, '管理者', 'admin');
    console.log(`Seeded admin user: ${adminUsername}`);
    // Assign all existing projects to admin
    db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(id);
    console.log('Assigned existing projects to admin user');
  }
})();

// ============ LINE Integration Database Setup ============
// Add line_user_id and source columns if not exists
try {
  db.exec('ALTER TABLE projects ADD COLUMN line_user_id TEXT');
  console.log('Added line_user_id column to projects table');
} catch (e) {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN source TEXT DEFAULT 'manual'");
  console.log('Added source column to projects table');
} catch (e) {
  // Column already exists
}

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_line_user_id ON projects(line_user_id)');
} catch (e) {
  // Index creation failed
}

// Create line_conversations table
db.exec(`
  CREATE TABLE IF NOT EXISTS line_conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_content TEXT,
    sender TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_line_conversations_project ON line_conversations(project_id);
  CREATE INDEX IF NOT EXISTS idx_line_conversations_user ON line_conversations(line_user_id);
`);

// ============ REINS ID Database Setup ============
// Add reins_id column to houses table if not exists
try {
  db.exec('ALTER TABLE houses ADD COLUMN reins_id TEXT');
  console.log('Added reins_id column to houses table');
} catch (e) {
  // Column already exists
}

// Add platform column to houses table if not exists
try {
  db.exec('ALTER TABLE houses ADD COLUMN platform TEXT');
  console.log('Added platform column to houses table');
} catch (e) {
  // Column already exists
}

// Create index for reins_id
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_houses_reins_id ON houses(reins_id)');
} catch (e) {
  // Index creation failed
}

// LINE configuration check
const LINE_ENABLED = lineHandler.isLineConfigured();
if (LINE_ENABLED) {
  console.log('[LINE] Webhook integration enabled');
} else {
  console.warn('[LINE] Missing credentials, LINE integration disabled');
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
        const adminId = getAdminUserId();

        if (createdAt) {
          db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(projectId, projectName, details.requirements, customer.id, createdAt, adminId);
        } else {
          db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id, owner_id) VALUES (?, ?, ?, ?, ?)')
            .run(projectId, projectName, details.requirements, customer.id, adminId);
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

// Initialize auth (after db is ready)
const auth = createAuth(db);
_authMiddleware = auth.authMiddleware;
_loginHandler = auth.loginHandler;
app.post('/api/auth/login', (req, res) => _loginHandler(req, res));

// Get current user info
app.get('/api/auth/me', (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Helper: admin-only guard
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  next();
}

// Helper: project ownership check
function requireProjectAccess(req, res, next) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (req.user.role !== 'admin' && project.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'アクセス権限がありません' });
  }
  req.project = project;
  next();
}

// Helper: get admin user id (for background jobs)
function getAdminUserId() {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  return admin?.id;
}

// ============ User Management APIs (admin only) ============
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, created_at FROM users').all();
  for (const user of users) {
    user.projectCount = db.prepare('SELECT COUNT(*) as count FROM projects WHERE owner_id = ?').get(user.id).count;
  }
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'このユーザー名は既に使用されています' });
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, hash, displayName || username, role || 'user');
  res.json({ id, username, displayName: displayName || username, role: role || 'user' });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: '自分自身は削除できません' });
  }
  const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
  const targetUser = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!targetUser) {
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  }
  if (targetUser.role === 'admin' && adminCount <= 1) {
    return res.status(400).json({ error: '最後の管理者は削除できません' });
  }
  db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id = ?').run(req.user.id, id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes

// Get all projects (filtered by owner, admin sees all)
app.get('/api/projects', (req, res) => {
  const projects = req.user.role === 'admin'
    ? db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(projects);
});

// Create new project
app.post('/api/projects', (req, res) => {
  const id = uuidv4();
  const { name } = req.body;
  db.prepare('INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)').run(id, name || '新規プロジェクト', req.user.id);

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
    const ownerId = req.user.id;

    if (createdAt) {
      db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, projectName, details.requirements, customerId, createdAt, ownerId);
    } else {
      db.prepare('INSERT INTO projects (id, name, user_requirements, suumo_customer_id, owner_id) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, projectName, details.requirements, customerId, ownerId);
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
app.get('/api/projects/:projectId', requireProjectAccess, (req, res) => {
  const project = req.project;
  const houses = db.prepare('SELECT * FROM houses WHERE project_id = ?').all(project.id);
  const recommendations = db.prepare('SELECT * FROM recommendations WHERE project_id = ?').all(project.id);

  res.json({ ...project, houses, recommendations });
});

// Update project requirements
app.put('/api/projects/:projectId/requirements', requireProjectAccess, (req, res) => {
  const { projectId } = req.params;
  const { requirements } = req.body;

  db.prepare('UPDATE projects SET user_requirements = ? WHERE id = ?').run(requirements, projectId);

  res.json({ success: true, requirements });
});

// Search properties using external API and write REINS IDs to Notion
app.post('/api/projects/:projectId/search-properties', requireProjectAccess, async (req, res) => {
  const { projectId } = req.params;
  const { userRequirements, typeId } = req.body;
  const project = req.project;

  try {
    console.log(`[Search] Searching properties for project ${projectId} (${project.name})...`);
    console.log(`[Search] Requirements: ${userRequirements?.substring(0, 100)}...`);

    // Call Fango API to get REINS IDs
    const response = await axios.post(
      `${EXTERNAL_API_URL}/api/external/search-pdf`,
      {
        userRequirements: userRequirements || project.user_requirements,
        typeId: typeId
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': EXTERNAL_API_KEY
        },
        timeout: 600000 // 10 minutes timeout
      }
    );

    // Fango returns: { success: true, reins_ids: [...], total_properties: N }
    const { reins_ids } = response.data;

    if (!reins_ids || reins_ids.length === 0) {
      return res.json({
        success: true,
        message: '物件が見つかりませんでした',
        count: 0,
        reinsIds: []
      });
    }

    // Convert to properties format for downstream processing
    const properties = reins_ids.map(id => ({ reins_id: id, platform: 'reins' }));

    console.log(`[Search] Received ${properties.length} REINS IDs from Fango`);

    // Write each REINS ID to Notion with user info
    const reinsIds = [];
    const notionResults = [];

    for (const prop of properties) {
      const { reins_id, platform } = prop;

      if (!reins_id) continue;

      reinsIds.push(reins_id);

      // Sync to Notion
      const recInfo = {
        reins_id: reins_id,
        project_id: projectId,
        user_name: project.name || 'Unknown',
        platform: platform || 'unknown',
        round: 0  // Initial search, round 0
      };

      try {
        const result = await syncRecommendationToNotion(recInfo);
        notionResults.push({ reins_id, ...result });
        console.log(`[Search] Synced to Notion: ${reins_id} (${result.action})`);
      } catch (notionErr) {
        console.error(`[Search] Notion sync error for ${reins_id}:`, notionErr.message);
        notionResults.push({ reins_id, success: false, error: notionErr.message });
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    const successCount = notionResults.filter(r => r.success).length;
    console.log(`[Search] Synced ${successCount}/${reinsIds.length} properties to Notion`);

    res.json({
      success: true,
      message: `${reinsIds.length}件の物件を取得し、${successCount}件をNotionに同期しました`,
      count: reinsIds.length,
      reinsIds,
      notionSyncResults: notionResults
    });

  } catch (error) {
    console.error('[Search] Error:', error.message);

    // Connection refused / API not running
    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
      console.error(`[Search] External API unreachable at ${EXTERNAL_API_URL}`);
      return res.status(503).json({
        error: '物件検索APIに接続できません',
        details: `外部API (${EXTERNAL_API_URL}) が起動していない可能性があります。`,
        code: error.code
      });
    }

    if (error.response) {
      console.error('[Search] Response status:', error.response.status);

      // 404 with search result body = no matching properties
      if (error.response.status === 404 && error.response.data?.parsed_requirements) {
        return res.json({
          success: true,
          message: '条件に合う物件が見つかりませんでした。条件を変更してお試しください。',
          count: 0,
          reinsIds: [],
          parsedRequirements: error.response.data.parsed_requirements
        });
      }

      // 404 without search body = endpoint not found (API misconfiguration)
      if (error.response.status === 404) {
        console.error(`[Search] Endpoint not found: ${EXTERNAL_API_URL}/api/external/search-pdf`);
        return res.status(502).json({
          error: '物件検索APIのエンドポイントが見つかりません',
          details: `${EXTERNAL_API_URL}/api/external/search-pdf が存在しません。APIのバージョンや設定を確認してください。`
        });
      }
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
  // Check project access
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role !== 'admin' && project.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'アクセス権限がありません' });
  }
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
app.post('/api/projects/:projectId/random-sample', requireProjectAccess, (req, res) => {
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
app.post('/api/projects/:projectId/rate', requireProjectAccess, async (req, res) => {
  const { projectId } = req.params;
  const { ratings, round } = req.body; // ratings: [{houseId, rating, notes}]
  const project = req.project;

  // Save ratings and sync to Notion
  const notionResults = [];
  for (const r of ratings) {
    db.prepare('UPDATE recommendations SET rating = ?, notes = ? WHERE project_id = ? AND house_id = ? AND round = ?')
      .run(r.rating, r.notes || '', projectId, r.houseId, round);

    // Get house info for Notion sync
    const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(r.houseId);

    // Sync to Notion if house has reins_id
    if (house?.reins_id) {
      // Parse content for property details
      const contentLines = (house.content || '').split('\n');
      const getField = (prefix) => {
        const line = contentLines.find(l => l.startsWith(prefix));
        return line ? line.replace(prefix, '').trim() : '';
      };

      const recInfo = {
        reins_id: house.reins_id,
        project_id: projectId,
        user_name: project?.name || 'Unknown',
        platform: house.platform || 'unknown',
        round: round,
        rating: r.rating,
        location: getField('所在地:'),
        rent: getField('賃料:'),
        layout: getField('間取り:')
      };

      try {
        const result = await syncRecommendationToNotion(recInfo);
        notionResults.push(result);
        console.log(`[Rate] Synced to Notion: ${house.reins_id} (${r.rating})`);
      } catch (err) {
        console.error(`[Rate] Notion sync error for ${house.reins_id}:`, err.message);
      }
    }
  }

  // Update project round
  db.prepare('UPDATE projects SET current_round = ? WHERE id = ?').run(round + 1, projectId);

  res.json({
    success: true,
    notionSync: {
      total: notionResults.length,
      success: notionResults.filter(r => r.success).length
    }
  });
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
app.post('/api/projects/:projectId/next-round', requireProjectAccess, async (req, res) => {
  const { projectId } = req.params;
  const project = req.project;

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
app.get('/api/projects/:projectId/rounds/:round', requireProjectAccess, (req, res) => {
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
app.get('/api/projects/:projectId/download/:round', requireProjectAccess, (req, res) => {
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
app.delete('/api/projects/:projectId', requireProjectAccess, async (req, res) => {
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

// ============ LINE Webhook and Management APIs ============

// LINE Webhook endpoint (receives events from LINE)
// IMPORTANT: This must use raw body for signature verification
app.post('/api/line/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!LINE_ENABLED) {
    return res.status(503).json({ error: 'LINE integration not configured' });
  }

  // Verify signature
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    console.log('[LINE] Missing signature');
    return res.status(400).json({ error: 'Missing signature' });
  }

  // Use raw buffer for signature verification
  const bodyBuffer = req.body;
  if (!lineHandler.verifySignature(bodyBuffer, signature)) {
    console.log('[LINE] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse events
  let events;
  try {
    events = JSON.parse(bodyBuffer.toString()).events;
  } catch (e) {
    console.error('[LINE] Failed to parse body:', e.message);
    return res.status(400).json({ error: 'Invalid body' });
  }

  // Respond quickly (LINE expects response within seconds)
  res.status(200).end();

  // Process events asynchronously
  for (const event of events) {
    await processLineEvent(event);
  }
});

// Process LINE event
async function processLineEvent(event) {
  console.log('[LINE] Event received:', event.type);

  // Handle follow event (user adds friend)
  if (event.type === 'follow') {
    await handleLineFollowEvent(event);
    return;
  }

  // Only process message events
  if (event.type !== 'message') {
    console.log('[LINE] Ignoring non-message event');
    return;
  }

  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const messageType = event.message.type;

  // Handle file messages (chat record txt files)
  if (messageType === 'file') {
    await handleLineChatRecordFile(event, userId, replyToken);
    return;
  }

  // Handle text messages - check if it looks like pasted chat record
  if (messageType === 'text') {
    const messageText = event.message.text;

    // Check if text looks like a pasted chat record (contains date/time patterns)
    const isChatRecord = messageText.includes('\n') &&
      (messageText.match(/\d{4}\/\d{1,2}\/\d{1,2}/) ||
       messageText.match(/\d{1,2}:\d{2}\t/));

    if (isChatRecord) {
      await handleLineChatRecordText(messageText, userId, replyToken);
      return;
    }

    // Otherwise handle as regular message
    await handleLineRegularMessage(messageText, userId, replyToken);
    return;
  }

  console.log(`[LINE] Ignoring unsupported message type: ${messageType}`);
}

// Handle chat record txt file upload
async function handleLineChatRecordFile(event, userId, replyToken) {
  const messageId = event.message.id;
  const fileName = event.message.fileName || 'unknown.txt';

  console.log(`[LINE] Received file: ${fileName} from ${userId}`);

  // Check if it's a txt file
  if (!fileName.toLowerCase().endsWith('.txt')) {
    await lineHandler.replyMessage(replyToken,
      lineHandler.textMessage('申し訳ございません。現在、.txt形式のファイルのみ対応しております。')
    );
    return;
  }

  // Download file content
  const fileContent = await lineHandler.getMessageContent(messageId);
  if (!fileContent) {
    await lineHandler.replyMessage(replyToken,
      lineHandler.textMessage('ファイルの取得に失敗しました。もう一度お試しください。')
    );
    return;
  }

  // Decode content as UTF-8
  const chatText = fileContent.toString('utf-8');
  console.log(`[LINE] File content length: ${chatText.length} chars`);

  await processChatRecord(chatText, userId, replyToken, fileName);
}

// Handle pasted chat record text
async function handleLineChatRecordText(chatText, userId, replyToken) {
  console.log(`[LINE] Processing pasted chat record from ${userId}`);
  await processChatRecord(chatText, userId, replyToken, 'pasted_chat');
}

// Process chat record (from file or pasted text)
async function processChatRecord(chatText, userId, replyToken, source) {
  // Parse the chat record
  const parsedMessages = lineHandler.parseChatExportTxt(chatText);
  console.log(`[LINE] Parsed ${parsedMessages.length} messages from chat record`);

  // Format for analysis
  let formattedChat = chatText;
  if (parsedMessages.length > 0) {
    formattedChat = parsedMessages.map(m =>
      `[${m.date} ${m.time}] ${m.sender}: ${m.content}`
    ).join('\n');
  }

  // Extract customer name from chat if possible
  let customerName = '顧客';
  if (parsedMessages.length > 0) {
    // Find the most common sender that's not likely the agent
    const senderCounts = {};
    parsedMessages.forEach(m => {
      senderCounts[m.sender] = (senderCounts[m.sender] || 0) + 1;
    });
    const senders = Object.keys(senderCounts);
    if (senders.length > 0) {
      customerName = senders[0]; // First sender is likely the customer
    }
  }

  // Analyze chat record with GPT
  let requirements = null;
  if (openai) {
    await lineHandler.replyMessage(replyToken,
      lineHandler.textMessage(`📝 チャット履歴を受け取りました。\n分析中です...お待ちください。`)
    );

    requirements = await lineHandler.analyzeChatRecord(formattedChat, openai);
    console.log(`[LINE] Chat analysis completed`);
  } else {
    requirements = `【チャット履歴】\n${chatText.substring(0, 2000)}${chatText.length > 2000 ? '...(省略)' : ''}`;
  }

  // Create new project
  const projectId = uuidv4();
  const projectName = `${customerName} (${new Date().toLocaleDateString('ja-JP')})`;

  db.prepare(`
    INSERT INTO projects (id, name, line_user_id, source, user_requirements, owner_id)
    VALUES (?, ?, ?, 'line_chat_import', ?, ?)
  `).run(projectId, projectName, userId, requirements || chatText, getAdminUserId());

  // Create upload directory
  fs.mkdirSync(path.join(__dirname, 'uploads', projectId), { recursive: true });

  // Save the original chat record as a conversation entry
  db.prepare(`
    INSERT INTO line_conversations (id, project_id, line_user_id, message_type, message_content, sender)
    VALUES (?, ?, ?, 'chat_record', ?, 'import')
  `).run(uuidv4(), projectId, userId, chatText);

  console.log(`[LINE] Created project ${projectId} from chat record`);

  // Send confirmation with extracted requirements
  const confirmMessage = requirements
    ? `✅ チャット履歴の分析が完了しました！\n\nプロジェクト「${projectName}」を作成しました。\n\n${requirements.substring(0, 800)}${requirements.length > 800 ? '\n...(続く)' : ''}`
    : `✅ チャット履歴を保存しました。\n\nプロジェクト「${projectName}」を作成しました。`;

  await lineHandler.pushMessage(userId, lineHandler.textMessage(confirmMessage));
}

// Handle regular text message (not chat record)
async function handleLineRegularMessage(messageText, userId, replyToken) {
  console.log(`[LINE] Regular message from ${userId}: ${messageText.substring(0, 50)}...`);

  // Find existing project for this user
  let project = db.prepare(`
    SELECT * FROM projects
    WHERE line_user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId);

  if (!project) {
    // Create new project for this user
    const profile = await lineHandler.getUserProfile(userId);
    const userName = profile?.displayName || `LINE顧客 ${userId.substring(0, 8)}`;

    const projectId = uuidv4();
    db.prepare(`
      INSERT INTO projects (id, name, line_user_id, source, user_requirements, owner_id)
      VALUES (?, ?, ?, 'line', ?, ?)
    `).run(projectId, userName, userId, `【LINE会話開始】\n${messageText}`, getAdminUserId());

    project = { id: projectId, name: userName };

    // Create upload directory
    fs.mkdirSync(path.join(__dirname, 'uploads', projectId), { recursive: true });
    console.log(`[LINE] Created new project ${projectId} for ${userName}`);

    // Save first message
    db.prepare(`
      INSERT INTO line_conversations (id, project_id, line_user_id, message_type, message_content, sender)
      VALUES (?, ?, ?, 'text', ?, 'user')
    `).run(uuidv4(), projectId, userId, messageText);

    // Send welcome message
    await lineHandler.replyMessage(replyToken, lineHandler.getWelcomeMessage(profile?.displayName));
  } else {
    // Save conversation
    const convId = uuidv4();
    db.prepare(`
      INSERT INTO line_conversations (id, project_id, line_user_id, message_type, message_content, sender)
      VALUES (?, ?, ?, 'text', ?, 'user')
    `).run(convId, project.id, userId, messageText);

    // Update requirements with new message
    const currentReqs = project.user_requirements || '';
    const updatedReqs = currentReqs + '\n' + messageText;
    db.prepare('UPDATE projects SET user_requirements = ? WHERE id = ?')
      .run(updatedReqs, project.id);

    // Check message count for auto-analysis
    const messageCount = db.prepare(`
      SELECT COUNT(*) as count FROM line_conversations
      WHERE project_id = ? AND sender = 'user'
    `).get(project.id).count;

    const threshold = parseInt(process.env.LINE_MESSAGE_ANALYZE_THRESHOLD || '3');

    if (messageCount >= threshold && openai) {
      // Analyze conversation and extract structured requirements
      const messages = db.prepare(`
        SELECT * FROM line_conversations
        WHERE project_id = ? ORDER BY timestamp ASC
      `).all(project.id);

      console.log(`[LINE] Analyzing ${messages.length} messages for project ${project.id}`);
      const requirements = await lineHandler.parseRequirementsFromMessages(messages, openai);

      if (requirements) {
        db.prepare('UPDATE projects SET user_requirements = ? WHERE id = ?')
          .run(requirements, project.id);

        await lineHandler.replyMessage(replyToken, lineHandler.getRequirementsAnalyzedMessage());
        console.log(`[LINE] Requirements extracted for project ${project.id}`);
      } else {
        await lineHandler.replyMessage(replyToken, lineHandler.getAcknowledgmentMessage());
      }
    } else {
      // Send acknowledgment
      await lineHandler.replyMessage(replyToken, lineHandler.getAcknowledgmentMessage());
    }
  }
}

// Handle LINE follow event (user adds friend)
async function handleLineFollowEvent(event) {
  const userId = event.source.userId;
  const profile = await lineHandler.getUserProfile(userId);

  console.log(`[LINE] New follower: ${profile?.displayName || userId}`);

  await lineHandler.replyMessage(event.replyToken, lineHandler.getWelcomeMessage(profile?.displayName));
}

// Get LINE integration status
app.get('/api/line/status', (req, res) => {
  const totalProjects = db.prepare("SELECT COUNT(*) as count FROM projects WHERE source = 'line'").get().count;
  const totalConversations = db.prepare('SELECT COUNT(*) as count FROM line_conversations').get().count;

  res.json({
    enabled: LINE_ENABLED,
    totalProjects,
    totalConversations
  });
});

// Get LINE projects
app.get('/api/line/projects', (req, res) => {
  const projects = req.user.role === 'admin'
    ? db.prepare(`
        SELECT p.*, COUNT(c.id) as message_count
        FROM projects p
        LEFT JOIN line_conversations c ON p.id = c.project_id
        WHERE p.source = 'line'
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `).all()
    : db.prepare(`
        SELECT p.*, COUNT(c.id) as message_count
        FROM projects p
        LEFT JOIN line_conversations c ON p.id = c.project_id
        WHERE p.source = 'line' AND p.owner_id = ?
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `).all(req.user.id);
  res.json(projects);
});

// Get LINE conversations for a project
app.get('/api/line/projects/:projectId/conversations', requireProjectAccess, (req, res) => {
  const conversations = db.prepare(`
    SELECT * FROM line_conversations
    WHERE project_id = ?
    ORDER BY timestamp ASC
  `).all(req.params.projectId);
  res.json(conversations);
});

// Send message to LINE user
app.post('/api/line/projects/:projectId/send', requireProjectAccess, async (req, res) => {
  if (!LINE_ENABLED) {
    return res.status(503).json({ error: 'LINE integration not configured' });
  }

  const { message } = req.body;
  const project = req.project;

  if (!project.line_user_id) {
    return res.status(400).json({ error: 'Not a LINE project' });
  }

  const success = await lineHandler.pushMessage(project.line_user_id, message);

  if (success) {
    // Save sent message
    db.prepare(`
      INSERT INTO line_conversations (id, project_id, line_user_id, message_type, message_content, sender)
      VALUES (?, ?, ?, 'text', ?, 'bot')
    `).run(uuidv4(), project.id, project.line_user_id, message);
  }

  res.json({ success });
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
