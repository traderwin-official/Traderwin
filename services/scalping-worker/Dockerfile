FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY services/scalping-worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY services/scalping-worker/index.js ./index.js
EXPOSE 8080
USER node
CMD ["node", "index.js"]
