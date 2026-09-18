const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');
const { google } = require('googleapis');
const { Readable } = require('stream');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || 'root';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const USERS_SHEET_NAME = process.env.USERS_SHEET_NAME || '';
const SUBJECTS_SHEET_NAME = process.env.SUBJECTS_SHEET_NAME || '';

if (
  !BOT_TOKEN ||
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REFRESH_TOKEN ||
  !GOOGLE_SHEET_ID
) {
  console.error('الرجاء تعبئة جميع المتغيرات المطلوبة (BOT_TOKEN, Google OAuth, GOOGLE_SHEET_ID).');
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

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

let shuttingDown = false;
let uploadQueue = Promise.resolve();
let healthServer = null;
const folderCache = new Map();
const handledMessages = new Set();
const MAX_HANDLED_MESSAGES = 5000;

// Caches
let allowedUsersCache = new Map();
let allowedUsersCacheAt = 0;
let subjectsCache = [];
let subjectsCacheAt = 0;
const CACHE_TTL_MS = 60 * 1000; // تحديث الكاش كل دقيقة

let resolvedUsersSheetTitle = null;
let resolvedSubjectsSheetTitle = null;

function enqueueUpload(task) {
  const result = uploadQueue.then(task, task);
  uploadQueue = result.catch(() => undefined);
  return result;
}

// تطبيع النصوص العربية لمطابقة ذكية
function normalizeArabic(str) {
  return String(str || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/_/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .toLowerCase();
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

// تحويل الأرقام العربية النصية (مثل: الحادية والعشرون) إلى أرقام رقمية (21)
function parseArabicLectureNumber(text) {
  if (!text) return '';
  const digitsOnly = text.match(/\d+/);
  if (digitsOnly) return digitsOnly[0];

  const norm = normalizeArabic(text);

  const units = {
    'حادي': 1, 'حاديه': 1, 'اول': 1, 'اولي': 1,
    'ثاني': 2, 'ثانيه': 2,
    'ثالث': 3, 'ثالثه': 3,
    'رابع': 4, 'رابعه': 4,
    'خامس': 5, 'خامسه': 5,
    'سادس': 6, 'سادسه': 6,
    'سابع': 7, 'سابعه': 7,
    'ثامن': 8, 'ثامنه': 8,
    'تاسع': 9, 'تاسعه': 9,
    'عاشر': 10, 'عاشره': 10
  };

  const tens = {
    'عشر': 10, 'عشره': 10,
    'عشرون': 20, 'عشرين': 20,
    'ثلاثون': 30, 'ثلاثين': 30,
    'اربعون': 40, 'اربعين': 40,
    'خمسون': 50, 'خمسين': 50
  };

  // فحص المركبات مثل (الحادية عشرة، الثانية عشرة)
  for (const [uWord, uVal] of Object.entries(units)) {
    if (uVal < 10 && (norm.includes(`${uWord} عشر`) || norm.includes(`${uWord} عشره`))) {
      return String(10 + uVal);
    }
  }

  // فحص العقود مع الواو مثل (الحادية والعشرون)
  let foundUnit = 0;
  let foundTen = 0;

  for (const [uWord, uVal] of Object.entries(units)) {
    if (norm.includes(uWord)) {
      foundUnit = uVal;
      break;
    }
  }

  for (const [tWord, tVal] of Object.entries(tens)) {
    if (norm.includes(tWord) && tVal >= 20) {
      foundTen = tVal;
      break;
    }
  }

  if (foundTen > 0) {
    return String(foundTen + foundUnit);
  }

  if (foundUnit > 0) {
    return String(foundUnit);
  }

  return '';
}

// تحليل سطر الدبوس 📌
function parsePinLine(caption) {
  if (!caption) return null;
  const lines = caption.split('\n');
  const pinLine = lines.find((l) => l.includes('📌') || (l.includes('المحاضرة') && l.includes('-')));
  if (!pinLine) return null;

  const clean = pinLine.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const parts = clean.split('-').map((p) => p.trim());
  if (parts.length < 2) return null;

  const lecturePart = parts[0] || '';
  const titlePart = parts[1] || '';
  const doctorPart = parts.length >= 3 ? parts[2] : '';

  const lecNum = parseArabicLectureNumber(lecturePart);
  const cleanTitle = titlePart.replace(/[\\/:*?"<>|]/g, '').trim();
  const cleanDoctor = doctorPart
    .replace(/^(د\.?|الدكتور|الدكتورة)\s*/i, '')
    .replace(/[\\/:*?"<>|.]/g, '')
    .trim();

  return {
    lectureNumber: lecNum,
    title: cleanTitle,
    doctorName: cleanDoctor
  };
}

async function resolveSheetTitles() {
  if (resolvedUsersSheetTitle && resolvedSubjectsSheetTitle) return;

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    fields: 'sheets.properties.title'
  });

  const allSheets = spreadsheet.data.sheets || [];
  if (allSheets.length === 0) {
    throw new Error('لم يتم العثور على أي تبويب داخل Google Sheet.');
  }

  resolvedUsersSheetTitle = USERS_SHEET_NAME || allSheets[0]?.properties?.title || 'users';

  if (SUBJECTS_SHEET_NAME) {
    resolvedSubjectsSheetTitle = SUBJECTS_SHEET_NAME;
  } else if (allSheets.length > 1) {
    resolvedSubjectsSheetTitle = allSheets[1]?.properties?.title;
  } else {
    resolvedSubjectsSheetTitle = 'subjects';
  }
}

async function getAllowedUsers() {
  const now = Date.now();
  if (now - allowedUsersCacheAt < CACHE_TTL_MS && allowedUsersCache.size > 0) {
    return allowedUsersCache;
  }

  await resolveSheetTitles();
  const escapedTitle = resolvedUsersSheetTitle.replace(/'/g, "''");

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${escapedTitle}'!A2:D`,
    majorDimension: 'ROWS'
  });

  const users = new Map();
  for (const row of result.data.values || []) {
    const telegramId = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const active = String(row[2] || '').trim().toLowerCase();
    const section = String(row[3] || '').trim();
    const isActive = ['yes', 'true', '1', 'نعم', 'فعال', 'مفعل'].includes(active);

    if (telegramId && isActive) {
      users.set(telegramId, {
        name: name || telegramId,
        section: section ? sanitizeFolderName(section) : ''
      });
    }
  }

  allowedUsersCache = users;
  allowedUsersCacheAt = now;
  return users;
}

async function getSubjectsData() {
  const now = Date.now();
  if (now - subjectsCacheAt < CACHE_TTL_MS && subjectsCache.length > 0) {
    return subjectsCache;
  }

  await resolveSheetTitles();
  const escapedTitle = resolvedSubjectsSheetTitle.replace(/'/g, "''");

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${escapedTitle}'!A1:ZZ`,
    majorDimension: 'ROWS'
  });

  const rows = result.data.values || [];
  if (rows.length < 2) {
    subjectsCache = [];
    subjectsCacheAt = now;
    return subjectsCache;
  }

  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());

  const hashtagIdx = headers.indexOf('hashtag');
  const folderNameIdx = headers.indexOf('folder_name');
  const batchIdx = headers.indexOf('batch');
  const semesterIdx = headers.indexOf('semester');

  const parsed = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const hashtag = String(row[hashtagIdx] !== undefined ? row[hashtagIdx] : '').trim();
    const folderName = String(row[folderNameIdx] !== undefined ? row[folderNameIdx] : '').trim();
    let batch = String(row[batchIdx] !== undefined ? row[batchIdx] : '').trim();
    let semester = String(row[semesterIdx] !== undefined ? row[semesterIdx] : '').trim();

    if (!hashtag && !folderName) continue;

    batch = batch.replace(/[^\d]/g, '');

    if (/ثان|2/i.test(semester)) {
      semester = 'الفصل الثاني';
    } else if (/اول|أول|1/i.test(semester)) {
      semester = 'الفصل الأول';
    }

    const theorySections = [];
    const extraSections = [];
    const coursesSections = [];

    headers.forEach((header, colIdx) => {
      const val = String(row[colIdx] || '').trim();
      if (!val) return;

      const parts = val.split(/[،,]/).map((p) => p.trim()).filter(Boolean);

      if (header.startsWith('theory')) {
        theorySections.push(...parts);
      } else if (header.startsWith('extra')) {
        extraSections.push(...parts);
      } else if (header.startsWith('course')) {
        coursesSections.push(...parts);
      }
    });

    parsed.push({
      hashtag,
      normHashtag: normalizeArabic(hashtag),
      folderName: folderName || hashtag,
      batch,
      semester,
      theory: [...new Set(theorySections)],
      extra: [...new Set(extraSections)],
      courses: [...new Set(coursesSections)]
    });
  }

  subjectsCache = parsed;
  subjectsCacheAt = now;
  return subjectsCache;
}

async function isUserAllowed(userId) {
  try {
    const allowedUsers = await getAllowedUsers();
    return allowedUsers.get(String(userId)) || null;
  } catch (error) {
    console.error('تعذر قراءة المستخدمين من الشيت:', error?.message || error);
    return null;
  }
}

function extractTags(caption) {
  const matches = String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || [];
  return matches.map((t) => t.replace(/^#/, '').trim());
}

async function determineFolderAndFileName(caption, originalFileName, defaultUserSection = '') {
  const tags = extractTags(caption);
  const normTags = tags.map(normalizeArabic);
  const fullTextNorm = normalizeArabic(caption);
  const subjects = await getSubjectsData();

  // 1. تحديد المادة
  let matchedRows = [];
  let subjectTag = '';

  for (const tag of tags) {
    const norm = normalizeArabic(tag);
    const matches = subjects.filter(
      (s) => s.normHashtag === norm || s.folderName.toLowerCase() === tag.toLowerCase()
    );
    if (matches.length > 0) {
      matchedRows = matches;
      subjectTag = tag;
      break;
    }
  }

  // إذا لم يجد في الهاشتاقات، يبحث في نص الرسالة بالكامل
  if (matchedRows.length === 0) {
    for (const sub of subjects) {
      if (fullTextNorm.includes(sub.normHashtag)) {
        matchedRows = [sub];
        subjectTag = sub.hashtag;
        break;
      }
    }
  }

  if (matchedRows.length === 0) {
    throw new Error(
      `لم يتم التعرف على اسم المادة في الرسالة.\nتأكد من كتابة هاشتاق المادة الصحيح (مثل #الاحياء_الدقيقة أو #الباطنة_الغدية).`
    );
  }

  // 2. تصفية الفصل
  let semester = '';
  const isSem1 = normTags.some((t) => t.includes('اول') || t === '1' || t === 'فصل 1');
  const isSem2 = normTags.some((t) => t.includes('ثان') || t === '2' || t === 'فصل 2');

  if (isSem1) semester = 'الفصل الأول';
  if (isSem2) semester = 'الفصل الثاني';

  if (semester) {
    const filtered = matchedRows.filter((r) => r.semester === semester);
    if (filtered.length > 0) matchedRows = filtered;
  } else {
    const uniqueSemesters = [...new Set(matchedRows.map((r) => r.semester).filter(Boolean))];
    if (uniqueSemesters.length === 1) {
      semester = uniqueSemesters[0];
    } else if (uniqueSemesters.length > 1) {
      throw new Error(`المادة "${subjectTag}" متوفرة بالفصلين. يرجى كتابة الهاشتاق: #الفصل_الأول أو #الفصل_الثاني`);
    }
  }

  const selectedSubject = matchedRows[0];
  const folderName = selectedSubject.folderName;

  // 3. فحص سطر الدبوس 📌 (لاستخراج الدكتور وتسمية الملف إن وُجد)
  const pinInfo = parsePinLine(caption);

  // حساب اسم الملف
  let finalFileName = originalFileName;
  const ext = path.extname(originalFileName) || '.pdf';

  if (pinInfo && pinInfo.title) {
    if (pinInfo.lectureNumber) {
      finalFileName = `${pinInfo.lectureNumber} - ${pinInfo.title}${ext}`;
    } else {
      finalFileName = `${pinInfo.title}${ext}`;
    }
  }

  // 4. تحديد النوع الرئيسي (ستاج، عملي، دورات، إكسترا، نظري)
  const isStage = normTags.some((t) => t.includes('ستاج') || t.includes('اوسكي'));
  const isPractical = normTags.some((t) => t.includes('عملي'));
  const isCourses = normTags.some(
    (t) => t.includes('دورات') || t.includes('دوره') || t.includes('اسئله دورات')
  );
  const isExtra = normTags.some((t) => t.includes('اكسترا'));

  let typeFolders = [];
  let chosenSection = '';

  if (isStage) {
    // ستاج: مجلد ستاج فقط وبدون أي تفريعات داخله
    typeFolders = ['ستاج'];
  } else if (isPractical) {
    // عملي: مجلد عملي فقط وبدون أي تفريعات داخله
    typeFolders = ['عملي'];
  } else if (isCourses) {
    // دورات: تنزل بمجلد الدورات، وإن ذكر دكتور يُفرع له
    typeFolders = ['دورات'];
    for (const tag of tags) {
      const norm = normalizeArabic(tag);
      const found = selectedSubject.courses.find((sec) => normalizeArabic(sec) === norm);
      if (found && normalizeArabic(found) !== 'عام') {
        chosenSection = found;
        break;
      }
    }
  } else if (isExtra) {
    typeFolders = ['اكسترا'];
    for (const tag of tags) {
      const norm = normalizeArabic(tag);
      const found = selectedSubject.extra.find((sec) => normalizeArabic(sec) === norm);
      if (found && normalizeArabic(found) !== 'عام') {
        chosenSection = found;
        break;
      }
    }
  } else {
    // الافتراضي: نظري
    typeFolders = ['نظري'];

    // أ) مطابقة اسم الدكتور من سطر الدبوس أولاً
    if (pinInfo && pinInfo.doctorName) {
      const normPinDoc = normalizeArabic(pinInfo.doctorName);
      const matchedDoctor = selectedSubject.theory.find((doc) => {
        const normDoc = normalizeArabic(doc);
        return normDoc.includes(normPinDoc) || normPinDoc.includes(normDoc);
      });
      if (matchedDoctor) {
        chosenSection = matchedDoctor;
      } else {
        chosenSection = pinInfo.doctorName;
      }
    }

    // ب) إن لم يوجد بالدبوس، نبحث في الهاشتاقات أو نص الرسالة
    if (!chosenSection) {
      for (const tag of tags) {
        const norm = normalizeArabic(tag);
        const found = selectedSubject.theory.find((sec) => normalizeArabic(sec) === norm);
        if (found) {
          chosenSection = found;
          break;
        }
      }
    }

    if (!chosenSection) {
      for (const doc of selectedSubject.theory) {
        if (fullTextNorm.includes(normalizeArabic(doc))) {
          chosenSection = doc;
          break;
        }
      }
    }

    if (!chosenSection && defaultUserSection) {
      chosenSection = defaultUserSection;
    }
  }

  // 5. بناء المسار (بدون مجلد الدفعة)
  const finalPath = [];
  if (semester) finalPath.push(semester);
  finalPath.push(folderName);
  finalPath.push(...typeFolders);

  if (chosenSection) {
    finalPath.push(chosenSection);
  }

  return {
    folderPath: finalPath,
    fileName: finalFileName
  };
}

async function getOrCreateFolderPath(folderNames) {
  let parentId = GOOGLE_DRIVE_FOLDER_ID;

  for (const rawName of folderNames) {
    const folderName = sanitizeFolderName(rawName);
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
  const allowedUser = await isUserAllowed(senderId);

  if (!allowedUser) {
    console.log(`تم رفض ملف من مستخدم غير مصرح له: ${senderId}`);
    try {
      await ctx.reply('⛔ عذرًا، أنت غير مصرح لك برفع الملفات عبر هذا البوت.');
    } catch (err) {
      console.error('تعذر إرسال رسالة الرفض:', err?.message);
    }
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

  let processPlan;
  try {
    processPlan = await determineFolderAndFileName(
      ctx.message.caption?.trim(),
      fileInfo.fileName,
      allowedUser.section
    );
  } catch (err) {
    return ctx.reply(`⚠️ تنبيه في التصنيف:\n${err.message}`);
  }

  const { folderPath, fileName } = processPlan;

  await ctx.reply(
    `⏳ تم استلام الملف:\n` +
    `📄 الاسم المعتمد: ${fileName}\n` +
    `📂 المسار: ${folderPath.join(' / ')}`
  );

  enqueueUpload(async () => {
    try {
      await ctx.reply('⬆️ جاري الرفع إلى Google Drive...');

      const fileLink = await ctx.telegram.getFileLink(fileInfo.fileId);
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 180000,
        maxContentLength: 2 * 1024 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024 * 1024
      });

      const fileBuffer = Buffer.from(response.data);
      const folderId = await getOrCreateFolderPath(folderPath);

      const uploaded = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId]
        },
        media: {
          mimeType: response.headers['content-type'] || 'application/octet-stream',
          body: Readable.from(fileBuffer)
        },
        fields: 'id,name,webViewLink'
      });

      const fileUrl = uploaded.data.webViewLink ? `\n🔗 ${uploaded.data.webViewLink}` : '';

      await ctx.reply(
        `✅ تم رفع الملف بنجاح إلى Google Drive.\n` +
        `📄 الملف: ${fileName}\n` +
        `📂 المجلد: ${folderPath.join(' / ')}` +
        fileUrl
      );
    } catch (error) {
      console.error('خطأ أثناء الرفع إلى Google Drive:', error?.stack || error);
      try {
        await ctx.reply('❌ فشل رفع الملف إلى Google Drive. يرجى مراجعة الصلاحيات أو المحاولة لاحقاً.');
      } catch (replyError) {
        console.error('تعذر إرسال رسالة الخطأ:', replyError?.message);
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
      res.end(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>سياسة الخصوصية</title></head><body><h1>سياسة الخصوصية</h1><p>تطبيق لرفع الملفات إلى Google Drive.</p></body></html>`);
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
    console.log('🤖 Telegram bot is running successfully.');
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
    console.error('خطأ أثناء إيقاف Telegram:', error?.message);
  }

  try {
    await uploadQueue;
  } catch (_) {}

  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
  }

  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

startHealthServer();
startBot();
