/**
 * Simple health check server for Railway deployment testing
 */
import express from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

console.log('🚀 Starting simple health server on port', PORT);

app.get('/health', (req, res) => {
  console.log('Health check received at', new Date().toISOString());
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'Simple health server working!'
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'FinScreener Pro Backend',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Simple server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
