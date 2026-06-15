# FlexCraft Launcher

Desktop Minecraft launcher with a minimal local test auth flow for offline or test server entry.

## Recommended Environment

For Electron work, use the project from Windows instead of WSL:

```text
C:\Projects\minecraft-launcher-win
```

Use Node.js 22 LTS or newer. Node.js 20 also works if it is `20.19.0` or newer.

## Work From Another PC

The project is meant to be moved through source control or a clean source archive. Do not copy
`node_modules`, `dist`, `dist-electron`, `dist-lean`, or `release`; those folders are generated again
on each machine.

### Option 1: Git

On the first PC:

```powershell
git init
git add .
git commit -m "Initial FlexCraft launcher project"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```

On the second PC:

```powershell
git clone <your-repository-url> C:\Projects\minecraft-launcher-win
cd C:\Projects\minecraft-launcher-win
.\setup-windows.cmd
.\run-windows.cmd
```

### Option 2: Source Archive

On the first PC:

```powershell
npm run archive:source
```

Copy `flexcraft-launcher-source-<version>.zip` to the second PC, unzip it, then run:

```powershell
.\setup-windows.cmd
.\run-windows.cmd
```

## First Run on Windows

Open `PowerShell` or `cmd` in `C:\Projects\minecraft-launcher-win` and run:

```powershell
.\setup-windows.cmd
```

This will:

- install dependencies
- build the renderer and Electron bundles
- clear the `ELECTRON_RUN_AS_NODE` issue for the current run

## Run the Launcher on Windows

```powershell
.\run-windows.cmd
```

## Package a Windows Download

```powershell
npm run package:win
```

This creates a Windows installer in `release/FlexCraft-Installer-<version>-win-x64.exe`.
It also creates a portable fallback in `release/FlexCraft-Launcher-<version>-portable-win-x64.exe`.
Publish the installer for players instead of `setup-windows.cmd`.

## Development

```bash
npm ci
npm run dev
```

## Scripts

- `npm run dev` - start Vite and Electron in development mode.
- `npm run build` - typecheck and build renderer and Electron bundles.
- `npm run archive:source` - create a clean source ZIP for moving the project to another PC.
- `npm run package:win` - build the app and create installer, portable, and ZIP Windows artifacts.
- `npm run preview` - preview the built renderer.
- `npm run lint` - run TypeScript checks without emitting files.

## What to Keep Out of Git

These files and folders are generated or local-only:

- `node_modules`
- `dist`
- `dist-electron`
- `dist-lean`
- `release`
- local `.env` files
- packaged archives, installers, and temporary transfer files
