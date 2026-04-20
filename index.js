/**
 * FinScreener Pro Backend - Simple Server (CommonJS)
 * No TypeScript, no ESM - pure CommonJS for Railway compatibility
 */

const http = require('http');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON
app.use(express.json());

console.log('==========================================');
console.log('FinScreener Pro Backend');
console.log('Time: ' + new Date().toISOString());
console.log('Port: ' + PORT);
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

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});

// Create HTTP server and listen
const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('Server started successfully!');
  console.log('Listening on port: ' + PORT);
  console.log('Health: http://localhost:' + PORT + '/health');
  console.log('==========================================');
});

// Handle server errors
server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
