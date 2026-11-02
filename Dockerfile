FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
# /app/data is only used when Turso isn't set (local database file). With Docker on your own server,
# keep it with a volume: docker run ... -v neoncyber-data:/app/data ...
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
