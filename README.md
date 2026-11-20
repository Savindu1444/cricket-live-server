# Cricket Live Server

One central server for scoring, live pages and OBS / vMix overlays.
Needs only **Node.js 18 or newer**. No install step, no packages.

## What's new: central database
- **Matches are saved on the server.** Create or score a match on any device (phone, laptop, another computer) and it appears on every other device that opens the same server address. Open the address on a new computer and all matches are already there.
- **Every match has its own overlay links.** Two matches can be on air at the same time and never share a scoreboard. Open a match, go to the **Broadcast** tab, and copy its links.
- Teams and players are shared too.
- If the server is unreachable, the scoring page keeps working and saves on the device; it uploads everything when the server is back.

## Run on your own computer
    node server.js
(Windows: double-click `start.bat`.) Open `http://localhost:4000/`.
Matches are saved in the `data` folder next to `server.js`.

## Run online for free (Render + Upstash)
Render's free plan wipes its disk on every restart, so use a free **Upstash Redis** database to keep the matches:

1. Sign up at upstash.com -> **Create Database** (Redis), pick the closest region, plan **Free**.
2. On the database page open the **REST API** section and copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**.
3. On Render open your service -> **Environment** -> **Add Environment Variable**, and add:
   - `UPSTASH_REDIS_REST_URL` = the URL
   - `UPSTASH_REDIS_REST_TOKEN` = the token
   - `EDIT_PASSWORD` = a password you choose (recommended, see below)
4. Save. Render redeploys. The log should say `Database: upstash (online)`.

If the Upstash settings are wrong, the server refuses to start (so nothing is overwritten) and the log says why.

## Password (recommended when online)
Set `EDIT_PASSWORD` and only people who know it can create, change or delete matches and settings. Viewers (live pages, overlays) never need it. The scoring page asks for the password once per device. Without `EDIT_PASSWORD`, anyone with the link can edit matches.

## OBS Studio
1. Open the match in the scoring page -> **Broadcast** tab.
2. Sources -> **+** -> **Browser**. URL: one of that match's overlay links, for example
   `https://your-server/overlay/<match id>/scoreboard`
3. Width/Height: `1920` x `1080`. Leave the custom CSS box empty. The background is transparent.
4. Tick **Refresh browser when scene becomes active**.
5. Add each graphic as its own source and show/hide it in OBS.

## vMix
Add Input -> **Web Browser**, URL = one overlay link, size 1920x1080. One input per graphic.
Live score values for vMix Data Sources: `/api/fields.json?m=<match id>` (values appear while that match is open in a scoring page).

## One link per graphic (per match)
    /overlay/<match id>/scoreboard          /overlay/<match id>/target (chase)      /overlay/<match id>/partner
    /overlay/<match id>/batter              /overlay/<match id>/bowler
    /overlay/<match id>/matchsum            /overlay/<match id>/result              /overlay/<match id>/custom
    /overlay/<match id>/batcard?inn=1..4    /overlay/<match id>/bowlcard?inn=1..4   /overlay/<match id>/inningsum?inn=1..4
    /overlay/<match id>/wagon?inn=1..4      /overlay/<match id>/zones?inn=1..4

Options (add to any link, e.g. `?size=1280x720&c1=0b2a4a`):
`size=1280x720` · `c1=` main colour (hex, no #) · `c2=` accent colour · `batter=Name` · `bowler=Name` · `wagon=Name` or `wagon=*` · `bg=green` (chroma key background)

Overlay links keep working when the scoring page is closed: they read the match from the server. Colours and size follow the Broadcast tab (remembered per match) unless you put them in the link.
The old links without a match id (`/overlay/scoreboard`) still work and show whichever match was last open in a scoring page.

## Public pages (no sign-in)
    /live            list of live and recent matches
    /live/<id>       live score page for one match

## Notes
- Two people scoring the *same* match at once is possible: both sets of balls are kept and merged. One scorer per match is still the safest.
- Free Render sleeps after about 15 minutes without visitors; the first visit afterwards takes about a minute. Matches are safe in Upstash meanwhile.
- Upstash free plan (checked Nov 2026): 500K commands per month, 250 MB. A T20 match uses well under a thousand commands.
- Other settings: `PORT=5000 node server.js`, `HOST=127.0.0.1` (this computer only), `DATA_DIR=/some/folder` (where the local database file goes).
