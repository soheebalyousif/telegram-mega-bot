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

// تخزين حالات المستخدمين والجلسات
const userSessions = new Map();

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

  // إزالة النقط والرموز الزائدة
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
    console.log('لم يتم العثور على تبويب batches، سيتم الاعتماد على المجلد الرئيسي الافتراضي.');
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

    // استنتاج السنة إن لم تكن مكتوبة
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

  // 2. التحقق من صلاحية دفعة العضو
  if (!isAdmin && senderBatch) {
    const matchWithBatch = matchedRows.find((r) => r.batch === senderBatch);
    if (!matchWithBatch) {
      throw new Error(`صلاحياتك محصورة بمواد دفعة ${senderBatch} فقط.`);
    }
    matchedRows = [matchWithBatch];
  }

  const selectedSubject = matchedRows[0];
  const { folderName, year, semester, batch } = selectedSubject;

  // 3. تحليل سطر الدبوس 📌
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

  // 4. تحديد النوع مع الأولوية للدورات
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

  // 5. بناء المسار: السنة ⬅️ الفصل ⬅️ المادة ⬅️ القسم
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
  await ctx.reply(`⏳ جاري رفع الملف: ${fileName}...`);

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
      const fileUrl = uploaded.data.webViewLink ? `\n🔗 ${uploaded.data.webViewLink}` : '';

      userSessions.set(`file_info_${driveFileId}`, {
        ownerId: String(ctx.from.id),
        batch
      });

      await ctx.reply(
        `✅ تم رفع الملف بنجاح إلى Google Drive.\n` +
        `📄 الملف: ${fileName}\n` +
        `📂 المسار: ${folderPath.join(' / ')}` +
        fileUrl,
        getFileActionButtons(driveFileId, subjectIdx)
      );
    } catch (error) {
      console.error('خطأ الرفع:', error?.message);
      await ctx.reply('❌ فشل رفع الملف إلى Google Drive.');
    }
  });
}

// القائمة السفلية العامة للطلاب
const publicMainMenu = Markup.keyboard([
  ['📚 تصفح المحاضرات والملفات']
]).resize();

bot.start(async (ctx) => {
  await ctx.reply(
    `أهلاً بك في بوت المحاضرات والملفات الطبية 🩺\n` +
    `يمكنك تصفح وتحميل أي محاضرة بصيغة PDF مباشرة بالضغط على الزر أدناه 👇`,
    publicMainMenu
  );
});

// ==========================================
// قسم استعراض وتحميل المحاضرات للطلاب
// ==========================================
bot.hears('📚 تصفح المحاضرات والملفات', async (ctx) => {
  const yearButtons = [
    [Markup.button.callback('السنة الثانية (دفعة 2030)', 'browse_yr:2030:السنة الثانية')],
    [Markup.button.callback('السنة الثالثة (دفعة 2029)', 'browse_yr:2029:السنة الثالثة')],
    [Markup.button.callback('السنة الرابعة (دفعة 2028)', 'browse_yr:2028:السنة الرابعة')],
    [Markup.button.callback('السنة الخامسة (دفعة 2027)', 'browse_yr:2027:السنة الخامسة')]
  ];

  await ctx.reply('📚 اختر سنتك الدراسية للتصفح:', Markup.inlineKeyboard(yearButtons));
});

bot.action(/^browse_yr:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const batch = ctx.match[1];
  const yearName = ctx.match[2];

  const subjects = await getSubjectsData();
  const batchSubs = subjects.filter((s) => s.batch === batch);

  if (batchSubs.length === 0) {
    return ctx.editMessageText(`⚠️ لا توجد مواد مضافة حالياً لـ ${yearName}.`);
  }

  const subButtons = [];
  for (let i = 0; i < batchSubs.length; i += 2) {
    const idx1 = subjects.indexOf(batchSubs[i]);
    const row = [Markup.button.callback(batchSubs[i].hashtag, `browse_sub:${idx1}`)];
    if (batchSubs[i + 1]) {
      const idx2 = subjects.indexOf(batchSubs[i + 1]);
      row.push(Markup.button.callback(batchSubs[i + 1].hashtag, `browse_sub:${idx2}`));
    }
    subButtons.push(row);
  }

  subButtons.push([Markup.button.callback('🔙 رجوع للسنوات', 'browse_back_years')]);

  await ctx.editMessageText(
    `📂 *${yearName}*\nاختر المادة المطلوبة:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(subButtons) }
  );
});

bot.action('browse_back_years', async (ctx) => {
  await ctx.answerCbQuery();
  const yearButtons = [
    [Markup.button.callback('السنة الثانية (دفعة 2030)', 'browse_yr:2030:السنة الثانية')],
    [Markup.button.callback('السنة الثالثة (دفعة 2029)', 'browse_yr:2029:السنة الثالثة')],
    [Markup.button.callback('السنة الرابعة (دفعة 2028)', 'browse_yr:2028:السنة الرابعة')],
    [Markup.button.callback('السنة الخامسة (دفعة 2027)', 'browse_yr:2027:السنة الخامسة')]
  ];
  await ctx.editMessageText('📚 اختر سنتك الدراسية للتصفح:', Markup.inlineKeyboard(yearButtons));
});

bot.action(/^browse_sub:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subIdx = Number(ctx.match[1]);
  const subjects = await getSubjectsData();
  const sub = subjects[subIdx];

  const typeButtons = [
    [
      Markup.button.callback('📖 نظري', `browse_type:${subIdx}:نظري`),
      Markup.button.callback('🏥 ستاج', `browse_type:${subIdx}:ستاج`)
    ],
    [
      Markup.button.callback('📝 دورات', `browse_type:${subIdx}:دورات`),
      Markup.button.callback('✨ اكسترا', `browse_type:${subIdx}:اكسترا`)
    ],
    [Markup.button.callback('🔙 رجوع للمواد', `browse_yr:${sub.batch}:${sub.year}`)]
  ];

  await ctx.editMessageText(
    `📂 مادة: *${sub.hashtag}*\nاختر القسم:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(typeButtons) }
  );
});

bot.action(/^browse_type:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subIdx = Number(ctx.match[1]);
  const type = ctx.match[2];

  const subjects = await getSubjectsData();
  const sub = subjects[subIdx];

  let list = [];
  if (type === 'نظري') list = sub.theory;
  else if (type === 'دورات') list = sub.courses;
  else if (type === 'اكسترا') list = sub.extra;

  if (type === 'ستاج' || list.length === 0) {
    return showFilesList(ctx, sub, type, '');
  }

  const docButtons = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [Markup.button.callback(list[i], `browse_doc:${subIdx}:${type}:${i}`)];
    if (list[i + 1]) {
      row.push(Markup.button.callback(list[i + 1], `browse_doc:${subIdx}:${type}:${i + 1}`));
    }
    docButtons.push(row);
  }

  docButtons.push([
    Markup.button.callback('📁 عام / الكل', `browse_doc:${subIdx}:${type}:none`),
    Markup.button.callback('🔙 رجوع', `browse_sub:${subIdx}`)
  ]);

  await ctx.editMessageText(
    `📂 *${sub.hashtag} > ${type}*\nاختر الدكتور أو القسم:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(docButtons) }
  );
});

bot.action(/^browse_doc:(\d+):(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subIdx = Number(ctx.match[1]);
  const type = ctx.match[2];
  const docIdx = ctx.match[3];

  const subjects = await getSubjectsData();
  const sub = subjects[subIdx];

  let chosenDoc = '';
  if (docIdx !== 'none') {
    let list = sub.theory;
    if (type === 'دورات') list = sub.courses;
    else if (type === 'اكسترا') list = sub.extra;
    chosenDoc = list[Number(docIdx)] || '';
  }

  return showFilesList(ctx, sub, type, chosenDoc);
});

// جلب وعرض الملفات كأزرار تحميل
async function showFilesList(ctx, sub, type, sectionName) {
  await ctx.editMessageText('⏳ جاري جلب قائمة المحاضرات من Google Drive...');

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
      return ctx.editMessageText(
        `📂 *${sub.hashtag} > ${type}*\n\n⚠️ لا توجد ملفات مرفوعة هنا حالياً.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', `browse_sub:${subjectsCache.indexOf(sub)}`)]])
        }
      );
    }

    const fileButtons = files.slice(0, 30).map((f) => [
      Markup.button.callback(`📄 ${f.name}`, `dl_file:${f.id}`)
    ]);

    fileButtons.push([Markup.button.callback('🔙 رجوع للأقسام', `browse_sub:${subjectsCache.indexOf(sub)}`)]);

    await ctx.editMessageText(
      `📂 *${sub.hashtag} > ${type} ${sectionName ? `> ${sectionName}` : ''}*\n` +
      `اضغط على اسم أي محاضرة لتحميلها مباشرة 👇:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(fileButtons) }
    );
  } catch (error) {
    console.error('خطأ جلب الملفات:', error?.message);
    await ctx.editMessageText('❌ تعذر جلب الملفات من Google Drive.');
  }
}

// إرسال ملف الـ PDF مباشرة للدردشة
bot.action(/^dl_file:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery('جاري تجهيز الملف وإرساله...');

  try {
    await ctx.reply('⏳ جاري إرسال المحاضرة إليك بصيغة PDF مباشرة...');

    const fileMeta = await drive.files.get({
      fileId,
      fields: 'id, name, size, webViewLink'
    });

    const fileSize = Number(fileMeta.data.size || 0);

    // إذا كان حجم الملف أكبر من 50 ميغابايت (حد تيليغرام للبوتات)
    if (fileSize > 48 * 1024 * 1024) {
      return ctx.reply(
        `📄 *${fileMeta.data.name}*\n\n` +
        `⚠️ حجم الملف كبير (${(fileSize / (1024 * 1024)).toFixed(1)} ميغابايت).\n` +
        `يمكنك تحميله مباشرة من الرابط التالي:\n🔗 ${fileMeta.data.webViewLink}`,
        { parse_mode: 'Markdown' }
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
        caption: `📄 *${fileMeta.data.name}*\n\n🔗 [رابط الملف على Google Drive](${fileMeta.data.webViewLink})`,
        parse_mode: 'Markdown'
      }
    );
  } catch (error) {
    console.error('خطأ إرسال الملف:', error?.message);
    await ctx.reply('❌ تعذر إرسال الملف، يرجى المحاولة لاحقاً.');
  }
});

// ==========================================
// استقبال الملفات من أعضاء الفريق المصرح لهم
// ==========================================
bot.on(['document', 'photo'], async (ctx) => {
  if (shuttingDown) return;

  const senderId = String(ctx.from?.id || '');
  const allowedUser = await isUserAllowed(senderId);

  if (!allowedUser) {
    return ctx.reply('⛔ عذرًا، أنت غير مصرح لك برفع الملفات عبر هذا البوت.');
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
    return ctx.reply(`⚠️ تنبيه:\n${err.message}`);
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
      `📚 تم تحديد مادة: *${selectedSubject.folderName}*\nاختر القسم المراد الرفع إليه:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  await executeUpload({ ctx, fileInfo, folderPath, fileName, batch, subjectIdx: subIdx });
});

bot.action(/^btn_type:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = ctx.match[1];
  const type = ctx.match[2];

  const session = userSessions.get(sessionId);
  if (!session) return ctx.editMessageText('⚠️ انتهت الجلسة.');

  const { selectedSubject, batch, fileInfo, fileName, subIdx } = session;

  if (type === 'ستاج') {
    userSessions.delete(sessionId);
    await ctx.editMessageText('✅ تم اختيار ستاج، جاري الرفع...');
    const finalPath = [selectedSubject.year, selectedSubject.semester, selectedSubject.folderName, 'ستاج'].filter(Boolean);
    return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName, batch, subjectIdx: subIdx });
  }

  let list = [];
  if (type === 'نظري') list = selectedSubject.theory;
  else if (type === 'دورات') list = selectedSubject.courses;
  else if (type === 'اكسترا') list = selectedSubject.extra;

  if (list.length === 0) {
    userSessions.delete(sessionId);
    await ctx.editMessageText(`✅ تم اختيار ${type}، جاري الرفع...`);
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

  await ctx.editMessageText(`اختر الدكتور أو القسم:`, Markup.inlineKeyboard(docButtons));
});

bot.action(/^btn_doc:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = ctx.match[1];
  const docIdx = ctx.match[2];

  const session = userSessions.get(sessionId);
  if (!session) return ctx.editMessageText('⚠️ انتهت الجلسة.');

  const { selectedSubject, batch, type, fileInfo, fileName, subIdx } = session;
  userSessions.delete(sessionId);

  let chosenDoc = '';
  if (docIdx !== 'none') {
    let list = selectedSubject.theory;
    if (type === 'دورات') list = selectedSubject.courses;
    else if (type === 'اكسترا') list = selectedSubject.extra;
    chosenDoc = list[Number(docIdx)] || '';
  }

  await ctx.editMessageText('✅ جاري رفع الملف...');
  const finalPath = [selectedSubject.year, selectedSubject.semester, selectedSubject.folderName, type, chosenDoc].filter(Boolean);
  return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName, batch, subjectIdx: subIdx });
});

bot.action(/^btn_cancel:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('تم الإلغاء');
  userSessions.delete(ctx.match[1]);
  await ctx.editMessageText('❌ تم إلغاء الرفع.');
});

// ==========================================
// أزرار إدارة الملف (حذف، تسمية، نقل)
// ==========================================
bot.action(/^del:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  const userId = String(ctx.from.id);
  const user = await isUserAllowed(userId);
  const fileInfo = userSessions.get(`file_info_${fileId}`);

  if (!user?.isAdmin && fileInfo && fileInfo.ownerId !== userId) {
    return ctx.answerCbQuery('⛔ ليس لديك صلاحية لحذف هذا الملف.', { show_alert: true });
  }

  await ctx.answerCbQuery('جاري الحذف...');
  try {
    await drive.files.delete({ fileId });
    await ctx.editMessageText('🗑️ تم حذف الملف نهائياً من Google Drive.');
  } catch (error) {
    await ctx.reply('❌ تعذر حذف الملف.');
  }
});

bot.action(/^ren:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  const userId = String(ctx.from.id);
  const user = await isUserAllowed(userId);
  const fileInfo = userSessions.get(`file_info_${fileId}`);

  if (!user?.isAdmin && fileInfo && fileInfo.ownerId !== userId) {
    return ctx.answerCbQuery('⛔ ليس لديك صلاحية لإعادة تسمية هذا الملف.', { show_alert: true });
  }

  await ctx.answerCbQuery();
  userSessions.set(`wait_ren_${userId}`, { fileId, expiresAt: Date.now() + 5 * 60 * 1000 });
  await ctx.reply('✏️ أرسل الآن الاسم الجديد للملف بالدردشة:');
});

bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  const state = userSessions.get(`wait_ren_${userId}`);

  if (!state) return next();
  userSessions.delete(`wait_ren_${userId}`);

  let newName = ctx.message.text.trim();
  if (!path.extname(newName)) newName += '.pdf';

  try {
    await drive.files.update({
      fileId: state.fileId,
      requestBody: { name: newName }
    });
    await ctx.reply(`✅ تم تعديل اسم الملف بنجاح إلى:\n📄 ${newName}`);
  } catch (err) {
    await ctx.reply('❌ فشل تعديل اسم الملف.');
  }
});

// نقل ذكي يبدأ من نفس المادة ونفس الدفعة مع زر رجوع
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
    [Markup.button.callback(`📚 مادة أخرى (دفعة ${sub.batch})`, `mov_other_subs:${fileId}:${subIdx}`)],
    [Markup.button.callback('❌ إلغاء', 'mov_cancel')]
  ];

  await ctx.reply(
    `📁 *نقل الملف:* ${sub.folderName}\nاختر القسم الجديد:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(typeButtons) }
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

  await ctx.editMessageText(
    `📚 اختر مادة من نفس دفعة (*${curSub.batch}*):`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(subButtons) }
  );
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
    `📂 المادة: *${sub.folderName}*\nاختر القسم:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(typeButtons) }
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

  await ctx.editMessageText(`اختر الدكتور للقسم الجديد:`, Markup.inlineKeyboard(docButtons));
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
  await ctx.answerCbQuery('تم الإلغاء');
  await ctx.editMessageText('❌ تم إلغاء عملية النقل.');
});

async function doMove(ctx, fileId, finalPath, batch) {
  try {
    await ctx.editMessageText('⏳ جاري نقل الملف...');
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
      `✅ تم نقل الملف بنجاح!\n📂 المسار الجديد: ${finalPath.join(' / ')}`
    );
  } catch (err) {
    await ctx.editMessageText('❌ فشل نقل الملف.');
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
    console.log('🤖 Telegram bot is running successfully.');
  } catch (err) {
    console.error('فشل تشغيل البوت:', err?.message);
    process.exit(1);
  }
}

startHealthServer();
startBot();
