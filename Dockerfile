# ---- build the web app ----
FROM public.ecr.aws/docker/library/node:26-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- runtime ----
FROM public.ecr.aws/docker/library/node:26-alpine
RUN apk add --no-cache openssl
# Trust Amazon RDS's certificate authority so the database connection is verified TLS
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server/src server/src
COPY --from=client /app/client/dist client/dist
# Public website (roammail.net/), served by the same app
COPY site site
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
