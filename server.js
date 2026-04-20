/**
 * FinScreener Pro Backend - Simple Server
 */
import express from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

console.log('==========================================');
console.log('FinScreener Pro Backend - Starting...');
console.log(`Time: ${new Date().toISOString()}`);
console.log(`Node: ${process.version}`);
console.log(`PORT: ${PORT}`);
console.log('==========================================');

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'FinScreener Pro Backend'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'FinScreener Pro Backend',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
