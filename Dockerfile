# FinScreener Pro Backend - Railway Deployment
FROM node:20-slim

WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm install --include=dev

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3001

# Set PORT env
ENV PORT=3001

# Start the main server
CMD ["node", "dist/index.js"]
