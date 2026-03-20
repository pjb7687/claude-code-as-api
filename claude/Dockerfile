FROM node:latest

RUN apt-get update -qq && apt-get install -y -qq expect unzip htop socat && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash claude
RUN mkdir -p /workspace && chown claude:claude /workspace /home/claude

ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.com/install | bash

ENV PATH=$BUN_INSTALL/bin:$PATH

COPY ./localcc /opt/localcc
RUN cd /opt/localcc && bun install --no-summary && chown -R 1001:1001 /opt/localcc

COPY ./claude/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY ./localcc/.mcp.json /workspace/.mcp.json
RUN chown claude:claude /workspace/.mcp.json

USER claude

WORKDIR /workspace

EXPOSE 8788

ENTRYPOINT ["entrypoint.sh"]
