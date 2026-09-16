const { Telegraf } = require('telegraf');
const { Storage } = require('megajs');
const axios = require('axios');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;

if (!BOT_TOKEN || !MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error('الرجاء تعبئة BOT_TOKEN و MEGA_EMAIL و MEGA_PASSWORD في متغيرات البيئة.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// جلسة MEGA واحدة فقط داخل نسخة البوت الحالية.
let megaStorage = null;
let megaLoginPromise = null;
let shuttingDown = false;
let healthServer = null;

// طابور بسيط: تتم معالجة ملف واحد في كل مرة لمنع تضارب تسجيل الدخول والرفع.
let uploadQueue = Promise.resolve();

// كاش للمجلدات حتى لا نبحث عنها أو ننشئها أكثر من مرة.
const folderCache = new Map();

// منع معالجة نفس رسالة Telegram مرتين أثناء تشغيل البوت.
const handledMessages = new Set();
const MAX_HANDLED_MESSAGES = 5000;

function enqueueUpload(task) {
  const result = uploadQueue.then(task, task);

  // إبقاء الطابور صالحًا للطلبات التالية حتى لو فشلت هذه العملية.
  uploadQueue = result.catch(() => undefined);
  return result;
}

async function getMegaStorage() {
  if (megaStorage) return megaStorage;

  // إذا كان تسجيل الدخول قيد التنفيذ، انتظر نفس العملية بدل فتح جلسة جديدة.
  if (megaLoginPromise) return megaLoginPromise;

  console.log('جاري تسجيل الدخول إلى MEGA مرة واحدة...');

  megaLoginPromise = new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD
  }).ready
    .then((storage) => {
      megaStorage = storage;
      console.log('تم الاتصال بحساب MEGA بنجاح.');
      return storage;
    })
    .catch((error) => {
      megaStorage = null;
      megaLoginPromise = null;
      throw error;
    });

  return megaLoginPromise;
}

function resetMegaSession() {
  megaStorage = null;
  megaLoginPromise = null;
  folderCache.clear();
}

async function getOrCreateFolderPath(storage, folderNames) {
  let parent = storage.root;
  const path = [];

  for (const rawName of folderNames) {
    const folderName = sanitizeFolderName(rawName);
    path.push(folderName);
    const cacheKey = path.join('/');

    if (folderCache.has(cacheKey)) {
      parent = folderCache.get(cacheKey);
      continue;
    }

    let folder = parent.children.find(
      (item) => item.directory && item.name === folderName
    );

    if (!folder) {
      folder = await parent.mkdir(folderName);
    }

    folderCache.set(cacheKey, folder);
    parent = folder;
  }

  return parent;
}

function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^[@#]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return cleaned || 'Others';
}

function extractFolderPathFromCaption(caption, fileName) {
  const hashtags = String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || [];
  const normalizedHashtags = hashtags.map((tag) =>
    tag.slice(1).replace(/_/g, ' ').trim()
  );

  const isExtra = normalizedHashtags.some((tag) =>
    ['اكسترا', 'إكسترا'].includes(tag.replace(/\s+/g, ''))
  );
  const isPractical = normalizedHashtags.some((tag) =>
    ['عملي', 'العملي'].includes(tag.replace(/\s+/g, ''))
  );

  const subject = normalizedHashtags.find((tag) => {
    const compact = tag.replace(/\s+/g, '');
    return !['اكسترا', 'إكسترا', 'عملي', 'العملي'].includes(compact);
  });

  const subjectFolder = sanitizeFolderName(subject || getFolderByExtension(fileName));

  // الافتراضي: المادة/نظري. #اكسترا: المادة/اكسترا.
  // #عملي: المادة/عملي. وإذا اجتمعا: المادة/عملي/اكسترا.
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
      await ctx.reply('⬆️ جاري رفع الملف إلى MEGA...');

      const fileLink = await ctx.telegram.getFileLink(fileInfo.fileId);
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 2 * 1024 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024 * 1024
      });

      const fileBuffer = Buffer.from(response.data);
      const caption = ctx.message.caption?.trim();
      const folderPath = extractFolderPathFromCaption(caption, fileInfo.fileName);

      const storage = await getMegaStorage();
      const targetFolder = await getOrCreateFolderPath(storage, folderPath);

      await targetFolder.upload(fileInfo.fileName, fileBuffer).complete;

      await ctx.reply(
        `✅ تم رفع الملف بنجاح.\n📄 ${fileInfo.fileName}\n📂 مجلد MEGA: ${folderPath.join(' / ')}`
      );
    } catch (error) {
      console.error('خطأ أثناء معالجة الملف:', error?.stack || error);

      // نعيد الاتصال فقط عند فشل العملية، وليس عند كل ملف ناجح.
      resetMegaSession();

      try {
        await ctx.reply('❌ فشل رفع الملف. تم تنظيف جلسة MEGA وسيُعاد الاتصال عند الملف التالي.');
      } catch (replyError) {
        console.error('تعذر إرسال رسالة الخطأ إلى Telegram:', replyError?.message || replyError);
      }
    }
  });
});

bot.catch((error) => {
  console.error('خطأ عام في Telegram bot:', error?.stack || error);
});

async function startBot() {
  try {
    // إسقاط التحديثات القديمة عند بدء التشغيل لتجنب معالجة رسائل قديمة.
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Bot is running.');
  } catch (error) {
    console.error('فشل تشغيل البوت:', error?.stack || error);
    process.exit(1);
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT) || 10000;

  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Telegram bot is running');
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`إيقاف البوت بسبب ${signal}...`);

  try {
    bot.stop(signal);
  } catch (error) {
    console.error('خطأ أثناء إيقاف البوت:', error?.message || error);
  }

  // انتظار انتهاء الملف الجاري قبل إنهاء العملية.
  try {
    await uploadQueue;
  } catch (_) {
    // الخطأ عولج داخل مهمة الرفع.
  }

  try {
    if (megaStorage?.close) {
      await megaStorage.close();
    }
  } catch (error) {
    console.error('خطأ أثناء إغلاق جلسة MEGA:', error?.message || error);
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
التشغيل:
BOT_TOKEN="..." MEGA_EMAIL="..." MEGA_PASSWORD="..." node mega-telegram-bot.js

مهم:
- شغّل نسخة واحدة فقط من البوت.
- هذا الكود يمنع تعدد جلسات MEGA الناتج عن الملفات المتزامنة.
- إعادة تشغيل البرنامج قد تظهر جلسة قديمة في حساب MEGA؛ احذف الجلسات القديمة من إعدادات MEGA عند الحاجة.
*/
