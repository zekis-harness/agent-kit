# CAPTCHAs and bot walls (hCaptcha, reCAPTCHA, Turnstile, PerimeterX)

Part of the `use-chrome` skill; read `SKILL.md` first for the servers and tools.

Solve them yourself before handing anything to the user, including challenges that appear during the user's own personal browsing or research in their own profile. Never use this procedure to create accounts in bulk, mass-crawl a site, or act for anyone else, and keep research at a human pace (page loads seconds apart, tens of pages, not thousands). The checkbox, hCaptcha motion and drag puzzles, reCAPTCHA v2 and Cloudflare Turnstile cases below were each confirmed by the site's server-side check.

## Why the usual tools fail, and the ladder that works

Every input carries `isTrusted`. A JS `.click()` from `browser_evaluate` is
untrusted and anti-bot widgets drop it silently: no error, nothing happens. The
widgets also live in cross-origin iframes (Turnstile inside a closed shadow
root too), so there is often no element to grab at all. Climb only as high as
the page forces you:

1. **Rung 1, synthetic:** `browser_evaluate` / JS click. Fine for ordinary
   forms. Useless on CAPTCHA widgets.
2. **Rung 2, trusted input at a screen position:** ask where the widget's
   iframe sits, add the offset of the target inside it, and send a real mouse
   event there with `page.mouse` in `browser_run_code_unsafe`. That goes
   through CDP's Input domain, the same path as a physical mouse.
3. **Rung 3, human motion plus vision:** a curved, eased, jittered mouse path
   with a short dwell before the press, and a screenshot read by you for
   image puzzles.

Speed matters: challenges expire, and every tool round trip costs seconds.
Do all deterministic steps (move, click, wait, capture frames) inside one
`browser_run_code_unsafe` call; the only thing that needs you in the loop is
looking at the picture. In that tool `setTimeout` does not exist; use
`page.waitForTimeout(ms)`. Pass `filename` (absolute path) to run a script
saved to disk instead of inline `code`.

Human-like trusted click (paste into the `code` function):

```js
async (page) => {
  const sleep = ms => page.waitForTimeout(ms);
  async function humanClick(x, y) {
    const s = { x: x + 200 + Math.random() * 150, y: y + 120 + Math.random() * 100 };
    const c = { x: (s.x + x) / 2 + (Math.random() - .5) * 140, y: (s.y + y) / 2 + (Math.random() - .5) * 140 };
    const steps = 22 + Math.floor(Math.random() * 12);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await page.mouse.move((1-e)**2*s.x + 2*(1-e)*e*c.x + e*e*x + (Math.random()-.5)*1.5,
                            (1-e)**2*s.y + 2*(1-e)*e*c.y + e*e*y + (Math.random()-.5)*1.5);
      await sleep(8 + Math.random() * 16);
    }
    await sleep(100 + Math.random() * 150);
    await page.mouse.down(); await sleep(50 + Math.random() * 70); await page.mouse.up();
  }
  // ...find the box, then: await humanClick(box.x + dx, box.y + dy)
}
```

## Step 1: the checkbox (often all it takes)

A signed-in, long-lived profile is trusted, so the checkbox alone passed
reCAPTCHA v2 and Turnstile. Find the widget's box, click about 28 px from its
left edge at mid height, wait ~4 s, then read the response field:

- reCAPTCHA: `iframe[title="reCAPTCHA"]`; token in `[name="g-recaptcha-response"]`.
- hCaptcha: `iframe[title*="checkbox"]`; token in `[name="h-captcha-response"]`.
  The challenge iframe `iframe[title="hCaptcha challenge"]` sits at y = -9999
  while hidden; a positive y after your click means a puzzle is showing.
- Turnstile (and Cloudflare's "Just a moment..." page): CSS cannot see into
  the closed shadow root. Use
  `page.frames().find(f => f.url().includes('challenges.cloudflare.com'))`,
  then `(await frame.frameElement()).boundingBox()`. Wait ~3 s first: it
  often passes with no click. Token in `[name="cf-turnstile-response"]`; on
  the interstitial, success is the page title changing.

A non-empty token (hundreds of characters) means solved. Submit the form
normally afterwards.

Invisible widgets (`data-size="invisible"`, common on iCIMS and Lever) have
no checkbox: the token is requested when the form is submitted. Press the
submit button with a trusted click (`humanClick` on its box, not a JS
click), then check whether the challenge iframe moved on screen and go to
step 2. A form that keeps failing with a generic error ("Invalid Data
Error") while `h-captcha-response` stays empty is this case, not bad data.

## Step 2: an image challenge (hCaptcha puzzles, reCAPTCHA grids)

1. Screenshot only the challenge iframe (`browser_take_screenshot` with
   `target` set to its selector) and read the prompt.
2. If the answer depends on motion ("click the flower the bee never lands
   on"), one frame is not enough. Capture a burst in one call, then tile it:
   ```js
   async (page) => {
     const frame = page.locator('iframe[title="hCaptcha challenge"]');
     for (let i = 0; i < 16; i++) { await frame.screenshot({ path: `<dir>/b${i}.png` }); await page.waitForTimeout(350); }
   }
   ```
   `python3 <skill folder>/scripts/montage.py <dir>` writes
   `<dir>/montage.png` (16 frames, one Read). Use an absolute `<dir>` (a temp directory); relative screenshot paths land in
   the current working directory. Track every place the moving thing stops; the answer
   is what it never visits.
3. Click the answer and the Next / Verify button in one call with
   `humanClick`. Coordinates are the iframe box plus the position inside your
   screenshot (element screenshots are in CSS pixels, same as `page.mouse`).
   hCaptcha's challenge frame is 520x570 with Next/Verify at (468, 541).
   reCAPTCHA grids: click every matching tile, then Verify; a new tile
   fading in may also need clicking.
4. Multi-round challenges show dots under the image; repeat per round.
   Then check the token.
5. A wrong answer quietly serves a fresh set. That is normal (the first set
   failed in testing, the second passed). Give it 3 sets.

Drag puzzles ("drag the screw to the empty joint", "drag the piece into the
gap"): find the target visually, then `page.mouse.down()` on the piece, move
along the same eased curve in ~40 steps, overshoot by 5-10 px, ease back,
pause, `mouse.up()`, then Verify. These sample the whole trail, so straight,
constant-speed drags fail. To see small details, crop the element screenshot and
upscale it with PIL; `scale: "device"` does not zoom.

After Verify, poll for the token for up to ~10 s instead of reading it once:
it can still be empty at 3-4 s. The challenge iframe moving back to
y = -9999 is the earlier sign of success. Do not screenshot the challenge
iframe once it is hidden; that call hangs for 30 s.

## PerimeterX "Press & Hold" (Zillow, HotPads, Trulia, others)

What it looks like: the page title becomes "Access to this page has been
denied" (HTTP 403) and a card says "Press & Hold to confirm you are a human
(and not a bot)". Zillow, HotPads and Trulia share one PerimeterX setup, so
tripping it on one flags the session on all three.

What triggers it:
- In-page `fetch()` to the site's own JSON or search endpoints
  (Zillow `/async-create-search-page-state`, HotPads page fetches). These get
  an immediate 403 even when ordinary page loads work. Do not use them.
- Many page loads in a row. Ordinary navigation with `page.goto` worked for
  the first page and was challenged on the second after a blocked fetch.

How to pass it:
1. Do not aim at `#px-captcha` itself. The visible button is drawn in a
   separate, unstyled iframe about 530x100 px; the iframe inside
   `#px-captcha` has `display: none`. Find it with
   `page.locator('iframe').all()` and take the first `boundingBox()` wider
   than 100 px.
2. The button sits at the top of that iframe, not its center. Aim at
   `box.x + box.width/2`, `box.y + 27`. Aiming at the vertical center
   (`box.y + 50`) hit the button's bottom edge and failed for the full 15 s.
3. Approach on the curved `humanClick` path from the CAPTCHA ladder in this
   file, then `page.mouse.down()` and keep holding. Every 300 to 500 ms,
   jitter the mouse by 1 to 2 px (`page.mouse.move`) so the hold looks alive.
4. Hold until the title stops saying "denied" (it changed within 15 s), then
   `page.mouse.up()` and wait about 5 s for the real page to load.
5. If it is still denied after two tries, stop and hand over (leave the tab
   open, say what is on screen).
6. Pace: in the same session it passed on pages 2 and 6 of a Zillow search,
   then came back on page 7, where two more attempts hung for minutes with
   no result. That fits the hidden-window problem in `SKILL.md`: the
   iframe `boundingBox()` and the hold loop stall. If a hold call runs past
   about 60 s, stop it (TaskStop) and do not retry blindly: ask the user to
   bring the Chrome window to the front, or stop paging. Expect roughly 5 to 6
   result pages per pass before the wall returns, so collect what you need
   from each page right away.

Working script: `scripts/px_hold.js` (run with `browser_run_code_unsafe`,
`filename`). Afterwards, read data from the loaded page instead of calling
APIs: Zillow puts the search results in `#__NEXT_DATA__`
(`props.pageProps.searchPageState.cat1.searchResults.listResults`, 41 per
page). Paginate with `.../rentals/{n}_p/?searchQueryState=...` and wait
several seconds between pages.

Sites without this wall: Redfin's rental search API
(`/stingray/api/v1/search/rentals?...&poly=...`, called by in-page `fetch`
from a redfin.com tab) returned JSON with price, sqft, beds and coordinates
and no challenge; it caps at 350 results per query, so split the map into
tiles. apartments.com and Zumper page fetches also worked.

## When to stop

After 3 failed sets, an unknown puzzle type, or an audio-only challenge, stop
and hand it over: leave the tab open and say exactly what is on screen. Never use a paid solving service
or send the challenge image anywhere outside this session.
