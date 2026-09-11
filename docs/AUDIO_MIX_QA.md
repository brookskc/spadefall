# Audio mix sign-off

Use a normal match first; the harness is for isolated A/B checks, not the final
decision. Open `?audioqa=1`, then call these from the browser console:

- `__audioQa.comparisons.weapons()` — rifle, SMG, and sniper weight.
- `__audioQa.comparisons.feedback()` — hit, headshot, and kill distinction.
- `__audioQa.comparisons.reload('rifle')` — staged reload timing and pitch.
- `__audioQa.comparisons.airstrike()` — drone, launch, fall, and impact hierarchy.
- `__audioQa.play('step')` — any individual sound listed by `__audioQa.sounds`.

Check once on speakers and once on ordinary headphones. Gunfire should dominate
reloads and footsteps; enemy footsteps should remain useful within their short
24-block range; terrain should remove high-frequency detail without erasing a
shot; hit, headshot, and kill should be identifiable without looking at the HUD;
reload cues should land at 24%, 62%, and 86% of the animation; and the drone
should sit below the missile launch and impact. Repeat at 50% master volume and
with each category bus at 50% to catch clipping or a misleading balance.

Also inspect soldier firing, hit, crouch, and death poses in a live two-browser
match. This is a release sign-off checklist: automated tests protect routing,
timing, pitch ceilings, range, and occlusion, but cannot decide whether a mix is
pleasant on the listener's hardware.

The `?audioqa=1` harness is intentionally repeatable: run each comparison at
normal volume, then 50% master and 50% effects. Record the browser, output
device, and whether captions remained local/occlusion-safe. This is a
code-level QA aid, not an ears-based approval.
