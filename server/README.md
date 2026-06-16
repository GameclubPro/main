# FlexCraft Auth Server

Production API for FlexCraft accounts.

## Environment

Copy `.env.example` to `/etc/flexcraft-auth.env` on the VM and set:

- `AUTH_COOKIE_SECRET` to a long random value.
- `SMTP_*` when real email delivery is ready.
- `PUBLIC_ORIGIN=https://flex-craft.ru`.

Without SMTP settings verification links are written to the server log. This is useful only for setup.

## Run

```powershell
cd server
npm install
npm start
```

The API listens on `127.0.0.1:3088` by default and should be proxied by nginx under `/api/`.
