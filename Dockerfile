FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy client script
COPY client.js ./

# Make executable
RUN chmod +x client.js

# Install curl for health checks
RUN apk add --no-cache curl

# Default command shows usage
CMD ["node", "client.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)"

# Labels
LABEL org.opencontainers.image.title="AWS OIDC Token Client"
LABEL org.opencontainers.image.description="Fetches OIDC tokens from AWS using SigV4 authentication"
LABEL org.opencontainers.image.source="https://github.com/latacora/aws-oidc-workload-identity"
