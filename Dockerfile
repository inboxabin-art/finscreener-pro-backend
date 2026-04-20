# FinScreener Pro Backend
FROM node:20-slim

WORKDIR /app

# Copy and install dependencies first (caching layer)
COPY package*.json ./
RUN npm install --include=dev

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Set environment variables
ENV PORT=3001
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
