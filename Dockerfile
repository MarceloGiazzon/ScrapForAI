FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

# Static web-console assets are served at runtime from <root>/public by publicDir();
# they are not needed for the build, so copy them after it to keep the build cache warm.
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]