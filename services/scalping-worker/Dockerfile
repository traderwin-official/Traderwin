FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY services/scalping-worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && mkdir -p /app/lib
COPY services/scalping-worker/index.js ./index.js
COPY lib/scalping-engine.js ./lib/scalping-engine.js
COPY lib/scalping-execution.js ./lib/scalping-execution.js
COPY lib/scalping-paper-adapter.js ./lib/scalping-paper-adapter.js
COPY lib/scalping-session-eligibility.js ./lib/scalping-session-eligibility.js
COPY lib/usd-conversion.js ./lib/usd-conversion.js
COPY lib/deriv-public-quote.js ./lib/deriv-public-quote.js
COPY lib/market-intelligence.js ./lib/market-intelligence.js
COPY lib/market-intelligence-gate.js ./lib/market-intelligence-gate.js
COPY lib/scalping-trade-concurrency.js ./lib/scalping-trade-concurrency.js
COPY lib/gdelt-news-risk.js ./lib/gdelt-news-risk.js
COPY lib/xaus-gold-reference.js ./lib/xaus-gold-reference.js
EXPOSE 8080
USER node
CMD ["node", "index.js"]
