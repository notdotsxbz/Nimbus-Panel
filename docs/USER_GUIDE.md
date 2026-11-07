# User Guide (Customers)

## Logging in

Open the panel URL. There is one login page for everyone — admins and customers.
Use the email/username and password your provider gave you. Forgot it? Contact support.

## Install the app (PWA)

- **Android (Chrome):** menu ⋮ → *Install app* / *Add to Home screen*
- **iPhone (Safari):** Share → *Add to Home Screen*
- **Desktop:** install icon in the address bar

NIMBUS then runs standalone, full-screen, on every device. No private data is cached
offline; service controls require a connection (the panel never pretends otherwise).

## Dashboard

Your dashboard shows active/offline services, total RAM and upcoming expirations.
Every service card shows name, type, status, domain, resources and expiration.

## Managing a service

Open a service → **Manage**:

- **Start / Stop / Restart** — one tap, with real node confirmation
- **Reinstall** — wipes data; you must confirm and are advised to back up first
- **Overview** — connection details (domain, IP, port) with copy buttons
- **Console** — live output, command input, copy log, full screen, mobile-friendly
- **Files** — your service's file space, streamed through the node agent
- **Backups** — create a snapshot any time; restore is verified and staged

## Domains

**My Domains → Add domain**: point the TXT record shown at your DNS provider, press
**Verify**. Once verified, map the domain to a service. Every service also gets a
free Nimbus subdomain automatically — no purchase needed.

## Backups with Google Drive

Dashboard → **Backups → Connect Google Drive** and pick a folder. Scheduled backups,
retention and restore are managed from the same page.

## Teams

Invite subusers with scoped permissions (console, files, backups, view-only) from
your account page. They can never exceed what your plan allows.

## Appearance

**Account → Appearance** (if your provider allows it):

- **Theme** — choose from the themes your administrator published; your choice
  follows your account on every device.
- **Color mode** — Light, Dark or System (follows your device).
- **Animations** — on/off, reduced motion, and a preset if permitted.

If your administrator disabled customization you'll see the panel default
instead. Reduced motion and your OS's `prefers-reduced-motion` setting always
minimize animation.

## Low Bandwidth Mode

Sidebar bottom → **Low Bandwidth Mode**: disables blur/animations and slows graph
refreshes — ideal on slow connections and older devices.
