# Held items (need people, money, permits or hardware)

| Item | Needed from | Prepared so far |
|---|---|---|
| Trademark registration (classes 9, 38, 42) and Madrid filing | user / IP lawyer | name davrabox free on .uz, .com, Telegram (2026-11-23); Instagram/Facebook/registry name unchecked |
| Company (MChJ), IT Park residency | user | none |
| Data-localisation legal opinion (plan says all personal data in UZ; 2026 amendments appear narrower) | IT lawyer | none |
| Cryptography permit/expertise question | IT lawyer | none |
| Independent pentest, ISO 27001 / SOC 2 audit | external firms, budget | none |
| Data-centre provider, production servers, 1-2 Gbit link | user, budget | LAN/PC hosting for now |
| EV code-signing cert, Apple Developer account | user, budget | none |
| Hiring, sales, support, 24/7 on-call | user | none |
| Figma design system (UI kit, brand identity, logo) | designer/user | design tokens with WCAG-tested light/dark palettes in packages/design-tokens |
| Wazuh SIEM host (about 4 GB RAM) | user, server | none |
| Staging cluster, remote repository, ArgoCD | user | Helm chart validated on kind, Terraform validated, ArgoCD manifest written |
| Media for participants outside the LAN (UDP/TCP reach to the server or a TURN relay on a public IP) | user: public IP / port forwarding or a small VPS (paid, needs approval) | tunnel carries web + signalling only; TURN is a phase 2 task |
| Media through TURN end to end, and TURN over TLS on 443 | a Linux host or public IP with media ports reachable, a domain and certificate | TURN enabled and verified up to relay allocation; Helm values for UDP and TLS; firewall-mode switch in the app |
