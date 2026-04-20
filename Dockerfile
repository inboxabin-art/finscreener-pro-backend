# FinScreener Pro Backend - Railway Deployment
FROM node:20-slim

# Create app directory
RUN mkdir -p /app
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --include=dev

# Copy source and build
COPY . .
RUN npm run build

# Prune devDependencies
RUN npm prune --production

# Expose port
EXPOSE 3001

# Set env vars
ENV NODE_ENV=production

# Run directly
CMD ["node", "dist/index.js"]
