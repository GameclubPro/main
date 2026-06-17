# FlexCraft Auth Server

Production API for FlexCraft social login and launcher linking.

## Environment

Copy `.env.example` to `/etc/flexcraft-auth.env` on the VM and set:

- `AUTH_COOKIE_SECRET` to a long random value.
- `PUBLIC_ORIGIN=https://flex-craft.ru`.
- `VK_CLIENT_ID` from the VK ID app.
- `VK_CLIENT_SECRET` from the VK ID app if it is issued for the app.
- `VK_REDIRECT_URI=https://flex-craft.ru/api/auth/vk/callback`.
- `TELEGRAM_CLIENT_ID` from BotFather OpenID Connect Login.
- `TELEGRAM_CLIENT_SECRET` from BotFather OpenID Connect Login.
- `TELEGRAM_REDIRECT_URI=https://flex-craft.ru/api/auth/telegram/callback`.

The VK ID app must allow the same redirect URI.
The Telegram bot must have OpenID Connect Login enabled and allow the same Telegram redirect URI.

## Run

```powershell
cd server
npm install
npm start
```

The API listens on `127.0.0.1:3088` by default and should be proxied by nginx under `/api/`.
