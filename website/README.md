# Ping — Marketing Site

A static landing page (plain HTML/CSS/JS, no build step) for Ping.

## Preview locally

```
cd website
python3 -m http.server 8080
```

Then open http://localhost:8080

## Deploy

This is a static site — deploy it anywhere:

- **Vercel**: `vercel deploy` from this folder, or drag-and-drop the `website/` folder in the Vercel dashboard.
- **Netlify**: drag-and-drop the `website/` folder, or connect this repo and set the base directory to `website`.
- **Custom domain**: point `useping.me` at whichever host you pick.

## What's wired up, what's not

- **Meta Pixel**: base code is in `index.html`, commented out. Replace `YOUR_PIXEL_ID` and uncomment once you have it.
- **UTM/fbclid capture**: `script.js` already captures `utm_*` and `fbclid` params into `sessionStorage` on page load, ready to attach to a Stripe Checkout Session later.
- **Pricing buttons**: currently placeholders (`data-plan="monthly"` / `"yearly"`). They'll call a Stripe Checkout Session endpoint on the Railway backend once that's built — see the main repo's `src/` for that work.

## Editing the WhatsApp mockup conversations

Message content for every chat mockup lives in `script.js` at the top, in the `THREADS` object — edit that to change copy, add a new feature thread, etc. Each feature section's phone references a thread by `data-thread="key"` in `index.html`.
