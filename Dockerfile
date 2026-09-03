# gsc-mcp — stdio MCP server for Google Search Console
# Build:  docker build -t gsc-mcp .
# Run:    docker run -i --rm \
#           -v "$HOME/.config/gws:/home/node/.config/gws:ro" gsc-mcp

# Pin the multi-architecture base for reproducible MCP Catalog builds.
# Dependabot checks the pinned node/alpine tag weekly for a new digest.
FROM node:26-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:26-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

# The server reads its OAuth credential from
#   ~/.config/gws/searchconsole_credentials.json
# (an OAuth user credential for the webmasters scope). Mount that
# directory into the container, or set GSC_CREDENTIALS_PATH to a mounted path.
# The server starts and answers tools/list without it; tool calls then return a
# clear setup error until the credential is present.

USER node
CMD ["node", "dist/index.js"]
