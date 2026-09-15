const { Telegraf } = require('telegraf');
const { Storage } = require('megajs');
const axios = require('axios');

// قراءة الإعدادات من متغيرات البيئة (Environment Variables)
const BOT_TOKEN = process.env.BOT_TOKEN;
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;

if (!BOT_TOKEN || !MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error("الرجاء التأكد من تعبئة جميع متغيرات البيئة!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// دالة الاتصال بميغا
async function getMegaStorage() {
  return await new Storage({ email: MEGA_EMAIL, password: MEGA_PASSWORD }).ready;
}

// استقبال أي ملف (مستند، صورة، صوت)
bot.on(['document', 'photo', 'audio'], async (ctx) => {
  try {
    let fileId, fileName;

    if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
      fileName = ctx.message.document.file_name || 'document';
    } else if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      fileId = photo.file_id;
      fileName = `photo_${Date.now()}.jpg`;
    } else if (ctx.message.audio) {
      fileId = ctx.message.audio.file_id;
      fileName = ctx.message.audio.file_name || `audio_${Date.now()}.mp3`;
    }

    await ctx.reply('⏳ جاري تحميل الملف ومعالجته للرفع إلى MEGA...');

    // 1. جلب رابط الملف من تليجرام
    const fileLink = await ctx.telegram.getFileLink(fileId);
    
    // 2. تحميل الملف كـ Buffer
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const fileBuffer = Buffer.from(response.data);

    // 3. تحديد المجلد في ميغا (حسب الكابشن أو التصنيف التلقائي)
    const folderName = ctx.message.caption ? ctx.message.caption.trim() : getFolderByExtension(fileName);

    // 4. الاتصال بميغا والرفع
    const storage = await getMegaStorage();
    
    let targetFolder = storage.root.children.find(item => item.name === folderName && item.directory);
    if (!targetFolder) {
      targetFolder = await storage.root.mkdir(folderName);
    }

    await targetFolder.upload(fileName, fileBuffer).complete;

    await ctx.reply(`✅ تم الرفع بنجاح!\n📂 المجلد في MEGA: [${folderName}]`);

  } catch (error) {
    console.error(error);
    await ctx.reply('❌ حدث خطأ أثناء الرفع إلى MEGA.');
  }
});

// تصنيف تلقائي حسب الامتداد
function getFolderByExtension(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (['pdf', 'doc', 'docx', 'txt', 'epub'].includes(ext)) return 'Documents';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'Images';
  if (['mp3', 'm4a', 'wav', 'ogg'].includes(ext)) return 'Audios';
  if (['zip', 'rar', '7z', 'tar'].includes(ext)) return 'Archives';
  return 'Others';
}

bot.launch();
console.log('🤖 Bot is running...');

// إيقاف آمن
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
