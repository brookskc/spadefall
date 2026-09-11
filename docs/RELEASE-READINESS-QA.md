# Browser release-readiness pass

Run `npm run test:release-readiness` before a release. It opens small mobile,
common laptop, and large desktop viewports and checks menu/HUD overflow,
keyboard reachability, first-minute fit, automatic graphics selection, and
bounded runtime-resource counters. It is a layout and regression harness, not
a GPU benchmark.

Before shipping, do one normal playable match in current Chrome, Edge, and
Firefox on an integrated GPU and a discrete GPU where available. Check LOW,
MEDIUM, HIGH, and Automatic; verify 60, 120, and 144 Hz displays if available;
use keyboard-only menus; and leave a match running for ten minutes while
watching frame pacing and resource drift. Software/headless rendering cannot
prove weak-GPU performance.
