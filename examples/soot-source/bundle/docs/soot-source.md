# Soot source `lohi2`

This directory is one repository's slice of a shared Soot runtime. It declares
Soots, their own Packs, groups and website clients. It never names an AI provider,
listener or credential: each Soot picks a `tier` (flash, lite, pro or max) and the
runtime host decides which provider serves that tier.

- Soot, group and client IDs are unique across the whole runtime; prefix them with the source ID.
- A Soot can only use Packs installed under `soot/packs.d/`, plus the host data pool when the host includes it.
- After a reviewed edit run `soot bundle --refresh .`; deploy replaces only `sources.d/lohi2/` on the host.
