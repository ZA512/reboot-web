FROM node:24-alpine
WORKDIR /app
COPY package.json ./package.json
COPY *.mjs ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
