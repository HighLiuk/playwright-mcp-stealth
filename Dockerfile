FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
RUN npx playwright install --with-deps chromium
COPY . .
ENV NODE_ENV=production
EXPOSE 3000 3001
CMD ["node", "server.js"]
