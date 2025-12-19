FROM node:20-bullseye AS base

WORKDIR /app

# Install all dependencies for build, then prune dev deps
COPY package*.json ./
RUN npm install && npm run build:css && npm prune --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
