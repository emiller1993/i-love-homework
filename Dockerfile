FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS app
COPY tsconfig.json playwright.config.ts compose.yaml .prettierignore .gitignore ./
COPY README.md AGENT.md ./
COPY adr ./adr
COPY src ./src
COPY sql ./sql
COPY fixtures ./fixtures
COPY tests ./tests
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]

FROM dependencies AS test
COPY --from=app /app /app
CMD ["npm", "run", "verify"]
