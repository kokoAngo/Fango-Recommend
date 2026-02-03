import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SUUMO JDS configuration from environment variables
const SUUMO_LOGIN_ID = process.env.SUUMO_LOGIN_ID || '118535900103';
const SUUMO_PASSWORD = process.env.SUUMO_PASSWORD || 'funt0406@@@';
const SUUMO_PATH = process.env.SUUMO_PATH || 'dc5653d1d8cf5a968d5a6d09fe5f3255';
const SUUMO_BASE_URL = 'https://jds.suumo.jp';
const SUUMO_LOGIN_URL = `${SUUMO_BASE_URL}/jds/CJ000AU001/?path=${SUUMO_PATH}`;

// Screenshot directory for debugging
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

let browser = null;
let page = null;

/**
 * Save screenshot for debugging
 */
async function saveScreenshot(name) {
  try {
    const fs = await import('fs');
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    const filename = `${name}_${Date.now()}.png`;
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
    console.log(`[SUUMO] Screenshot saved: ${filename}`);
  } catch (e) {
    console.log('[SUUMO] Screenshot failed:', e.message);
  }
}

/**
 * Initialize browser and login to SUUMO JDS
 */
async function initBrowser() {
  if (browser) {
    try {
      await browser.pages();
      return;
    } catch (e) {
      browser = null;
      page = null;
    }
  }

  console.log('[SUUMO] Launching browser...');
  browser = await puppeteer.launch({
    headless: false,  // Show browser for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null
  });
  page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
}

/**
 * Login to SUUMO JDS
 */
async function login() {
  await initBrowser();

  console.log('[SUUMO] Navigating to login page...');
  await page.goto(SUUMO_LOGIN_URL, { waitUntil: 'networkidle2' });

  // Check if already logged in (not on login page)
  const currentUrl = page.url();
  if (!currentUrl.includes('CJ000AU001')) {
    console.log('[SUUMO] Already logged in');
    return true;
  }

  await saveScreenshot('01_login_page');

  console.log('[SUUMO] Entering credentials...');

  // Find login form fields
  await page.waitForSelector('input', { timeout: 10000 });

  // Get all input fields and identify login ID and password fields
  const inputs = await page.$$('input');
  let loginIdInput = null;
  let passwordInput = null;

  for (const input of inputs) {
    const type = await input.evaluate(el => el.type);
    const name = await input.evaluate(el => el.name || '');

    if ((type === 'text' || type === 'tel') && !loginIdInput) {
      loginIdInput = input;
    }
    if (type === 'password') {
      passwordInput = input;
    }
  }

  if (!loginIdInput || !passwordInput) {
    await saveScreenshot('error_no_login_fields');
    throw new Error('Could not find login form fields');
  }

  await loginIdInput.type(SUUMO_LOGIN_ID, { delay: 30 });
  await passwordInput.type(SUUMO_PASSWORD, { delay: 30 });

  await saveScreenshot('02_credentials_entered');

  // Find and click submit button
  const clicked = await page.evaluate(() => {
    const submitBtns = document.querySelectorAll('input[type="submit"], button[type="submit"], button');
    for (const btn of submitBtns) {
      const text = btn.textContent || btn.value || '';
      if (text.includes('ログイン') || btn.type === 'submit') {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    await page.keyboard.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  await saveScreenshot('03_after_login');

  console.log('[SUUMO] Login successful, current URL:', page.url());
  return true;
}

/**
 * Navigate to 反響閲覧 page and click 検索する
 */
async function navigateToFeedbackAndSearch() {
  console.log('[SUUMO] Navigating to 反響閲覧...');

  // Look for 反響閲覧 menu link
  const feedbackClicked = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent?.includes('反響閲覧')) {
        link.click();
        return true;
      }
    }
    return false;
  });

  if (feedbackClicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  }

  await new Promise(r => setTimeout(r, 2000));
  await saveScreenshot('04_feedback_page');
  console.log('[SUUMO] Current page:', page.url());

  // Click 検索する button
  console.log('[SUUMO] Clicking 検索する...');
  const searchClicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('input[type="submit"], input[type="button"], button');
    for (const btn of buttons) {
      const text = btn.textContent || btn.value || '';
      if (text.includes('検索')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (searchClicked) {
    await new Promise(r => setTimeout(r, 3000));
  }

  await saveScreenshot('05_search_results');
}

/**
 * Extract customer list from search results
 * Each customer has an onclick handler with their ID: CJ003LI001_hankyoLink('ID')
 */
async function extractCustomerList() {
  console.log('[SUUMO] Extracting customer list...');

  const customers = await page.evaluate(() => {
    const results = [];

    // Find all status links with onclick handlers
    const links = document.querySelectorAll('a');

    links.forEach((link) => {
      const onclick = link.getAttribute('onclick') || '';
      const text = link.textContent || '';

      // Look for links with hankyoLink onclick handler
      const idMatch = onclick.match(/hankyoLink\(['"](\d+)['"]\)/);
      if (idMatch) {
        const customerId = idMatch[1];

        // Find the parent row to get basic info
        const row = link.closest('tr');
        if (!row) return;

        // Get the next row (contains name, phone, email)
        const nextRow = row.nextElementSibling;
        if (!nextRow) return;

        const row1Cells = row.querySelectorAll('td');
        const row2Cells = nextRow?.querySelectorAll('td');

        if (row1Cells.length < 4 || !row2Cells || row2Cells.length < 3) return;

        // Extract basic info from rows
        const dateTime = row1Cells[1]?.textContent?.trim() || '';
        const propertyName = row1Cells[4]?.textContent?.trim() || '';

        const name = row2Cells[0]?.textContent?.trim() || '';
        const phone = row2Cells[1]?.textContent?.trim() || '';
        const email = row2Cells[3]?.textContent?.trim() || '';

        const dateMatch = dateTime.match(/(\d{4}\/\d{2}\/\d{2})/);
        const date = dateMatch ? dateMatch[1] : '';

        results.push({
          id: customerId,
          name: name || `顧客${customerId}`,
          date: date,
          phone: phone,
          email: email,
          propertyName: propertyName,
          // Will fetch detailed info when importing
          hasDetailPage: true
        });
      }
    });

    return results;
  });

  console.log(`[SUUMO] Found ${customers.length} customers with detail links`);

  // Log first few customers for debugging
  customers.slice(0, 3).forEach(c => {
    console.log(`  - ${c.name} (ID:${c.id}) | ${c.propertyName}`);
  });

  return customers;
}

/**
 * Click on customer link and extract detailed info from detail page
 */
async function fetchCustomerDetailPage(customerId) {
  console.log(`[SUUMO] Fetching detail page for customer ${customerId}...`);

  // Click the status link to navigate to detail page
  const clicked = await page.evaluate((id) => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const onclick = link.getAttribute('onclick') || '';
      if (onclick.includes(`hankyoLink('${id}')`)) {
        link.click();
        return true;
      }
    }
    return false;
  }, customerId);

  if (!clicked) {
    console.log(`[SUUMO] Could not find link for customer ${customerId}`);
    return null;
  }

  // Wait for navigation to detail page
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  await saveScreenshot(`detail_${customerId}`);

  // Extract all labeled data from detail page
  const details = await page.evaluate(() => {
    const data = {};

    // Get all table rows with th/td pairs
    document.querySelectorAll('table tr').forEach(row => {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) {
        const label = th.textContent?.trim() || '';
        const value = td.textContent?.trim() || '';
        if (label && value) {
          data[label] = value;
        }
      }
    });

    return data;
  });

  console.log(`[SUUMO] Extracted ${Object.keys(details).length} fields from detail page`);

  return details;
}

/**
 * Build customer requirements from detail page data
 */
function buildRequirementsFromDetails(details) {
  const requirements = [];

  // Customer basic info
  if (details['名前（漢字）']) requirements.push(`【お客様名】${details['名前（漢字）']}`);
  if (details['名前（カナ）']) requirements.push(`【フリガナ】${details['名前（カナ）']}`);
  if (details['メールアドレス']) requirements.push(`【メールアドレス】${details['メールアドレス']}`);
  if (details['ＴＥＬ']) requirements.push(`【電話番号】${details['ＴＥＬ']}`);
  if (details['FAX']) requirements.push(`【FAX】${details['FAX']}`);
  if (details['連絡方法']) requirements.push(`【希望連絡方法】${details['連絡方法']}`);

  // Inquiry details
  if (details['お問合せ日時']) requirements.push(`【問合せ日時】${details['お問合せ日時']}`);
  if (details['お問合せ内容']) requirements.push(`【お問合せ内容】${details['お問合せ内容']}`);
  if (details['お問合せ企画']) requirements.push(`【問合せ企画】${details['お問合せ企画']}`);

  // Property details
  requirements.push('');
  requirements.push('━━━ 問合せ物件情報 ━━━');
  if (details['物件名']) requirements.push(`【物件名】${details['物件名']}`);
  if (details['物件種別']) requirements.push(`【物件種別】${details['物件種別']}`);
  if (details['所在地']) requirements.push(`【所在地】${details['所在地']}`);
  if (details['最寄り駅']) requirements.push(`【最寄り駅】${details['最寄り駅']}`);
  if (details['バス／歩']) requirements.push(`【徒歩】${details['バス／歩']}`);
  if (details['賃料']) requirements.push(`【賃料】${details['賃料']}`);
  if (details['間取り']) requirements.push(`【間取り】${details['間取り']}`);
  if (details['専有面積']) requirements.push(`【専有面積】${details['専有面積']}`);
  if (details['物件詳細画面']) requirements.push(`【物件URL】${details['物件詳細画面']}`);

  return {
    name: details['名前（漢字）'] || '',
    email: details['メールアドレス'] || '',
    phone: details['ＴＥＬ'] || '',
    inquiry: details['お問合せ内容'] || '',
    requirements: requirements.join('\n'),
    rawDetails: details
  };
}

/**
 * Main function to get all customers
 */
export async function getCustomerList() {
  try {
    await login();
    await navigateToFeedbackAndSearch();
    const customers = await extractCustomerList();
    return customers;
  } catch (error) {
    console.error('[SUUMO] Error getting customer list:', error.message);
    await saveScreenshot('error_customer_list');
    throw error;
  }
}

/**
 * Get detailed requirements for a specific customer
 * Navigates to detail page and extracts full information
 */
export async function getCustomerRequirements(customerId, customerData) {
  try {
    // Make sure we're logged in and on the search results page
    await login();
    await navigateToFeedbackAndSearch();

    // Fetch detailed info from detail page
    const detailPageData = await fetchCustomerDetailPage(customerId);

    if (detailPageData && Object.keys(detailPageData).length > 0) {
      // Build requirements from detail page
      const details = buildRequirementsFromDetails(detailPageData);
      console.log(`[SUUMO] Got detailed info for ${details.name}`);
      return details;
    } else {
      // Fallback to basic info from customer list
      console.log('[SUUMO] Could not get detail page, using basic info');
      const requirements = [];
      if (customerData?.name) requirements.push(`【お客様名】${customerData.name}`);
      if (customerData?.phone) requirements.push(`【電話番号】${customerData.phone}`);
      if (customerData?.email) requirements.push(`【メールアドレス】${customerData.email}`);
      if (customerData?.propertyName) requirements.push(`【問合せ物件】${customerData.propertyName}`);

      return {
        name: customerData?.name || '',
        email: customerData?.email || '',
        phone: customerData?.phone || '',
        requirements: requirements.join('\n')
      };
    }
  } catch (error) {
    console.error('[SUUMO] Error getting customer requirements:', error.message);
    await saveScreenshot('error_get_requirements');
    throw error;
  }
}

/**
 * Close browser when done
 */
export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

export default {
  getCustomerList,
  getCustomerRequirements,
  closeBrowser
};
