# VM appliance (REQ-INT-018)

Captured 2026-11-10.

## What was built

The appliance lives in `deploy/appliance`. The image is Ubuntu Server 24.04 with Docker Engine and its compose plugin.
It holds the air-gap bundle's images, already loaded, and two systemd units.

**Image build:**

- **`openmap-appliance.pkr.hcl`:** a Packer template using the QEMU builder (KVM), from the Ubuntu cloud image.
  - It uses a build-only user from a cloud-init seed, whose password is a per-build variable.
  - It copies the bundle and the appliance files in, then runs `install.sh`.
  - A post-processor converts the image to VMDK (VMware, for an OVA) and VHDX (Hyper-V).
- **`install.sh`:**
  - installs Docker from Docker's apt repository;
  - verifies the bundle's `SHA256SUMS` and loads its images;
  - installs and enables the units;
  - locks the build user and clears the SSH host keys, the machine id and cloud-init state.

  Nothing starts and no secret exists in the image.

**On the VM:**

- **`openmap-firstboot.sh` / `.service`:** runs once on first boot, before the stack starts.
  - It replaces every development default secret with its own 32-character random value: PostgreSQL, ClickHouse,
    Meilisearch, Keycloak admin, Superset secret and admin, the DNS lab TSIG key. That includes the password inside
    the host-side `POSTGRES_URL`, whose TLS parameters it keeps.
  - It sets the public URLs and the scheduler's TLS SAN to the VM's address.
  - It writes the administrator credentials to a 0600 file, and the console URL to the login banner.
  - A marker file keeps a second boot from changing the secrets of a running stack.
- **`openmap.service`:** the air-gapped compose stack (`docker-compose.airgap.yml`, `pull_policy: never`), started after
  Docker and the first boot.

**Found and fixed:** the air-gap bundle did not carry `deploy/compose/openbao` (init script, policies, agent
configurations). Every bundle built since OpenBao went to production mode (ADR-067) could not have started.
`build-bundle.sh` now copies it.

## Checks

| Check | Result |
| --- | --- |
| `packer init` and `packer validate` (hashicorp/packer 1.11.2, QEMU plugin 1.1.3) | `The configuration is valid.`; `packer fmt -check` clean |
| `sh -n` on `install.sh` and `openmap-firstboot.sh` | clean |
| `tools/appliance/src/firstboot.integration.test.ts` (T-584): the first-boot script run for real in `ubuntu:24.04` against `deploy/compose/.env.example` | 2 passed: 7 distinct random secrets, none a default; `POSTGRES_URL` carries the new password and keeps `sslmode=require`; public URLs and SAN on the appliance's name; `.env` and the credentials file mode 600; a second run changes nothing |

## Not done here

**A full image build and boot.** It needs a Linux host with KVM and a built air-gap bundle (several GB), and neither
is available on this Windows development machine. Until one such build has booted the stack from the image, the row
stays **In review**.

The build is one command on such a host (deploy/README.md, "VM appliance"). It can also run as a CI job on a runner
with KVM and enough disk for the bundle.
