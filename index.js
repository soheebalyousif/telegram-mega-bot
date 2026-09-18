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

// تخزين حالات المستخدمين (إعادة التسمية، النقل، الأزرار التفاعلية)
const userSessions = new Map();

// Caches
let allowedUsersCache = new Map();
let allowedUsersCacheAt = 0;
let subjectsCache = [];
let subjectsCacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

let resolvedUsersSheetTitle = null;
let resolvedSubjectsSheetTitle = null;

function enqueueUpload(task) {
  const result = uploadQueue.then(task, task);
  uploadQueue = result.catch(() => undefined);
  return result;
}

// تنظيف الجلسات المؤقتة كل 10 دقائق
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

// كشف ذكي لسطر الدبوس سواء كان الدكتور بالوسط أو بالآخر
function parsePinLine(caption, knownDoctors = []) {
  if (!caption) return null;
  const lines = caption.split('\n');
  const pinLine = lines.find((l) => l.includes('📌') || (l.includes('المحاضرة') && l.includes('-')));
  if (!pinLine) return null;

  const clean = pinLine.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const parts = clean.split('-').map((p) => p.trim());
  if (parts.length < 2) return null;

  const lecturePart = parts[0] || '';
  const p1 = parts[1] || '';
  const p2 = parts.length >= 3 ? parts[2] : '';

  const lecNum = parseArabicLectureNumber(lecturePart);

  // دالة لمعرفة هل الجزء يمثل دكتوراً
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
    // 3 أجزاء
    if (isDoctor(p1)) {
      doctorPart = p1;
      titlePart = p2;
    } else if (isDoctor(p2)) {
      doctorPart = p2;
      titlePart = p1;
    } else {
      // افتراضي: الوسط عنوان والآخر دكتور
      titlePart = p1;
      doctorPart = p2;
    }
  }

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

  // 4. فحص نوع الملف
  const isStage = normTags.some((t) => t.includes('ستاج') || t.includes('اوسكي'));
  const isPractical = normTags.some((t) => t.includes('عملي'));
  const isCourses = normTags.some(
    (t) => t.includes('دورات') || t.includes('دوره') || t.includes('اسئله دورات')
  );
  const isExtra = normTags.some((t) => t.includes('اكسترا'));

  let typeFolders = [];
  let chosenSection = '';

  if (isStage) {
    typeFolders = ['ستاج'];
  } else if (isPractical) {
    typeFolders = ['عملي'];
  } else if (isCourses) {
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
    // نظري
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

  // 5. بناء المسار
  const finalPath = [];
  if (semester) finalPath.push(semester);
  finalPath.push(folderName);
  finalPath.push(...typeFolders);

  if (chosenSection) {
    finalPath.push(chosenSection);
  }

  return {
    folderPath: finalPath,
    fileName: finalFileName,
    selectedSubject,
    semester,
    isFullyDetermined: Boolean(isStage || isPractical || isCourses || isExtra || pinInfo || chosenSection)
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

// دالة توليد أزرار إدارة الملف بعد الرفع
function getFileActionButtons(driveFileId, currentFolderId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ إعادة تسمية', `ren:${driveFileId}`),
      Markup.button.callback('📁 نقل لمجلد آخر', `mov:${driveFileId}`)
    ],
    [
      Markup.button.callback('🗑️ حذف الملف نهائياً', `del:${driveFileId}`)
    ]
  ]);
}

// دالة تنفيذ الرفع إلى Google Drive
async function executeUpload({ ctx, fileInfo, folderPath, fileName }) {
  await ctx.reply(`⏳ جاري رفع الملف: ${fileName}...`);

  enqueueUpload(async () => {
    try {
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

      const driveFileId = uploaded.data.id;
      const fileUrl = uploaded.data.webViewLink ? `\n🔗 ${uploaded.data.webViewLink}` : '';

      await ctx.reply(
        `✅ تم رفع الملف بنجاح إلى Google Drive.\n` +
        `📄 الملف: ${fileName}\n` +
        `📂 المجلد: ${folderPath.join(' / ')}` +
        fileUrl,
        getFileActionButtons(driveFileId, folderId)
      );
    } catch (error) {
      console.error('خطأ أثناء الرفع إلى Google Drive:', error?.stack || error);
      try {
        await ctx.reply('❌ فشل رفع الملف إلى Google Drive. يرجى مراجعة الصلاحيات وحجم الملف.');
      } catch (replyError) {
        console.error('تعذر إرسال رسالة الخطأ:', replyError?.message);
      }
    }
  });
}

// استقبال الملفات
bot.on(['document', 'photo', 'audio', 'video'], async (ctx) => {
  if (shuttingDown) return;

  const senderId = String(ctx.from?.id || '');
  const allowedUser = await isUserAllowed(senderId);

  if (!allowedUser) {
    try {
      await ctx.reply('⛔ عذرًا، أنت غير مصرح لك برفع الملفات عبر هذا البوت.');
    } catch (_) {}
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

  const { folderPath, fileName, selectedSubject, semester, isFullyDetermined } = processPlan;

  // إذا أرسل المستخدم فقط هاشتاق المادة بدون تحديد نوع أو دكتور
  if (!isFullyDetermined) {
    const sessionId = `upl_${Date.now()}_${senderId}`;
    userSessions.set(sessionId, {
      fileInfo,
      fileName,
      selectedSubject,
      semester,
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
      [
        Markup.button.callback('❌ إلغاء', `btn_cancel:${sessionId}`)
      ]
    ];

    return ctx.reply(
      `📚 تم تحديد مادة: *${selectedSubject.folderName}*\n` +
      `يرجى اختيار القسم المراد رفع الملف إليه:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  // رفع مباشر إذا كانت البيانات مكتملة
  await executeUpload({ ctx, fileInfo, folderPath, fileName });
});

// التعامل مع أزرار تحديد النوع قبل الرفع
bot.action(/^btn_type:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = ctx.match[1];
  const typeChosen = ctx.match[2];

  const session = userSessions.get(sessionId);
  if (!session) {
    return ctx.editMessageText('⚠️ انتهت صلاحية هذه الجلسة، يرجى إعادة إرسال الملف.');
  }

  const { selectedSubject, semester, fileInfo, fileName } = session;

  // ستاج أو عملي يرفع مباشرة دون تفريعات
  if (typeChosen === 'ستاج' || typeChosen === 'عملي') {
    userSessions.delete(sessionId);
    await ctx.editMessageText(`✅ تم اختيار قسم: ${typeChosen}، جاري الرفع...`);
    const finalPath = [semester, selectedSubject.folderName, typeChosen].filter(Boolean);
    return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName });
  }

  // نظري أو دورات أو إكسترا: إظهار أسماء الدكاترة إن وجدت
  let doctorsList = [];
  if (typeChosen === 'نظري') doctorsList = selectedSubject.theory;
  else if (typeChosen === 'دورات') doctorsList = selectedSubject.courses;
  else if (typeChosen === 'اكسترا') doctorsList = selectedSubject.extra;

  if (!doctorsList || doctorsList.length === 0) {
    userSessions.delete(sessionId);
    await ctx.editMessageText(`✅ تم اختيار قسم: ${typeChosen}، جاري الرفع...`);
    const finalPath = [semester, selectedSubject.folderName, typeChosen].filter(Boolean);
    return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName });
  }

  session.typeChosen = typeChosen;
  const docButtons = [];
  for (let i = 0; i < doctorsList.length; i += 2) {
    const row = [Markup.button.callback(doctorsList[i], `btn_doc:${sessionId}:${i}`)];
    if (doctorsList[i + 1]) {
      row.push(Markup.button.callback(doctorsList[i + 1], `btn_doc:${sessionId}:${i + 1}`));
    }
    docButtons.push(row);
  }

  docButtons.push([
    Markup.button.callback('📁 عام / بدون دكتور', `btn_doc:${sessionId}:none`),
    Markup.button.callback('❌ إلغاء', `btn_cancel:${sessionId}`)
  ]);

  await ctx.editMessageText(
    `📂 القسم: *${typeChosen}*\nاختر اسم الدكتور أو القسم الفرعي:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(docButtons) }
  );
});

// التعامل مع اختيار الدكتور
bot.action(/^btn_doc:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = ctx.match[1];
  const docIndex = ctx.match[2];

  const session = userSessions.get(sessionId);
  if (!session) {
    return ctx.editMessageText('⚠️ انتهت صلاحية هذه الجلسة، يرجى إعادة إرسال الملف.');
  }

  const { selectedSubject, semester, typeChosen, fileInfo, fileName } = session;
  userSessions.delete(sessionId);

  let chosenDoc = '';
  if (docIndex !== 'none') {
    let list = selectedSubject.theory;
    if (typeChosen === 'دورات') list = selectedSubject.courses;
    else if (typeChosen === 'اكسترا') list = selectedSubject.extra;

    chosenDoc = list[Number(docIndex)] || '';
  }

  await ctx.editMessageText(`✅ تم اعتماد المسار، جاري الرفع إلى Google Drive...`);
  const finalPath = [semester, selectedSubject.folderName, typeChosen, chosenDoc].filter(Boolean);
  return executeUpload({ ctx, fileInfo, folderPath: finalPath, fileName });
});

// زر الإلغاء
bot.action(/^btn_cancel:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('تم الإلغاء');
  const sessionId = ctx.match[1];
  userSessions.delete(sessionId);
  await ctx.editMessageText('❌ تم إلغاء عملية رفع الملف.');
});

// ==========================================
// 1. زر حذف الملف
// ==========================================
bot.action(/^del:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery('جاري الحذف...');

  try {
    await drive.files.delete({ fileId });
    await ctx.editMessageText('🗑️ تم حذف الملف بنجاح من Google Drive.');
  } catch (error) {
    console.error('خطأ أثناء حذف الملف:', error?.message);
    await ctx.reply('❌ تعذر حذف الملف من Google Drive. قد يكون قد حُذف مسبقاً.');
  }
});

// ==========================================
// 2. زر إعادة تسمية الملف
// ==========================================
bot.action(/^ren:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery();

  const userId = String(ctx.from.id);
  userSessions.set(`wait_rename_${userId}`, {
    fileId,
    msgId: ctx.callbackQuery.message.message_id,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  await ctx.reply(
    '✏️ أرسل الآن الاسم الجديد للملف في الدردشة (يمكنك إرسال الاسم بدون .pdf وسيتكفل البوت بإضافتها):',
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ إلغاء التسمية', `cancel_rename_${userId}`)]
    ])
  );
});

bot.action(/^cancel_rename_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('تم الإلغاء');
  const userId = ctx.match[1];
  userSessions.delete(`wait_rename_${userId}`);
  await ctx.editMessageText('❌ تم إلغاء عملية إعادة التسمية.');
});

// استقبال الاسم الجديد كنص
bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  const renameState = userSessions.get(`wait_rename_${userId}`);

  if (!renameState) return next();

  userSessions.delete(`wait_rename_${userId}`);
  let newName = ctx.message.text.trim();

  if (!path.extname(newName)) {
    newName += '.pdf';
  }

  try {
    await drive.files.update({
      fileId: renameState.fileId,
      requestBody: { name: newName }
    });

    await ctx.reply(`✅ تم تعديل اسم الملف بنجاح إلى:\n📄 ${newName}`);
  } catch (error) {
    console.error('خطأ أثناء تعديل اسم الملف:', error?.message);
    await ctx.reply('❌ فشل تعديل اسم الملف على Google Drive.');
  }
});

// ==========================================
// 3. زر نقل الملف لمجلد آخر
// ==========================================
bot.action(/^mov:(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery();

  const subjects = await getSubjectsData();
  const subButtons = [];

  for (let i = 0; i < subjects.length; i += 2) {
    const row = [Markup.button.callback(subjects[i].folderName, `mov_sub:${fileId}:${i}`)];
    if (subjects[i + 1]) {
      row.push(Markup.button.callback(subjects[i + 1].folderName, `mov_sub:${fileId}:${i + 1}`));
    }
    subButtons.push(row);
  }

  subButtons.push([Markup.button.callback('❌ إلغاء النقل', `mov_cancel`)]);

  await ctx.reply(
    '📁 اختر المادة التي تريد نقل الملف إليها:',
    Markup.inlineKeyboard(subButtons)
  );
});

bot.action(/^mov_sub:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);

  const subjects = await getSubjectsData();
  const selectedSubject = subjects[subIdx];
  if (!selectedSubject) return ctx.editMessageText('⚠️ مادة غير صالحة.');

  const typeButtons = [
    [
      Markup.button.callback('📖 نظري', `mov_type:${fileId}:${subIdx}:نظري`),
      Markup.button.callback('🏥 ستاج', `mov_type:${fileId}:${subIdx}:ستاج`)
    ],
    [
      Markup.button.callback('📝 دورات', `mov_type:${fileId}:${subIdx}:دورات`),
      Markup.button.callback('✨ اكسترا', `mov_type:${fileId}:${subIdx}:اكسترا`)
    ],
    [Markup.button.callback('❌ إلغاء', `mov_cancel`)]
  ];

  await ctx.editMessageText(
    `📂 تم اختيار: *${selectedSubject.folderName}*\nاختر القسم الجديد:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(typeButtons) }
  );
});

bot.action(/^mov_type:(.+):(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);
  const typeChosen = ctx.match[3];

  const subjects = await getSubjectsData();
  const selectedSubject = subjects[subIdx];
  const semester = selectedSubject.semester || 'الفصل الأول';

  let doctorsList = [];
  if (typeChosen === 'نظري') doctorsList = selectedSubject.theory;
  else if (typeChosen === 'دورات') doctorsList = selectedSubject.courses;
  else if (typeChosen === 'اكسترا') doctorsList = selectedSubject.extra;

  // نقل مباشر للستاج والعملي أو إذا لم يكن هناك دكاترة
  if (typeChosen === 'ستاج' || typeChosen === 'عملي' || doctorsList.length === 0) {
    const finalPath = [semester, selectedSubject.folderName, typeChosen].filter(Boolean);
    return executeMoveFile(ctx, fileId, finalPath);
  }

  const docButtons = [];
  for (let i = 0; i < doctorsList.length; i += 2) {
    const row = [Markup.button.callback(doctorsList[i], `mov_final:${fileId}:${subIdx}:${typeChosen}:${i}`)];
    if (doctorsList[i + 1]) {
      row.push(Markup.button.callback(doctorsList[i + 1], `mov_final:${fileId}:${subIdx}:${typeChosen}:${i + 1}`));
    }
    docButtons.push(row);
  }

  docButtons.push([
    Markup.button.callback('📁 بدون تفريع دكتور', `mov_final:${fileId}:${subIdx}:${typeChosen}:none`),
    Markup.button.callback('❌ إلغاء', `mov_cancel`)
  ]);

  await ctx.editMessageText(
    `اختر الدكتور للقسم الجديد:`,
    Markup.inlineKeyboard(docButtons)
  );
});

bot.action(/^mov_final:(.+):(\d+):(.+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const subIdx = Number(ctx.match[2]);
  const typeChosen = ctx.match[3];
  const docIdx = ctx.match[4];

  const subjects = await getSubjectsData();
  const selectedSubject = subjects[subIdx];
  const semester = selectedSubject.semester || 'الفصل الأول';

  let chosenDoc = '';
  if (docIdx !== 'none') {
    let list = selectedSubject.theory;
    if (typeChosen === 'دورات') list = selectedSubject.courses;
    else if (typeChosen === 'اكسترا') list = selectedSubject.extra;

    chosenDoc = list[Number(docIdx)] || '';
  }

  const finalPath = [semester, selectedSubject.folderName, typeChosen, chosenDoc].filter(Boolean);
  return executeMoveFile(ctx, fileId, finalPath);
});

bot.action('mov_cancel', async (ctx) => {
  await ctx.answerCbQuery('تم الإلغاء');
  await ctx.editMessageText('❌ تم إلغاء عملية النقل.');
});

// تنفيذ نقل الملف في Google Drive
async function executeMoveFile(ctx, fileId, targetFolderPath) {
  try {
    await ctx.editMessageText('⏳ جاري نقل الملف إلى المجلد الجديد...');
    const targetFolderId = await getOrCreateFolderPath(targetFolderPath);

    const fileMeta = await drive.files.get({
      fileId,
      fields: 'parents'
    });

    const previousParents = (fileMeta.data.parents || []).join(',');

    await drive.files.update({
      fileId,
      addParents: targetFolderId,
      removeParents: previousParents,
      fields: 'id, parents'
    });

    await ctx.editMessageText(
      `✅ تم نقل الملف بنجاح!\n` +
      `📂 المسار الجديد: ${targetFolderPath.join(' / ')}`
    );
  } catch (error) {
    console.error('خطأ أثناء نقل الملف:', error?.message);
    await ctx.editMessageText('❌ فشل نقل الملف في Google Drive.');
  }
}

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
    console.log('🤖 Telegram bot is running successfully with Action Buttons.');
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
