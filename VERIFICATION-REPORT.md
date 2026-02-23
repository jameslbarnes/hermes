# Hermes TEE Verification Report

## Deployment Identity

| Field | Value |
|-------|-------|
| App ID | `db82f581256a3c9244c4d7129a67336990d08cdf` |
| Trust Center | https://trust.phala.com/app/db82f581256a3c9244c4d7129a67336990d08cdf |
| TEE Metadata | https://db82f581256a3c9244c4d7129a67336990d08cdf-8090.dstack-pha-prod9.phala.network/ |
| Production URL | https://hermes.teleport.computer |
| Source Code | https://github.com/jameslbarnes/hermes |
| Docker Image | `docker.io/generalsemantics/hermes` |
| KMS | Base (on-chain transparency log) |

## Verification Steps

### 1. Verify TEE Attestation

Fetch the TDX attestation from the metadata endpoint:

```bash
curl -s https://db82f581256a3c9244c4d7129a67336990d08cdf-8090.dstack-pha-prod9.phala.network/ | jq .
```

This returns the `compose_hash`, `os_image_hash`, `device_id`, and TDX quote proving the app runs in a hardware-isolated Intel TDX enclave.

### 2. Verify Compose Hash Matches Docker Compose

The `compose_hash` in the attestation is the SHA-256 of the `docker-compose.yml` that was deployed. To verify:

```bash
# Download the compose file used for the deploy (check CI workflow run)
# Then hash it:
sha256sum docker-compose.deploy.yml
```

Compare this hash with `compose_hash` from step 1.

### 3. Verify Image Digest

The docker-compose file pins the Hermes image by digest:

```yaml
image: docker.io/generalsemantics/hermes:<git-sha>@sha256:<digest>
```

Verify the digest matches what was built by GitHub Actions:
- Go to the [Actions tab](https://github.com/jameslbarnes/hermes/actions)
- Find the workflow run for the deployed commit
- Check the "Docker Image Attestation" in the job summary for the digest

### 4. Verify Source-to-Image Chain

Each deploy records a full chain:

| Step | How to Verify |
|------|---------------|
| Git commit SHA | Visible in compose image tag and `evidences/<date>/deploy-info.json` |
| Docker image digest | Pinned in compose file, recorded in GitHub Actions summary |
| Compose hash | Attested by TDX hardware via port 8090 |
| On-chain record | Base KMS emits events for each `compose_hash` update |

### 5. Check On-Chain Deployment History

With Base KMS, every `phala cvms upgrade` emits an on-chain event. Query the Base blockchain to see the full history of compose hashes deployed to this App ID, answering "what code was running at time X?"

### 6. Inspect Archived Evidences

Historical attestation artifacts are committed to the `evidences/` directory in this repository, organized by deployment date:

```
evidences/
  2026-02-23/
    metadata.json    # TEE metadata snapshot
    quote.json       # TDX quote
    deploy-info.json # Git SHA, image digest, timestamp, workflow URL
```

## Trust Boundaries

### What the TEE Protects

- **Secret keys in memory** - never leave the enclave
- **Pending entries** - held in encrypted TEE volume before publishing
- **TLS private keys** - stored in encrypted TEE volume
- **Runtime integrity** - TDX hardware ensures the attested code is what's actually running

### What the TEE Does NOT Protect

- **Published entries** - stored in Firestore (public by design)
- **Operator access** - the operator can deploy new code (but Base KMS logs this publicly)
- **Firestore credentials** - injected as env vars; the operator could theoretically read Firestore outside the TEE

### Trust Assumptions

1. Intel TDX hardware is not compromised
2. Phala's dstack and KMS infrastructure operates correctly
3. The operator deploys only the code in this repository (verifiable via the attestation chain)
4. Docker Hub serves the correct image for a given digest (mitigated by digest pinning)

## Known Gaps

| Gap | Status | Mitigation |
|-----|--------|------------|
| Non-reproducible builds | Open | Base images pinned by digest; full reproducibility requires Nix or apko |
| Docker Hub hosting | Open | Consider migrating to GHCR for Sigstore signatures and SLSA provenance |
| No rate limiting on API | Open | Tracked separately from TEE concerns |

## References

- [Phala dstack Verification Docs](https://docs.phala.com/dstack/verification)
- [xordi-release-process](https://github.com/Account-Link/xordi-release-process/) (reference implementation)
- [devproof audit report](https://github.com/amiller/devproof-audits-guide/blob/main/case-studies/hermes/DEVPROOF-REPORT.md)
