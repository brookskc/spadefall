# Spadefall Gameplay Excellence Roadmap

Status: product and playtest plan, 2026-09-14

## Implementation status — 2026-09-14

The bounded implementation phases in this roadmap are complete:

- Local, privacy-safe match diagnostics now track first contact, spawn deaths, class outcomes, route lanes, occupied/contested KOTH time, captures/retakes, engineering, pings, and continuation choices. Bot simulation rotates update order to prevent a persistent first-mover bias.
- Consequential engineering assists, terrain-intent pings, and evidence-based death recaps expose terrain mastery without rewarding raw edit volume.
- The block tool now has deterministic low-wall, firing-step, and ramp blueprints with previews, full-cost atomic placement, collision checks, and host authority.
- Greenbelt received distinct lane landmarks; Beachhead received bounded counter-routes and ridge cover; Pinefall received clear base-exit headroom; and Caldera received rim sightline breaks and protected hill staging. Foundry and Faultline received an initial visual-identity pass before direct play feedback established that their underlying layouts still need substantial redesign.
- Post-match reports now show paired start/finish terrain views, descriptive roles, one teammate commendation per voter, and an optional unanimous rivalry round on the same map and seed with sides rebalanced.
- Foundry and Faultline pass deterministic structural and bot-flow validation, but direct play feedback found both boring. They are now private prototypes rather than public maps; this is concrete evidence that bot flow alone cannot establish enjoyment, suspense, social value, or perceived fairness.

The items under “Mechanics to test later” remain intentionally unbuilt. They are evidence-gated experiments, not part of the approved core, and should not be promoted without human playtest support.

This roadmap converts the findings in `GAME-EXCELLENCE-RESEARCH.md` into a practical development sequence. Its central bet is that Spadefall should not compete by becoming a broader conventional shooter. It should become the shooter in which players can read, reshape, and remember a battlefield better than anywhere else.

The targets below are product hypotheses, not universal laws. They should be replaced by observed player behavior once enough human matches have been recorded.

## Product thesis

Spadefall is at its best when three loops reinforce one another:

1. **Combat is immediately readable.** Players understand where pressure is coming from, can re-enter the fight quickly, and know what they could try next.
2. **Terrain changes have visible consequences.** Digging, building, and destroying are tactical decisions rather than background spectacle.
3. **Matches create social stories.** Teammates can coordinate without voice, recognize one another's contributions, and want another round.

The first priority is therefore not another weapon, progression track, or reward currency. It is making terrain mastery legible and socially valuable.

## Recommended mechanics

### 1. Engineering assists and consequential terrain feedback

Create an authoritative event layer that recognizes what a terrain edit accomplished, not merely that a block changed.

Candidate events:

- **Breach opened:** an edit creates a traversable route through previously separating terrain.
- **Cover save:** recently placed or preserved cover intercepts damage that would otherwise reach a teammate.
- **Sightline blocked:** construction interrupts an enemy-to-teammate line of sight during an active engagement.
- **Collapse assist:** a terrain collapse contributes to an elimination or forces an enemy from an objective.
- **Route assist:** a teammate uses a newly opened or built route shortly before dealing damage, reaching a hill, or surviving pressure.

Feedback should be short and factual: `BREACH OPENED`, `COVER SAVE`, or `ROUTE ASSIST +25`. Award contribution for consequences, with per-event cooldowns and diminishing returns. Never reward raw block placement or destruction; that invites spam.

Why first: this makes the game's unique mechanic understandable, rewards competence, and lets support-minded players matter without introducing a class lock or stat advantage.

Initial validation:

- Players can explain at least one useful terrain action they or a teammate performed after a match.
- The events correlate with objective progress, survival, or damage rather than block volume.
- Event spam stays below roughly one prominent message every 15 seconds per player.
- No repeatable self-farming loop survives adversarial testing.

### 2. Terrain-intent pings

Extend the existing team ping into a small hold-to-select vocabulary:

- Attack
- Defend
- Breach here
- Build cover here
- Rotate

`Breach` and `Build cover` should attach to a voxel surface or ground point and show a modest team-only marker. Bots can treat these as weighted goals later, but the first release only needs clear human communication. A quick tap should preserve the current simple ping so coordination does not become slower.

Validation:

- New players successfully create and follow a breach/build ping without reading a manual.
- Ping acknowledgement or teammate proximity increases over the current generic ping baseline.
- Muting, rate limits, and duplicate collapse prevent visual or audio harassment.

### 3. Combat blueprints

Make building tactically usable under pressure with three simple, destructible patterns made from the same block budget:

- **Low wall:** a short three-block-wide cover line.
- **Firing step:** a compact step and protected firing edge.
- **Ramp:** a short traversable incline for climbing or crossing.

Placement needs a ghost preview, server authority, collision checks, a brief commitment window, and the ability to rotate before confirming. Patterns must be predictable; do not procedurally choose their shape. They are conveniences for existing materials, not magical deployables.

Counterplay:

- Blueprints cost the full number of blocks they place.
- Recent incoming damage can slow or interrupt placement if instant panic walls prove dominant.
- Every placed block remains destructible by normal systems.
- Spawn, objective, and protected-volume restrictions remain authoritative.

Validation:

- Building during live combat rises without increasing stalled fights.
- Blueprint users do not gain a disproportionate duel win rate after controlling for skill.
- Players can identify each pattern's purpose on first use.

### 4. Death-to-adaptation recap

Build on the existing death recap with one fixed-rule, evidence-based observation and one visual reference. Examples:

- `The shot came through a breach opened 9 seconds ago.`
- `You were visible from the east ridge for 3.2 seconds.`
- `No teammate or solid cover was within 8 m.`
- `The attacker held the same angle for 5 seconds.`

Mark the relevant breach, direction, or last safe cover briefly on the map or respawn view. Do not generate advice text or claim that one counter was correct; show facts that help the player form a plan.

Validation:

- At least 70% of observed players can state why they died and name a plausible next adjustment.
- Respawn-to-input time does not grow materially.
- Reports of the recap being inaccurate stay rare enough that players trust it.

### 5. Battlefield evolution recap

At match end, show a quick before/after view of the terrain and highlight at most two decisive changes. Examples: the tunnel used for three hill entries, the wall that absorbed the most damage, or the collapse associated with a swing.

This should last only a few seconds and feed directly into existing stay-team/rematch actions. A same-seed rematch resets terrain to the original fair state but lets both teams try a revised plan.

Validation:

- The recap is skipped less often than a conventional statistics screen.
- Players reference highlighted terrain events in chat, commendations, or the following match.
- Immediate rematch acceptance improves without making sessions feel compulsory.

### 6. Descriptive team roles and commendations

At postmatch, describe contributions that already happened rather than assigning pre-match classes:

- Architect
- Breacher
- Vanguard
- Anchor
- Scout

Offer one teammate commendation tied to these behaviors. Roles grant no combat bonuses and should not feed a grind currency. Their purpose is social recognition and a vocabulary for different ways to help.

### 7. Opt-in rivalry set

After a close match, both teams may vote for a best-of-three rivalry using the same lobby and alternating sides where appropriate. Declining is frictionless. Do not automatically lengthen a session or use loss aversion, expiring rewards, or streak penalties.

### Mechanics to test later, not build now

- A team utility choice as an alternative to the personal airstrike. First determine whether the current airstrike creates snowballing or gives losing teams enough counterplay.
- A longer KOTH next-hill warning. Test 8, 10, and 12 seconds after human rotation data exists.
- Directional sound intelligence from unsilenced fire. Avoid wallhacks and avoid duplicating ordinary spatial audio.
- A deliberate breach charge. The spade and grenades may already cover this role; add it only if players understand the desired breach but cannot execute it reliably.

## Instrumentation before broad balance changes

Add match events for:

- map, mode, seed, team, side, and skill proxy;
- spawn, first contact, damage, death, and respawn;
- route and combat-zone entry;
- hill approach, arrival, ownership, contest, and retake;
- every terrain edit plus nearby players, sightlines, and subsequent traversal;
- weapon/class selection and change timing;
- ping creation, acknowledgement, and nearby teammate response;
- stay-team, rematch, quit timing, and session length.

For automated simulations, alternate which team updates first and report both orderings. A fixed update order can manufacture a persistent side advantage. Run at least 20 seeds per candidate map/mode before treating bot score as a balance signal, and retain traces for stall coordinates rather than only aggregate counts.

Human sessions should include side-swapped matches. Compare new players, returning casual players, and experienced shooter players separately; a single mean can hide onboarding failures.

## Map improvement plan

### Greenbelt — public TDM

Role: approachable baseline with rolling natural cover.

Current risk: its broad playable area and repeated natural forms can make decisions feel less memorable than its raw traversal statistics suggest.

Plan:

1. Establish three unmistakable macro landmarks across the north, center, and south lanes.
2. Make entrances through the midfield green belt readable from both approaches without eliminating flank uncertainty.
3. Identify unused outer areas and either add a meaningful route purpose or visually discourage them.
4. Review long sniper angles after landmarks and foliage are placed.

Measure route distribution, first-contact time, time lost outside combat zones, stall heatmaps, and kills by engagement distance.

### Beachhead — public TDM

Role: dramatic asymmetric terrain and elevation pressure.

Current risk: the fantasy is strong, but the bluff can convert initial high-ground access into persistent side advantage. Older bot samples favored blue and showed slower re-engagement.

Plan:

1. Run paired human rounds with sides swapped and identical seeds.
2. Ensure both teams can reach at least two meaningful collision points at comparable times.
3. Add a protected counter-route toward the bluff or interrupt its global line of sight; preserve the beach-versus-height identity.
4. If asymmetry remains the map's best feature, move Beachhead toward a future Assault/Breakthrough ruleset rather than flattening it into symmetric TDM.

Measure side-swapped win rate, time to first power position, deaths by elevation delta, escape rate from pinned spawns, and route concentration.

### Pinefall — public TDM

Role: current flow benchmark; quick contact and re-engagement.

Current risk: repeated trees and accidental canopy obstruction can reduce orientation and create seed-dependent navigation noise.

Plan:

1. Preserve the macro geometry and combat tempo.
2. Give three areas distinctive silhouettes and color/value cues.
3. Keep deterministic clearance around primary paths, spawn exits, and ravine crossings.
4. Improve crossing cues without making every safe route visible from spawn.

Measure whether orientation improves while first-contact and re-engagement remain near the existing benchmark.

### Caldera — public KOTH only

Role: established objective-mode benchmark.

Current risk: rim control can become global control, some seeds create long stalls, and existing bot tests cannot yet establish meaningful contested-hill balance.

Plan:

1. Trace and fix the coordinates responsible for the worst navigation stalls.
2. Break uninterrupted rim sightlines without removing elevation decisions.
3. Give each hill protected staging pockets on at least two approaches.
4. Strengthen the visual identity and preview path for the upcoming hill.
5. Validate with alternating bot update order and side-swapped human sessions before interpreting the historic green advantage as geometry alone.

Measure approach diversity, arrival advantage, contest percentage, retake rate, consecutive-hold duration, rim kill share, and side-swapped score.

### Foundry — private TDM prototype

Role: compact, purpose-built competitive TDM arena.

Current evidence: final greybox simulations produced fast contact, low spawn-death pressure, and competitive scores, but direct play feedback found the arena extremely boring. It is retired from normal hosting and public matchmaking pending a substantially stronger redesign.

Plan:

1. Human-test it directly against Pinefall, alternating which map is played first.
2. Inspect central-cover stalls and whether the side routes remain useful after players learn the fastest lane.
3. Track class and engagement-distance share; the industrial cover must support more than one weapon style.
4. Add richer industrial silhouettes, lighting, and navigational color only after the lane structure survives testing.
5. If humans feel rushed, add spawn-exit concealment or route depth before increasing the overall footprint.

### Faultline — private KOTH prototype

Role: compact four-hill rotation map designed specifically for KOTH.

Current evidence: contact and pacing thresholds pass, but direct play feedback found the arena extremely boring. It is retired from normal hosting and public matchmaking pending a substantially stronger redesign.

Plan:

1. Inspect the remaining stall trace and remove non-tactical navigation traps.
2. Run human tests focused on whether defenders can prepare and attackers can retake each of the four hills.
3. Give each hill a distinct silhouette and approach story after the greybox validates.
4. Confirm that the central foundation breaks sightlines without becoming mandatory global control.
5. Adjust individual staging pockets rather than expanding the entire map when a hill underperforms.

### Dunes — private redesign lab

Role: retained for private matches and experimentation.

Do not spend public-polish time on Dunes until its long sightline dominance and KOTH staging problems have a clear redesign hypothesis. If rehabilitated, prototype shorter sightline segments, stronger lateral cover, and fairer objective approaches, then compare it with Faultline rather than quietly returning it to rotation.

### Crown — private siege experiment

Role: distinctive fortress/siege play unavailable in the ordinary public pool.

Keep Crown private until moat and causeway traversal produce acceptable re-engagement. Its identity may ultimately fit a dedicated attack/defend mode better than either TDM or KOTH.

## Delivery sequence

### Phase 0 — trustworthy evidence

- Add the instrumentation above.
- Alternate bot update order and expand to 20+ seeds.
- Establish a repeatable side-swapped human playtest.
- Capture baseline sessions on every public map before balance edits.

### Phase 1 — expose the unique game

- Ship engineering-assist detection behind a telemetry flag.
- Add terrain-intent pings.
- Improve the death recap with factual adaptation cues.

### Phase 2 — make terrain viable under fire

- Prototype low-wall, firing-step, and ramp blueprints.
- Red-team placement exploits and farming.
- Tune only from combat and objective outcomes, not build counts.

### Phase 3 — improve map clarity and safety

- Pinefall orientation polish.
- Greenbelt landmarks and route clarity.
- Caldera stall fixes and protected hill staging.
- Beachhead side-balance experiment.

### Phase 4 — redesign and validate the dedicated maps

- Redesign Foundry before any new Pinefall comparison.
- Redesign Faultline before any new Caldera comparison.
- Apply art polish only to geometry that survives the tests.

### Phase 5 — strengthen memory and social return

- Battlefield evolution recap.
- Descriptive roles and teammate commendations.
- Same-seed rematch and opt-in rivalry set.

## Initial acceptance ranges

Use these only as alerts for investigation:

| Signal | Initial range |
| --- | --- |
| First meaningful enemy contact | 6–10 seconds |
| 90th percentile re-engagement, TDM | 25 seconds or less |
| 90th percentile re-engagement, KOTH | 35 seconds or less |
| Deaths shortly after spawn | under 5% |
| Side win rate after a meaningful sample | 45–55% |
| KOTH active time contested | 8–25% |
| Primary route concentration | no route below 15% or above 60% |
| Death comprehension in observed tests | 70% or more |

Do not optimize one number in isolation. For example, faster contact is harmful if it comes from spawn pressure, and equal win rates can coexist with repetitive or frustrating play.

## What not to add

- Stat upgrades, weapon rarity, or any progression that weakens competitive clarity.
- Daily chores, expiring rewards, streak-loss penalties, or FOMO-driven retention.
- Random macro-route or spawn-distance changes that prevent mastery.
- More weapons before the current terrain and class decisions are legible.
- Mandatory longer sessions or forced rematches.
- More public maps without human evidence that they are more enjoyable than the current controls.

## Next decision gate

The next decision is a **new greybox hypothesis**, followed by counterbalanced human playtesting before either prototype returns. Foundry needs a stronger TDM-specific spatial hook than a flat cover yard; Faultline needs hill rotations that create distinct stories rather than four versions of the same basin fight. Compare a redesigned Foundry with Pinefall and a redesigned Faultline with Caldera, swap sides and play order, and use the local diagnostics alongside short player-experience surveys. Beachhead and Caldera remain the highest-risk public maps, while Pinefall is the TDM flow control.
