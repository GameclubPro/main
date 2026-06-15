package ru.flexcraft.airplane;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;

public final class FlexAirplaneSpawnInstaller extends JavaPlugin {
  private static final String WORLD_NAME = "world";

  private static final int OLD_X = 2744;
  private static final int OLD_Y_MIN = 48;
  private static final int OLD_Y_MAX = 136;
  private static final int OLD_Z = 2744;
  private static final int OLD_RADIUS = 84;

  private static final int PLANE_X = 2744;
  private static final int PLANE_FLOOR_Y = 186;
  private static final int PLANE_Z = 2744;

  private final BlockData air = Bukkit.createBlockData(Material.AIR);

  @Override
  public void onEnable() {
    Path doneMarker = getDataFolder().toPath().resolve("done.txt");
    if (Files.exists(doneMarker)) {
      getLogger().info("Airplane spawn is already installed; skipping.");
      Bukkit.getPluginManager().disablePlugin(this);
      return;
    }

    World world = Bukkit.getWorld(WORLD_NAME);
    if (world == null) {
      getLogger().severe("World '" + WORLD_NAME + "' is not loaded.");
      Bukkit.getPluginManager().disablePlugin(this);
      return;
    }

    prepareChunks(world);
    getLogger().info("Building airplane spawn...");
    new InstallTask(world, doneMarker).runTaskTimer(this, 1L, 1L);
  }

  private void prepareChunks(World world) {
    loadChunkRange(world, OLD_X - OLD_RADIUS, OLD_Z - OLD_RADIUS, OLD_X + OLD_RADIUS, OLD_Z + OLD_RADIUS);
    loadChunkRange(world, PLANE_X - 48, PLANE_Z - 40, PLANE_X + 48, PLANE_Z + 40);
  }

  private void loadChunkRange(World world, int minX, int minZ, int maxX, int maxZ) {
    for (int chunkX = Math.floorDiv(minX, 16); chunkX <= Math.floorDiv(maxX, 16); chunkX += 1) {
      for (int chunkZ = Math.floorDiv(minZ, 16); chunkZ <= Math.floorDiv(maxZ, 16); chunkZ += 1) {
        world.getChunkAt(chunkX, chunkZ).load(true);
      }
    }
  }

  private final class InstallTask extends BukkitRunnable {
    private static final int BLOCKS_PER_TICK = 24000;

    private final World world;
    private final Path doneMarker;
    private boolean installed;

    private InstallTask(World world, Path doneMarker) {
      this.world = world;
      this.doneMarker = doneMarker;
    }

    @Override
    public void run() {
      if (installed) {
        return;
      }
      installed = true;

      cancel();
      buildAirplane(world);
      setNewSpawn(world);
      writeMarker(doneMarker);
      world.save();
      getLogger().info("Airplane spawn installed at " + PLANE_X + " " + (PLANE_FLOOR_Y + 1) + " " + PLANE_Z + ".");
      Bukkit.getPluginManager().disablePlugin(FlexAirplaneSpawnInstaller.this);
    }
  }

  private void buildAirplane(World world) {
    clearAirspace(world);
    buildFuselage(world);
    buildWings(world);
    buildTail(world);
    buildEngines(world);
    buildInterior(world);
    buildSpawnPad(world);
  }

  private void clearAirspace(World world) {
    fill(world, -46, -10, -38, 46, 18, 38, Material.AIR);
  }

  private void buildFuselage(World world) {
    Material shell = Material.WHITE_CONCRETE;
    Material trim = Material.LIGHT_GRAY_CONCRETE;
    Material glass = Material.LIGHT_BLUE_STAINED_GLASS;

    for (int dx = -34; dx <= 34; dx += 1) {
      int halfWidth = dx > 28 ? Math.max(1, 4 - (dx - 28)) : 4;
      int top = dx > 30 ? 4 : 5;
      for (int dz = -halfWidth; dz <= halfWidth; dz += 1) {
        set(world, dx, 0, dz, shell);
        set(world, dx, top, dz, shell);
      }
      for (int dy = 1; dy < top; dy += 1) {
        set(world, dx, dy, -halfWidth, shell);
        set(world, dx, dy, halfWidth, shell);
      }
    }

    for (int dx = -33; dx <= 27; dx += 5) {
      set(world, dx, 3, -4, glass);
      set(world, dx, 3, 4, glass);
    }

    fill(world, 30, 2, -2, 35, 4, 2, glass);
    set(world, 36, 1, 0, trim);
    set(world, 36, 2, 0, trim);
    set(world, 36, 3, 0, trim);

    fill(world, -35, 1, -3, -35, 4, 3, shell);
    fill(world, -36, 2, -2, -36, 3, 2, trim);
    set(world, -37, 2, 0, trim);
  }

  private void buildWings(World world) {
    Material wing = Material.LIGHT_GRAY_CONCRETE;
    Material edge = Material.WHITE_CONCRETE;
    Material red = Material.RED_CONCRETE;

    for (int dx = -12; dx <= 11; dx += 1) {
      int reach = 33 - Math.abs(dx);
      for (int dz = -reach; dz <= reach; dz += 1) {
        if (Math.abs(dz) <= 4) {
          continue;
        }
        set(world, dx, -1, dz, wing);
      }
    }

    for (int dz = -32; dz <= 32; dz += 1) {
      set(world, -12, -1, dz, edge);
      set(world, 11, -1, dz, edge);
    }
    fill(world, -2, 0, -34, 5, 0, -31, red);
    fill(world, -2, 0, 31, 5, 0, 34, red);
  }

  private void buildTail(World world) {
    Material wing = Material.LIGHT_GRAY_CONCRETE;
    Material red = Material.RED_CONCRETE;

    for (int dx = -37; dx <= -25; dx += 1) {
      int reach = 15 - Math.abs(dx + 31);
      for (int dz = -reach; dz <= reach; dz += 1) {
        if (Math.abs(dz) > 4) {
          set(world, dx, 4, dz, wing);
        }
      }
    }

    for (int dy = 5; dy <= 14; dy += 1) {
      int length = Math.max(1, 15 - dy);
      fill(world, -35, dy, 0, -35 + length, dy, 0, red);
      fill(world, -34, dy, -1, -34 + Math.max(0, length - 2), dy, 1, wing);
    }
  }

  private void buildEngines(World world) {
    buildEngine(world, -2, -4, -19);
    buildEngine(world, -2, -4, 19);
  }

  private void buildEngine(World world, int centerDx, int centerDy, int centerDz) {
    for (int dx = -5; dx <= 5; dx += 1) {
      for (int dy = -2; dy <= 2; dy += 1) {
        for (int dz = -2; dz <= 2; dz += 1) {
          if (dy * dy + dz * dz <= 5) {
            set(world, centerDx + dx, centerDy + dy, centerDz + dz, Material.LIGHT_GRAY_CONCRETE);
          }
        }
      }
    }
    fill(world, centerDx + 6, centerDy - 1, centerDz - 1, centerDx + 6, centerDy + 1, centerDz + 1, Material.BLACK_CONCRETE);
    fill(world, centerDx - 6, centerDy - 1, centerDz - 1, centerDx - 6, centerDy + 1, centerDz + 1, Material.GRAY_CONCRETE);
  }

  private void buildInterior(World world) {
    Material floor = Material.SMOOTH_QUARTZ;
    Material carpet = Material.BLUE_CARPET;
    Material light = Material.SEA_LANTERN;

    fill(world, -30, 1, -2, 24, 1, 2, Material.AIR);
    fill(world, -30, 2, -3, 24, 4, 3, Material.AIR);
    fill(world, -30, 0, -2, 24, 0, 2, floor);

    for (int dx = -26; dx <= 20; dx += 4) {
      set(world, dx, 1, -2, Material.BLUE_WOOL);
      set(world, dx, 1, 2, Material.BLUE_WOOL);
      set(world, dx, 5, 0, light);
    }
    fill(world, -2, 1, 0, 2, 1, 0, carpet);
  }

  private void buildSpawnPad(World world) {
    fill(world, -4, 0, -4, 4, 0, 4, Material.SMOOTH_QUARTZ);
    fill(world, -3, 1, -3, 3, 1, 3, Material.AIR);
    fill(world, -2, 1, -2, 2, 1, 2, Material.CYAN_CARPET);
    set(world, 0, 1, 0, Material.AIR);
    set(world, 0, 2, 0, Material.AIR);
    set(world, 0, 5, 0, Material.SEA_LANTERN);
    fill(world, -4, 1, -4, 4, 3, -4, Material.LIGHT_BLUE_STAINED_GLASS);
    fill(world, -4, 1, 4, 4, 3, 4, Material.LIGHT_BLUE_STAINED_GLASS);
  }

  private void setNewSpawn(World world) {
    Location spawn = new Location(world, PLANE_X + 0.5, PLANE_FLOOR_Y + 1.0, PLANE_Z + 0.5, 90.0f, 0.0f);
    world.setSpawnLocation(spawn);
    try {
      world.setGameRule(GameRule.SPAWN_RADIUS, 0);
    } catch (RuntimeException error) {
      getLogger().log(Level.WARNING, "Could not set spawn radius game rule.", error);
    }
  }

  private void writeMarker(Path doneMarker) {
    try {
      Files.createDirectories(doneMarker.getParent());
      Files.writeString(
          doneMarker,
          "installed=" + Instant.now() + "\n"
              + "groundCleared=false\n"
              + "spawn=world " + PLANE_X + " " + (PLANE_FLOOR_Y + 1) + " " + PLANE_Z + "\n");
    } catch (IOException error) {
      getLogger().log(Level.WARNING, "Could not write done marker.", error);
    }
  }

  private void fill(World world, int minDx, int minDy, int minDz, int maxDx, int maxDy, int maxDz, Material material) {
    int minX = Math.min(minDx, maxDx);
    int maxX = Math.max(minDx, maxDx);
    int minY = Math.min(minDy, maxDy);
    int maxY = Math.max(minDy, maxDy);
    int minZ = Math.min(minDz, maxDz);
    int maxZ = Math.max(minDz, maxDz);

    for (int dx = minX; dx <= maxX; dx += 1) {
      for (int dy = minY; dy <= maxY; dy += 1) {
        for (int dz = minZ; dz <= maxZ; dz += 1) {
          set(world, dx, dy, dz, material);
        }
      }
    }
  }

  private void set(World world, int dx, int dy, int dz, Material material) {
    Block block = world.getBlockAt(PLANE_X + dx, PLANE_FLOOR_Y + dy, PLANE_Z + dz);
    block.setType(material, false);
  }
}
