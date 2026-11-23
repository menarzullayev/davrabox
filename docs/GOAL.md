# GOAL: Build DavraBox, a corporate video-conferencing platform (full plan, phases 0-7)

Status: APPROVED by the user on 2026-11-23. Execution not started.
Source of truth for scope: `E:\projects\davrabox\docs\Korporativ_videokonferens_platformasi_reja.docx` (PDF copy alongside). Read it fully before starting; this file only adds decisions and rules.

## 1. Mission
Build the platform described in the plan: own-brand, security-first video conferencing for corporate customers (web + Windows/macOS/Linux desktop), delivered by one codebase in three deployment models (SaaS, dedicated cloud, on-premise). Brand: **DavraBox**.
The customer is mixed (education/SMB and bank/telecom/government), so the architecture must support both from day one.

## 2. Scope (user decision, do not shrink)
- Full plan: sections 2 A (MVP), 2 B (Enterprise) and 2 C (next stage) as far as software can deliver them. Phases 0-7 in plan section 9, in order.
- Never silently shrink, defer, simplify or replace a requested feature. No placeholder, fake or mock production logic, no TODO for required functionality.
- Anything that cannot be done by code alone (legal registration, trademark, independent pentest, ISO/SOC audits, data-centre contracts, hiring, sales, 24/7 on-call, HSM hardware, EV code-signing certificates, Apple developer account) goes to `docs/HELD.md` with: what is needed, who must do it, what is already prepared. Finish everything else around it.

## 3. Decisions already made
| Topic | Decision |
|---|---|
| Media server | LiveKit (SFU), simulcast, adaptive bitrate. Already running as a spike: container `davra-livekit` (dev mode, LAN only). Jitsi spike is stopped; files kept in `spike/jitsi`, do not use it. |
| Backend | NestJS / TypeScript, modular monolith (not microservices) |
| Frontend / desktop | React + TypeScript + Vite + LiveKit Client SDK; Electron for desktop |
| Data | PostgreSQL with Row-Level Security, Redis, NATS, MinIO |
| Identity | Keycloak (SSO, SAML/OIDC/LDAP, MFA) |
| Infra target | Docker Compose for dev/test on this PC; Kubernetes + Helm + Terraform for production packaging (validate with a local kind/k3d cluster at small size) |
| Languages | UI in Uzbek (Latin), Russian, English |
| Hosting now | This PC (24 threads, 32 GB). LAN first; `davrabox.bugvector.uz` via Cloudflare Tunnel for web UI and signalling only. Media (UDP) does not pass the tunnel; verify and document what works. |
| Repo | `E:\projects\davrabox`, git, PUBLIC on GitHub (user decision, risk accepted). Because it is public: never commit secrets, keys, tokens, `.env` files, customer data or real IPs/credentials; add secret scanning to CI; no license file granting reuse (all rights reserved) unless the user says otherwise. |
| Commits | Conventional Commits. No AI attribution, no Co-Authored-By, no "Generated with" lines. |
| Reports | Uzbek Latin. Code, commits, identifiers in English. |

## 4. Autonomy and hard boundaries
The agent works autonomously: write code, run tests/builds/Docker, create branches and commits, install ordinary dev dependencies, run local security scans, without asking.
Still requires explicit user approval first (do not do, add to HELD.md and continue):
- anything that costs money (VPS, domains, certificates, paid APIs, paid plans);
- messages to outside people or organisations; public announcements;
- pushing to GitHub or creating the remote (ask once, at the first push; after approval push at milestones);
- touching other projects or containers on this PC (rankwant, nazoratly, cpstands, tassvision, hiso-box, offpanel and any not created by this goal), the shared Chrome profile, or system/security settings;
- destructive operations outside `E:\projects\davrabox` and containers/volumes whose names start with `davra`.

## 5. Environment constraints (shared workstation)
- Docker Desktop has ~6 CPU and ~10 GB RAM and already hosts production-like projects. Every container this goal creates must be named `davra-*`, have `mem_limit` and `cpus` set, and publish only high ports on the LAN IP or localhost. Stop heavy stacks when not testing.
- Check free disk before big builds (C: and E: each ~60 GB; pause below 15 GB).
- Load tests must stay inside those limits; report what was actually measured, not extrapolated capacity.

## 6. How to work
1. Brainstorm/design per phase only where a real decision is open; otherwise follow the plan.
2. Keep `docs/PROGRESS.md` updated after every milestone: phase, done items, evidence (command + result), failures, next step, open decisions. It must let a fresh session resume.
3. Follow the plan's phase gates. A gate counts as passed only with evidence (tests/logs), recorded in PROGRESS.md. If a gate depends on something external, record the software part as done and the rest in HELD.md.
4. TDD for backend logic; negative tests for every validation and security rule; never weaken or delete tests to make them pass.
5. Security from day one per plan section 4 (ASVS L2, L3 for auth/crypto). E2EE: SFrame via WebRTC encoded transforms plus MLS (RFC 9420) for group keys, using a maintained library (e.g. OpenMLS) rather than hand-rolled crypto; state honestly in docs that it needs independent review before being marketed as audited.
6. Legal facts (localisation law etc.) are not decided by the agent: the plan claims all personal data must stay in Uzbekistan, newer reporting suggests a narrower rule since March 2026. Build configurable data residency; record the open question in HELD.md for a lawyer.
7. Report each check as PASSED / FAILED / SKIPPED / BLOCKED with the exact command. Never claim PASS without running and reading the output.
8. Context is large: work in focused sessions, summarise large inputs, checkpoint in PROGRESS.md. Do not spawn subagents unless the user asks.

## 7. Definition of done
- All software items of plan sections 2-5 implemented and tested, or listed in HELD.md with the precise blocker.
- Working end-to-end demo on this PC: web app and desktop build, meeting with several real participants (user's devices on LAN), admin console, SSO via a local Keycloak test realm, recording, E2EE mode, breakout rooms, polls, integrations that can be tested without third-party accounts. Test accounts and a short Uzbek user guide provided so the user can act as a customer.
- Measured KPIs where measurable on this hardware (join time, audio latency, load test size), with honest limits.
- On-premise package (Helm + single config) validated on a local kind/k3d cluster; air-gapped bundle script produced.
- CI green (lint, types, tests, SAST, dependency/secret scan, SBOM) and a final diff review.
- Final report in Uzbek: what works (with evidence), what was not done and why, HELD.md summary, risks.

## 8. Open items before starting
- User approval of this file.
- Confirm trademark/name: `davrabox` is free on .uz, .com and Telegram as of 2026-11-23; Instagram and Facebook not machine-checked; company-registry name unchecked.
