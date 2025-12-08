FROM node:20-bullseye AS base

WORKDIR /app

# Install production dependencies first (leveraging Docker layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
