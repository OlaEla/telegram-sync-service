"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncTelegramPosts = syncTelegramPosts;
const promise_1 = __importDefault(require("mysql2/promise"));
const ssh2_sftp_client_1 = __importDefault(require("ssh2-sftp-client"));
const path_1 = __importDefault(require("path"));
// ===== DATABASE POOL =====
let pool = null;
function getPool() {
    if (!pool) {
        pool = promise_1.default.createPool({
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT || '3306'),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 5,
            queueLimit: 0,
            charset: 'utf8mb4'
        });
    }
    return pool;
}
async function syncTelegramPosts() {
    let connection = null;
    try {
        const pool = getPool();
        connection = await pool.getConnection();
        // 1️⃣ Получаем метаданные синхронизации
        const [metaRows] = await connection.query('SELECT last_sync, last_update_id FROM sync_meta WHERE id = 1');
        const lastSync = metaRows[0]?.last_sync
            ? new Date(metaRows[0].last_sync)
            : new Date(0);
        const minutesSinceSync = (Date.now() - lastSync.getTime()) / 1000 / 60;
        console.log(`⏰ Minutes since last sync: ${minutesSinceSync.toFixed(1)}`);
        // 2️⃣ Запуск синхронизации через Bot API
        const syncedCount = await syncViaBotAPI(connection, metaRows[0]?.last_update_id || 0, 100);
        // 3️⃣ Обновляем метаданные
        await connection.query(`UPDATE sync_meta 
       SET last_sync = NOW(),
           total_posts = (SELECT COUNT(*) FROM telegram_posts)
       WHERE id = 1`);
        return {
            success: true,
            synced: syncedCount,
            method: 'bot_api',
            nextSync: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        };
    }
    catch (error) {
        console.error('❌ Sync error:', error);
        return {
            success: false,
            synced: 0,
            method: 'bot_api',
            error: error.message
        };
    }
    finally {
        // ✅ ГАРАНТИРОВАННО освобождаем соединение
        if (connection) {
            connection.release();
            console.log('🔌 DB connection released');
        }
    }
}
// ===== КОД syncViaBotAPI =====
async function syncViaBotAPI(connection, lastUpdateId = 0, limit = 100) {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const CHANNEL_NAME = process.env.TELEGRAM_CHANNEL || 'More Than English';
    const CHANNEL_AVATAR = process.env.TELEGRAM_CHANNEL_AVATAR || '/images/blog/telegram-avatar.png';
    // фильтрация репостов 
    const ALLOW_FORWARDED_POSTS = process.env.ALLOW_FORWARDED_POSTS === 'true';
    const ALLOWED_FORWARD_CHANNEL_IDS = (process.env.ALLOWED_FORWARD_CHANNEL_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    console.log(`🔧 Forwarded posts: ${ALLOW_FORWARDED_POSTS ? 'ENABLED' : 'DISABLED'}`);
    if (ALLOW_FORWARDED_POSTS && ALLOWED_FORWARD_CHANNEL_IDS.length > 0) {
        console.log(`🔐 Allowed forward sources: ${ALLOWED_FORWARD_CHANNEL_IDS.join(', ')}`);
    }
    if (!BOT_TOKEN || !CHAT_ID) {
        throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
    }
    console.log(`Starting Bot API sync... last_update_id: ${lastUpdateId}`);
    try {
        // Получаем обновления
        const offset = lastUpdateId ? lastUpdateId + 1 : -limit;
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&limit=${limit}`);
        const data = (await response.json());
        if (!data.ok) {
            throw new Error(`Telegram API error: ${data.description}`);
        }
        console.log(`Received ${data.result.length} updates from Telegram`);
        const channelPosts = data.result
            .map((update) => ({
            update_id: update.update_id,
            post: update.channel_post
        }))
            .filter(({ post }) => {
            if (!post)
                return false;
            // только наш канал
            if (post.chat.id.toString() !== CHAT_ID.toString()) {
                return false;
            }
            const isForwarded = Boolean(post.forward_origin ||
                post.forward_from_chat);
            // 🚫 репосты запрещены
            if (isForwarded && !ALLOW_FORWARDED_POSTS) {
                console.log(`⛔ Skipping forwarded post ${post.message_id} (forwards disabled)`);
                return false;
            }
            // 🔐 репосты разрешены, но ограничены источниками
            if (isForwarded && ALLOWED_FORWARD_CHANNEL_IDS.length > 0) {
                const sourceChatId = post.forward_origin?.chat?.id ??
                    post.forward_from_chat?.id;
                if (!sourceChatId) {
                    console.log(`⛔ Skipping forwarded post ${post.message_id} (unknown source)`);
                    return false;
                }
                if (!ALLOWED_FORWARD_CHANNEL_IDS.includes(String(sourceChatId))) {
                    console.log(`⛔ Skipping forwarded post ${post.message_id} (source ${sourceChatId} not allowed)`);
                    return false;
                }
                console.log(`✅ Allowed forwarded post ${post.message_id} from ${sourceChatId}`);
            }
            // ✅ оригинальный пост или разрешённый репост
            return true;
        });
        // console.log(`Found ${channelPosts.length} channel posts`);
        console.log(`Found ${channelPosts.length} channel posts after filtering`);
        let syncedCount = 0;
        let maxUpdateId = lastUpdateId;
        // ✅ для альбомов
        const processedMediaGroups = new Set();
        for (const { update_id, post } of channelPosts) {
            try {
                // ✅ media group (album) handling
                if (post.media_group_id) {
                    if (processedMediaGroups.has(post.media_group_id)) {
                        console.log(`⏭️  Skipping album image ${post.message_id} (media_group_id=${post.media_group_id})`);
                        continue;
                    }
                    // первое сообщение альбома
                    processedMediaGroups.add(post.media_group_id);
                }
                await savePost(connection, post, CHAT_ID, CHANNEL_NAME, CHANNEL_AVATAR, BOT_TOKEN);
                syncedCount++;
                maxUpdateId = Math.max(maxUpdateId, update_id);
            }
            catch (itemError) {
                console.error(`❌ Error processing post ${post?.message_id}:`, itemError);
            }
        }
        // Сохраняем последний update_id
        if (maxUpdateId > lastUpdateId) {
            await connection.query('UPDATE sync_meta SET last_update_id = ? WHERE id = 1', [maxUpdateId]);
        }
        console.log(`Successfully synced ${syncedCount} posts, last_update_id: ${maxUpdateId}`);
        return syncedCount;
    }
    catch (error) {
        console.error('Bot API sync error:', error);
        throw error;
    }
}
// ===== КОД savePost =====
async function savePost(connection, post, chatId, channelName, channelAvatar, botToken) {
    // 🔴 Исключаем опросы
    if (post.poll && post.poll.type === "quiz") {
        console.log(`⏭️  Skipping quiz poll (message_id: ${post.message_id})`);
        return;
    }
    const postId = `tg_${chatId}_${post.message_id}`;
    const messageId = post.message_id;
    const fullText = post.text || post.caption || '';
    const date = new Date(post.date * 1000);
    // Парсим title и paragraph
    const { title, paragraph } = parseTextToTitleAndParagraph(fullText);
    // Извлекаем хештеги
    const hashtags = extractHashtags(fullText);
    // 🚫 Проверяем служебный хештег — не публикуем пост на сайте
    const SKIP_HASHTAG = process.env.TELEGRAM_SKIP_HASHTAG;
    if (SKIP_HASHTAG && hashtags.includes(SKIP_HASHTAG.toLowerCase())) {
        console.log(`⏭️  Post ${post.message_id} skipped due to #${SKIP_HASHTAG}`);
        return;
    }
    // Извлекаем медиа URL (fallback для Telegram CDN)
    let imageUrl = null;
    let videoUrl = null;
    if (post.photo && post.photo.length > 0) {
        const largestPhoto = post.photo[post.photo.length - 1];
        imageUrl = await getFileUrl(botToken, largestPhoto.file_id);
    }
    if (post.video) {
        videoUrl = await getFileUrl(botToken, post.video.file_id);
    }
    if (post.document) {
        if (post.document.mime_type?.startsWith('image')) {
            imageUrl = await getFileUrl(botToken, post.document.file_id);
        }
        else if (post.document.mime_type?.startsWith('video')) {
            videoUrl = await getFileUrl(botToken, post.document.file_id);
        }
    }
    // Формируем ссылку на пост в Telegram
    const channelUsername = chatId.startsWith('@')
        ? chatId.substring(1)
        : `c/${chatId.toString().substring(4)}`;
    const telegramLink = `https://t.me/${channelUsername}/${messageId}`;
    // 1️⃣ Сначала сохраняем основную информацию поста
    await connection.query(`INSERT INTO telegram_posts 
    (id, message_id, text, title, paragraph, date, image_url, video_url, 
     telegram_link, author_name, author_image, author_designation,
     image_uploaded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      text = VALUES(text),
      title = VALUES(title),
      paragraph = VALUES(paragraph),
      image_url = VALUES(image_url),
      video_url = VALUES(video_url)`, [
        postId,
        messageId,
        fullText,
        title,
        paragraph,
        date,
        imageUrl,
        videoUrl,
        telegramLink,
        channelName,
        channelAvatar,
        'English Learning Community',
        false // По умолчанию image_uploaded = false
    ]);
    console.log(`✅ Post ${messageId} saved to DB`);
    // Скачиваем: Изображение ПРЕВЬЮ ВИДЕО (если есть видео)
    if (post.video?.thumbnail || post.video?.thumb) {
        try {
            const thumbnail = post.video.thumbnail || post.video.thumb;
            console.log(`🎬 Downloading video thumbnail for post ${messageId}...`);
            const imagePath = await downloadTelegramImage(thumbnail.file_id, messageId);
            if (imagePath) {
                await connection.query(`UPDATE telegram_posts 
          SET image_local_path = ?, image_uploaded = 1 
          WHERE id = ?`, [imagePath, postId]);
                console.log(`✅ Video thumbnail uploaded: ${imagePath}`);
            }
        }
        catch (error) {
            console.error(`❌ Error uploading video thumbnail:`, error);
        }
    }
    // 2️⃣ Скачиваем и загружаем изображение на Beget (если есть)
    if (post.photo?.length) {
        try {
            const largestPhoto = post.photo[post.photo.length - 1];
            console.log(`📥 Downloading image for post ${messageId}...`);
            const imagePath = await downloadTelegramImage(largestPhoto.file_id, messageId);
            if (imagePath) {
                // Обновляем запись с путём к локальному изображению
                await connection.query(`UPDATE telegram_posts 
          SET image_local_path = ?, image_uploaded = 1 
          WHERE id = ?`, [imagePath, postId]);
                console.log(`✅ Image uploaded for post ${messageId}: ${imagePath}`);
            }
            else {
                console.warn(`⚠️  Image upload failed for post ${messageId}, using Telegram URL fallback`);
            }
        }
        catch (imageError) {
            console.error(`❌ Error uploading image for post ${messageId}:`, imageError);
        }
    }
    // 3️⃣ Сохраняем хештеги
    if (hashtags.length > 0) {
        try {
            await connection.query('DELETE FROM post_hashtags WHERE post_id = ?', [postId]);
            const hashtagValues = hashtags.map(tag => [postId, tag]);
            await connection.query('INSERT INTO post_hashtags (post_id, hashtag) VALUES ?', [hashtagValues]);
            console.log(`✅ Saved ${hashtags.length} hashtags for post ${messageId}`);
        }
        catch (hashtagError) {
            console.error(`❌ Error saving hashtags for post ${messageId}:`, hashtagError);
        }
    }
}
// ===== КОД parseTextToTitleAndParagraph =====
function parseTextToTitleAndParagraph(text) {
    if (!text) {
        return { title: 'Untitled Post', paragraph: '' };
    }
    const textWithoutHashtags = text.replace(/#[\wа-яА-ЯёЁ]+/gu, '').trim();
    const lines = textWithoutHashtags.split('\n').filter(line => line.trim());
    if (lines.length === 0) {
        return { title: 'Untitled Post', paragraph: '' };
    }
    let title = lines[0].trim();
    if (title.length > 100) {
        title = title.substring(0, 97) + '...';
    }
    let paragraph = lines.slice(1).join(' ').trim();
    if (!paragraph && lines[0].length > title.length) {
        paragraph = lines[0].substring(title.length).trim();
    }
    if (paragraph.length > 500) {
        paragraph = paragraph.substring(0, 497) + '...';
    }
    return {
        title: title || 'Untitled Post',
        paragraph: paragraph || text.substring(0, 200)
    };
}
// ===== КОД getFileUrl =====
async function getFileUrl(botToken, fileId) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const data = (await response.json());
        if (!data.ok) {
            console.error('Failed to get file:', data.description);
            return null;
        }
        return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
    }
    catch (error) {
        console.error('Error getting file URL:', error);
        return null;
    }
}
// ===== КОД extractHashtags =====
function extractHashtags(text) {
    const matches = text.match(/#[\wа-яА-ЯёЁ]+/gu) || [];
    return [...new Set(matches.map(tag => tag.slice(1).toLowerCase()))];
}
// ===== КОД downloadTelegramImage =====
async function downloadTelegramImage(fileId, postId) {
    const sftp = new ssh2_sftp_client_1.default();
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const PUBLIC_URL = process.env.PUBLIC_UPLOAD_BASE_URL;
    if (!PUBLIC_URL) {
        throw new Error('PUBLIC_UPLOAD_BASE_URL is not defined in .env');
    }
    const SFTP_HOST = process.env.SFTP_HOST;
    const SFTP_PORT = parseInt(process.env.SFTP_PORT || '22');
    const SFTP_USER = process.env.SFTP_USER;
    const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
    const SFTP_BASE_PATH = process.env.SFTP_BASE_PATH;
    try {
        // 1️⃣ Получить file_path из Telegram
        console.log(`📡 Getting file info from Telegram (fileId: ${fileId})...`);
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const fileData = (await fileRes.json());
        if (!fileData.ok) {
            console.error('❌ Failed to get file from Telegram:', fileData);
            return null;
        }
        const filePath = fileData.result.file_path;
        console.log(`✅ File path: ${filePath}`);
        // 2️⃣ Скачать файл из Telegram
        console.log(`📥 Downloading image from Telegram...`);
        const imageRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
        if (!imageRes.ok) {
            console.error('❌ Failed to download image from Telegram');
            return null;
        }
        const buffer = Buffer.from(await imageRes.arrayBuffer());
        console.log(`✅ Downloaded ${buffer.length} bytes`);
        // 3️⃣ Подключиться к Beget SFTP
        console.log(`🔌 Connecting to SFTP: ${SFTP_USER}@${SFTP_HOST}:${SFTP_PORT}...`);
        await sftp.connect({
            host: SFTP_HOST,
            port: SFTP_PORT,
            username: SFTP_USER,
            password: SFTP_PASSWORD,
            readyTimeout: 30000,
            retries: 2,
        });
        console.log('✅ SFTP connected');
        // 4️⃣ Создать директории YYYY/MM на Beget
        const now = new Date();
        const year = now.getFullYear().toString();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const remoteDirPath = `${SFTP_BASE_PATH}/${year}/${month}`;
        console.log(`📁 Creating directory: ${remoteDirPath}`);
        try {
            await sftp.mkdir(remoteDirPath, true);
            console.log('✅ Directory created/exists');
        }
        catch (mkdirError) {
            if (mkdirError.code !== 4 && !mkdirError.message.includes('exist')) {
                throw mkdirError;
            }
            console.log('✅ Directory already exists');
        }
        // 5️⃣ Сохранить файл на Beget
        const ext = path_1.default.extname(filePath) || '.jpg';
        const fileName = `post_${postId}${ext}`;
        const remoteFilePath = `${remoteDirPath}/${fileName}`;
        console.log(`📤 Uploading file: ${remoteFilePath}`);
        await sftp.put(buffer, remoteFilePath);
        console.log(`✅ File uploaded successfully!`);
        // 6️⃣ Вернуть публичный URL
        const publicUrl = `${PUBLIC_URL}/${year}/${month}/${fileName}`;
        console.log(`🌐 Public URL: ${publicUrl}`);
        return publicUrl;
    }
    catch (error) {
        console.error('❌ Image upload error:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
        });
        return null;
    }
    finally {
        try {
            await sftp.end();
            console.log('🔌 SFTP connection closed');
        }
        catch (closeError) {
            console.error('⚠️  Error closing SFTP:', closeError);
        }
    }
}
