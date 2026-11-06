# Build Shop Kiosk: shared server setup

One shared service keeps every store's availability settings and suggestions apart.
The kiosk page stays on GitHub Pages; only this API runs on Render.

1. In Render: New + > Blueprint > connect `hschatteles/buildshop-kiosk`. It reads `render.yaml`.
2. When asked, enter `BSK_STORE_PIN` and `BSK_REGIONAL_PIN` (never put PINs in the repo).
3. Once deployed, copy the service address (https://....onrender.com).
4. In `index.html`, set `const API_BASE = '<that address>';` and push.
5. On each kiosk, open the site once and pick its store (or use `?store=dallas`).

To give a store its own PIN later, add `BSK_STORE_PINS` in Render, e.g. {"dallas":"1234"}.
Stores: minneapolis, minnetonka, wilmington, columbia, scottsdale, dallas, westpalmbeach.
