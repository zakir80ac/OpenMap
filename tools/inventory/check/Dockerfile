# REQ-INT-011 (ADR-072) — the real configuration-management tools, to check OpenMap's inventory output against them:
# ansible-core (ansible-inventory), Salt (the salt-ssh flat roster loader), Puppet (the exec node terminus that runs an
# ENC) and Chef (knife against an in-memory chef-zero server). A throwaway image for tests and evidence only; it is not
# part of any compose profile. The Python tools are pinned; the gems take the newest release the image's Ruby accepts,
# and run.sh prints every version it ran with, so the evidence records them.
FROM python:3.12-slim

ARG ANSIBLE_CORE_VERSION=2.20.11
ARG SALT_VERSION=3007.17

RUN apt-get update \
  && apt-get install -y --no-install-recommends ruby-full build-essential libffi-dev git \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "ansible-core==${ANSIBLE_CORE_VERSION}" "salt==${SALT_VERSION}"

RUN gem install --no-document puppet
RUN gem install --no-document chef-zero "knife:~> 18.0"

# salt-ssh refuses to start without an ssh client, even to list its roster's hosts.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /work
