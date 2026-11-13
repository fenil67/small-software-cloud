FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
ENV NODE_ENV=production
WORKDIR /app
COPY dist/src ./dist/src
RUN chmod -R a+rX /app/dist
USER node
EXPOSE 8787
CMD ["node", "dist/src/index.js"]
