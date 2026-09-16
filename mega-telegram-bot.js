const { Telegraf } = require('telegraf');
const { Storage } = require('megajs');
const axios = require('axios');

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

async function getOrCreateFolder(storage, folderName) {
  if (folderCache.has(folderName)) {
    return folderCache.get(folderName);
  }

  let folder = storage.root.children.find(
    (item) => item.directory && item.name === folderName
  );

  if (!folder) {
    folder = await storage.root.mkdir(folderName);
  }

  folderCache.set(folderName, folder);
  return folder;
}

function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return cleaned || 'Others';
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
      const folderName = sanitizeFolderName(
        caption || getFolderByExtension(fileInfo.fileName)
      );

      const storage = await getMegaStorage();
      const targetFolder = await getOrCreateFolder(storage, folderName);

      await targetFolder.upload(fileInfo.fileName, fileBuffer).complete;

      await ctx.reply(
        `✅ تم رفع الملف بنجاح.\n📄 ${fileInfo.fileName}\n📂 مجلد MEGA: ${folderName}`
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

  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

startBot();

/*
التشغيل:
BOT_TOKEN="..." MEGA_EMAIL="..." MEGA_PASSWORD="..." node mega-telegram-bot.js

مهم:
- شغّل نسخة واحدة فقط من البوت.
- هذا الكود يمنع تعدد جلسات MEGA الناتج عن الملفات المتزامنة.
- إعادة تشغيل البرنامج قد تظهر جلسة قديمة في حساب MEGA؛ احذف الجلسات القديمة من إعدادات MEGA عند الحاجة.
*/
