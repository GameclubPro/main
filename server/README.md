# FlexCraft Auth Server

Production API for FlexCraft social login and launcher linking.

## Environment

Copy `.env.example` to `/etc/flexcraft-auth.env` on the VM and set:

- `AUTH_COOKIE_SECRET` to a long random value.
- `PUBLIC_ORIGIN=https://flex-craft.ru`.
- `VK_CLIENT_ID` from the VK ID app.
- `VK_CLIENT_SECRET` from the VK ID app if it is issued for the app.
- `VK_REDIRECT_URI=https://flex-craft.ru/api/auth/vk/callback`.

The VK ID app must allow the same redirect URI.

## Run

```powershell
cd server
npm install
npm start
```

The API listens on `127.0.0.1:3088` by default and should be proxied by nginx under `/api/`.
