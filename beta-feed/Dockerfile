FROM node:26-alpine
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node landing.mjs icon.png ./
COPY --chown=node:node manrope.ttf MANROPE-LICENSE.txt ./
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.mjs"]
