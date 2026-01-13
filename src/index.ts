import express from 'express';
// import cron from 'node-cron';
import dotenv from 'dotenv';
import { syncTelegramPosts } from './sync';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'change-me-in-production';
// const SYNC_INTERVAL = process.env.SYNC_INTERVAL?.trim() || '*/15 * * * *'; // если fallback то Каждые 15 минут

if (!SECRET_TOKEN) {
  throw new Error('SECRET_TOKEN is not set');
}

// app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'Telegram Sync Service',
    status: 'running',
    timestamp: new Date().toISOString()
    // interval: SYNC_INTERVAL
  });
});


// NOTE:
// POST /sync endpoint is intentionally disabled.
// This service is triggered via external cron using GET /sync?token=...
// POST endpoint may be re-enabled in the future for admin UI or extended control.

// Ручной запуск синхронизации с POST (защищён токеном)
// app.post('/sync', async (req, res) => {
//   const { token } = req.body;

//   if (token !== SECRET_TOKEN) {
//     return res.status(401).json({ error: 'Unauthorized' });
//   }

//   console.log('🔄 Manual sync triggered via API');

//   const result = await syncTelegramPosts();

//   res.json(result);
// });


// Защищённый ручной запуск sync с GET для внешнего запроса PHP
app.get('/sync', async (req, res) => {
  const token = req.query.token;

  if (token !== SECRET_TOKEN) {
    console.warn('❌ Unauthorized sync attempt');
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    console.log('🔐 Authorized sync request');
    const result = await syncTelegramPosts();
    res.json({ status: 'ok', result });
  } catch (err) {
    console.error('Sync failed:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// // Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Telegram Sync Service running on port ${PORT}`);
  console.log(`🔐 Secret token: ${SECRET_TOKEN.substring(0, 4)}...`);
});


// Автоматическая синхронизация по cron расписанию
// cron.schedule(SYNC_INTERVAL, async () => {
//   console.log(`\n⏰ Cron triggered: ${new Date().toISOString()}`);
//   await syncTelegramPosts();
// });

// Запуск сервера
// app.listen(PORT, async () => {
//   console.log(`\n🚀 Telegram Sync Service started`);
//   console.log(`📡 Server running on port ${PORT}`);
//   // console.log(`📅 Sync interval: ${SYNC_INTERVAL}`);
//   console.log(`🔐 Secret token: ${SECRET_TOKEN.substring(0, 4)}...`);

  // // Первая синхронизация при старте
  // console.log('\n🔄 Running initial sync...\n');
  // await syncTelegramPosts();
// });