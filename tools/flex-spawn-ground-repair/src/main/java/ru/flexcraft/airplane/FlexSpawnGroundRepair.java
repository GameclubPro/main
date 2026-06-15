package ru.flexcraft.airplane;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;

public final class FlexSpawnGroundRepair extends JavaPlugin {
  private static final String WORLD_NAME = "world";

  private static final int CENTER_X = 2744;
  private static final int CENTER_Z = 2744;
  private static final int RADIUS_X = 92;
  private static final int RADIUS_Z = 92;
  private static final int MIN_Y = 48;
  private static final int SURFACE_Y = 83;
  private static final int CLEAR_TO_Y = 145;

  @Override
  public void onEnable() {
    Path doneMarker = getDataFolder().toPath().resolve("done.txt");
    if (Files.exists(doneMarker)) {
      getLogger().info("Ground under airplane spawn is already repaired; skipping.");
      Bukkit.getPluginManager().disablePlugin(this);
      return;
    }

    World world = Bukkit.getWorld(WORLD_NAME);
    if (world == null) {
      getLogger().severe("World '" + WORLD_NAME + "' is not loaded.");
      Bukkit.getPluginManager().disablePlugin(this);
      return;
    }

    loadRepairChunks(world);
    getLogger().info("Repairing terrain under airplane spawn...");
    new RepairTask(world, doneMarker).runTaskTimer(this, 1L, 1L);
  }

  private void loadRepairChunks(World world) {
    for (int chunkX = Math.floorDiv(CENTER_X - RADIUS_X, 16); chunkX <= Math.floorDiv(CENTER_X + RADIUS_X, 16); chunkX += 1) {
      for (int chunkZ = Math.floorDiv(CENTER_Z - RADIUS_Z, 16); chunkZ <= Math.floorDiv(CENTER_Z + RADIUS_Z, 16); chunkZ += 1) {
        world.getChunkAt(chunkX, chunkZ).load(true);
      }
    }
  }

  private final class RepairTask extends BukkitRunnable {
    private static final int COLUMNS_PER_TICK = 180;

    private final World world;
    private final Path doneMarker;
    private int x = CENTER_X - RADIUS_X;
    private int z = CENTER_Z - RADIUS_Z;

    private RepairTask(World world, Path doneMarker) {
      this.world = world;
      this.doneMarker = doneMarker;
    }

    @Override
    public void run() {
      int processed = 0;
      while (processed < COLUMNS_PER_TICK && x <= CENTER_X + RADIUS_X) {
        repairColumn(world, x, z);
        processed += 1;

        z += 1;
        if (z > CENTER_Z + RADIUS_Z) {
          z = CENTER_Z - RADIUS_Z;
          x += 1;
        }
      }

      if (x <= CENTER_X + RADIUS_X) {
        return;
      }

      cancel();
      writeMarker(doneMarker);
      world.save();
      getLogger().info("Ground under airplane spawn repaired.");
      Bukkit.getPluginManager().disablePlugin(FlexSpawnGroundRepair.this);
    }
  }

  private void repairColumn(World world, int x, int z) {
    int dx = x - CENTER_X;
    int dz = z - CENTER_Z;
    double normalized = (dx * dx) / (double) (RADIUS_X * RADIUS_X) + (dz * dz) / (double) (RADIUS_Z * RADIUS_Z);
    if (normalized > 1.0) {
      return;
    }

    double ridge = Math.sin((x + 31) * 0.075) * 2.0 + Math.cos((z - 17) * 0.065) * 2.0;
    int surfaceY = SURFACE_Y + (int) Math.round(ridge);

    for (int y = MIN_Y; y <= CLEAR_TO_Y; y += 1) {
      Material material;
      if (y > surfaceY) {
        material = Material.AIR;
      } else if (y == surfaceY) {
        material = Material.GRASS_BLOCK;
      } else if (y >= surfaceY - 4) {
        material = Material.DIRT;
      } else {
        material = Material.STONE;
      }

      Block block = world.getBlockAt(x, y, z);
      block.setType(material, false);
    }
  }

  private void writeMarker(Path doneMarker) {
    try {
      Files.createDirectories(doneMarker.getParent());
      Files.writeString(
          doneMarker,
          "repaired=" + Instant.now() + "\n"
              + "area=world " + CENTER_X + " " + CENTER_Z + " radius " + RADIUS_X + "x" + RADIUS_Z + "\n"
              + "surfaceY=" + SURFACE_Y + "\n");
    } catch (IOException error) {
      getLogger().warning("Could not write done marker: " + error.getMessage());
    }
  }
}
