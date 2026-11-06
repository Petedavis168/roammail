# ---- build the web app ----
FROM public.ecr.aws/docker/library/node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- runtime ----
FROM public.ecr.aws/docker/library/node:22-alpine
RUN apk add --no-cache openssl
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server/src server/src
COPY --from=client /app/client/dist client/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
