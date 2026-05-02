import express from 'express';
import cors from 'cors';
import path from 'path';
import baselineRouter from './routes/baseline';
import reviewRouter from './routes/review';
import permissionRouter from './routes/permission';
import positionPlanRouter from './routes/position-plan';
import nextTradePlanRouter from './routes/next-trade-plan';
import pretradeRouter from './routes/pretrade';
import violationsRouter from './routes/violations';
import tacticsRouter from './routes/tactics';
import chatRouter from './routes/chat';
import { ensureUploadsDir, UPLOADS_DIR } from './services/chat-uploads';

const app = express();
const PORT = Number(process.env['PORT'] ?? 50001);

ensureUploadsDir();

app.use(cors());
// 提到 20mb 以容纳 base64 编码后的图片（前端会预压缩，单条 message 上限约 8MB）
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  immutable: true,
}));
app.use(express.static(path.join(process.cwd(), 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('pragma', 'no-cache');
      res.setHeader('expires', '0');
    }
  },
}));
app.use('/api/baseline', baselineRouter);
app.use('/api/review', reviewRouter);
app.use('/api/permission', permissionRouter);
app.use('/api/position-plan', positionPlanRouter);
app.use('/api/next-trade-plan', nextTradePlanRouter);
app.use('/api/pretrade', pretradeRouter);
app.use('/api/violations', violationsRouter);
app.use('/api/tactics', tacticsRouter);
app.use('/api/chat', chatRouter);
app.get('*', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Trade Baseline v2`);
  console.log(`   http://localhost:${PORT}\n`);
});

// SSE 长连接需要：禁用 socket idle timeout 与 request timeout（默认值会主动关闭长连接）
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 60_000; // 仅限制请求头读取
server.keepAliveTimeout = 30_000;
