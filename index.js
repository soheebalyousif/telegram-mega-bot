const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');
const { google } = require('googleapis');
const { Readable } = require('stream');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || 'root';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A2:C';

if (
  !BOT_TOKEN ||
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REFRESH_TOKEN ||
  !GOOGLE_SHEET_ID
) {
  console.error(
    'الرجاء تعبئة BOT_TOKEN وبيانات Google OAuth و GOOGLE_SHEET_ID.'
  );
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({
  version: 'v3',
  auth: oauth2Client
});

const sheets = google.sheets({
  version: 'v4',
  auth: oauth2Client
});

let shuttingDown = false;
let uploadQueue = Promise.resolve();
let healthServer = null;
const folderCache = new Map();
const handledMessages = new Set();
const MAX_HANDLED_MESSAGES = 5000;
let allowedUsersCache = new Map();
let allowedUsersCacheAt = 0;
const SHEET_CACHE_TTL_MS = 60 * 1000;

function enqueueUpload(task) {
  const result = uploadQueue.then(task, task);
  uploadQueue = result.catch(() => undefined);
  return result;
}

async function getAllowedUsers() {
  const now = Date.now();
  if (now - allowedUsersCacheAt < SHEET_CACHE_TTL_MS) {
    return allowedUsersCache;
  }

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: GOOGLE_SHEET_RANGE,
    majorDimension: 'ROWS'
  });

  const users = new Map();
  for (const row of result.data.values || []) {
    const telegramId = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const active = String(row[2] || '').trim().toLowerCase();
    const isActive = ['yes', 'true', '1', 'نعم', 'فعال', 'مفعل'].includes(active);

    if (telegramId && isActive) {
      users.set(telegramId, name || telegramId);
    }
  }

  allowedUsersCache = users;
  allowedUsersCacheAt = now;
  return users;
}

async function isUserAllowed(userId) {
  try {
    const allowedUsers = await getAllowedUsers();
    return allowedUsers.has(String(userId));
  } catch (error) {
    // رفض آمن عند تعذر الوصول إلى الجدول بدل السماح للجميع.
    console.error('تعذر قراءة Google Sheet للصلاحيات:', error?.message || error);
    return false;
  }
}

function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^[@#]+/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return cleaned || 'Others';
}

function normalizeTag(tag) {
  return tag
    .replace(/^#/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isExtraTag(tag) {
  const compact = tag.replace(/\s+/g, '');
  return compact.startsWith('اكسترا') || compact.startsWith('إكسترا');
}

function isPracticalTag(tag) {
  const compact = tag.replace(/\s+/g, '');
  return compact === 'عملي' || compact === 'العملي';
}

function extractFolderPathFromCaption(caption, fileName) {
  const hashtags = String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || [];
  const tags = hashtags.map(normalizeTag);

  // حسب تنسيق رسائلك: الهاشتاق الأول هو اسم المادة دائمًا.
  const subjectFolder = sanitizeFolderName(
    tags[0] || getFolderByExtension(fileName)
  );

  const isExtra = tags.some(isExtraTag);
  const isPractical = tags.some(isPracticalTag);

  if (isPractical) {
    return [subjectFolder, 'عملي', ...(isExtra ? ['اكسترا'] : [])];
  }

  if (isExtra) {
    return [subjectFolder, 'اكسترا'];
  }

  return [subjectFolder, 'نظري'];
}

function getFolderByExtension(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase();

  if (['pdf', 'doc', 'docx', 'txt', 'epub', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
    return 'Documents';
  }
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic'].includes(ext)) {
    return 'Images';
  }
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) {
    return 'Audios';
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) {
    return 'Videos';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return 'Archives';
  }

  return 'Others';
}

async function getOrCreateFolderPath(folderNames) {
  let parentId = GOOGLE_DRIVE_FOLDER_ID;
  const path = [];

  for (const rawName of folderNames) {
    const folderName = sanitizeFolderName(rawName);
    path.push(folderName);
    const cacheKey = `${parentId}/${folderName}`;

    if (folderCache.has(cacheKey)) {
      parentId = folderCache.get(cacheKey);
      continue;
    }

    const escapedName = folderName.replace(/'/g, "\\'");
    const query = [
      `'${parentId}' in parents`,
      `name = '${escapedName}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false'
    ].join(' and ');

    const existing = await drive.files.list({
      q: query,
      fields: 'files(id,name)',
      pageSize: 1,
      spaces: 'drive'
    });

    let folderId = existing.data.files?.[0]?.id;

    if (!folderId) {
      const created = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId]
        },
        fields: 'id,name'
      });
      folderId = created.data.id;
    }

    folderCache.set(cacheKey, folderId);
    parentId = folderId;
  }

  return parentId;
}

function getTelegramFileInfo(message) {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name || `document_${Date.now()}`
    };
  }

  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId: photo.file_id,
      fileName: `photo_${Date.now()}.jpg`
    };
  }

  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileName: message.audio.file_name || `audio_${Date.now()}.mp3`
    };
  }

  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileName: message.video.file_name || `video_${Date.now()}.mp4`
    };
  }

  return null;
}

bot.on(['document', 'photo', 'audio', 'video'], async (ctx) => {
  if (shuttingDown) return;

  const senderId = String(ctx.from?.id || '');
  if (!(await isUserAllowed(senderId))) {
    console.log(`تم رفض ملف من مستخدم غير مصرح له: ${senderId || 'unknown'}`);
    return;
  }

  const messageId = `${ctx.chat.id}:${ctx.message.message_id}`;
  if (handledMessages.has(messageId)) return;

  handledMessages.add(messageId);
  if (handledMessages.size > MAX_HANDLED_MESSAGES) {
    const firstItem = handledMessages.values().next().value;
    handledMessages.delete(firstItem);
  }

  const fileInfo = getTelegramFileInfo(ctx.message);
  if (!fileInfo) return;

  await ctx.reply('⏳ تم استلام الملف، وسيتم رفعه بالترتيب...');

  enqueueUpload(async () => {
    try {
      await ctx.reply('⬆️ جاري رفع الملف إلى Google Drive...');

      const fileLink = await ctx.telegram.getFileLink(fileInfo.fileId);
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 2 * 1024 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024 * 1024
      });

      const fileBuffer = Buffer.from(response.data);
      const folderPath = extractFolderPathFromCaption(
        ctx.message.caption?.trim(),
        fileInfo.fileName
      );
      const folderId = await getOrCreateFolderPath(folderPath);

      const uploaded = await drive.files.create({
        requestBody: {
          name: fileInfo.fileName,
          parents: [folderId]
        },
        media: {
          mimeType: response.headers['content-type'] || 'application/octet-stream',
          body: Readable.from(fileBuffer)
        },
        fields: 'id,name,webViewLink'
      });

      const fileUrl = uploaded.data.webViewLink
        ? `\n🔗 ${uploaded.data.webViewLink}`
        : '';

      await ctx.reply(
        `✅ تم رفع الملف بنجاح إلى Google Drive.\n` +
        `📄 ${fileInfo.fileName}\n` +
        `📂 المجلد: ${folderPath.join(' / ')}` +
        fileUrl
      );
    } catch (error) {
      console.error('خطأ أثناء الرفع إلى Google Drive:', error?.stack || error);

      try {
        await ctx.reply(
          '❌ فشل رفع الملف إلى Google Drive. تحقق من بيانات OAuth وصلاحية المجلد.'
        );
      } catch (replyError) {
        console.error('تعذر إرسال رسالة الخطأ:', replyError?.message || replyError);
      }
    }
  });
});

bot.catch((error) => {
  console.error('خطأ عام في Telegram bot:', error?.stack || error);
});

function startHealthServer() {
  const port = Number(process.env.PORT) || 10000;

  healthServer = http.createServer((req, res) => {
    const requestPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

    if (requestPath === '/privacy') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>سياسة الخصوصية</title></head>
<body>
  <h1>سياسة الخصوصية</h1>
  <p>يستخدم هذا التطبيق Telegram لاستقبال الملفات من المستخدمين المصرح لهم ورفعها إلى Google Drive الخاص بمالك التطبيق.</p>
  <p>لا يبيع التطبيق البيانات ولا يشاركها مع جهات خارجية. تحفظ الملفات في Google Drive وفق صلاحيات مالك الحساب.</p>
  <p>لا يتم استخدام بيانات المستخدمين إلا للتحقق من الصلاحية ومعالجة الملفات المطلوبة.</p>
  <p>للتواصل: ضع بريدك الإلكتروني في إعدادات التطبيق.</p>
</body>
</html>`);
      return;
    }

    if (requestPath === '/' || requestPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Telegram Google Drive bot is running');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  healthServer.on('error', (error) => {
    console.error('خطأ في خادم Render:', error?.stack || error);
    process.exit(1);
  });

  healthServer.listen(port, '0.0.0.0', () => {
    console.log(`Health server listening on port ${port}`);
  });
}

async function startBot() {
  try {
    await bot.launch({ dropPendingUpdates: false });
    console.log('🤖 Telegram bot is running.');
  } catch (error) {
    console.error('فشل تشغيل البوت:', error?.stack || error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`إيقاف البوت بسبب ${signal}...`);

  try {
    bot.stop(signal);
  } catch (error) {
    console.error('خطأ أثناء إيقاف Telegram:', error?.message || error);
  }

  try {
    await uploadQueue;
  } catch (_) {
    // تمت معالجة الخطأ داخل مهمة الرفع.
  }

  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
  }

  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

startHealthServer();
startBot();

/*
متطلبات package.json:
{
  "dependencies": {
    "axios": "^1.7.0",
    "googleapis": "^144.0.0",
    "telegraf": "^4.16.3"
  }
}

متغيرات Render المطلوبة:
BOT_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_DRIVE_FOLDER_ID
GOOGLE_SHEET_ID
GOOGLE_SHEET_RANGE

Google Sheet يجب أن يحتوي الأعمدة التالية ابتداءً من الصف الأول:
telegram_id | name | active

ضع بيانات المستخدمين ابتداءً من الصف الثاني، مثل:
123456789 | أحمد | yes
987654321 | سارة | no

GOOGLE_SHEET_RANGE الافتراضي هو Sheet1!A2:C.
القيمة yes أو true أو 1 أو نعم أو فعال أو مفعل تعني أن المستخدم مسموح.

GOOGLE_DRIVE_FOLDER_ID هو معرّف المجلد الرئيسي في Google Drive.
إذا أردت الرفع إلى My Drive الرئيسي، اتركه فارغًا أو استخدم root.

أمر التشغيل:
node telegram-google-drive-bot.js
*/
