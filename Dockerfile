# FinScreener Pro Backend - Railway Deployment
FROM node:20-slim

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies including devDependencies for build
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove devDependencies to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 3001

# Set environment
ENV NODE_ENV=production

# Start with explicit binding
CMD ["node", "--enable-source-maps", "dist/index.js"]
