# Designing Spadefall for Challenge, Enjoyment, and Repeat Play

> Implementation note — 2026-09-13: This report preserves the evidence and map audit that informed the work. Since that baseline, Foundry and Faultline have been built as dedicated public TDM and KOTH maps; Dunes and Crown are private; and the public rotations are Greenbelt, Beachhead, Pinefall, and Foundry for TDM, plus Caldera and Faultline for KOTH. Engineering assists, intent pings, combat blueprints, evidence-based death recaps, post-match terrain evolution, descriptive roles, commendations, rivalry rounds, local playtest diagnostics, rotating bot update order, and the roadmap's bounded safety/legibility map changes are now implemented. Automated simulation can reject major flow defects, but the report's side-swapped human validation remains necessary before claiming that either map is excellent.

## Executive decision

Spadefall already has the ingredients of an excellent multiplayer game, but the current public map set does not yet express their full potential.

The most defensible design direction is:

1. Treat competence, autonomy, relatedness, effectance, suspense, and legible improvement as the core experience—not raw difficulty, violence, or match duration.
2. Make destructible and buildable terrain the signature mastery system: stable macro routes make maps learnable, while mutable micro routes make matches surprising.
3. Build one dedicated TDM arena next. None of the four public TDM maps was authored solely around TDM combat flow.
4. Then build a second dedicated KOTH arena. Caldera is a promising purpose-built KOTH map, but Dunes is a hybrid and the mode does not yet have two strong, independently validated homes.
5. Validate both maps with side-swapped human playtests and player-experience surveys. Bot simulations can reject obviously unhealthy geometry, but they cannot establish fun, fairness, tension, or replayability.

The recommended build order is therefore:

- Instrument and validate the current maps.
- Greybox a compact, dedicated TDM map, provisionally called Foundry.
- Test it head-to-head against Pinefall, the healthiest current TDM flow candidate.
- Greybox a rotating-loop KOTH map, provisionally called Faultline.
- Test it head-to-head against Caldera.
- Add art and progression only after the greyboxes win on player experience and behavior.

## What the research says

### 1. Enjoyment grows from satisfied psychological needs

Self-determination research repeatedly connects game enjoyment and continued play to three needs:

- Competence: I am getting better, and my skill changes the outcome.
- Autonomy: I have meaningful choices rather than one correct script.
- Relatedness: I feel connected to, recognized by, or useful to other players.

Across four studies, Ryan, Rigby, and Przybylski found that in-game autonomy and competence were associated with enjoyment, preferences, and wellbeing; in online multiplayer play, autonomy, competence, and relatedness independently predicted enjoyment and future play.[1] Their later motivational model places need satisfaction at the center of engagement rather than treating retention as a bag of isolated rewards.[2]

Implications for Spadefall:

- Every death should teach a plausible lesson: aim, positioning, route choice, timing, teamwork, or terrain manipulation.
- Classes and routes should support genuinely different plans, not cosmetic variations on the same plan.
- Pings, assists, revives or saves, coordinated construction, and shared pushes should visibly credit team contribution.
- A player should leave a loss thinking “I know what I want to try next,” not “the map decided that.”

### 2. The shooter fantasy is not mainly about violence

Six studies examining violent game content found that enjoyment, value, and future play were robustly associated with autonomy and competence; violent content itself contributed little unique explanatory power.[3]

For Spadefall, more spectacle or lethality will not compensate for weak agency. The game earns repeat play when firing, moving, choosing a route, digging, building, and coordinating all feel consequential.

### 3. Immediate, visible cause and effect is intrinsically satisfying

Klimmt, Hartmann, and Frey describe effectance as the perception that one’s input produces an immediate, discernible change in the game world. In an online experiment with 500 players, effectance was an important determinant of enjoyment, while the relationship between broad perceived control and enjoyment was more complex.[4]

This is Spadefall’s unusual advantage. Destroying a wall, cutting a firing slit, collapsing a crossing, or building emergency cover can create a vivid “I did that” moment. To capitalize on it:

- Terrain edits need strong audiovisual feedback.
- The tactical consequence should be visible quickly.
- Maps should contain a small number of highly legible weak points rather than uniform destructibility everywhere.
- A terrain edit should usually create, close, reveal, or protect a choice.
- Permanent fallback paths must keep a clever edit from turning into an irreversible spawn prison.

The useful formula is stable macro layout plus mutable micro routes. The first supports learning and fair competition; the second supports novelty, improvisation, and stories players retell.

### 4. Good challenge is perceived, legible, and multidimensional

A small Halo 3 study found that the perceived enjoyment of challenge and concentration predicted enjoyment better than raw difficulty.[5] However, a preregistered study with 311 participants found no significant enjoyment or engagement benefit from experimentally matching objective difficulty to player skill.[6] A systematic review of 70 game-design articles and meta-analysis of 37 studies likewise found high heterogeneity and no universal enjoyment effect for several commonly assumed design variables, including difficulty and control.[7]

The practical conclusion is not “challenge does not matter.” It is that a universal flow sweet spot should not be treated as a law. Challenge has to be interpreted by the player and tested in context.

The CORGIS challenge scale distinguishes four useful kinds of challenge:[8]

- Performative: aiming, movement, timing, execution.
- Decision-making: choosing a route, class, target, push, retreat, or rotation.
- Cognitive: reading state, predicting opponents, and understanding altered terrain.
- Emotional: managing suspense, pressure, reversals, and the consequences of failure.

Spadefall should exercise all four. A long sightline that only tests aim is less durable than a fight that also asks whether to expose, flank, reshape cover, coordinate, or disengage. Conversely, confusion is not good cognitive challenge. Players should be able to attribute outcomes to comprehensible causes.

### 5. Suspense and changing stakes matter

In a randomized first-person-shooter experiment with 63 participants, a high-suspense condition produced more enjoyment than a low-suspense condition.[9] The sample and game scope were limited, but the result fits an important design principle: players value uncertain outcomes with understandable stakes.

For Spadefall, suspense can come from:

- A close score and visible lead changes.
- A hill about to rotate.
- A final coordinated push.
- A temporarily opened route.
- A structure that is close to breaking.
- A comeback that is possible but not granted.

Suspense should come from the match state, not opaque randomness. KOTH is naturally well positioned here because territory, timing, rotation, and score interact continuously.

### 6. Multiplayer enjoyment is social, not merely simultaneous

In a laboratory study of 139 Counter-Strike players, social interaction, human teammates, team play, and communication supported competence and relatedness and were connected to enjoyment and wellbeing.[10] An observational study of millions of Halo: Reach matches, supplemented by surveys, found that friendship was associated with better individual and team performance and more prosocial behavior after accounting for expertise.[11] A separate experiment found greater presence, flow, and enjoyment against human-controlled opponents than computer-controlled opponents, although the broader meta-analysis literature warns that this effect is not universal.[12][7]

Implications:

- Bots are valuable for instant starts and population support, but the game should transparently identify them.
- A rematch, party, or “stay with squad” path is likely more important for durable repeat play than a shallow reward track.
- Team contribution needs to be readable. The scoreboard should not imply that kills are the only form of mastery.
- KOTH should reward coordinated timing, route preparation, and support around the hill—not just the player standing on it.

### 7. Level geometry changes pace, affect, and player behavior

In an FPS study using three Half-Life 2 level modifications, Nacke and Lindley found that level design altered measured player experience; the combat-oriented flow level was associated with high-arousal positive affect.[13] Spatial FPS design research emphasizes “collision points”: locations where routes intersect, opponents meet, and meaningful tactical choices arise. It recommends equal access to important collision zones, cover and height choices there, multiple exits from team-play spaces, and a limited set of recognizable landmarks. It also documents a case in which visually interesting portions of a map went largely unused because the action was concentrated elsewhere.[14]

Hullett’s FPS level-design research similarly found that geometry, placement, and scripting influence pace, tension, challenge, and behavior—but also that predicted behavior often differs from observed behavior.[15] That is a strong argument for greyboxing, heatmaps, telemetry, and repeated human tests before visual polish.

Wayfinding research outside shooters also found that landmark-enriched virtual environments reduced navigation time and errors relative to landmark-devoid ones.[16] The transfer is not exact, but it reinforces a concern visible in Pinefall and Dunes: repeated trees, dunes, and similar terrain can create disorientation even when they look attractive.

### 8. Technical performance is part of fairness

In an FPS study with nearly 100 users, lower frame rate degraded performance most on precise, rapid shooting tasks.[17] In a browser shooter, performance, input latency, network behavior, and visual clarity are therefore not merely polish. They determine whether players can experience competence and attribute outcomes fairly.

## A design model for Spadefall

An excellent Spadefall match should create the following loop:

1. Read: understand the objective, local danger, team state, and altered terrain.
2. Choose: select a route, role, engagement, or terrain intervention.
3. Act: execute movement, shooting, building, destruction, or coordination.
4. See consequence: receive immediate feedback about what changed.
5. Reflect: understand why the outcome occurred.
6. Adapt: form a specific new plan.
7. Rejoin: return to a meaningful decision quickly.

Repeatability comes from the loop producing different but intelligible situations. It should not depend on making the player repeat a chore or chase an extrinsic reward.

### Healthy psychological challenge

Healthy challenge is:

- Learnable: the player can form a better model over time.
- Attributable: the player can explain wins and losses.
- Expressive: more than one viable solution exists.
- Recoverable: a mistake is costly without making the rest of the match pointless.
- Social: teammates can amplify one another’s plans.
- Variable: opposing plans and terrain edits prevent rote repetition.

Unhealthy challenge is:

- Spawn exposure without a readable counter.
- Getting lost among visually similar spaces.
- A dominant height position with no credible response.
- One team reaching the decisive space first because of spawn geometry.
- Irreversible route denial.
- Network or frame-rate loss disguised as mechanical failure.
- Bots or hidden rules that make the match feel dishonest.

## Current map audit

The following audit combines code inspection, visual review, the current public rules, and a fresh deterministic bot simulation. It is directional evidence, not a human fun study.

The public catalogue is:

- TDM: Greenbelt, Beachhead, Pinefall, Dunes.
- KOTH: Dunes, Caldera.
- Crown: private/experimental.

Public TDM is 5v5, first to 35 or 5:30. Public KOTH is 4v4, first to 90 seconds of control or 6:00. KOTH uses a 45-second active point, an 8-second warning, and a 6-second capture.

### Simulation snapshot

The current public bot simulation ran two deterministic 180-second rounds for every valid public map/mode combination:

| Map and mode | Score results | First contact | Re-engagement P90 | Notable result |
|---|---:|---:|---:|---|
| Greenbelt TDM | 30–27, 26–27 | 8–11 s | 18–19 s | Close scores; one run had many bot stalls |
| Beachhead TDM | 31–35, 29–35 | 5 s | 23–36 s | Fast opening; blue won both |
| Pinefall TDM | 35–34, 27–25 | 5–9 s | 13–16 s | Best current score and return-to-action profile |
| Dunes TDM | 23–35, 22–35 | 4–5 s | 15–25 s | No stalls, but blue won both by a wide margin |
| Dunes KOTH | 27.6–4.95, 25.35–1.95 | 9–12 s | 19–30 s | Very little contested hill time |
| Caldera KOTH | 43.8–10, 24.65–0 | 11–12 s | 25–28 s | Strong concept; one run had many bot stalls |

Across 12 rounds there were 678 deaths, three deaths shortly after spawning, and 3,568 terrain edits. The worst first contact was 12 seconds and the worst public re-engagement P90 was 35.6 seconds.

Critical limitation: the KOTH score skew is partly produced by the simulator. Bots on one team update first and can apply damage immediately; reversing update order previously flipped the apparent advantage. Two deterministic seeds, accelerated bot logic, and bot navigation cannot establish human fairness or enjoyment. A map also cannot be declared fair simply because this artifact exists. KOTH needs alternating update-order simulations and side-swapped human play.

### Greenbelt

Strengths:

- Symmetrical bases and a comprehensible base-to-base structure.
- Central road, field walls, hedge belts, breaches, and outer flanks create route choices.
- Bot scores were close and re-engagement was healthy.

Risks:

- The large rolling terrain can diffuse encounters away from designed collision points.
- Sparse authored landmarks may make the space feel less memorable than its theme deserves.
- A high stall count in one simulation suggests navigation or obstruction edge cases.

Verdict: keep and tune. Greenbelt is a healthy general-purpose map, but it is not yet the definitive expression of Spadefall TDM.

### Beachhead

Strengths:

- The strongest narrative and landmark identity in the current set.
- Beach, bluff, trench, bunkers, and fortified line make orientation easy.
- Immediate contact creates urgency.

Risks:

- Its D-Day attacker-versus-defender composition is intentionally asymmetric.
- High ground and fortified geometry can translate into persistent side advantage in ordinary TDM.
- One simulation produced the public set’s slowest re-engagement tail.

Verdict: preserve it, but treat it as a specialist map. It may ultimately fit a side-swapped assault, breakthrough, or round-based mode better than a single un-swapped TDM round. Before removing it from TDM, run human side swaps and compare perceived fairness.

### Pinefall

Strengths:

- The strongest current TDM flow candidate.
- Short sightlines, a central ravine, bridge, ford, and cuttable shoulder support close decisions and terrain play.
- The simulation produced close scores and the fastest re-engagement profile.

Risks:

- Dense, similar trees can obscure landmarks and make navigation or target reading tiring.
- Seeded vegetation can create unplanned obstruction and inconsistent combat pockets.
- The central crossing structure could become repetitive if too much combat collapses onto it.

Verdict: use Pinefall as the current TDM benchmark. Improve landmarks and audit route usage, but do not radically redesign it without human evidence.

### Dunes

Strengths:

- Broad visibility, mesas, ruins, gates, and arches produce a distinct long-range identity.
- Mirrored structure is a better competitive starting point than visual symmetry alone.
- Bots found combat immediately and did not stall in TDM.

Risks:

- Long sightlines can over-reward one combat style and reduce decision variety.
- Both TDM bot rounds ended in wide blue wins.
- In KOTH, the hill was almost never contested by both teams at once, and scores were extremely one-sided.
- As a hybrid TDM/KOTH layout, its hills may sit in spaces designed more for traversal and spectacle than sustained objective fighting.

Verdict: retain Dunes as a style contrast, but flag it as the weakest public all-rounder until human testing shows otherwise. Audit spawn-to-power-position timing, kill distance, cover access, and hill approaches.

### Caldera

Strengths:

- The clearest current expression of Spadefall’s map potential.
- It was authored for KOTH, has a memorable crater identity, three broad base-facing ramp cuts, rotating center/north/south hills, fault gates, and multiple cover layers.
- It correctly has no public TDM configuration.

Risks:

- The rim and bowl can make height control too globally valuable.
- The three largely collinear hill positions may make rotations predictable.
- One simulation had 44 stall events.
- The bot matches had severe score skew and almost no simultaneous contesting, even though update order is a known confound.

Verdict: keep as the KOTH benchmark and improve it rather than abandoning it. Human tests should focus on navigation failures, hill entry timing, rim dominance, and whether losing teams can stage a credible retake.

### Crown

Strengths:

- Strong central monument identity and clear purpose-built objective geometry.
- Causeways, moat, plateau, and ring fort create readable stakes.

Risks:

- Moats and constrained causeways can turn objective play into a bottleneck rather than a choice.
- A prior internal bot run produced roughly a 92-second re-engagement P90, far outside the public maps.

Verdict: keeping Crown private is correct. It is useful as an experimental testbed for siege-like play, not as a public competitive standard.

## Does KOTH hold its own?

Conceptually, yes. In fact, KOTH may be the mode that best unifies Spadefall’s systems:

- The objective focuses encounters and creates suspense.
- Terrain edits can prepare, attack, or defend a known location.
- Rotation creates decision-making challenge and prevents one solved fortification from lasting forever.
- Team coordination has an obvious shared purpose.

Empirically, the game has not yet proven that KOTH holds its own with human players. The current bot results show healthy time-to-contact but very little simultaneous hill contesting and severe score separation. Some of that is simulation-order bias, while some may reflect approach geometry, capture timing, bot coordination, or hill placement. The correct conclusion is “promising and under-validated,” not “bad” or “solved.”

KOTH should remain a first-class mode, with these priorities:

- Make the upcoming hill unmistakable during the warning period.
- Give each hill three permanent approaches and one optional terrain-created shortcut.
- Provide staging cover just outside the capture space.
- Ensure no single rim or tower controls every approach.
- Credit setup, defense, assists, and terrain interventions, not only occupation time.
- Preserve comeback suspense without using arbitrary rubber-banding.

## Recommended new TDM map: Foundry

Build the TDM map first. The public rotation currently has four TDM maps, but none is a pure TDM arena: Greenbelt, Beachhead, and Pinefall inherit base-to-base objective structure, while Dunes is a hybrid.

Foundry should be a compact 5v5 industrial ruin designed around repeated collision, flanking, readable elevation, and controlled terrain mutation.

### Spatial brief

- Use 180-degree rotational symmetry for spawn fairness without making both views visually identical.
- Create three primary collision zones:
  - Central foundry floor: short-to-medium-range, multiple pieces of hard cover.
  - North conveyor trench: compressed route with vertical counterplay.
  - South slag yard: more open, with broken machines and smoke or heat landmarks.
- Cross-connect the three routes frequently so no lane ends in a trap.
- Give each important room or yard at least two exits, preferably three.
- Use two valuable height positions. Each must have two access routes and a credible counter-sightline.
- Place four to six clearly marked destructible weak walls, collapsible catwalks, or breakable barriers.
- Keep at least one permanent path through every macro lane.
- Allow local building and emergency cover, but prevent spawn sealing and unlimited towers.
- Make the center, each flank, and each spawn visually distinct at a glance.

### Intended match rhythm

These are design hypotheses to test, not academic constants:

- First meaningful enemy contact: 6–10 seconds.
- Median death-to-next-contact: no more than 14 seconds.
- Re-engagement P90: no more than 25 seconds.
- Deaths shortly after spawning: below 5 percent.
- Public 35-kill match: usually 4–6 minutes.
- No side wins more than 55 percent after a sufficiently large, side-swapped human sample.

### Why it should be replayable

The macro routes remain learnable, while each match can change the local network:

- Opening a wall turns a safe hold into a crossfire.
- Dropping a catwalk changes a height route.
- A constructed barricade redirects a push without deleting all alternatives.
- Different class compositions emphasize different collision zones.

This produces meaningful novelty rather than procedural noise.

## Recommended new KOTH map: Faultline

Build Faultline after Foundry. Caldera gives KOTH one purpose-built home; the mode needs a second to prove that its strengths survive a different geometry.

Faultline should be a compact 4v4 loop around a recognizable central landmark. Four hills should alternate around the loop rather than sit on one line.

### Spatial brief

- Use four hill locations: north, west, south, east.
- Make north and south strategically neutral.
- Let west and east have modest opposite-side proximity, then rotate through them evenly.
- A sample full-cycle order is north, west, south, east. At a 45-second hill duration, a full six-minute match contains exactly two four-hill cycles.
- Give every hill three permanent approaches plus one obvious destructible shortcut.
- Make each hill visually and tactically distinct:
  - North: enclosed machinery and short-range entrances.
  - West: broken courtyard with lateral cover.
  - South: low excavation with rim counterplay.
  - East: raised but penetrable structure.
- Ensure the central landmark helps orientation but cannot dominate all four hills.
- Put staging cover outside each capture area so a losing team can organize a retake.
- Show the next hill during the current 8-second warning.
- Target roughly 8–12 seconds of travel between adjacent hills for an unopposed player.

### Intended KOTH health targets

Again, these are product hypotheses:

- Both teams should be present near the objective often, but not trapped in permanent stalemate.
- Simultaneous contested time should be material—roughly 8–25 percent of active hill time is an initial human-playtest target.
- A team that loses a hill should still have a credible choice between retaking, cutting a shortcut, and rotating early.
- The current leader should have to choose between defending remaining seconds and preparing the next hill.
- Side win rate, first-arrival rate, and time with uncontested ownership should be reviewed separately.

## Human validation plan

### Fix the measurement foundation

Before comparing maps:

- Run bot simulations with both team update orders.
- Expand beyond two deterministic seeds.
- Log route usage, path failures, kill location, kill distance, line of sight, and terrain-edit consequences.
- Record whether an edit actually changed a route, created cover, or exposed a target.
- Distinguish bot-filled and human-filled matches.

### Run counterbalanced playtests

Recruit both shooter-experienced and shooter-new players. As a practical first pass, use at least 16 in each group, then continue accumulating sessions rather than treating that sample as final proof.

Every participant should:

- Play both sides of a map.
- Encounter map order in a counterbalanced sequence.
- Play both the current benchmark and the new greybox.
- Complete a very short survey after each match.
- Be offered an actual voluntary rematch or map vote.

For TDM, compare Foundry primarily with Pinefall. For KOTH, compare Faultline primarily with Caldera.

### Measure behavior

- Time to first meaningful input, contact, and death.
- Death-to-next-contact median and P90.
- Spawn-adjacent deaths.
- Kill distance and weapon/class distribution.
- Score margin and lead changes.
- Heatmap and route entropy.
- Time spent alive without combat or a meaningful objective action.
- Terrain edits attempted, completed, and tactically consequential.
- KOTH occupancy, contesting, first-arrival, retake success, and early rotation.
- Voluntary rematch, map vote, and “one more” rate.
- Party continuation and teammate retention where available.

Do not equate session length with enjoyment. A player can remain because a system is manipulative, because a match cannot be exited gracefully, or because rewards demand it. Combine behavior with self-report and interview evidence.

### Measure experience

The validated Player Experience Inventory covers functional and psychosocial dimensions such as mastery, autonomy, immersion, ease of control, and feedback.[18] A short miniPXI form can reduce survey burden.[19] CORGIS can separately measure performative, emotional, cognitive, and decision-making challenge.[8]

An efficient post-match form should include:

- A compact PXI or miniPXI measure.
- Selected CORGIS items relevant to the playtest question.
- “I understood why I won or lost most fights.”
- “I had more than one useful plan available.”
- “My terrain changes mattered.”
- “I would voluntarily play this map again now.”
- “What would you try differently next match?”
- One open prompt: “What moment do you remember most?”

The last two are especially important. A player who can name a new plan has entered the mastery loop; a player who can recall a specific moment has experienced a match worth remembering.

## Excellence gates

Do not ship a new map merely because it passes automation. Promote it when the evidence supports all of the following:

- New players can state the mode objective after their first life.
- Players can identify why they died and name a credible adjustment.
- Both sides perform comparably in side-swapped tests.
- No single route, height position, class, or terrain edit dominates.
- Experts find expressive choices without making novices irrelevant.
- Navigation errors are rare and landmarks are recalled correctly.
- Terrain editing produces tactical consequences without breaking the match.
- KOTH creates real retakes, rotations, and contested states.
- The new greybox beats or clearly complements the current benchmark on player experience.
- Players voluntarily choose another match for reasons they can articulate.

## Final recommendation

The current maps reflect the game’s potential partly, not fully.

Pinefall is the best present TDM benchmark. Greenbelt is healthy but broad. Beachhead is memorable but structurally better suited to side-swapped asymmetric play. Dunes provides useful long-range contrast but is the weakest current all-rounder and needs a fairness and objective-flow audit. Caldera is the strongest conceptual statement of Spadefall’s potential and should remain KOTH-only, but it needs navigation and human fairness validation. Crown should remain private.

Create both new maps, sequentially:

1. Foundry, a dedicated TDM arena, because TDM currently lacks any purpose-built flagship.
2. Faultline, a second dedicated KOTH arena, because KOTH is a promising core mode but currently depends on one purpose-built public map.

The key is not the number of maps. Two rigorously tested maps that generate readable choices, fair collisions, meaningful terrain changes, social coordination, suspense, and a clear desire to try again will do more for excellence than a larger rotation of attractive but under-validated spaces.

## Sources

1. Ryan, R. M., Rigby, C. S., & Przybylski, A. (2006). The Motivational Pull of Video Games: A Self-Determination Theory Approach. Motivation and Emotion, 30, 344–360. https://doi.org/10.1007/s11031-006-9051-8. Author PDF: https://selfdeterminationtheory.org/SDT/documents/2006_RyanRigbyPrzybylski_MandE.pdf
2. Przybylski, A. K., Rigby, C. S., & Ryan, R. M. (2010). A Motivational Model of Video Game Engagement. Review of General Psychology, 14(2), 154–166. https://doi.org/10.1037/a0019440. Author PDF: https://selfdeterminationtheory.org/SDT/documents/2010_PrzybylskiRigbyRyan_ROGP.pdf
3. Przybylski, A. K., Ryan, R. M., & Rigby, C. S. (2009). The Motivating Role of Violence in Video Games. Personality and Social Psychology Bulletin, 35(2), 243–259. https://doi.org/10.1177/0146167208327216. Author PDF: https://selfdeterminationtheory.org/wp-content/uploads/2014/04/2009_PrzbylskiRyanRigby_PSPB-1.pdf
4. Klimmt, C., Hartmann, T., & Frey, A. (2007). Effectance and Control as Determinants of Video Game Enjoyment. CyberPsychology & Behavior, 10(6), 845–848. https://doi.org/10.1089/cpb.2007.9942
5. Corcos, A. (2018). Being enjoyably challenged is the key to an enjoyable gaming experience: an experimental approach in a first-person shooter game. Socioaffective Neuroscience & Psychology, 8(1), 1474668. https://doi.org/10.1080/20009011.2018.1474668. Open access: https://pmc.ncbi.nlm.nih.gov/articles/PMC5954478/
6. Cutting, J., Deterding, S., Demediuk, S., & Sephton, N. (2023). Difficulty-skill balance does not affect engagement and enjoyment: a pre-registered study using artificial intelligence-controlled difficulty. Royal Society Open Science, 10, 220274. https://doi.org/10.1098/rsos.220274
7. Caroux, L., & Pujol, M. (2024). Player Enjoyment in Video Games: A Systematic Review and Meta-analysis of the Effects of Game Design Choices. International Journal of Human–Computer Interaction, 40(16). https://doi.org/10.1080/10447318.2023.2210880
8. Denisova, A., Guckelsberger, C., & Zendle, D. (2020). Measuring Perceived Challenge in Digital Games: Development and Validation of the Challenge Originating from Recent Gameplay Interaction Scale (CORGIS). International Journal of Human–Computer Studies. Author PDF: https://openaccess.city.ac.uk/23517/1/CORGIS_IJHCS%20(Final).pdf
9. Klimmt, C., Rizzo, A., Vorderer, P., Koch, J., & Fischer, T. (2009). Experimental Evidence for Suspense as Determinant of Video Game Enjoyment. CyberPsychology & Behavior, 12(1), 29–31. https://doi.org/10.1089/cpb.2008.0060. PubMed: https://pubmed.ncbi.nlm.nih.gov/19025464/
10. Reer, F., & Krämer, N. C. (2020). A self-determination theory-based laboratory experiment on social aspects of playing multiplayer first-person shooter games. Entertainment Computing, 34, 100353. https://doi.org/10.1016/j.entcom.2020.100353. Author PDF: https://selfdeterminationtheory.org/wp-content/uploads/2021/10/2020_ReerKramer_SDTbasedLaboratoryExperiment.pdf
11. Mason, W. A., & Clauset, A. (2013). Friends FTW! Friendship and Competition in Halo: Reach. Proceedings of CSCW. https://doi.org/10.1145/2441776.2441820. Preprint: https://arxiv.org/abs/1203.2268
12. Weibel, D., Wissmath, B., Habegger, S., Steiner, Y., & Groner, R. (2008). Playing online games against computer- vs. human-controlled opponents: Effects on presence, flow, and enjoyment. Computers in Human Behavior, 24(5), 2274–2291. https://doi.org/10.1016/j.chb.2007.11.002
13. Nacke, L. E., & Lindley, C. A. (2008). Flow and Immersion in First-Person Shooters: Measuring the Player’s Gameplay Experience. Proceedings of Future Play. https://doi.org/10.1145/1496984.1496998. Preprint: https://arxiv.org/abs/1004.0248
14. Güttler, C., & Johansson, T. D. (2003). Spatial Principles of Level-Design in Multi-Player First-Person Shooters. PDF: https://svn.sable.mcgill.ca/sable/courses/COMP763/oldpapers/guttler-03-spatial.pdf
15. Hullett, K. (2012). The Science of Level Design: Design Patterns and Analysis of Player Behavior in First-Person Shooter Levels. PhD dissertation, University of California, Santa Cruz. https://escholarship.org/content/qt1m25b5j5/qt1m25b5j5.pdf
16. Sharma, G., Kaushal, Y., Chandra, S., Singh, V., Mittal, A. P., & Dutt, V. (2017). Influence of Landmarks on Wayfinding and Brain Connectivity in Immersive Virtual Reality Environment. Frontiers in Psychology, 8, 1220. https://doi.org/10.3389/fpsyg.2017.01220
17. Claypool, K. T., & Claypool, M. (2007). On Frame Rate and Player Performance in First Person Shooter Games. Multimedia Systems, 13, 3–17. https://doi.org/10.1007/s00530-007-0081-1. Project page: https://web.cs.wpi.edu/~claypool/papers/fr/
18. Vanden Abeele, V., Spiel, K., Nacke, L., Johnson, D., & Gerling, K. (2020). Development and validation of the Player Experience Inventory: A scale to measure player experiences at the level of functional and psychosocial consequences. International Journal of Human–Computer Studies, 135, 102370. https://doi.org/10.1016/j.ijhcs.2019.102370
19. Haider, A., Harteveld, C., Johnson, D., Birk, M. V., Mandryk, R. L., Vanden Abeele, V., Mekler, E. D., Denisova, A., & Nacke, L. E. (2022). miniPXI: Development and Validation of an Eleven-Item Measure of the Player Experience Inventory. Proceedings of the ACM on Human-Computer Interaction. https://doi.org/10.1145/3549507
