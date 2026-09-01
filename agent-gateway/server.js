/**
 * Amharic Agent Gateway Server
 * Entry point for Express server
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const handleRequestRouter = require('./routes/handleRequest');
const { getSessionStore } = require('./services/hermesClient');
const { pendingConfirmations } = require('./middleware/confirmationGate');

const app = express();
const PORT = process.env.PORT || 3000;

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Health & Status Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'Amharic Agent Gateway for Hermes Agent',
    timestamp: new Date().toISOString(),
    mockTranslationMode: process.env.MOCK_TRANSLATION === 'true' || !process.env.ADDIS_API_KEY,
    activeSessions: Object.keys(getSessionStore()).length,
    pendingConfirmations: pendingConfirmations.size
  });
});

// Main Gateway Pipeline Routes
app.use('/api', handleRequestRouter);

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🇪🇹 Amharic Agent Gateway Server running on port ${PORT}`);
    console.log(`   Health Check: http://localhost:${PORT}/health`);
    console.log(`   Chat Endpoint: POST http://localhost:${PORT}/api/chat`);
    console.log(`   Confirm Endpoint: POST http://localhost:${PORT}/api/confirm`);
    console.log(`   Mock Translation Mode: ${process.env.MOCK_TRANSLATION === 'true' || !process.env.ADDIS_API_KEY}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
