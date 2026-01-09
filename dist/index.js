"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const node_cron_1 = __importDefault(require("node-cron"));
const dotenv_1 = __importDefault(require("dotenv"));
const sync_1 = require("./sync");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT) || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'change-me-in-production';
const SYNC_INTERVAL = process.env.SYNC_INTERVAL?.trim() || '*/15 * * * *'; // если fallback то Каждые 15 минут
app.use(express_1.default.json());
// Health check
app.get('/', (req, res) => {
    res.json({
        service: 'Telegram Sync Service',
        status: 'running',
        timestamp: new Date().toISOString(),
        interval: SYNC_INTERVAL
    });
});
// Ручной запуск синхронизации (защищён токеном)
app.post('/sync', async (req, res) => {
    const { token } = req.body;
    if (token !== SECRET_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log('🔄 Manual sync triggered via API');
    const result = await (0, sync_1.syncTelegramPosts)();
    res.json(result);
});
// Автоматическая синхронизация по cron расписанию
node_cron_1.default.schedule(SYNC_INTERVAL, async () => {
    console.log(`\n⏰ Cron triggered: ${new Date().toISOString()}`);
    await (0, sync_1.syncTelegramPosts)();
});
// Запуск сервера
app.listen(PORT, async () => {
    console.log(`\n🚀 Telegram Sync Service started`);
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`📅 Sync interval: ${SYNC_INTERVAL}`);
    console.log(`🔐 Secret token: ${SECRET_TOKEN.substring(0, 4)}...`);
    // Первая синхронизация при старте
    console.log('\n🔄 Running initial sync...\n');
    await (0, sync_1.syncTelegramPosts)();
});
