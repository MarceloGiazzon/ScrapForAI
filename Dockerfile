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

# An always-on host (docker-compose.team.yml) needs the orchestrator to know when the API stopped answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]