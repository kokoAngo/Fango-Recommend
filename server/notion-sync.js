import { Client } from '@notionhq/client';

// Notion configuration from environment variables
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '30b1c1974dad80ec9ea3d63db4c0ace9';
const NOTION_RECOMMENDATION_DB_ID = process.env.NOTION_RECOMMENDATION_DB_ID || '33b1c1974dad8048add5c41c7ead9c13';

let notion = null;

// Local cache to track created properties during batch sync
// Key: property name, Value: { pageId, count }
const propertyCache = new Map();

/**
 * Initialize Notion client
 */
function initNotion() {
  if (!NOTION_API_KEY) {
    console.warn('[Notion] NOTION_API_KEY not set. Notion sync disabled.');
    return false;
  }

  if (!notion) {
    notion = new Client({ auth: NOTION_API_KEY });
    console.log('[Notion] Client initialized');
  }
  return true;
}

/**
 * Search for existing property in Notion database by name
 */
async function findExistingProperty(propertyName) {
  if (!initNotion()) return null;

  try {
    // Use search API to find pages with the property name
    const response = await notion.search({
      query: propertyName,
      filter: {
        property: 'object',
        value: 'page'
      },
      page_size: 10
    });

    // Filter results to find exact match in our database
    for (const page of response.results) {
      if (page.parent?.database_id?.replace(/-/g, '') === NOTION_DATABASE_ID.replace(/-/g, '')) {
        // Check if title matches
        const titleProp = page.properties['物件名'];
        if (titleProp?.title?.[0]?.plain_text === propertyName) {
          return page;
        }
      }
    }
    return null;
  } catch (error) {
    console.error('[Notion] Search error:', error.message);
    return null;
  }
}

/**
 * Increment 反響数 for existing property
 */
async function incrementResponseCount(pageId, currentCount) {
  if (!initNotion()) return false;

  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        '反響数': {
          number: (currentCount || 0) + 1
        }
      }
    });
    console.log(`[Notion] Incremented 反響数 to ${(currentCount || 0) + 1}`);
    return true;
  } catch (error) {
    console.error('[Notion] Update error:', error.message);
    return false;
  }
}

/**
 * Create new property entry in Notion database
 */
async function createPropertyEntry(propertyInfo) {
  if (!initNotion()) return null;

  try {
    // Build properties object
    const properties = {
      '物件名': {
        title: [
          {
            text: {
              content: propertyInfo['物件名'] || '不明'
            }
          }
        ]
      },
      '反響数': {
        number: 1
      }
    };

    // Add optional rich_text fields
    const textFieldMappings = {
      '物件種別': '物件種別',
      '所在地': '所在地',
      '最寄り駅': '最寄り駅',
      '間取り': '間取り'
    };

    for (const [ourField, dbField] of Object.entries(textFieldMappings)) {
      if (propertyInfo[ourField]) {
        properties[dbField] = {
          rich_text: [{ text: { content: propertyInfo[ourField] } }]
        };
      }
    }

    // Handle number fields - extract numbers from text
    // 徒歩 (e.g., "徒歩5分" -> 5)
    if (propertyInfo['バス／歩']) {
      const walkMatch = propertyInfo['バス／歩'].match(/(\d+)/);
      if (walkMatch) {
        properties['徒歩'] = { number: parseInt(walkMatch[1]) };
      }
    }

    // 賃料 (e.g., "150,000円" -> 150000)
    if (propertyInfo['賃料']) {
      const rentMatch = propertyInfo['賃料'].replace(/[,，]/g, '').match(/(\d+)/);
      if (rentMatch) {
        properties['賃料'] = { number: parseInt(rentMatch[1]) };
      }
    }

    // 面積 (e.g., "25.5m²" -> 25.5)
    if (propertyInfo['専有面積']) {
      const areaMatch = propertyInfo['専有面積'].replace(/[,，]/g, '').match(/([\d.]+)/);
      if (areaMatch) {
        properties['面積'] = { number: parseFloat(areaMatch[1]) };
      }
    }

    console.log('[Notion] Creating entry with properties:', Object.keys(properties).join(', '));

    const response = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: properties
    });

    console.log(`[Notion] Created new entry for: ${propertyInfo['物件名']}`);
    return response;
  } catch (error) {
    console.error('[Notion] Create error:', error.message);
    return null;
  }
}

/**
 * Sync property info to Notion
 * - If property exists (same name), increment 反響数
 * - If property is new, create entry with 反響数 = 1
 */
export async function syncPropertyToNotion(propertyInfo) {
  if (!NOTION_API_KEY) {
    return { success: false, reason: 'NOTION_API_KEY not configured' };
  }

  if (!propertyInfo || !propertyInfo['物件名']) {
    return { success: false, reason: 'No property info or name' };
  }

  const propertyName = propertyInfo['物件名'];
  console.log(`[Notion] Syncing property: ${propertyName}`);

  try {
    // First check local cache (for batch sync)
    if (propertyCache.has(propertyName)) {
      const cached = propertyCache.get(propertyName);
      const newCount = cached.count + 1;
      const success = await incrementResponseCount(cached.pageId, cached.count);
      if (success) {
        propertyCache.set(propertyName, { pageId: cached.pageId, count: newCount });
      }
      return {
        success,
        action: 'incremented',
        propertyName: propertyName,
        newCount: newCount
      };
    }

    // Check if property already exists in Notion using search
    const existingPage = await findExistingProperty(propertyName);

    if (existingPage) {
      // Get current 反響数
      const currentCount = existingPage.properties['反響数']?.number || 0;
      const success = await incrementResponseCount(existingPage.id, currentCount);
      if (success) {
        // Add to cache
        propertyCache.set(propertyName, { pageId: existingPage.id, count: currentCount + 1 });
      }
      return {
        success,
        action: 'incremented',
        propertyName: propertyName,
        newCount: currentCount + 1
      };
    } else {
      // Create new entry
      const newPage = await createPropertyEntry(propertyInfo);
      if (newPage) {
        // Add to cache
        propertyCache.set(propertyName, { pageId: newPage.id, count: 1 });
      }
      return {
        success: !!newPage,
        action: 'created',
        propertyName: propertyName,
        newCount: 1
      };
    }
  } catch (error) {
    console.error('[Notion] Sync error:', error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * Clear the property cache (call after batch sync completes)
 */
export function clearPropertyCache() {
  propertyCache.clear();
  console.log('[Notion] Property cache cleared');
}

/**
 * Extract property info from SUUMO detail page data
 */
export function extractPropertyInfo(rawDetails) {
  if (!rawDetails) return null;

  return {
    '物件名': rawDetails['物件名'] || null,
    '物件種別': rawDetails['物件種別'] || null,
    '所在地': rawDetails['所在地'] || null,
    '最寄り駅': rawDetails['最寄り駅'] || null,
    'バス／歩': rawDetails['バス／歩'] || null,
    '賃料': rawDetails['賃料'] || null,
    '間取り': rawDetails['間取り'] || null,
    '専有面積': rawDetails['専有面積'] || null,
    '物件詳細画面': rawDetails['物件詳細画面'] || null
  };
}

/**
 * Clean up duplicate entries in Notion database
 * Merges duplicates by keeping one and summing up 反響数
 */
export async function cleanupDuplicates() {
  if (!initNotion()) {
    return { success: false, reason: 'Notion not initialized' };
  }

  console.log('[Notion] Starting duplicate cleanup...');

  try {
    // Get all pages from database using search
    const allPages = [];
    let hasMore = true;
    let startCursor = undefined;

    // Use search to get all pages in the database
    while (hasMore) {
      const response = await notion.search({
        filter: {
          property: 'object',
          value: 'page'
        },
        page_size: 100,
        start_cursor: startCursor
      });

      // Filter to only pages from our database
      const dbPages = response.results.filter(page =>
        page.parent?.database_id?.replace(/-/g, '') === NOTION_DATABASE_ID.replace(/-/g, '')
      );
      allPages.push(...dbPages);

      hasMore = response.has_more;
      startCursor = response.next_cursor;

      // Safety limit
      if (allPages.length > 1000) break;
    }

    console.log(`[Notion] Found ${allPages.length} pages in database`);

    // Group pages by property name
    const pagesByName = new Map();
    for (const page of allPages) {
      const name = page.properties['物件名']?.title?.[0]?.plain_text;
      if (name) {
        if (!pagesByName.has(name)) {
          pagesByName.set(name, []);
        }
        pagesByName.get(name).push(page);
      }
    }

    // Find and merge duplicates
    let mergedCount = 0;
    let deletedCount = 0;

    for (const [name, pages] of pagesByName.entries()) {
      if (pages.length > 1) {
        console.log(`[Notion] Found ${pages.length} duplicates for: ${name}`);

        // Sort by created time (keep the oldest)
        pages.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));

        const keepPage = pages[0];
        const duplicates = pages.slice(1);

        // Sum up all 反響数
        let totalCount = 0;
        for (const page of pages) {
          totalCount += page.properties['反響数']?.number || 1;
        }

        // Update the kept page with total count
        await notion.pages.update({
          page_id: keepPage.id,
          properties: {
            '反響数': { number: totalCount }
          }
        });
        console.log(`[Notion] Updated ${name}: 反響数 = ${totalCount}`);

        // Delete duplicates
        for (const dup of duplicates) {
          await notion.pages.update({
            page_id: dup.id,
            archived: true
          });
          deletedCount++;
        }

        mergedCount++;

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`[Notion] Cleanup completed: merged ${mergedCount} groups, deleted ${deletedCount} duplicates`);

    return {
      success: true,
      mergedGroups: mergedCount,
      deletedPages: deletedCount,
      totalPages: allPages.length
    };
  } catch (error) {
    console.error('[Notion] Cleanup error:', error.message);
    return { success: false, reason: error.message };
  }
}

// ============ Recommendation Sync Functions ============

/**
 * Find existing recommendation in Notion by REINS ID and project ID
 * Note: Database has properties: "Reins ID" (title), "User ID" (rich_text)
 * Uses search API since databases.query is not available in this version
 */
async function findExistingRecommendation(reinsId, projectId) {
  if (!initNotion()) return null;

  try {
    // Use search API to find pages with the REINS ID
    const response = await notion.search({
      query: reinsId,
      filter: {
        property: 'object',
        value: 'page'
      },
      page_size: 50
    });

    // Filter results to find exact match in our database
    const dbId = NOTION_RECOMMENDATION_DB_ID.replace(/-/g, '');
    for (const page of response.results) {
      const pageDbId = page.parent?.database_id?.replace(/-/g, '');
      if (pageDbId !== dbId) continue;

      // Check if REINS ID and User ID match
      const pageReinsId = page.properties['Reins ID']?.title?.[0]?.plain_text;
      const pageUserId = page.properties['User ID']?.rich_text?.[0]?.plain_text;

      if (pageReinsId === reinsId && pageUserId === projectId) {
        return page;
      }
    }

    return null;
  } catch (error) {
    console.error('[Notion Recommendation] Search error:', error.message);
    return null;
  }
}

/**
 * Create recommendation entry in Notion
 * Note: Database has properties: "Reins ID" (title), "User ID" (rich_text)
 */
async function createRecommendationEntry(recInfo) {
  if (!initNotion()) return null;

  try {
    const properties = {
      'Reins ID': {
        title: [{ text: { content: recInfo.reins_id || '不明' } }]
      },
      'User ID': {
        rich_text: [{ text: { content: recInfo.project_id || recInfo.user_name || '' } }]
      }
    };

    console.log(`[Notion Recommendation] Creating entry for REINS ID: ${recInfo.reins_id}, User ID: ${recInfo.project_id}`);

    const response = await notion.pages.create({
      parent: { database_id: NOTION_RECOMMENDATION_DB_ID },
      properties: properties
    });

    console.log(`[Notion Recommendation] Created entry: ${recInfo.reins_id}`);
    return response;
  } catch (error) {
    console.error('[Notion Recommendation] Create error:', error.message);
    return null;
  }
}

/**
 * Update recommendation entry in Notion (e.g., update rating)
 */
async function updateRecommendationEntry(pageId, updates) {
  if (!initNotion()) return false;

  try {
    const properties = {};

    if (updates.rating) {
      properties['評価'] = {
        select: { name: updates.rating }
      };
    }

    if (updates.round !== undefined) {
      properties['ラウンド'] = {
        number: updates.round
      };
    }

    await notion.pages.update({
      page_id: pageId,
      properties: properties
    });

    console.log(`[Notion Recommendation] Updated entry: ${pageId}`);
    return true;
  } catch (error) {
    console.error('[Notion Recommendation] Update error:', error.message);
    return false;
  }
}

/**
 * Sync recommendation to Notion
 * - If exists, update rating
 * - If new, create entry
 *
 * @param {Object} recInfo - Recommendation info
 * @param {string} recInfo.reins_id - REINS property ID
 * @param {string} recInfo.project_id - Project ID
 * @param {string} recInfo.user_name - User/Project name
 * @param {string} recInfo.platform - Platform (atbb, itandi, reins, etc.)
 * @param {number} recInfo.round - Recommendation round (0-3)
 * @param {string} recInfo.rating - Rating (good, question, bad)
 * @param {string} recInfo.location - Property location
 * @param {string} recInfo.rent - Rent amount
 * @param {string} recInfo.layout - Layout (間取り)
 */
export async function syncRecommendationToNotion(recInfo) {
  if (!NOTION_API_KEY) {
    return { success: false, reason: 'NOTION_API_KEY not configured' };
  }

  if (!recInfo || !recInfo.reins_id) {
    return { success: false, reason: 'No REINS ID provided' };
  }

  console.log(`[Notion Recommendation] Syncing: ${recInfo.reins_id} for project ${recInfo.project_id}`);

  try {
    // Check if recommendation already exists
    const existing = await findExistingRecommendation(recInfo.reins_id, recInfo.project_id);

    if (existing) {
      // Update existing entry
      const success = await updateRecommendationEntry(existing.id, {
        rating: recInfo.rating,
        round: recInfo.round
      });

      return {
        success,
        action: 'updated',
        reins_id: recInfo.reins_id
      };
    } else {
      // Create new entry
      const newPage = await createRecommendationEntry(recInfo);

      return {
        success: !!newPage,
        action: 'created',
        reins_id: recInfo.reins_id
      };
    }
  } catch (error) {
    console.error('[Notion Recommendation] Sync error:', error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * Batch sync recommendations to Notion
 */
export async function batchSyncRecommendationsToNotion(recommendations) {
  const results = [];

  for (const rec of recommendations) {
    const result = await syncRecommendationToNotion(rec);
    results.push(result);

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`[Notion Recommendation] Batch sync: ${successCount}/${recommendations.length} succeeded`);

  return {
    total: recommendations.length,
    success: successCount,
    results
  };
}

export default {
  syncPropertyToNotion,
  extractPropertyInfo,
  clearPropertyCache,
  cleanupDuplicates,
  syncRecommendationToNotion,
  batchSyncRecommendationsToNotion
};
