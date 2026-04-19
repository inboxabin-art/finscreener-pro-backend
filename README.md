# FinScreener Pro Backend

Real-time stock data, alerts, and Telegram notifications for FinScreener Pro.

## Features

- **Polygon.io Integration** - Real-time 1-minute stock data
- **Telegram Notifications** - Alert and trade updates
- **Supabase Database** - Persistent storage
- **WebSocket Server** - Real-time updates to frontend
- **Alert Monitoring** - Automatic trigger and exit detection

## Setup

### 1. Install Dependencies

```bash
cd finscreener-pro-backend
npm install
```

### 2. Environment Variables

Create a `.env` file or set these in Railway:

```env
# Server
PORT=3001

# Supabase (required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key

# Polygon.io (for real-time data)
POLYGON_API_KEY=iO7G4s0BzGHxip4_W8Bou00ml0F1SRFP

# Telegram (for notifications)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

### 3. Railway Deployment

1. Connect your GitHub repository to Railway
2. Add the environment variables in Railway dashboard
3. Deploy - Railway will automatically detect Node.js

#### Railway Quick Deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize
railway init

# Add variables
railway variables set POLYGON_API_KEY=your-key
railway variables set TELEGRAM_BOT_TOKEN=your-token
railway variables set TELEGRAM_CHAT_ID=your-chat-id

# Deploy
railway up
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/stocks` | Get all stocks |
| GET | `/api/stocks/:symbol/quote` | Get real-time quote |
| GET | `/api/stocks/:symbol/bars/:m/:timespan` | Get price bars |
| GET | `/api/alerts` | Get all alerts |
| POST | `/api/alerts` | Create new alert |
| PATCH | `/api/alerts/:id` | Update alert |
| GET | `/api/news/:stockId` | Get news for stock |

## WebSocket

Connect to `ws://your-server:3001/ws` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
};
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  FinScreener    │     │  Railway         │
│  Frontend       │────▶│  Backend         │
│  (React)        │◀────│  (Node.js)       │
└─────────────────┘     └────────┬─────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Polygon.io   │     │  Supabase        │     │  Telegram       │
│  (Real-time)  │     │  (Database)      │     │  (Notifications)│
└───────────────┘     └──────────────────┘     └─────────────────┘
```

## Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## License

MIT
