# Signature voxel mechanics plan

Status: all six mechanics are implemented and active by default. BEACHHEAD's
fortified line and DUNES' arch courts use ordinary destructible voxels; their
fallback lane anchors are the only signature-specific protected cells.

## Goal

Every first match should make one fact unavoidable: terrain is a weapon. Each map gets one large, legible decision where the direct route is changed by digging, destruction, collapse, or construction. The mechanic must use the existing flat-color voxel language and current tools rather than a new crafting system, currency, prompt chain, or special-purpose gadget.

## Shared rules

- Put the first signature interaction on the natural base-to-objective route, reachable within 20–30 seconds.
- Always preserve two usable fallback routes. Players can improve or degrade a lane, but cannot make the objective permanently unreachable.
- Keep the objective core, spawn footprint, and one fallback route protected from edits. Everything that looks destructible should otherwise obey the ordinary voxel rules.
- Mark opportunities with silhouette and construction: cracked profiles, missing blocks, thin walls, exposed supports, rubble, and team pings. Do not add textures, glowing outlines, or a new interaction key.
- Let ordinary spade, gunfire, grenades, airstrikes, and placed blocks do the work. A map-specific mechanic should be a consequence of the shared simulation, not a scripted button.
- Give bots authored alternate route nodes plus invalidation when terrain changes. Bots should use a player-made opening within five seconds and stop routing into a destroyed crossing.
- Credit the existing fieldwork system with plain-language verbs: `DIG`, `BRIDGE`, `FORTIFY`, and `COLLAPSE`. The first-minute card should point at the opportunity once, then get out of the way.
- Add deterministic generation tests, protected-route tests, bot-route tests, and a destruction/rebuild browser test before shipping any map.

## GREENBELT — breach the belt (implemented)

Build two broad, staggered hedgerow-and-stone belts across the center approaches. Each belt has a visible thin section facing the normal route, a longer open gate on the flank, and enough height to stop a casual hop or clean shot.

The obvious play is to cut a doorway with the spade or grenade, then reuse the removed blocks to harden the new opening. A fresh match begins as a lane fight; two minutes later it should contain player-authored doors, firing steps, and counter-walls. The existing broken field walls and outcrops become the visual grammar for the belts rather than unrelated scenery.

Guardrails: never span the entire map edge to edge, keep both outer flanks open, keep belt fragments outside protected base zones, and limit vertical thickness so tunneling is useful without becoming a long mining chore.

## BEACHHEAD — crack the fortified line (implemented)

Turn the existing bluff pillboxes into one readable defensive line with three strongpoints and two thin connecting seawall sections. The beach team can take the exposed trench route, attack a pillbox door, or blast a short breach through a visibly damaged wall section. Defenders can spend blocks to close a hole, but cannot restore protected foundation blocks.

The signature moment is a grenade opening a team-sized route through the bluff while the pillbox roof and buttresses visibly collapse. Landing craft remain immediate cover and teach the same idea on a smaller scale: hard-looking voxel structures are still temporary.

Guardrails: keep the covered trench permanently passable, protect one ramp on each north/south flank, prevent a single explosion from exposing either spawn directly, and ensure the defensive line is useful but not a blue-team shooting gallery.

## PINEFALL — cross the ravine your way (implemented)

Make the widened shallow ravine the central routing decision. Author one intact stone ford, one broken log crossing with a two-to-four-block gap, and one steep earth shoulder thin enough to tunnel through. The fastest crossing requires players to finish the broken bridge with placed blocks; the quiet route is a dug bank cut; the safe default is the longer ford.

Dense tree clusters should frame these crossings. Cutting trunks opens sightlines and can collapse canopies, making the battle visibly strip the forest without pretending that a removed tree can fall and become a physics bridge. Cache placement supplies builders near, but not on, the crossing fight.

Guardrails: the ford is protected and always walkable, water exits remain mantle-safe for humans and bots, bridge anchors are protected while the span is editable, and canopy collapse cannot bury a spawn or the ford.

## DUNES — bring down the ruins (implemented)

Expand the paired midfield ruins into two tall, skeletal arch courts beside the rotating hill approaches. Their exposed support columns are ordinary stone. Removing a support triggers the existing structural-collapse system, dropping a whole firing perch and opening a direct ground lane.

The before/after silhouette should be dramatic from across the map: a vertical ruin becomes a low rubble field. Players can then build short shade walls or firing steps from the remains. This gives long-range classes changing sightlines and close-range classes a reason to reshape the court before pushing a hill.

Guardrails: hill pads and dry washes remain permanent paths, collapse cells are capped and batched, no arch can fall into a spawn, and paired ruins stay mirrored for competitive fairness.

## CROWN — cut and rebuild the causeways (implemented)

Make the four causeways the map’s signature. Two diagonal causeways remain permanent fallback routes. The north/south pair get short, destructible center spans with protected abutments. Attackers can cut a pursued route into the moat; either team can rebuild a narrow bridge with normal blocks.

The crown becomes a visible record of the match: intact bridges, blown gaps, emergency one-block crossings, and fortified bridgeheads. The ring fort remains destructible cover, but the bridge decision is the unmistakable headline.

Guardrails: at least two crossings always survive, water-to-block mantling is tested at every abutment, placed blocks cannot seal the objective core, bots re-evaluate crossings immediately, and airstrikes cannot remove protected bridge anchors.

## CALDERA — breach the rim (implemented)

Give the north and south rim sectors two thin basalt fault gates. The ordinary saddle routes remain open east and west, but blasting or digging through a fault creates a much faster entrance into the bowl. Basalt fins inside the bowl provide destructible cover and readable material continuity from rim to center.

The signature moment is seeing daylight through a new hole in the crater wall, then watching both teams redirect through it. A later airstrike can widen that route and erase nearby fins, changing the sniper-versus-brawler balance without changing weapons or rules.

Guardrails: saddles remain protected fallback routes, fault depth is short enough for one player to open quickly, rim breaches cannot produce lethal unavoidable drops, objective knolls remain protected, and bots understand both the original saddles and new holes.

## Recommended validation order

1. Validate first-use timing, route choice, remesh spikes, and whether teams can create a stalemate across all six maps.
2. Sign off BEACHHEAD after water exits, pillbox breaches, and fortified-line balance pass two-browser playtests.
3. Sign off DUNES after worst-case collapse profiling and mirrored-route playtests.

## Ship gates

- At least 70% of observed first-time matches contain one signature terrain action in the first two minutes during moderated playtests.
- No signature event exceeds the current explosion/collapse frame and packet budgets.
- A team can always reach every live objective without placing or removing a block.
- Bots finish ten deterministic matches per supported mode without route loops at intact, breached, destroyed, and rebuilt states.
- Testers can describe the map’s voxel choice afterward without being told the feature name.
