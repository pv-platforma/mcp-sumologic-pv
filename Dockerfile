# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies including dev dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Remove husky prepare script and install production dependencies
RUN npm pkg delete scripts.prepare && \
    npm ci --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Copy .env file if it exists (optional — prefer env vars or Secrets Manager in prod)
COPY --from=builder /app/.env* ./ 

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV MCP_TRANSPORT=sse

# Expose the port for ALB health checks and SSE connections
EXPOSE 3000

# Add a healthcheck for container orchestration and ALB
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1) })" || exit 1

# Start the application
CMD ["node", "dist/index.js"]