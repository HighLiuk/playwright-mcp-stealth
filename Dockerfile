FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl jq netcat-openbsd && \
    npm install && \
    npx playwright install --with-deps chromium && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    npm cache clean --force

COPY launch_browser.js .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 9222
EXPOSE 8931

ENTRYPOINT ["./entrypoint.sh"]
