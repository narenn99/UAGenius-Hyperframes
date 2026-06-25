FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    ffmpeg \
    fonts-dejavu-core \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
RUN npx @puppeteer/browsers install chrome-headless-shell@stable --path /opt/browser \
  && ln -s "$(find /opt/browser -type f -name chrome-headless-shell | head -n 1)" /usr/local/bin/chrome-headless-shell

COPY . .

ENV HOST=0.0.0.0
ENV PORT=4173
ENV CHROME_PATH=/usr/local/bin/chrome-headless-shell
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome-headless-shell
ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell

EXPOSE 4173

CMD ["npm", "start"]
