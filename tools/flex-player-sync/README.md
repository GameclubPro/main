# FlexPlayerSync

Paper plugin that sends player snapshots to the FlexCraft website backend.

## What It Sends

- Minecraft nickname and UUID
- online/offline state
- world, coordinates, yaw and pitch
- inventory, ender chest and equipment
- basic stats: health, food, level, play time, deaths and kills

The plugin only sends snapshots. It does not restore or edit player inventory.

## Build

Use Java 21 and Maven:

```powershell
cd tools\flex-player-sync
mvn package
```

The jar will be created at:

```text
target\FlexPlayerSync-1.0.0.jar
```

## Server Install

1. Copy `FlexPlayerSync-1.0.0.jar` to the Minecraft server `plugins` folder.
2. Restart the Minecraft server once so `plugins/FlexPlayerSync/config.yml` is created.
3. Set the same secret token in two places:
   - backend environment: `GAME_API_TOKEN=...`
   - plugin config: `api-token: "..."`
4. Restart the backend API and the Minecraft server.

Default API URL:

```yaml
api-url: "https://flex-craft.ru/api/game/player/snapshot"
```

Admin commands:

```text
/flexsync push
/flexsync reload
```
