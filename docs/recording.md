# Meeting recording

Recording uses LiveKit Egress (room composite, 720p30, MP4). The API owns the lifecycle; Egress only records.

## Rules
- Only the host, a co-host or an org admin can start, stop, list and download. Everyone else gets 403.
- A meeting with `meetings.e2ee = true` refuses to record (409). The call screen disables the button and explains why.
- Every action is audited, including refusals: `recording.start`, `recording.stop`, `recording.list`, `recording.download` and the
  `*.denied` variants (target `<code>:<reason>`).
- Consent: the API sets `recording: true` in the LiveKit room metadata BEFORE Egress starts, and clears it after stop. Every client
  (also one that joins later) reads the room metadata and shows a badge plus an `aria-live` announcement. If the flag cannot be
  set, no recording is started (502).
- At rest: Egress writes a plaintext MP4 to `staging/<org>/<meeting>/<id>.mp4` in the `davra-recordings` bucket. When it is
  complete the API encrypts it in 4 MiB AES-256-GCM frames (`recording-crypto.ts`, data key wrapped by `FILE_MASTER_KEY` through the
  helpers of `files/crypto.ts`), stores `<org>/<meeting>/<id>.enc` and deletes the plaintext. Only the encrypted object can be
  downloaded; it is decrypted while streaming and an altered or truncated object aborts the download.
- API endpoints: `GET /v1/meetings/:code/recording` (status for participants), `POST .../recording/start`, `POST .../recording/stop`,
  `GET /v1/meetings/:code/recordings`, `GET /v1/recordings/:id/download`.
- Configuration: `RECORDING_ENABLED=1`, `RECORDING_BUCKET` (default `davra-recordings`), `RECORDING_S3_ENDPOINT` (the storage address as
  Egress sees it, default `S3_ENDPOINT`), plus the existing `S3_*` and `FILE_MASTER_KEY`. Without them the endpoints answer 503.
  Recording is off when the dev stack uses LiveKit Cloud (a hosted LiveKit cannot reach the local MinIO).

## Egress check, 2026-11-24 (throwaway stack, nothing of the dev stack touched)
Egress `livekit/egress:v1.15.0`, LiveKit `v1.13.11`, MinIO, Redis, all in the compose project `davra-egress-test` with random
throwaway keys, using the committed `deploy/compose/livekit.yaml` and `deploy/compose/egress.yaml`:

```
docker compose -p davra-egress-test up -d
# a demo publisher in the room:
docker run -d --rm --network davra-egress-test_default livekit/livekit-cli:latest room join --url http://livekit:7880 \
  --api-key <key> --api-secret <secret> --identity demo-bot --publish-demo <room>
# the real RecordingService + LiveKitMedia + S3Store start, wait 20 s, stop, encrypt, download
docker compose -p davra-egress-test down -v
```
Result: room metadata `{"recording":true}` while recording and `{}` after stop; Egress wrote a 6,045,905 byte MP4 to
`staging/...`; after processing the bucket held only `<org>/<meeting>/<id>.enc` (6,786,973 bytes) and the staging object was gone;
the downloaded file was 6,786,907 bytes, starts with an `ftyp` box and `gst-discoverer-1.0` reports 18 s, H.264 Main 1280x720 30 fps
plus AAC stereo. The Egress container made no request outside the compose network. Egress needs `cap_add: SYS_ADMIN`, `shm_size: 1gb`
and 4 CPUs (with 3 it logs "not enough cpu for some egress types").

## Not verified here
- The shared dev stack (it runs LiveKit with `--node-ip` of the LAN address and the dev LiveKit config has no `redis:` until it is
  recreated): Egress media connectivity through the host's LAN address is untested. In the throwaway stack LiveKit advertised its
  container address.
- Production: Egress to a LiveKit that uses `use_external_ip: true` (hairpin to the host's public address).
