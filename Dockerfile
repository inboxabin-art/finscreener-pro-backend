FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev || npm install || true
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["npm", "start"]
