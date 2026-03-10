FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.mjs config.json ./

EXPOSE 3100

CMD ["node", "server.mjs"]
