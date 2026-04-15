FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p /data/browser-session

ENV BROWSER_DATA_DIR=/data/browser-session
ENV PORT=3050

VOLUME /data

EXPOSE 3050

CMD ["node", "server.js"]
