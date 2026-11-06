#!/bin/bash
# EC2 "User data" bootstrap for Ubuntu 24.04: installs Docker and prepares /opt/mail-client.
# After the instance starts: copy the project into /opt/mail-client, create .env, then
#   cd /opt/mail-client && sudo docker compose up -d --build
set -euo pipefail
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu || true
mkdir -p /opt/mail-client
chown ubuntu:ubuntu /opt/mail-client
