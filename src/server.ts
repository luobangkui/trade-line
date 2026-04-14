import express from 'express';
import cors from 'cors';
import path from 'path';
import baselineRouter from './routes/baseline';

const app = express();
const PORT = Number(process.env['PORT'] ?? 50008);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/api/baseline', baselineRouter);
app.get('*', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🚀 Trade Baseline v2`);
  console.log(`   http://localhost:${PORT}\n`);
});
