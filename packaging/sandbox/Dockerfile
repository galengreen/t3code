# The reference sandbox image: a T3 server, Claude Code, and common
# development tools, run by a host's sandboxes. The contract it meets is in
# apps/server/src/sandbox/SandboxService.ts.
#
# Kept small, since a cloud host pulls it onto each new machine before its
# first boot. Everything is installed outside /home/dev, which holds only the
# sandbox's own files, so a new Docker sandbox's home volume starts empty.
#
#   docker build -t t3code-sandbox packaging/sandbox
#   docker build --build-arg T3CODE_VERSION=0.0.45 -t t3code-sandbox packaging/sandbox
FROM debian:bookworm-slim

ARG TARGETARCH
# Empty installs the latest stable release.
ARG T3CODE_VERSION=
ARG NODE_MAJOR=24

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client sudo procps libatomic1 less \
      ripgrep jq python3 xz-utils \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Node, for the projects agents work on.
RUN arch="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)" \
 && base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" \
 && file="$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-${arch}.tar.xz" | head -1)" \
 && curl -fsSL "$base/$file" -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude='*/include' --exclude='*/share/doc' --exclude='*/share/man' \
 && rm /tmp/node.tar.xz

# T3 from its release archive, and Claude Code, which keeps itself in the
# installing user's home, so it installs into one of its own.
RUN curl -fsSL https://t3.codes/install.sh \
      | T3CODE_HOME=/opt/t3 T3CODE_INSTALL_BIN_DIR=/usr/local/bin T3CODE_VERSION="$T3CODE_VERSION" sh \
 && curl -fsSL https://claude.ai/install.sh | HOME=/opt/claude bash \
 && ln -s "$(readlink -f /opt/claude/.local/bin/claude)" /usr/local/bin/claude \
 && chmod -R a+rX /opt/t3 /opt/claude
# The image is the update channel; a sandbox should not update itself.
ENV DISABLE_AUTOUPDATER=1

RUN useradd -m -s /bin/bash dev \
 && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
COPY --chmod=755 entrypoint.sh /usr/local/bin/t3-sandbox-entrypoint
COPY --chmod=755 clone.sh /usr/local/bin/t3-sandbox-clone

USER dev
WORKDIR /home/dev
EXPOSE 7777
ENTRYPOINT ["/usr/local/bin/t3-sandbox-entrypoint"]
