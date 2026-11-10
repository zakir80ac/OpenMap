# REQ-INT-019 (ADR-066) — the backup image: PostgreSQL 17's own client tools (pg_dump and pg_restore must not be older
# than the server), curl for ClickHouse's HTTP interface and OpenBao, and openssl for the encrypted sets (REQ-SEC-011,
# ADR-067 step 5), running deploy/backup/openmap-backup.sh.
# Build: docker build -f deploy/docker/backup.Dockerfile -t openmap/backup .
FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY deploy/backup/openmap-backup.sh /usr/local/bin/openmap-backup
RUN sed -i 's/\r$//' /usr/local/bin/openmap-backup && chmod 0755 /usr/local/bin/openmap-backup
ENTRYPOINT ["/usr/local/bin/openmap-backup"]
CMD ["create"]
