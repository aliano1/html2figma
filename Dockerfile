# html2figma capture server — real Chromium via the official Playwright image.
# Tag must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV PORT=8080

# Google Chrome stable: needed for H.264/AAC video (Shopify, YouTube embeds, most MP4s).
# The bundled open-source Chromium plays only VP8/VP9/AV1. Falls back to Chromium if this step is removed.
RUN npx -y playwright@1.63.0 install chrome || echo "chrome install failed; Chromium fallback will be used"

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
