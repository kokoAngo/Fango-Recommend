/**
 * LINE Messaging API Handler
 * Handles LINE webhook events and message processing
 */
import * as line from '@line/bot-sdk';
import crypto from 'crypto';
import https from 'https';

// Initialize blob client for file downloads
let blobClient = null;

export const getBlobClient = () => {
  if (!blobClient && isLineConfigured()) {
    blobClient = new line.messagingApi.MessagingApiBlobClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
    });
  }
  return blobClient;
};

// LINE configuration from environment variables
const lineConfig = {
  channelId: process.env.LINE_CHANNEL_ID,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// Check if LINE is configured
export const isLineConfigured = () => {
  return !!(lineConfig.channelSecret && lineConfig.channelAccessToken);
};

// Initialize LINE client (lazy initialization)
let lineClient = null;

export const getLineClient = () => {
  if (!lineClient && isLineConfigured()) {
    lineClient = new line.messagingApi.MessagingApiClient({
      channelAccessToken: lineConfig.channelAccessToken
    });
  }
  return lineClient;
};

/**
 * Verify LINE webhook signature
 */
export function verifySignature(body, signature) {
  if (!lineConfig.channelSecret) {
    console.log('[LINE] Channel secret not configured');
    return false;
  }

  // Ensure body is a Buffer for consistent hashing
  let bodyBuffer;
  if (Buffer.isBuffer(body)) {
    bodyBuffer = body;
  } else if (typeof body === 'string') {
    bodyBuffer = Buffer.from(body, 'utf8');
  } else {
    // If body is an object, stringify it
    bodyBuffer = Buffer.from(JSON.stringify(body), 'utf8');
  }

  const expectedSignature = crypto
    .createHmac('SHA256', lineConfig.channelSecret)
    .update(bodyBuffer)
    .digest('base64');

  // Use timing-safe comparison
  try {
    const sigBuffer = Buffer.from(signature, 'base64');
    const expectedBuffer = Buffer.from(expectedSignature, 'base64');

    if (sigBuffer.length !== expectedBuffer.length) {
      console.log('[LINE] Signature length mismatch');
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (e) {
    console.log('[LINE] Signature comparison error:', e.message);
    return signature === expectedSignature;
  }
}

/**
 * Get user profile from LINE
 */
export async function getUserProfile(userId) {
  const client = getLineClient();
  if (!client) return null;

  try {
    return await client.getProfile(userId);
  } catch (error) {
    console.error('[LINE] Failed to get user profile:', error.message);
    return null;
  }
}

/**
 * Send reply message (must be within 1 minute of receiving event)
 */
export async function replyMessage(replyToken, messages) {
  const client = getLineClient();
  if (!client) return false;

  try {
    await client.replyMessage({
      replyToken,
      messages: Array.isArray(messages) ? messages : [{ type: 'text', text: messages }]
    });
    return true;
  } catch (error) {
    console.error('[LINE] Reply failed:', error.message);
    return false;
  }
}

/**
 * Send push message (can be sent anytime)
 */
export async function pushMessage(userId, messages) {
  const client = getLineClient();
  if (!client) return false;

  try {
    await client.pushMessage({
      to: userId,
      messages: Array.isArray(messages) ? messages : [{ type: 'text', text: messages }]
    });
    return true;
  } catch (error) {
    console.error('[LINE] Push failed:', error.message);
    return false;
  }
}

/**
 * Parse requirements from conversation history using GPT
 */
export async function parseRequirementsFromMessages(messages, openai) {
  if (!openai || messages.length === 0) {
    return null;
  }

  const conversationText = messages
    .filter(m => m.sender === 'user' && m.message_type === 'text')
    .map(m => m.message_content)
    .join('\n');

  if (!conversationText.trim()) {
    return null;
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `あなたは不動産仲介の専門家です。顧客との会話から、物件探しの条件を抽出してください。
以下の形式で出力してください：

【お客様名】（分かれば）
【予算】
【希望エリア】
【希望間取り】
【駅徒歩】
【その他条件】
【備考・特記事項】

分からない項目は「未定」と記載してください。会話から読み取れる情報をできるだけ詳しく記載してください。`
        },
        {
          role: 'user',
          content: `以下の会話から条件を抽出してください:\n\n${conversationText}`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('[LINE] Requirements parsing failed:', error.message);
    return null;
  }
}

/**
 * Download file content from LINE
 */
export async function getMessageContent(messageId) {
  const client = getBlobClient();
  if (!client) return null;

  try {
    const stream = await client.getMessageContent(messageId);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    console.error('[LINE] Failed to get message content:', error.message);
    return null;
  }
}

/**
 * Parse LINE chat export txt format
 * Format example:
 * [LINE] Chat history with XXX
 * Saved: 2024/01/15 10:30
 *
 * 2024/01/15 Mon
 * 10:00 Customer Name
 * Hello, I'm looking for an apartment
 *
 * 10:05 Agent Name
 * Thank you for contacting us...
 */
export function parseChatExportTxt(content) {
  const lines = content.split('\n');
  const messages = [];
  let currentDate = '';
  let currentTime = '';
  let currentSender = '';
  let currentMessage = [];

  const dateRegex = /^(\d{4}\/\d{1,2}\/\d{1,2})/;
  const timeAndSenderRegex = /^(\d{1,2}:\d{2})\t(.+)$/;

  const flushMessage = () => {
    if (currentSender && currentMessage.length > 0) {
      messages.push({
        date: currentDate,
        time: currentTime,
        sender: currentSender,
        content: currentMessage.join('\n').trim()
      });
    }
    currentMessage = [];
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines and header lines
    if (!trimmedLine || trimmedLine.startsWith('[LINE]') || trimmedLine.startsWith('保存日時') || trimmedLine.startsWith('Saved')) {
      continue;
    }

    // Check for date line
    const dateMatch = trimmedLine.match(dateRegex);
    if (dateMatch && (trimmedLine.includes('月') || trimmedLine.includes('Mon') || trimmedLine.includes('Tue') ||
        trimmedLine.includes('Wed') || trimmedLine.includes('Thu') || trimmedLine.includes('Fri') ||
        trimmedLine.includes('Sat') || trimmedLine.includes('Sun') ||
        trimmedLine.match(/^\d{4}\/\d{1,2}\/\d{1,2}\(.\)$/))) {
      flushMessage();
      currentDate = dateMatch[1];
      continue;
    }

    // Check for time and sender line
    const timeMatch = trimmedLine.match(timeAndSenderRegex);
    if (timeMatch) {
      flushMessage();
      currentTime = timeMatch[1];
      currentSender = timeMatch[2];
      continue;
    }

    // Otherwise, it's message content
    if (currentSender) {
      currentMessage.push(trimmedLine);
    }
  }

  // Flush the last message
  flushMessage();

  return messages;
}

/**
 * Analyze chat record and extract requirements using GPT
 */
export async function analyzeChatRecord(chatContent, openai) {
  if (!openai) {
    console.log('[LINE] OpenAI not configured, skipping analysis');
    return null;
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `あなたは不動産仲介の専門家です。顧客との会話履歴から、物件探しの条件を抽出してください。

以下の形式で出力してください：

【お客様名】（会話から特定できる名前）
【予算】（月額賃料の上限、管理費込みかどうか）
【希望エリア】（駅名、路線、地域など具体的に）
【希望間取り】（1K、1LDK、2LDKなど）
【広さ】（〇〇㎡以上など）
【駅徒歩】（〇分以内）
【築年数】（〇年以内、新築のみなど）
【階数】（〇階以上、1階不可など）
【設備条件】（オートロック、宅配BOX、浴室乾燥、独立洗面台など）
【その他条件】（ペット可、楽器可、角部屋、南向きなど）
【入居時期】（即入居、〇月から など）
【備考・特記事項】（その他重要な情報）

分からない項目は「未定」と記載してください。
会話から読み取れる情報をできるだけ詳しく、具体的に記載してください。
優先度が高い条件は【重要】と付けてください。`
        },
        {
          role: 'user',
          content: `以下の会話履歴から物件の希望条件を抽出してください:\n\n${chatContent}`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('[LINE] Chat analysis failed:', error.message);
    return null;
  }
}

/**
 * Create text message object
 */
export function textMessage(text) {
  return { type: 'text', text };
}

/**
 * Create welcome message for new users
 */
export function getWelcomeMessage(displayName) {
  return textMessage(
    `${displayName || 'お客'}様、お問い合わせありがとうございます！\n\n` +
    `Fango Recommendは、お客様のご希望に合った物件をAIがご提案するサービスです。\n\n` +
    `ご希望の物件条件をお聞かせください。以下の情報があると、より良いご提案ができます：\n\n` +
    `・ご予算（家賃の上限）\n` +
    `・希望エリア（駅名や地域）\n` +
    `・間取り（1K、2LDKなど）\n` +
    `・その他のご要望`
  );
}

/**
 * Create acknowledgment message
 */
export function getAcknowledgmentMessage() {
  return textMessage('ありがとうございます。他にご希望の条件はございますか？');
}

/**
 * Create requirements analyzed message
 */
export function getRequirementsAnalyzedMessage() {
  return textMessage(
    '条件を整理いたしました。\n\n' +
    '現在、お客様のご希望に合う物件を検索しております。\n' +
    '良い物件が見つかりましたら、改めてご連絡いたします。\n\n' +
    '追加のご要望がございましたら、お気軽にお申し付けください。'
  );
}

export default {
  isLineConfigured,
  getLineClient,
  getBlobClient,
  verifySignature,
  getUserProfile,
  replyMessage,
  pushMessage,
  getMessageContent,
  parseChatExportTxt,
  analyzeChatRecord,
  parseRequirementsFromMessages,
  textMessage,
  getWelcomeMessage,
  getAcknowledgmentMessage,
  getRequirementsAnalyzedMessage
};
