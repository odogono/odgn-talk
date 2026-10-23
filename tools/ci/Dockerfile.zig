FROM odgn-talk-ci:2026-10-19-2

# Keep this version aligned with the workflows' mlugg/setup-zig pin. Rebuild
# under a new image tag when either the base image or Zig changes.
ARG ZIG_VERSION=0.17.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(uname -m)" \
    && curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${arch}-linux-${ZIG_VERSION}.tar.xz" \
       | tar -xJ -C /opt \
    && ln -s "/opt/zig-${arch}-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig
