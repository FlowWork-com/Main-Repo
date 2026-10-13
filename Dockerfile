# syntax=docker/dockerfile:1
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN --mount=type=secret,id=VITE_SUPABASE_URL,env=VITE_SUPABASE_URL \
  --mount=type=secret,id=VITE_SUPABASE_ANON_KEY,env=VITE_SUPABASE_ANON_KEY \
  npm run build

FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/health || exit 1
