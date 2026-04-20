# FinScreener Pro Backend - Railway Deployment
FROM node:20-slim

WORKDIR /app

# Copy everything first
COPY . .

# Install including devDependencies for build
RUN npm install --include=dev

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3001

# Start
CMD ["node", "dist/index.js"]
