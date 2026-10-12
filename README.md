# Trailbook

Installable web app (PWA) that maps everywhere you went on a trip. Data stays on the phone (IndexedDB).

## Put it online (GitHub Pages, ~5 min)
GPS and "Install app" both require HTTPS.
1. github.com → New repository → `trailbook`, Public.
2. "uploading an existing file" → drag in everything from this folder.
3. Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.
4. On the Pixel, open `https://<username>.github.io/trailbook/` in Chrome → ⋮ → **Install app**.

## Load the Vilnius days
1. Pixel: Settings → Location → Location services → **Timeline** → **Export Timeline data** → save `Timeline.json`.
2. Trailbook → **Import** → pick `Timeline.json`. Only points inside the trip dates are kept (Vilnius is preset to Oct 10–12; tap **Edit** to change).
GPX files from any tracker app import the same way.

## Using it
- **Record**: live GPS while the app is open and the screen is on. Points under ±50 m accuracy only.
- **Day chips**: tap one to show only that day, tap others to add them back.
- **Export**: GPX of the whole trip (works in Google Earth, Strava, OsmAnd).
- **New**: separate trip (e.g. Scotland). Map tiles you've viewed are cached for offline use.

## Limits of the web version
Chrome stops GPS when the screen is off or the app is in the background. Fill gaps with a Timeline import at the end of each day.

## Path to a native Android app
Same code, wrapped with Capacitor:
```
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor-community/background-geolocation
npx cap init Trailbook com.ben.trailbook --web-dir .
npx cap add android && npx cap open android
```
Then swap `navigator.geolocation.watchPosition` in `app.js` for the background-geolocation plugin's `addWatcher` to record with the screen off.
