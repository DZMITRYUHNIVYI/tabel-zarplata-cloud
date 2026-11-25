FROM node:22-alpine
WORKDIR /app
COPY package.json tabel-server.js tabel-zarplata-app.html ./
COPY data ./data
ENV PORT=8765
ENV HOST=0.0.0.0
EXPOSE 8765
CMD ["node", "tabel-server.js"]
