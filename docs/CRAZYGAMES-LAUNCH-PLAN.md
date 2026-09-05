# CrazyGames launch plan

Status: planning and launch-readiness work. This document does not itself enable a CrazyGames release.

Last updated: September 4, 2026.

## Outcome

Launch Spadefall on CrazyGames without splitting the player population or weakening the standalone game. CrazyGames should be the main browser discovery channel, while `spadefall.io` remains the canonical independent version. Both versions should use the same game rules, protocol version, public rooms, and TURN infrastructure.

The initial target is a successful Basic Launch. Full Launch, advertising, CrazyGames accounts, and cloud progress come only after the game demonstrates healthy engagement and passes the platform's additional review.

## Product promise

The store page and first match should communicate one idea immediately:

> A fast browser FPS where every wall can become a doorway.

Players should reach combat quickly, understand the current objective without reading a manual, and encounter a meaningful terrain decision during their first match. Destruction and building—not the fact that the game merely uses voxels—must be the recognizable reason to play Spadefall.

## Distribution principles

- Keep one cross-portal matchmaking population wherever platform rules permit it.
- Keep one shared gameplay codebase. Platform-specific behavior belongs behind a small adapter.
- Never expose the long-lived TURN API token to a client build.
- Add only exact, verified production origins to the TURN worker. Do not allow broad portal wildcards.
- Keep guests playable. An account prompt must never block the first match.
- Do not add advertisements before CrazyGames enables monetization.
- If monetization is enabled, place interruptions only at natural match boundaries.
- Keep public room chat disabled. Team chat must respect the platform's `DisableChat` preference.
- Release compatible builds together or prevent different protocol versions from entering the same room.

## Current readiness

### Already in good shape

- The browser build is small and uses relative local assets.
- The game supports Chrome-class browsers, mouse and keyboard, bots, public matchmaking, and private invitations.
- A player can play alone while a multiplayer room fills.
- Rooms continue through rotating maps and modes.
- Public chat is disabled; callsigns are normalized and profanity-filtered.
- The network protocol has strict message shapes and byte budgets.
- Host movement and combat actions are validated.
- Host migration and TURN fallback exist.
- Automated tests and a two-browser Playwright test run in CI.
- Graphics presets and HUD/accessibility controls already support a range of desktop hardware.

### Confirmed gaps

- The TURN worker does not yet allow CrazyGames preview or production origins.
- There is no CrazyGames SDK or platform adapter.
- Progress and settings are currently stored in the browser only.
- CrazyGames room, invite, account, cloud-save, analytics, and chat-preference APIs are not integrated.
- The signature per-map voxel mechanics remain design-only.
- Multiplayer has not been validated with a full room of real browser clients across target network conditions.
- Chrome and Edge are not yet represented as an explicit release matrix on 4 GB Chromebook-class hardware.
- The privacy notice describes GitHub Pages but not CrazyGames processing or platform services.
- The repository needs a reproducible portal release package and third-party notices.
- The public-facing version, changelog, and release synchronization procedure need to be formalized.

## Phase 0 — prove the game is ready to submit

Goal: establish that unfamiliar players understand and voluntarily replay the game before platform work begins.

- [ ] Complete the Greenbelt and Crown signature-voxel prototypes described in `docs/VOXEL-MECHANIC-PLAN.md`.
- [ ] Run moderated sessions with at least 20–30 people who have not worked on the game.
- [ ] Record time to gameplay, time to first combat, time to first useful terrain edit, match completion, second-match starts, and connection failures.
- [ ] Confirm that at least 70% of first-time matches contain a meaningful terrain action in the first two minutes.
- [ ] Confirm that players can explain the objective and one distinctive voxel tactic afterward without coaching.
- [ ] Remove or revise any first-session screen that delays combat without improving comprehension.
- [ ] Verify that the between-match flow automatically continues while still allowing class selection.
- [ ] Resolve critical gameplay, networking, or UI issues found in those sessions.

Exit gate: the game has a clearly observed core hook, no recurring first-session blocker, and a defensible reason to expect platform players to start a second match.

## Phase 1 — add a platform boundary

Goal: support CrazyGames without scattering platform checks throughout the simulation.

Create a narrow platform adapter with a standalone implementation and a CrazyGames implementation. Gameplay code should call the adapter, not the vendor SDK directly.

The adapter should expose only what the game uses:

- Environment and platform identity.
- Gameplay start and stop events.
- Loading start and stop events.
- User identity when available, with guest fallback.
- Progress load and save.
- Room status and joinability.
- Invite link and room-join callbacks.
- Instant-multiplayer launch intent.
- Chat-disabled preference.
- Analytics events approved for the platform build.
- Midgame advertisement requests, initially disabled.

Implementation rules:

- [ ] Dynamically activate the CrazyGames adapter only in its supported environment.
- [ ] Keep the standalone build fully functional when the SDK is absent or unavailable.
- [ ] Do not fork simulation, balancing, maps, or progression rules by platform.
- [ ] Define a versioned portable save schema before introducing cloud saves.
- [ ] Preserve local guest progress and specify how it merges when a guest signs in.
- [ ] Add adapter unit tests using a fake SDK.
- [ ] Add browser tests for standalone, CrazyGames guest, and CrazyGames signed-in flows.

Exit gate: one game build can run with either adapter, and SDK failure cannot prevent an offline/bot or guest session.

## Phase 2 — make networking portal-safe

Goal: preserve connection quality and keep all web players in the same compatible population.

- [ ] Upload a private build to the CrazyGames preview environment.
- [ ] Capture the exact preview and production origins used for credential requests.
- [ ] Add only approved origins to the TURN worker allowlist.
- [ ] Add tests for every allowed origin and for rejected lookalike origins.
- [ ] Verify TURN credential preflight, issuance, expiry, and rate limiting from the embedded build.
- [ ] Verify STUN-only fallback reports a useful local diagnostic rather than pretending TURN succeeded.
- [ ] Confirm that CrazyGames and `spadefall.io` clients can join the same compatible private room.
- [ ] Confirm that incompatible protocol versions fail with a clear update message.
- [ ] Define release ordering for the worker, standalone site, and portal build.
- [ ] Add a visible game version and retain the internal protocol version.
- [ ] Test abrupt host exit, elected-host migration, tab suspension, and reconnect from the embedded build.

Do not assume that the room pool's theoretical capacity is its production capacity. Validate it.

Exit gate: a CrazyGames preview client can complete a TURN-only match with a standalone client, including one host migration, without exposing secrets or accepting an unapproved origin.

## Phase 3 — satisfy Basic Launch requirements

Goal: submit a polished, desktop-first HTML5 build for CrazyGames evaluation.

### Gameplay and presentation

- [ ] Reach playable action in no more than one deliberate click.
- [ ] Keep onboarding inside gameplay, short, visual, and dismissible.
- [ ] Verify readable UI at 821×462, 907×510, 1077×606, and 1216×684 embedded sizes.
- [ ] Verify fullscreen layouts at 1280×720, 1366×768, 1536×864, and 1920×1080.
- [ ] Remove any custom fullscreen control from the portal build; CrazyGames supplies fullscreen.
- [ ] Verify physics and fire cadence at 60, 120, 144, and 165 Hz.
- [ ] Verify audio resumes correctly after focus and device interruptions.
- [ ] Review all content against CrazyGames' PEGI 12 requirement.
- [ ] Confirm that public chat remains off and team chat has moderation protections.
- [ ] Remove disallowed cross-promotion from the portal build.

### Performance and compatibility

- [ ] Measure initial download size and time to playable state.
- [ ] Keep the initial download below 50 MB and the total package below 250 MB.
- [ ] Keep the file count below 1,500.
- [ ] Test current Chrome and Edge releases on Windows.
- [ ] Test Chromium OS on representative 4 GB hardware or an equivalently constrained environment.
- [ ] Test Firefox and Safari as supported secondary browsers and document any platform disablement needed.
- [ ] Test high-DPI and device-pixel-ratio 1 displays.
- [ ] Test ad blockers, private browsing, blocked local storage, VPNs, and strict corporate networks.
- [ ] Require zero uncaught errors, missing assets, mixed-content requests, or blocked critical requests.

### Packaging

- [ ] Add a deterministic command that creates the upload archive.
- [ ] Include only runtime HTML, JavaScript, vendor libraries, legal pages, and required assets.
- [ ] Exclude tests, research notes, source maps not needed in production, local dependencies, and worker secrets/configuration.
- [ ] Add `THIRD_PARTY_NOTICES.md` with applicable Three.js, PeerJS, and other bundled-license notices.
- [ ] Generate and store a checksum for every submitted archive.
- [ ] Tag the exact submitted commit and record its CrazyGames build identifier.

Exit gate: the release archive passes local packaging checks and the CrazyGames preview inspector with no critical defects.

## Phase 4 — integrate multiplayer discovery

Goal: make joining friends and continuing together feel native to CrazyGames.

- [ ] Publish the current room identifier and joinable state through the SDK.
- [ ] Accept portal invite parameters and enter the requested room directly.
- [ ] Implement the CrazyGames room-join listener without requiring a page reload.
- [ ] Support the platform's instant-multiplayer launch path.
- [ ] Keep invited players together when the current round ends.
- [ ] Display the CrazyGames username for signed-in users and preserve a filtered guest callsign fallback.
- [ ] Respect `DisableChat` immediately and throughout the session.
- [ ] Ensure a friend joining mid-round gets an understandable spectator or safe join path.
- [ ] Test invitations with sender and receiver already running the game.

Exit gate: two CrazyGames accounts can invite, join, play, finish a round, and continue into the next round without recreating their group.

## Phase 5 — store assets and submission

Goal: make the submission accurately sell the actual play experience.

- [ ] Produce portal cover art at every required CrazyGames aspect ratio and safe area.
- [ ] Make the primary image show combat plus terrain deformation, not a static scenic map.
- [ ] Produce a 10–20 second silent-readable gameplay clip showing breach, push, elimination, and rebuild.
- [ ] Select screenshots that cover combat, construction/destruction, all three modes, and class variety.
- [ ] Write a short description centered on the gameplay hook.
- [ ] Provide exact keyboard and mouse controls.
- [ ] Describe multiplayer, bots, room size, and guest play accurately.
- [ ] Complete the platform's AI/content disclosure accurately for shipped assets.
- [ ] Update the privacy policy for CrazyGames hosting, accounts, analytics, cloud saves, advertising, and network services actually used.
- [ ] Verify ownership and distribution rights for all code, audio, images, fonts, and third-party libraries.
- [ ] Submit the tested build to Basic Launch.

Suggested positioning:

> Dig through cover, blast open new routes, and rebuild the battlefield in a fast browser FPS. Fight bots immediately or drop into public and private multiplayer rooms—no installation required.

Exit gate: the page promise matches the first minute of play, and every screenshot or claim can be reproduced in the submitted build.

## Phase 6 — Basic Launch operations

Goal: respond to real platform behavior without destabilizing the game.

Track at minimum:

- Load start to first input.
- First input to playable match.
- Matchmaking and TURN success/failure.
- First combat and first meaningful terrain edit.
- First-match completion.
- Second-match start.
- Invite creation and successful friend join.
- Session duration and matches per session.
- Frame-time and disconnect health by device/browser class.
- Exit screen or game state when measurable without invasive tracking.

Operating rules:

- [ ] Triage platform crashes and connection failures before balance requests.
- [ ] Keep one release owner and one written rollback procedure.
- [ ] Never change the network protocol without compatibility or a coordinated release.
- [ ] Review feedback in batches; do not redesign around one loud player.
- [ ] Publish small, legible updates with a changelog.
- [ ] Maintain a status notice for known matchmaking or TURN incidents.
- [ ] Compare portal results with standalone playtests without mixing unlike cohorts.

Exit gate: Basic Launch data identifies a stable funnel and no unresolved systemic connection, performance, or first-session failure.

## Phase 7 — Full Launch and monetization

Goal: integrate the required platform systems only after the game earns broader distribution.

- [ ] Complete all SDK gameplay start/stop and loading event requirements.
- [ ] Use CrazyGames accounts automatically when present while keeping guests playable.
- [ ] Move progression to the CrazyGames Data module or an approved account-backed system.
- [ ] Complete room, invite, instant-multiplayer, and chat-preference integration.
- [ ] Enable CrazyGames analytics required for promotion and product decisions.
- [ ] Request ads only through the CrazyGames SDK.
- [ ] Place midgame advertisements between matches, never during an active life or round.
- [ ] Keep rewarded advertising optional and avoid rewards that undermine competitive fairness.
- [ ] Test the complete game with advertising blocked.
- [ ] Do not build paid cosmetics until entitlement recovery and cross-device ownership are reliable.

Exit gate: the Full Launch build passes platform QA, preserves competitive integrity, and remains playable for guests and ad-block users.

## Multiplayer validation matrix

Every release candidate should cover these scenarios:

| Scenario | Required result |
| --- | --- |
| Standalone host, CrazyGames guest | Join and complete match |
| CrazyGames host, standalone guest | Join and complete match |
| Signed-in portal friends | Invite, join, and remain together |
| STUN available, TURN blocked | Clear fallback diagnostic; expected connectivity |
| TURN forced | Full match and credential renewal strategy verified |
| Host closes tab | Migration or clear recovery |
| Host sleeps/suspends tab | Timeout and recovery without permanent room poisoning |
| Version mismatch | Clear update message; no partial join |
| Full human room | Stable frame time, bandwidth, and action validation |
| Bots replaced by humans | Correct roster, teams, objectives, and spawn behavior |
| Round transition | Same party proceeds without an extra deploy requirement |
| Local storage unavailable | Guest play continues with graceful persistence loss |

## Proposed launch gates

These are internal targets, not claims about industry-wide benchmarks.

- At least 95% of test users reach a playable match within 60 seconds.
- At least 95% of supported-network attempts establish a playable connection.
- A full real-client room survives 60 minutes, a host migration, and a TURN-only run.
- No critical console, resource, pointer-lock, audio, or layout errors occur in supported browsers.
- At least 70% of first-time matches contain a meaningful voxel action within two minutes.
- At least half of moderated first-time testers voluntarily begin another match.
- The 95th-percentile frame time remains inside the selected graphics preset's budget on target hardware.
- There are no unresolved severity-one defects involving data exposure, credential issuance, remote crashes, or match integrity.

## Do not block launch on

- Central dedicated simulation servers.
- A global competitive ranking system.
- Paid cosmetics.
- Mobile controls.
- Every signature mechanic on every map.
- Perfect bots.
- Large social systems or public chat.
- A Steam wrapper.

Those can follow evidence of demand. The launch does depend on reliable connections, fast entry, a memorable voxel mechanic, and a build that behaves correctly inside the CrazyGames frame.

## Rollback triggers

Pause or roll back a release when any of the following occurs:

- TURN credentials are exposed, issued to an unauthorized origin, or generate uncontrolled cost.
- A protocol mismatch allows clients to join but corrupts match state.
- Connection success falls materially below the launch gate.
- A common browser cannot acquire pointer lock or start audio after player input.
- A release introduces repeatable host migration failure or room poisoning.
- A platform integration blocks guests from playing.
- An advertisement interrupts active gameplay or leaves the simulation/audio in a broken state.

## Source material

- [CrazyGames documentation](https://docs.crazygames.com/)
- [Launch and integration requirements](https://docs.crazygames.com/requirements/intro/)
- [Technical requirements](https://docs.crazygames.com/requirements/technical/)
- [Gameplay requirements](https://docs.crazygames.com/requirements/gameplay/)
- [Quality guidelines](https://docs.crazygames.com/requirements/quality/)
- [Multiplayer requirements](https://docs.crazygames.com/requirements/multiplayer/)
- [Account integration](https://docs.crazygames.com/requirements/account-integration/)
- [Advertisement requirements](https://docs.crazygames.com/requirements/ads/)
- [CrazyGames SDK](https://docs.crazygames.com/sdk/intro/)

Platform requirements change. Re-check the linked documentation before preparing each submission, not only when this plan is first implemented.
