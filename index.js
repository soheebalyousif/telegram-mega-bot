const { Telegraf, Markup } = require('telegraf');
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
const BATCHES_SHEET_NAME = process.env.BATCHES_SHEET_NAME || '';

if (
  !BOT_TOKEN ||
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REFRESH_TOKEN ||
  !GOOGLE_SHEET_ID
) {
  console.error('الرجاء تعبئة جميع المتغيرات المطلوبة.');
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

// تخزين حالات المستخدمين
const userSessions = new Map();
const browseState = new Map();

// Caches
let allowedUsersCache = new Map();
let allowedUsersCacheAt = 0;
let subjectsCache = [];
let subjectsCacheAt = 0;
let batchesCache = new Map();
let batchesCacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

let resolvedUsersSheetTitle = null;
let resolvedSubjectsSheetTitle = null;
let resolvedBatchesSheetTitle = null;

function enqueueUpload(task) {
  const result = uploadQueue.then(task, task);
  uploadQueue = result.catch(() => undefined);
  return result;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, session] of userSessions.entries()) {
    if (session.expiresAt && now > session.expiresAt) {
      userSessions.delete(key);
    }
  }
}, 10 * 60 * 1000);

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

  for (const [uWord, uVal] of Object.entries(units)) {
    if (uVal < 10 && (norm.includes(`${uWord} عشر`) || norm.includes(`${uWord} عشره`))) {
      return String(10 + uVal);
    }
  }

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

  if (foundTen > 0) return String(foundTen + foundUnit);
  if (foundUnit > 0) return String(foundUnit);

  return '';
}

function parsePinLine(caption, knownDoctors = []) {
  if (!caption) return null;
  const lines = caption.split('\n');
  const pinLine = lines.find((l) => l.includes('📌') || (l.includes('المحاضرة') && l.includes('-')) || (l.includes('الإكسترا') && l.includes('-')));
  if (!pinLine) return null;

  const clean = pinLine.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const parts = clean.split('-').map((p) => p.trim());
  if (parts.length < 2) return null;

  const lecturePart = parts[0] || '';
  const p1 = parts[1] || '';
  const p2 = parts.length >= 3 ? parts[2] : '';

  const lecNum = parseArabicLectureNumber(lecturePart);

  function isDoctor(str) {
    if (!str) return false;
    const norm = normalizeArabic(str);
    if (norm.startsWith('د ') || norm.startsWith('د.') || norm.startsWith('الدكتور') || norm.startsWith('الدكتوره')) {
      return true;
    }
    return knownDoctors.some((doc) => norm.includes(normalizeArabic(doc)));
  }

  let titlePart = '';
  let doctorPart = '';

  if (parts.length === 2) {
    if (isDoctor(p1)) doctorPart = p1;
    else titlePart = p1;
  } else {
    if (isDoctor(p1)) {
      doctorPart = p1;
      titlePart = p2;
    } else if (isDoctor(p2)) {
      doctorPart = p2;
      titlePart = p1;
    } else {
      titlePart = p1;
      doctorPart = p2;
    }
  }

  const cleanTitle = titlePart.replace(/[\\/:*?"<>|]/g, '').replace(/\.+$/, '').trim();
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
  if (resolvedUsersSheetTitle && resolvedSubjectsSheetTitle && resolvedBatchesSheetTitle) return;

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    fields: 'sheets.properties.title'
  });

  const allSheets = spreadsheet.data.sheets || [];
  if (allSheets.length === 0) {
    throw new Error('لم يتم العثور على أي تبويب داخل Google Sheet.');
  }

  resolvedUsersSheetTitle = USERS_SHEET_NAME || allSheets[0]?.properties?.title || 'users';
  resolvedSubjectsSheetTitle = SUBJECTS_SHEET_NAME || (allSheets.length > 1 ? allSheets[1]?.properties?.title : 'subjects');
  resolvedBatchesSheetTitle = BATCHES_SHEET_NAME || (allSheets.length > 2 ? allSheets[2]?.properties?.title : 'batches');
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
    const role = String(row[2] || '').trim().toLowerCase();
    const batch = String(row[3] || '').trim().replace(/[^\d]/g, '');

    const isAdmin = ['admin', 'مدير', 'ادمن'].includes(role);
    const isActive = isAdmin || ['yes', 'true', '1', 'نعم', 'فعال', 'مفعل', 'member'].includes(role);

    if (telegramId && isActive) {
      users.set(telegramId, {
        name: name || telegramId,
        isAdmin,
        batch
      });
    }
  }

  allowedUsersCache = users;
  allowedUsersCacheAt = now;
  return users;
}

async function getBatchesData() {
  const now = Date.now();
  if (now - batchesCacheAt < CACHE_TTL_MS && batchesCache.size > 0) {
    return batchesCache;
  }

  await resolveSheetTitles();
  const escapedTitle = resolvedBatchesSheetTitle.replace(/'/g, "''");

  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `'${escapedTitle}'!A2:B`,
      majorDimension: 'ROWS'
    });

    const bMap = new Map();
    for (const row of result.data.values || []) {
      const bNum = String(row[0] || '').trim().replace(/[^\d]/g, '');
      const folderId = String(row[1] || '').trim();
      if (bNum && folderId) {
        bMap.set(bNum, folderId);
      }
    }
    batchesCache = bMap;
    batchesCacheAt = now;
  } catch (err) {
    console.log('لم يتم العثور على تبويب batches، الاعتماد على المجلد الافتراضي.');
  }
  return batchesCache;
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
  const yearIdx = headers.indexOf('year');
  const semesterIdx = headers.indexOf('semester');

  const parsed = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const hashtag = String(row[hashtagIdx] !== undefined ? row[hashtagIdx] : '').trim();
    const folderName = String(row[folderNameIdx] !== undefined ? row[folderNameIdx] : '').trim();
    let batch = String(row[batchIdx] !== undefined ? row[batchIdx] : '').trim();
    let year = String(row[yearIdx] !== undefined ? row[yearIdx] : '').trim();
    let semester = String(row[semesterIdx] !== undefined ? row[semesterIdx] : '').trim();

    if (!hashtag && !folderName) continue;

    batch = batch.replace(/[^\d]/g, '');

    if (!year) {
      if (batch === '2027') year = 'السنة الخامسة';
      else if (batch === '2028') year = 'السنة الرابعة';
      else if (batch === '2029') year = 'السنة الثالثة';
      else if (batch === '2030') year = 'السنة الثانية';
    }

    if (/ثان|2/i.test(semester)) semester = 'الفصل الثاني';
    else if (/اول|أول|1/i.test(semester)) semester = 'الفصل الأول';

    const theorySections = [];
    const extraSections = [];
    const coursesSections = [];

    headers.forEach((header, colIdx) => {
      const val = String(row[colIdx] || '').trim();
      if (!val) return;

      const parts = val.split(/[،,]/).map((p) => p.trim()).filter(Boolean);

      if (header.startsWith('theory')) theorySections.push(...parts);
      else if (header.startsWith('extra')) extraSections.push(...parts);
      else if (header.startsWith('course')) coursesSections.push(...parts);
    });

    parsed.push({
      hashtag,
      normHashtag: normalizeArabic(hashtag),
      folderName: folderName || hashtag,
      batch,
      year,
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
    console.error('تعذر قراءة المستخدمين:', error?.message);
    return null;
  }
}

function extractTags(caption) {
  const matches = String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || [];
  return matches.map((t) => t.replace(/^#/, '').trim());
}

async function determineFolderAndFileName(caption, originalFileName, senderBatch = '', isAdmin = false) {
  const tags = extractTags(caption);
  const normTags = tags.map(normalizeArabic);
  const fullTextNorm = normalizeArabic(caption);
  const subjects = await getSubjectsData();

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
    throw new Error('لم يتم التعرف على اسم المادة في الرسالة.');
  }

  if (!isAdmin && senderBatch) {
    const matchWithBatch = matchedRows.find((r) => r.batch === senderBatch);
    if (!matchWithBatch) {
      throw new Error(`صلاحياتك محصورة بمواد دفعة ${senderBatch} فقط.`);
    }
    matchedRows = [matchWithBatch];
  }

  const selectedSubject = matchedRows[0];
  const { folderName, year, semester, batch } = selectedSubject;

  const pinInfo = parsePinLine(caption, selectedSubject.theory);
  let finalFileName = originalFileName;
  const ext = path.extname(originalFileName) || '.pdf';

  if (pinInfo && pinInfo.title) {
    if (pinInfo.lectureNumber) {
      finalFileName = `${pinInfo.lectureNumber} - ${pinInfo.title}${ext}`;
    } else {
      finalFileName = `${pinInfo.title}${ext}`;
    }
  }

  const isCourses = fullTextNorm.includes('دورات') || fullTextNorm.includes('دوره') || normTags.some((t) => t.includes('دورات'));
  const isStage = !isCourses && normTags.some((t) => t.includes('ستاج') || t.includes('اوسكي'));
  const isPractical = !isCourses && normTags.some((t) => t.includes('عملي'));
  const isExtra = !isCourses && normTags.some((t) => t.includes('اكسترا'));

  let typeFolders = [];
  let chosenSection = '';

  if (isCourses) {
    typeFolders = ['دورات'];
    if (pinInfo && pinInfo.doctorName) chosenSection = pinInfo.doctorName;
    if (!chosenSection) {
      for (const tag of tags) {
        const found = selectedSubject.courses.find((sec) => normalizeArabic(sec) === normalizeArabic(tag));
        if (found) { chosenSection = found; break; }
      }
    }
  } else if (isStage) {
    typeFolders = ['ستاج'];
  } else if (isPractical) {
    typeFolders = ['عملي'];
  } else if (isExtra) {
    typeFolders = ['اكسترا'];
    if (pinInfo && pinInfo.doctorName) chosenSection = pinInfo.doctorName;
    if (!chosenSection) {
      for (const tag of tags) {
        const found = selectedSubject.extra.find((sec) => normalizeArabic(sec) === normalizeArabic(tag));
        if (found) { chosenSection = found; break; }
      }
    }
  } else {
    typeFolders = ['نظري'];
    if (pinInfo && pinInfo.doctorName) {
      const normPinDoc = normalizeArabic(pinInfo.doctorName);
      const matchedDoctor = selectedSubject.theory.find((doc) => {
        const normDoc = normalizeArabic(doc);
        return normDoc.includes(normPinDoc) || normPinDoc.includes(normDoc);
      });
      chosenSection = matchedDoctor || pinInfo.doctorName;
    }

    if (!chosenSection) {
      for (const doc of selectedSubject.theory) {
        if (fullTextNorm.includes(normalizeArabic(doc))) {
          chosenSection = doc;
          break;
        }
      }
    }
  }

  const finalPath = [];
  if (year) finalPath.push(year);
  if (semester) finalPath.push(semester);
  finalPath.push(folderName);
  finalPath.push(...typeFolders);
  if (chosenSection) finalPath.push(chosenSection);

  return {
    folderPath: finalPath,
    fileName: finalFileName,
    selectedSubject,
    batch,
    isFullyDetermined: Boolean(isStage || isPractical || isCourses || isExtra || pinInfo || chosenSection)
  };
}

async function getOrCreateFolderPath(folderNames, rootParentId = GOOGLE_DRIVE_FOLDER_ID) {
  let parentId = rootParentId;

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
      fileName: message.document.file_name || `document_${Date.now()}.pdf`
    };
  }
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId: photo.file_id,
      fileName: `photo_${Date.now()}.jpg`
    };
  }
  return null;
}

function getFileActionButtons(driveFileId, subjectIdx) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ إعادة تسمية', `ren:${driveFileId}`),
      Markup.button.callback('📁 نقل لمجلد آخر', `mov_start:${driveFileId}:${subjectIdx}`)
    ],
    [
      Markup.button.callback('🗑️ حذف الملف نهائياً', `del:${driveFileId}`)
    ]
  ]);
}

async function executeUpload({ ctx, fileInfo, folderPath, fileName, batch, subjectIdx }) {
  await ctx.reply(`جاري حفظ الملف وأرشفته: ${escapeHtml(fileName)}...`, { parse_mode: 'HTML' });

  enqueueUpload(async () => {
    try {
      const batchesMap = await getBatchesData();
      const targetRootId = batchesMap.get(batch) || GOOGLE_DRIVE_FOLDER_ID;

      const fileLink = await ctx.telegram.getFileLink(fileInfo.fileId);
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 180000,
        maxContentLength: 2 * 1024 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024 * 1024
      });

      const fileBuffer = Buffer.from(response.data);
      const folderId = await getOrCreateFolderPath(folderPath, targetRootId);

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

      const driveFileId = uploaded.data.id;
      const fileUrl = uploaded.data.webViewLink ? `\n🔗 <a href="${uploaded.data.webViewLink}">رابط الملف في الأرشيف</a>` : '';

      userSessions.set(`file_info_${driveFileId}`, {
        ownerId: String(ctx.from.id),
        batch
      });

      await ctx.reply(
        `<b>تم حفظ الملف وأرشفته بنجاح.</b>\n\n` +
        `📄 <b>الملف:</b> ${escapeHtml(fileName)}\n` +
        `📂 <b>المسار:</b> ${escapeHtml(folderPath.join(' / '))}` +
        fileUrl,
        {
          parse_mode: 'HTML',
          ...getFileActionButtons(driveFileId, subjectIdx)
        }
      );
    } catch (error) {
      console.error('خطأ الرفع:', error?.message);
      await ctx.reply('تعذر حفظ الملف حالياً، يرجى إعادة المحاولة.');
    }
  });
}

// ==========================================
// القوائم السفلية (Reply Keyboard) للتصفح
// ==========================================
const MAIN_MENU_KEYBOARD = Markup.keyboard([
  ['📚 تصفح المحاضرات والملفات']
]).resize();

const YEARS_KEYBOARD = Markup.keyboard([
  ['السنة الثانية', 'السنة الثالثة'],
  ['السنة الرابعة', 'السنة الخامسة'],
  ['🏠 القائمة الرئيسية']
]).resize();

bot.start(async (ctx) => {
  browseState.delete(String(ctx.from.id));
  await ctx.reply(
    `أهلاً بك في منصة الأرشيف الطبي.\n` +
    `تفضل باختيار المحاضرات والملفات عبر الزر أدناه.`,
    MAIN_MENU_KEYBOARD
  );
});

// استقبال النصوص للأزرار السفلية
bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  // معالجة حالة إعادة تسمية الملف للأعضاء أولاً
  const renameState = userSessions.get(`wait_ren_${userId}`);
  if (renameState) {
    userSessions.delete(`wait_ren_${userId}`);
    let newName = text;
    if (!path.extname(newName)) newName += '.pdf';

    try {
      await drive.files.update({
        fileId: renameState.fileId,
        requestBody: { name: newName }
      });
      return ctx.reply(`تم تعديل اسم الملف بنجاح إلى:\n📄 <b>${escapeHtml(newName)}</b>`, {
        parse_mode: 'HTML',
        ...MAIN_MENU_KEYBOARD
      });
    } catch (err) {
      return ctx.reply('تعذر تعديل اسم الملف حالياً.', MAIN_MENU_KEYBOARD);
    }
  }

  // 1. القائمة الرئيسية
  if (text === '📚 تصفح المحاضرات والملفات') {
    browseState.set(userId, { step: 'YEARS' });
    return ctx.reply('تفضل باختيار السنة الدراسية:', YEARS_KEYBOARD);
  }

  if (text === '🏠 القائمة الرئيسية') {
    browseState.delete(userId);
    return ctx.reply('تفضل باختيار ما يناسبك:', MAIN_MENU_KEYBOARD);
  }

  // 2. اختيار السنة الدراسية
  const yearMap = {
    'السنة الثانية': { batch: '2030', year: 'السنة الثانية' },
    'السنة الثالثة': { batch: '2029', year: 'السنة الثالثة' },
    'السنة الرابعة': { batch: '2028', year: 'السنة الرابعة' },
    'السنة الخامسة': { batch: '2027', year: 'السنة الخامسة' }
  };

  if (yearMap[text]) {
    const { batch, year } = yearMap[text];
    const subjects = await getSubjectsData();
    const batchSubs = subjects.filter((s) => s.batch === batch);

    if (batchSubs.length === 0) {
      return ctx.reply(`لا توجد مواد مدرجة حالياً لـ ${escapeHtml(year)}.`, YEARS_KEYBOARD);
    }

    browseState.set(userId, { step: 'SUBJECTS', batch, year });

    const subRows = [];
    for (let i = 0; i < batchSubs.length; i += 2) {
      const row = [batchSubs[i].hashtag];
      if (batchSubs[i + 1]) row.push(batchSubs[i + 1].hashtag);
      subRows.push(row);
    }
    subRows.push(['🔙 رجوع للسنوات', '🏠 القائمة الرئيسية']);

    return ctx.reply(`<b>${escapeHtml(year)}</b>\nتفضل باختيار المادة:`, {
      parse_mode: 'HTML',
      ...Markup.keyboard(subRows).resize()
    });
  }

  if (text === '🔙 رجوع للسنوات') {
    browseState.set(userId, { step: 'YEARS' });
    return ctx.reply('تفضل باختيار السنة الدراسية:', YEARS_KEYBOARD);
  }

  // 3. اختيار المادة
  const state = browseState.get(userId);

  if (state && state.step === 'SUBJECTS') {
    const subjects = await getSubjectsData();
    const selectedSub = subjects.find(
      (s) => s.batch === state.batch && (s.hashtag === text || s.folderName === text)
    );

    if (selectedSub) {
      const subIdx = subjects.indexOf(selectedSub);
      browseState.set(userId, {
        step: 'TYPES',
        batch: state.batch,
        year: state.year,
        subIdx,
        sub: selectedSub
      });

      const typesKeyboard = Markup.keyboard([
        ['📖 نظري', '🏥 ستاج'],
        ['📝 دورات', '✨ اكسترا'],
        ['🔙 رجوع للمواد', '🏠 القائمة الرئيسية']
      ]).resize();

      return ctx.reply(
        `<b>مادة ${escapeHtml(selectedSub.hashtag)}</b>\nاختر القسم المطلوب:`,
        { parse_mode: 'HTML', ...typesKeyboard }
      );
    }
  }

  if (text === '🔙 رجوع للمواد' && state) {
    const subjects = await getSubjectsData();
    const batchSubs = subjects.filter((s) => s.batch === state.batch);

    browseState.set(userId, { step: 'SUBJECTS', batch: state.batch, year: state.year });

    const subRows = [];
    for (let i = 0; i < batchSubs.length; i += 2) {
      const row = [batchSubs[i].hashtag];
      if (batchSubs[i + 1]) row.push(batchSubs[i + 1].hashtag);
      subRows.push(row);
    }
    subRows.push(['🔙 رجوع للسنوات', '🏠 القائمة الرئيسية']);

    return ctx.reply(`<b>${escapeHtml(state.year)}</b>\nتفضل باختيار المادة:`, {
      parse_mode: 'HTML',
      ...Markup.keyboard(subRows).resize()
    });
  }

  // 4. اختيار القسم (نظري، ستاج، دورات، إكسترا)
  if (state && state.step === 'TYPES') {
    const typeMapping = {
      '📖 نظري': 'نظري',
      '🏥 ستاج': 'ستاج',
      '📝 دورات': 'دورات',
      '✨ اكسترا': 'اكسترا'
    };

    const chosenType = typeMapping[text];
    if (chosenType) {
      const sub = state.sub;

      let docList = [];
      if (chosenType === 'نظري') docList = sub.theory;
      else if (chosenType === 'دورات') docList = sub.courses;
      else if (chosenType === 'اكسترا') docList = sub.extra;

      // ستاج أو أقسام بدون تفريعات
      if (chosenType === 'ستاج' || docList.length === 0) {
        browseState.set(userId, {
          ...state,
          step: 'FILES',
          type: chosenType,
          sectionName: ''
        });
        return fetchAndShowFilesKeyboard(ctx, sub, chosenType, '');
      }

      // عرض أسماء الدكاترة كأزرار كيبورد سفلية
      browseState.set(userId, {
        ...state,
        step: 'DOCTORS',
        type: chosenType,
        docList
      });

      const docRows = [];
      for (let i = 0; i < docList.length; i += 2) {
        const row = [docList[i]];
        if (docList[i + 1]) row.push(docList[i + 1]);
        docRows.push(row);
      }
      docRows.push(['📁 عام / الكل']);
      docRows.push(['🔙 رجوع للأقسام', '🏠 القائمة الرئيسية']);

      return ctx.reply(
        `<b>${escapeHtml(sub.hashtag)} &gt; ${escapeHtml(chosenType)}</b>\nاختر الدكتور أو القسم:`,
        {
          parse_mode: 'HTML',
          ...Markup.keyboard(docRows).resize()
        }
      );
    }
  }

  if (text === '🔙 رجوع للأقسام' && state) {
    browseState.set(userId, {
      step: 'TYPES',
      batch: state.batch,
      year: state.year,
      subIdx: state.subIdx,
      sub: state.sub
    });

    const typesKeyboard = Markup.keyboard([
      ['📖 نظري', '🏥 ستاج'],
      ['📝 دورات', '✨ اكسترا'],
      ['🔙 رجوع للمواد', '🏠 القائمة الرئيسية']
    ]).resize();

    return ctx.reply(
      `<b>مادة ${escapeHtml(state.sub.hashtag)}</b>\nاختر القسم المطلوب:`,
      { parse_mode: 'HTML', ...typesKeyboard }
    );
  }

  // 5. اختيار الدكتور
  if (state && state.step === 'DOCTORS') {
    let chosenDoc = '';
    if (text === '📁 عام / الكل') {
      chosenDoc = '';
    } else if (state.docList && state.docList.includes(text)) {
      chosenDoc = text;
    } else {
      return next();
    }

    browseState.set(userId, {
      ...state,
      step: 'FILES',
      sectionName: chosenDoc
    });

    return fetchAndShowFilesKeyboard(ctx, state.sub, state.type, chosenDoc);
  }

  // 6. تحميل وإرسال الملف عند الضغط عليه من الكيبورد السفلي
  if (state && state.step === 'FILES' && state.filesList) {
    if (text === '🔙 رجوع للقائمة السابقة') {
      if (state.docList && state.docList.length > 0) {
        browseState.set(userId, {
          ...state,
          step: 'DOCTORS'
        });

        const docRows = [];
        for (let i = 0; i < state.docList.length; i += 2) {
          const row = [state.docList[i]];
          if (state.docList[i + 1]) row.push(state.docList[i + 1]);
          docRows.push(row);
        }
        docRows.push(['📁 عام / الكل']);
        docRows.push(['🔙 رجوع للأقسام', '🏠 القائمة الرئيسية']);

        return ctx.reply('تفضل باختيار القسم:', {
          parse_mode: 'HTML',
          ...Markup.keyboard(docRows).resize()
        });
      } else {
        browseState.set(userId, {
          step: 'TYPES',
          batch: state.batch,
          year: state.year,
          subIdx: state.subIdx,
          sub: state.sub
        });

        const typesKeyboard = Markup.keyboard([
          ['📖 نظري', '🏥 ستاج'],
          ['📝 دورات', '✨ اكسترا'],
          ['🔙 رجوع للمواد', '🏠 القائمة الرئيسية']
        ]).resize();

        return ctx.reply('اختر القسم المطلوب:', { parse_mode: 'HTML', ...typesKeyboard });
      }
    }

    const matchedFile = state.filesList.find(
      (f) => f.name === text || `📄 ${f.name}` === text
    );

    if (matchedFile) {
      return downloadAndSendFile(ctx, matchedFile.id);
    }
  }

  return next();
});

// دالة جلب وعرض الملفات في الكيبورد السفلي
async function fetchAndShowFilesKeyboard(ctx, sub, type, sectionName) {
  const userId = String(ctx.from.id);
  await ctx.reply('طلبك على قدم وساق، لحظات ويتم تحضير القائمة...');

  try {
    const batchesMap = await getBatchesData();
    const rootParentId = batchesMap.get(sub.batch) || GOOGLE_DRIVE_FOLDER_ID;

    const pathArr = [sub.year, sub.semester, sub.folderName, type, sectionName].filter(Boolean);
    const targetFolderId = await getOrCreateFolderPath(pathArr, rootParentId);

    const driveRes = await drive.files.list({
      q: `'${targetFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, size, webViewLink)',
      orderBy: 'name'
    });

    const files = driveRes.data.files || [];

    if (files.length === 0) {
      const curState = browseState.get(userId) || {};
      browseState.set(userId, { ...curState, filesList: [] });

      const emptyKeyboard = Markup.keyboard([
        ['🔙 رجوع للقائمة السابقة', '🏠 القائمة الرئيسية']
      ]).resize();

      return ctx.reply(
        `<b>${escapeHtml(sub.hashtag)} &gt; ${escapeHtml(type)}</b>\n\nلا توجد ملفات متوفرة هنا حالياً.`,
        { parse_mode: 'HTML', ...emptyKeyboard }
      );
    }

    const curState = browseState.get(userId) || {};
    browseState.set(userId, {
      ...curState,
      filesList: files
    });

    const fileRows = files.slice(0, 30).map((f) => [`📄 ${f.name}`]);
    fileRows.push(['🔙 رجوع للقائمة السابقة', '🏠 القائمة الرئيسية']);

    return ctx.reply(
      `<b>${escapeHtml(sub.hashtag)} &gt; ${escapeHtml(type)} ${sectionName ? `&gt; ${escapeHtml(sectionName)}` : ''}</b>\n` +
      `تفضل بالضغط على اسم المحاضرة من الأسفل لتحميلها مباشرة:`,
      {
        parse_mode: 'HTML',
        ...Markup.keyboard(fileRows).resize()
      }
    );
  } catch (error) {
    console.error('خطأ جلب الملفات:', error?.message);
    await ctx.reply('تعذر استعراض الملفات حالياً.');
  }
}

// دالة إرسال الملف
async function downloadAndSendFile(ctx, fileId) {
  try {
    await ctx.reply('طلبك على قدم وساق، لحظات ويكون الملف بين يديك...');

    const fileMeta = await drive.files.get({
      fileId,
      fields: 'id, name, size, webViewLink'
    });

    const fileSize = Number(fileMeta.data.size || 0);

    if (fileSize > 48 * 1024 * 1024) {
      return ctx.reply(
        `📄 <b>${escapeHtml(fileMeta.data.name)}</b>\n\n` +
        `حجم الملف كبير (${(fileSize / (1024 * 1024)).toFixed(1)} ميغابايت).\n` +
        `<a href="${fileMeta.data.webViewLink}">اضغط هنا للتحميل المباشر</a>`,
        { parse_mode: 'HTML' }
      );
    }

    const driveStream = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    await ctx.replyWithDocument(
      {
        source: driveStream.data,
        filename: fileMeta.data.name
      },
      {
        caption: `📄 <b>${escapeHtml(fileMeta.data.name)}</b>\n\n🔗 <a href="${fileMeta.data.webViewLink}">رابط الحفظ الخارجي</a>`,
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    console.error('خطأ إرسال الملف:', error?.message);
    await ctx.reply('تعذر إرسال الملف حالياً، يرجى المحاولة لاحقاً.');
  }
}

// ==========================================
// استقبال الملفات من أعضاء الفريق
// ==========================================
bot.on(['document', 'photo'], async (ctx) => {
  if (shuttingDown) return;

  const senderId = String(ctx.from?.id || '');
  const allowedUser = await isUserAllowed(senderId);

  if (!allowedUser) {
    return ctx.reply('عذرًا، أنت غير مصرح لك برفع الملفات عبر هذا البوت.');
  }

  const messageId = `${ctx.chat.id}:${ctx.message.message_id}`;
  if (handledMessages.has(messageId)) return;
  handledMessages.add(messageId);

  const fileInfo = getTelegramFileInfo(ctx.message);
  if (!fileInfo) return;

  let processPlan;
  try {
    processPlan = await determineFolderAndFileName(
      ctx.message.caption?.trim(),
      fileInfo.fileName,
      allowedUser.batch,
      allowedUser.isAdmin
    );
  } catch (err) {
    return ctx.reply(`تنبيه: ${err.message}`);
  }

  const { folderPath, fileName, selectedSubject, batch, isFullyDetermined } = processPlan;
  const subIdx = subjectsCache.indexOf(selectedSubject);

  if (!isFullyDetermined) {
    const sessionId = `upl_${Date.now()}_${senderId}`;
    userSessions.set(sessionId, {
      fileInfo,
      fileName,
      selectedSubject,
      batch,
      subIdx,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    const buttons = [
      [
        Markup.button.callback('📖 نظري', `btn_type:${sessionId}:نظري`),
        Markup.button.callback('🏥 ستاج', `btn_type:${sessionId}:ستاج`)
      ],
      [
        Markup.button.callback('📝 دورات', `btn_type:${sessionId}:دورات`),
        Markup.button.callback('✨ اكسترا', `btn_type:${sessionId}:اكسترا`)
      ],
      [Markup.button.callback('❌ إلغاء', `btn_cancel:${sessionId}`)]
    ];

    return ctx.reply(
      `تم تحديد مادة: <b>${escapeHtml(selectedSubject.folderName)}</b>\nتفضل باختيار القسم المراد الحفظ فيه:`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
  }

  await executeUpload({ ctx, fileInfo, folderPath, fileName, batch, subjectIdx: subIdx });
});

bot.action(/^btn_type:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = ctx.match[1];
  const type = ctx.match[2];

  const session = userSessions.get(sessionId);
  if (!session) return ctx.editMessageText('انتهت صلاحية الجلسة.');

  const { selectedSubject, batch, fileInfo, fileName, subIdx } = session;

  if (type === 'ستاج') {
    userSessions.delete(sessionId);
    await ctx.editMessageText('تم اعتماد قسم ستاج، جاري الحفظ...');
    const finalPath = [selectedSubject.year, selectedSubject.semester, selectedSubject.folderName, 'ستاج'].filter(Boolean);
    return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName, batch, subjectIdx: subIdx });
  }

  let list = [];
  if (type === 'نظري') list = selectedSubject.theory;
  else if (type === 'دورات') list = selectedSubject.courses;
  else if (type === 'اكسترا') list = selectedSubject.extra;

  if (list.length === 0) {
    userSessions.delete(sessionId);
    await ctx.editMessageText(`تم اعتماد ${escapeHtml(type)}، جاري الحفظ...`, { parse_mode: 'HTML' });
    const finalPath = [selectedSubject.year, selectedSubject.semester, selectedSubject.folderName, type].filter(Boolean);
    return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName, batch, subjectIdx: subIdx });
  }

  session.type = type;
  const docButtons = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [Markup.button.callback(list[i], `btn_doc:${sessionId}:${i}`)];
    if (list[i + 1]) row.push(Markup.button.callback(list[i + 1], `btn_doc:${sessionId}:${i + 1}`));
    docButtons.push(row);
  }

  docButtons.push([
    Markup.button.callback('📁 عام / بدون قسم', `btn_doc:${sessionId}:none`),
    Markup.button.callback('❌ إلغاء', `btn_cancel:${sessionId}`)
  ]);

  await ctx.editMessageText(`اختر القسم المطلوب:`, Markup.inlineKeyboard(docButtons));
});

bot.action(/^btn_doc:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = ctx.match[1];
  const docIdx = ctx.match[2];

  const session = userSessions.get(sessionId);
  if (!session) return ctx.editMessageText('انتهت صلاحية الجلسة.');

  const { selectedSubject, batch, type, fileInfo, fileName, subIdx } = session;
  userSessions.delete(sessionId);

  let chosenDoc = '';
  if (docIdx !== 'none') {
    let list = selectedSubject.theory;
    if (type === 'دورات') list = selectedSubject.courses;
    else if (type === 'اكسترا') list = selectedSubject.extra;
    chosenDoc = list[Number(docIdx)] || '';
  }

  await ctx.editMessageText('طلبك على قدم وساق، جاري حفظ الملف...');
  const finalPath = [selectedSubject.year, selectedSubject.semester, selectedSubject.folderName, type, chosenDoc].filter(Boolean);
  return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName, batch, subjectIdx: subIdx });
});

bot.action(/^btn_cancel:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  userSessions.delete(ctx.match[1]);
  await ctx.editMessageText('تم إلغاء العملية.');
});

// ==========================================
// أزرار إدارة الملف للفريق (حذف، تسمية، نقل)
// ==========================================
bot.action(/^del:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  const userId = String(ctx.from.id);
  const user = await isUserAllowed(userId);
  const fileInfo = userSessions.get(`file_info_${fileId}`);

  if (!user?.isAdmin && fileInfo && fileInfo.ownerId !== userId) {
    return ctx.answerCbQuery('ليس لديك صلاحية لحذف هذا الملف.', { show_alert: true });
  }

  await ctx.answerCbQuery();
  try {
    await drive.files.delete({ fileId });
    await ctx.editMessageText('تم حذف الملف نهائياً من الأرشيف.');
  } catch (error) {
    await ctx.reply('تعذر حذف الملف.');
  }
});

bot.action(/^ren:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  const userId = String(ctx.from.id);
  const user = await isUserAllowed(userId);
  const fileInfo = userSessions.get(`file_info_${fileId}`);

  if (!user?.isAdmin && fileInfo && fileInfo.ownerId !== userId) {
    return ctx.answerCbQuery('ليس لديك صلاحية لتعديل هذا الملف.', { show_alert: true });
  }

  await ctx.answerCbQuery();
  userSessions.set(`wait_ren_${userId}`, { fileId, expiresAt: Date.now() + 5 * 60 * 1000 });
  await ctx.reply('تفضل بإرسال الاسم الجديد للملف بالدردشة:');
});

bot.action(/^mov_start:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);

  const subjects = await getSubjectsData();
  const sub = subjects[subIdx];

  const typeButtons = [
    [
      Markup.button.callback('📖 نظري', `mov_t:${fileId}:${subIdx}:نظري`),
      Markup.button.callback('🏥 ستاج', `mov_t:${fileId}:${subIdx}:ستاج`)
    ],
    [
      Markup.button.callback('📝 دورات', `mov_t:${fileId}:${subIdx}:دورات`),
      Markup.button.callback('✨ اكسترا', `mov_t:${fileId}:${subIdx}:اكسترا`)
    ],
    [Markup.button.callback('📚 اختيار مادة أخرى', `mov_other_subs:${fileId}:${subIdx}`)],
    [Markup.button.callback('❌ إلغاء', 'mov_cancel')]
  ];

  await ctx.reply(
    `<b>نقل الملف:</b> ${escapeHtml(sub.folderName)}\nاختر القسم الجديد:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(typeButtons) }
  );
});

bot.action(/^mov_other_subs:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const curSubIdx = Number(ctx.match[2]);

  const subjects = await getSubjectsData();
  const curSub = subjects[curSubIdx];
  const sameBatchSubs = subjects.filter((s) => s.batch === curSub.batch);

  const subButtons = [];
  for (let i = 0; i < sameBatchSubs.length; i += 2) {
    const idx1 = subjects.indexOf(sameBatchSubs[i]);
    const row = [Markup.button.callback(sameBatchSubs[i].folderName, `mov_sub_picked:${fileId}:${idx1}`)];
    if (sameBatchSubs[i + 1]) {
      const idx2 = subjects.indexOf(sameBatchSubs[i + 1]);
      row.push(Markup.button.callback(sameBatchSubs[i + 1].folderName, `mov_sub_picked:${fileId}:${idx2}`));
    }
    subButtons.push(row);
  }

  subButtons.push([Markup.button.callback('🔙 رجوع للمادة السابقة', `mov_start:${fileId}:${curSubIdx}`)]);

  await ctx.editMessageText(`اختر المادة المطلوبة:`, Markup.inlineKeyboard(subButtons));
});

bot.action(/^mov_sub_picked:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);
  const sub = (await getSubjectsData())[subIdx];

  const typeButtons = [
    [
      Markup.button.callback('📖 نظري', `mov_t:${fileId}:${subIdx}:نظري`),
      Markup.button.callback('🏥 ستاج', `mov_t:${fileId}:${subIdx}:ستاج`)
    ],
    [
      Markup.button.callback('📝 دورات', `mov_t:${fileId}:${subIdx}:دورات`),
      Markup.button.callback('✨ اكسترا', `mov_t:${fileId}:${subIdx}:اكسترا`)
    ],
    [Markup.button.callback('🔙 رجوع لاختيار مادة', `mov_other_subs:${fileId}:${subIdx}`)]
  ];

  await ctx.editMessageText(
    `<b>مادة ${escapeHtml(sub.folderName)}</b>\nاختر القسم:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(typeButtons) }
  );
});

bot.action(/^mov_t:(.+):(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);
  const type = ctx.match[3];

  const subjects = await getSubjectsData();
  const sub = subjects[subIdx];

  if (type === 'ستاج') {
    const finalPath = [sub.year, sub.semester, sub.folderName, 'ستاج'].filter(Boolean);
    return doMove(ctx, fileId, finalPath, sub.batch);
  }

  let list = [];
  if (type === 'نظري') list = sub.theory;
  else if (type === 'دورات') list = sub.courses;
  else if (type === 'اكسترا') list = sub.extra;

  if (list.length === 0) {
    const finalPath = [sub.year, sub.semester, sub.folderName, type].filter(Boolean);
    return doMove(ctx, fileId, finalPath, sub.batch);
  }

  const docButtons = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [Markup.button.callback(list[i], `mov_f:${fileId}:${subIdx}:${type}:${i}`)];
    if (list[i + 1]) row.push(Markup.button.callback(list[i + 1], `mov_f:${fileId}:${subIdx}:${type}:${i + 1}`));
    docButtons.push(row);
  }

  docButtons.push([
    Markup.button.callback('📁 بدون تفريع دكتور', `mov_f:${fileId}:${subIdx}:${type}:none`),
    Markup.button.callback('🔙 رجوع', `mov_sub_picked:${fileId}:${subIdx}`)
  ]);

  await ctx.editMessageText(`اختر القسم المطلوب:`, Markup.inlineKeyboard(docButtons));
});

bot.action(/^mov_f:(.+):(\d+):(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);
  const type = ctx.match[3];
  const docIdx = ctx.match[4];

  const sub = (await getSubjectsData())[subIdx];
  let chosenDoc = '';

  if (docIdx !== 'none') {
    let list = sub.theory;
    if (type === 'دورات') list = sub.courses;
    else if (type === 'اكسترا') list = sub.extra;
    chosenDoc = list[Number(docIdx)] || '';
  }

  const finalPath = [sub.year, sub.semester, sub.folderName, type, chosenDoc].filter(Boolean);
  return doMove(ctx, fileId, finalPath, sub.batch);
});

bot.action('mov_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('تم إلغاء عملية النقل.');
});

async function doMove(ctx, fileId, finalPath, batch) {
  try {
    await ctx.editMessageText('طلبك على قدم وساق، جاري نقل الملف...');
    const batchesMap = await getBatchesData();
    const targetRootId = batchesMap.get(batch) || GOOGLE_DRIVE_FOLDER_ID;

    const targetFolderId = await getOrCreateFolderPath(finalPath, targetRootId);
    const fileMeta = await drive.files.get({ fileId, fields: 'parents' });
    const prevParents = (fileMeta.data.parents || []).join(',');

    await drive.files.update({
      fileId,
      addParents: targetFolderId,
      removeParents: prevParents,
      fields: 'id, parents'
    });

    await ctx.editMessageText(
      `<b>تم نقل الملف بنجاح.</b>\n\n📂 <b>المسار الجديد:</b> ${escapeHtml(finalPath.join(' / '))}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.editMessageText('تعذر نقل الملف.');
  }
}

bot.catch((err) => console.error('خطأ عام:', err?.message));

function startHealthServer() {
  const port = Number(process.env.PORT) || 10000;
  healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot is running');
  });
  healthServer.listen(port, '0.0.0.0');
}

async function startBot() {
  try {
    await bot.launch({ dropPendingUpdates: false });
    console.log('Bot is running successfully.');
  } catch (err) {
    console.error('فشل تشغيل البوت:', err?.message);
    process.exit(1);
  }
}

startHealthServer();
startBot();
