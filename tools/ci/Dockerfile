ARG NODE_VERSION=22
FROM golang:1.27.2-bookworm AS go
FROM oven/bun:1.4.2 AS bun
FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=go /usr/local/go /usr/local/go
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
ENV PATH="/usr/local/go/bin:${PATH}"
