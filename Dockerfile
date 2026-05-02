FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Prisma 7 loads prisma.config.ts during generate.
# Render runtime env vars are not always available during Docker image build,
# and prisma generate does not need a real database connection.
ENV DATABASE_URL="postgresql://postgres.ipmobruvwzgncomhackd:NoPFyQRgdYhJ4dgT@aws-1-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true"
ENV DIRECT_URL="postgresql://postgres.ipmobruvwzgncomhackd:NoPFyQRgdYhJ4dgT@aws-1-us-west-2.pooler.supabase.com:5432/postgres"

RUN npx prisma generate
RUN npm run build


FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

EXPOSE 3001

CMD ["node", "dist/src/main.js"]
