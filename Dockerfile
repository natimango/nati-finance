FROM node:20-bullseye AS base

WORKDIR /app

# Install all dependencies for build (dev included for CSS build)
COPY package*.json ./
RUN npm install

# Copy source and build CSS, then prune dev deps
COPY . .
RUN npm run build:css && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
