package ru.flexcraft.airplane;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.GameMode;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabExecutor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.FoodLevelChangeEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.util.Vector;

public final class FlexAirplaneSpawnGuard extends JavaPlugin implements Listener, TabExecutor {
  private static final String WORLD_NAME = "world";

  private static final int SPAWN_BLOCK_X = 2744;
  private static final int SPAWN_BLOCK_Y = 187;
  private static final int SPAWN_BLOCK_Z = 2744;

  private static final int OLD_SPAWN_X = 2744;
  private static final int OLD_SPAWN_Z = 2744;
  private static final int OLD_SPAWN_RADIUS = 96;

  private static final int PLANE_CENTER_X = 2744;
  private static final int PLANE_CENTER_Z = 2744;
  private static final int PLANE_MIN_Y = 170;
  private static final int PLANE_MAX_Y = 211;
  private static final int PLANE_RADIUS_X = 56;
  private static final int PLANE_RADIUS_Z = 44;

  private static final int FALL_TRACK_RADIUS_X = 70;
  private static final int FALL_TRACK_RADIUS_Z = 58;
  private static final int FALL_TRIGGER_BLOCKS_BELOW_PLANE = 1;
  private static final int FALL_BACKUP_BLOCKS_ABOVE_GROUND = 30;
  private static final int RANDOM_TELEPORT_MIN_RADIUS = 350;
  private static final int RANDOM_TELEPORT_MAX_RADIUS = 1800;

  private final Random random = new Random();
  private final Map<UUID, Long> protectedUntil = new HashMap<>();
  private final Set<UUID> airplaneFallers = new HashSet<>();

  @Override
  public void onEnable() {
    Bukkit.getPluginManager().registerEvents(this, this);

    World world = Bukkit.getWorld(WORLD_NAME);
    if (world != null) {
      world.setSpawnLocation(spawnLocation(world));
      try {
        world.setGameRule(GameRule.SPAWN_RADIUS, 0);
      } catch (RuntimeException error) {
        getLogger().warning("Could not set spawn radius: " + error.getMessage());
      }
    }

    registerCommands();
    Bukkit.getScheduler().runTaskTimer(this, this::checkFallingPlayers, 10L, 1L);
    getLogger().info("Airplane spawn guard enabled at " + SPAWN_BLOCK_X + " " + SPAWN_BLOCK_Y + " " + SPAWN_BLOCK_Z + ".");
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    String name = command.getName().toLowerCase(Locale.ROOT);
    return switch (name) {
      case "spawn" -> handleSpawn(sender, args);
      case "rtp" -> handleRtp(sender, args);
      case "heal" -> handleHeal(sender, args);
      case "feed" -> handleFeed(sender, args);
      case "fly" -> handleFly(sender, args);
      case "gm" -> handleGameMode(sender, args);
      case "day" -> handleTime(sender, true);
      case "night" -> handleTime(sender, false);
      case "sun" -> handleWeather(sender, false);
      case "rain" -> handleWeather(sender, true);
      case "announce" -> handleAnnounce(sender, args);
      case "admin67" -> handleAdmin67(sender, args);
      default -> false;
    };
  }

  @Override
  public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
    String name = command.getName().toLowerCase(Locale.ROOT);
    if (args.length == 0) {
      return List.of();
    }

    return switch (name) {
      case "spawn", "rtp", "heal", "feed", "fly" -> args.length == 1 ? onlinePlayerNames(args[0]) : List.of();
      case "gm" -> completeGameMode(args);
      case "admin67" -> completeAdmin67(args);
      default -> List.of();
    };
  }

  @EventHandler(priority = EventPriority.HIGHEST)
  public void onPlayerJoin(PlayerJoinEvent event) {
    Player player = event.getPlayer();
    grantProtection(player, 10_000L);

    Bukkit.getScheduler().runTaskLater(this, () -> {
      if (!player.isOnline()) {
        return;
      }

      teleportToSpawn(player);
    }, 10L);
  }

  @EventHandler(priority = EventPriority.HIGHEST)
  public void onPlayerRespawn(PlayerRespawnEvent event) {
    World world = Bukkit.getWorld(WORLD_NAME);
    if (world == null) {
      return;
    }

    event.setRespawnLocation(spawnLocation(world));
    Bukkit.getScheduler().runTaskLater(this, () -> {
      Player player = event.getPlayer();
      if (player.isOnline()) {
        stabilize(player);
        grantProtection(player, 10_000L);
      }
    }, 2L);
  }

  @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
  public void onPlayerMove(PlayerMoveEvent event) {
    Player player = event.getPlayer();
    Location to = event.getTo();
    if (to == null || !WORLD_NAME.equals(to.getWorld().getName())) {
      airplaneFallers.remove(player.getUniqueId());
      return;
    }

    if (shouldInterceptAirplaneFall(player, to)) {
      teleportRandomly(player);
      return;
    }

    if (isOnAirplane(to)) {
      stabilize(player);
      airplaneFallers.remove(player.getUniqueId());
      return;
    }

    if (isBelowAirplaneColumn(to) && player.getFallDistance() > 3.0f) {
      airplaneFallers.add(player.getUniqueId());
      if (shouldTeleportFallingPlayer(to)) {
        teleportRandomly(player);
      }
    }
  }

  @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
  public void onPlayerDamage(EntityDamageEvent event) {
    if (!(event.getEntity() instanceof Player player)) {
      return;
    }

    Location location = player.getLocation();
    if (event.getCause() == EntityDamageEvent.DamageCause.FALL
        && (airplaneFallers.contains(player.getUniqueId()) || isInAirplaneFallColumn(location))) {
      event.setCancelled(true);
      teleportRandomly(player);
      return;
    }

    if (isProtected(player) || isOnAirplane(location) || airplaneFallers.contains(player.getUniqueId())) {
      event.setCancelled(true);
      stabilize(player);
    }
  }

  @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
  public void onFoodLevelChange(FoodLevelChangeEvent event) {
    if (!(event.getEntity() instanceof Player player)) {
      return;
    }

    if (isOnAirplane(player.getLocation()) || isProtected(player)) {
      event.setCancelled(true);
      player.setFoodLevel(20);
      player.setSaturation(20.0f);
    }
  }

  private void checkFallingPlayers() {
    for (Player player : Bukkit.getOnlinePlayers()) {
      Location location = player.getLocation();
      if (!WORLD_NAME.equals(location.getWorld().getName())) {
        airplaneFallers.remove(player.getUniqueId());
        continue;
      }

      if (shouldInterceptAirplaneFall(player, location)) {
        teleportRandomly(player);
        continue;
      }

      if (isOnAirplane(location)) {
        stabilize(player);
        airplaneFallers.remove(player.getUniqueId());
        continue;
      }

      if (isBelowAirplaneColumn(location) && isFalling(player)) {
        airplaneFallers.add(player.getUniqueId());
      }

      if (!airplaneFallers.contains(player.getUniqueId())) {
        continue;
      }

      if (shouldTeleportFallingPlayer(location)) {
        teleportRandomly(player);
      }
    }
  }

  private void registerCommands() {
    for (String commandName : List.of("spawn", "rtp", "heal", "feed", "fly", "gm", "day", "night", "sun", "rain", "announce", "admin67")) {
      PluginCommand command = getCommand(commandName);
      if (command == null) {
        getLogger().warning("Command '" + commandName + "' is not declared in plugin.yml.");
        continue;
      }
      command.setExecutor(this);
      command.setTabCompleter(this);
    }
    getLogger().info("Server commands registered: /spawn, /rtp, /heal, /feed, /fly, /gm, /admin67.");
  }

  private boolean handleSpawn(CommandSender sender, String[] args) {
    if (args.length > 1) {
      sender.sendMessage("Использование: /spawn [player]");
      return true;
    }

    Player target = resolveTarget(sender, args, 0, "flex.command.admin");
    if (target == null || !canUseTargetedPlayerCommand(sender, target, "flex.command.spawn", "flex.command.admin")) {
      return true;
    }

    teleportToSpawn(target);
    if (!sender.equals(target)) {
      sender.sendMessage("Игрок " + target.getName() + " перенесен на спавн.");
    }
    return true;
  }

  private boolean handleRtp(CommandSender sender, String[] args) {
    if (args.length > 1) {
      sender.sendMessage("Использование: /rtp [player]");
      return true;
    }

    Player target = resolveTarget(sender, args, 0, "flex.command.admin");
    if (target == null || !canUseTargetedPlayerCommand(sender, target, "flex.command.rtp", "flex.command.admin")) {
      return true;
    }

    teleportRandomly(target, "Ты перенесен в случайное безопасное место.");
    if (!sender.equals(target)) {
      sender.sendMessage("Игрок " + target.getName() + " перенесен в случайное безопасное место.");
    }
    return true;
  }

  private boolean handleHeal(CommandSender sender, String[] args) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }

    Player target = resolveTarget(sender, args, 0, "flex.command.admin");
    if (target == null) {
      return true;
    }

    heal(target);
    target.sendMessage("Здоровье восстановлено.");
    if (!sender.equals(target)) {
      sender.sendMessage("Игрок " + target.getName() + " вылечен.");
    }
    return true;
  }

  private boolean handleFeed(CommandSender sender, String[] args) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }

    Player target = resolveTarget(sender, args, 0, "flex.command.admin");
    if (target == null) {
      return true;
    }

    feed(target);
    target.sendMessage("Голод восстановлен.");
    if (!sender.equals(target)) {
      sender.sendMessage("Голод игрока " + target.getName() + " восстановлен.");
    }
    return true;
  }

  private boolean handleFly(CommandSender sender, String[] args) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }

    Player target = resolveTarget(sender, args, 0, "flex.command.admin");
    if (target == null) {
      return true;
    }

    boolean enabled = !target.getAllowFlight();
    setFlight(target, enabled);
    target.sendMessage(enabled ? "Полет включен." : "Полет выключен.");
    if (!sender.equals(target)) {
      sender.sendMessage("Полет для " + target.getName() + ": " + (enabled ? "включен" : "выключен") + ".");
    }
    return true;
  }

  private boolean handleGameMode(CommandSender sender, String[] args) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }
    if (args.length < 1 || args.length > 2) {
      sender.sendMessage("Использование: /gm <survival|creative|adventure|spectator> [player]");
      return true;
    }

    GameMode gameMode = parseGameMode(args[0]);
    if (gameMode == null) {
      sender.sendMessage("Неизвестный режим: " + args[0]);
      return true;
    }

    Player target = resolveTarget(sender, args, 1, "flex.command.admin");
    if (target == null) {
      return true;
    }

    setGameMode(target, gameMode);
    target.sendMessage("Режим игры: " + gameMode.name().toLowerCase(Locale.ROOT) + ".");
    if (!sender.equals(target)) {
      sender.sendMessage("Режим " + target.getName() + ": " + gameMode.name().toLowerCase(Locale.ROOT) + ".");
    }
    return true;
  }

  private boolean handleTime(CommandSender sender, boolean day) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }

    return setTime(sender, day);
  }

  private boolean setTime(CommandSender sender, boolean day) {
    World world = commandWorld(sender);
    if (world == null) {
      sender.sendMessage("Мир не найден.");
      return true;
    }

    world.setTime(day ? 1000L : 13000L);
    sender.sendMessage(day ? "В мире установлен день." : "В мире установлена ночь.");
    return true;
  }

  private boolean handleWeather(CommandSender sender, boolean rain) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }

    return setWeather(sender, rain);
  }

  private boolean setWeather(CommandSender sender, boolean rain) {
    World world = commandWorld(sender);
    if (world == null) {
      sender.sendMessage("Мир не найден.");
      return true;
    }

    world.setStorm(rain);
    world.setThundering(false);
    world.setWeatherDuration(rain ? 12_000 : 0);
    world.setClearWeatherDuration(rain ? 0 : 24_000);
    sender.sendMessage(rain ? "Дождь включен." : "Погода очищена.");
    return true;
  }

  private boolean handleAnnounce(CommandSender sender, String[] args) {
    if (!requirePermission(sender, "flex.command.admin")) {
      return true;
    }
    if (args.length == 0) {
      sender.sendMessage("Использование: /announce <message>");
      return true;
    }

    Bukkit.broadcastMessage("[FlexCraft] " + joinArgs(args, 0));
    return true;
  }

  private boolean handleAdmin67(CommandSender sender, String[] args) {
    if (args.length == 0) {
      if (!(sender instanceof Player)) {
        sendAdmin67Help(sender);
        return true;
      }
      if (!requirePermission(sender, "flex.command.admin67")) {
        return true;
      }
      return handleAdminMode(sender, true);
    }

    if ("help".equalsIgnoreCase(args[0])) {
      sendAdmin67Help(sender);
      return true;
    }

    if (!requirePermission(sender, "flex.command.admin67")) {
      return true;
    }

    String action = args[0].toLowerCase(Locale.ROOT);
    return switch (action) {
      case "on" -> handleAdminMode(sender, true);
      case "off" -> handleAdminMode(sender, false);
      case "status" -> handleAdminStatus(sender);
      case "spawn" -> handleAdmin67PlayerAction(sender, args, "spawn");
      case "rtp" -> handleAdmin67PlayerAction(sender, args, "rtp");
      case "heal" -> handleAdmin67PlayerAction(sender, args, "heal");
      case "feed" -> handleAdmin67PlayerAction(sender, args, "feed");
      case "fly" -> handleAdmin67PlayerAction(sender, args, "fly");
      case "creative" -> handleAdmin67PlayerAction(sender, args, "creative");
      case "survival" -> handleAdmin67PlayerAction(sender, args, "survival");
      case "day" -> setTime(sender, true);
      case "night" -> setTime(sender, false);
      case "sun" -> setWeather(sender, false);
      case "rain" -> setWeather(sender, true);
      case "broadcast", "bc" -> handleAdmin67Broadcast(sender, args);
      default -> {
        sender.sendMessage("Неизвестная подкоманда admin67: " + args[0]);
        sendAdmin67Help(sender);
        yield true;
      }
    };
  }

  private boolean handleAdminMode(CommandSender sender, boolean enabled) {
    if (!(sender instanceof Player player)) {
      sender.sendMessage("Эта подкоманда доступна только игроку.");
      return true;
    }

    if (enabled) {
      enableCreativeAdmin(player);
      player.sendMessage("admin67 включен: режим как в креативе, полет, heal, feed, защита на 10 минут.");
      return true;
    }

    disableCreativeAdmin(player);
    player.sendMessage("admin67 выключен: survival и полет отключен.");
    return true;
  }

  private boolean handleAdminStatus(CommandSender sender) {
    World world = Bukkit.getWorld(WORLD_NAME);
    sender.sendMessage("FlexCraft Guard: игроков онлайн " + Bukkit.getOnlinePlayers().size() + ".");
    if (world != null) {
      sender.sendMessage("Спавн: " + WORLD_NAME + " " + SPAWN_BLOCK_X + " " + SPAWN_BLOCK_Y + " " + SPAWN_BLOCK_Z + ", чанков загружено " + world.getLoadedChunks().length + ".");
    } else {
      sender.sendMessage("Мир '" + WORLD_NAME + "' не загружен.");
    }
    return true;
  }

  private boolean handleAdmin67PlayerAction(CommandSender sender, String[] args, String action) {
    if (args.length > 2) {
      sender.sendMessage("Использование: /admin67 " + action + " [player]");
      return true;
    }

    Player target = resolveTarget(sender, args, 1, "flex.command.admin67");
    if (target == null) {
      return true;
    }

    switch (action) {
      case "spawn" -> teleportToSpawn(target);
      case "rtp" -> teleportRandomly(target, "Админ перенес тебя в случайное безопасное место.");
      case "heal" -> heal(target);
      case "feed" -> feed(target);
      case "fly" -> setFlight(target, !target.getAllowFlight());
      case "creative" -> enableCreativeAdmin(target);
      case "survival" -> disableCreativeAdmin(target);
      default -> {
        sender.sendMessage("Неизвестное действие: " + action);
        return true;
      }
    }

    sender.sendMessage("admin67 " + action + ": " + target.getName() + ".");
    if (!sender.equals(target)) {
      target.sendMessage("Админ-команда выполнена: " + action + ".");
    }
    return true;
  }

  private boolean handleAdmin67Broadcast(CommandSender sender, String[] args) {
    if (args.length < 2) {
      sender.sendMessage("Использование: /admin67 broadcast <message>");
      return true;
    }
    Bukkit.broadcastMessage("[Admin67] " + joinArgs(args, 1));
    return true;
  }

  private void sendAdmin67Help(CommandSender sender) {
    sender.sendMessage("admin67: /admin67 включает режим как в креативе. /admin67 off выключает его.");
    sender.sendMessage("admin67: /admin67 on, off, status, spawn [player], rtp [player], heal [player], feed [player], fly [player]");
    sender.sendMessage("admin67: /admin67 creative [player], survival [player], day, night, sun, rain, broadcast <message>");
    sender.sendMessage("Если /spawn занят другим плагином, используй /fspawn. Для admin67 также работает /a67.");
  }

  private void teleportToSpawn(Player player) {
    World world = Bukkit.getWorld(WORLD_NAME);
    if (world == null) {
      return;
    }

    player.teleport(spawnLocation(world));
    stabilizeAfterTeleport(player);
    grantProtection(player, 10_000L);
  }

  private void teleportRandomly(Player player) {
    teleportRandomly(player, "Падение перехвачено: тебя перенесло в случайное безопасное место.");
  }

  private void teleportRandomly(Player player, String message) {
    World world = player.getWorld();
    Location destination = findRandomSafeLocation(world);
    player.teleport(destination);
    player.sendMessage(message);
    airplaneFallers.remove(player.getUniqueId());
    stabilizeAfterTeleport(player);
    grantProtection(player, 8_000L);
  }

  private Location findRandomSafeLocation(World world) {
    Location generatedDestination = findGeneratedSafeLocation(world);
    if (generatedDestination != null) {
      return generatedDestination;
    }

    Location loadedDestination = findLoadedSafeLocation(world);
    if (loadedDestination != null) {
      return loadedDestination;
    }

    return spawnLocation(world);
  }

  private Location findGeneratedSafeLocation(World world) {
    Location spawn = spawnLocation(world);
    for (int attempt = 0; attempt < 48; attempt += 1) {
      double angle = random.nextDouble() * Math.PI * 2.0;
      int radius = RANDOM_TELEPORT_MIN_RADIUS + random.nextInt(RANDOM_TELEPORT_MAX_RADIUS - RANDOM_TELEPORT_MIN_RADIUS + 1);
      int x = spawn.getBlockX() + (int) Math.round(Math.cos(angle) * radius);
      int z = spawn.getBlockZ() + (int) Math.round(Math.sin(angle) * radius);
      if (!world.getWorldBorder().isInside(new Location(world, x + 0.5, spawn.getY(), z + 0.5))) {
        continue;
      }

      world.getChunkAt(Math.floorDiv(x, 16), Math.floorDiv(z, 16)).load(true);
      Location destination = safeLocationAt(world, x, z);
      if (destination != null) {
        return destination;
      }
    }
    return null;
  }

  private Location findLoadedSafeLocation(World world) {
    Chunk[] loadedChunks = world.getLoadedChunks();
    if (loadedChunks.length == 0) {
      return null;
    }

    for (int attempt = 0; attempt < 48; attempt += 1) {
      Chunk chunk = loadedChunks[random.nextInt(loadedChunks.length)];
      int x = (chunk.getX() << 4) + random.nextInt(16);
      int z = (chunk.getZ() << 4) + random.nextInt(16);
      Location destination = safeLocationAt(world, x, z);
      if (destination != null) {
        return destination;
      }
    }

    return null;
  }

  private Location safeLocationAt(World world, int x, int z) {
    Block ground = world.getHighestBlockAt(x, z);
    int y = ground.getY();
    if (!isSafeGround(ground.getType())) {
      return null;
    }
    if (!world.getBlockAt(x, y + 1, z).isPassable() || !world.getBlockAt(x, y + 2, z).isPassable()) {
      return null;
    }

    Location destination = new Location(world, x + 0.5, y + 1.0, z + 0.5, random.nextInt(360), 0.0f);
    if (destination.distanceSquared(spawnLocation(world)) < 6_400.0 || isInAirplaneFallColumn(destination)) {
      return null;
    }
    return destination;
  }

  private boolean isSafeGround(Material material) {
    if (!material.isSolid() || material.isAir()) {
      return false;
    }

    return switch (material) {
      case LAVA,
          WATER,
          FIRE,
          SOUL_FIRE,
          CACTUS,
          MAGMA_BLOCK,
          POWDER_SNOW,
          CAMPFIRE,
          SOUL_CAMPFIRE,
          SWEET_BERRY_BUSH,
          WITHER_ROSE -> false;
      default -> true;
    };
  }

  private void stabilize(Player player) {
    player.setFallDistance(0.0f);
    player.setFireTicks(0);
    player.setRemainingAir(player.getMaximumAir());
    player.setFoodLevel(20);
    player.setSaturation(20.0f);
    if (player.getHealth() < player.getMaxHealth()) {
      player.setHealth(player.getMaxHealth());
    }
  }

  private void heal(Player player) {
    player.setHealth(player.getMaxHealth());
    player.setFireTicks(0);
    player.setRemainingAir(player.getMaximumAir());
    player.setFallDistance(0.0f);
  }

  private void feed(Player player) {
    player.setFoodLevel(20);
    player.setSaturation(20.0f);
  }

  private void setFlight(Player player, boolean enabled) {
    player.setAllowFlight(enabled || player.getGameMode() == GameMode.CREATIVE || player.getGameMode() == GameMode.SPECTATOR);
    if (!enabled && player.getGameMode() != GameMode.CREATIVE && player.getGameMode() != GameMode.SPECTATOR) {
      player.setFlying(false);
    }
  }

  private void setGameMode(Player player, GameMode gameMode) {
    player.setGameMode(gameMode);
    if (gameMode == GameMode.CREATIVE || gameMode == GameMode.SPECTATOR) {
      player.setAllowFlight(true);
    }
  }

  private void enableCreativeAdmin(Player player) {
    setGameMode(player, GameMode.CREATIVE);
    setFlight(player, true);
    heal(player);
    feed(player);
    grantProtection(player, 10 * 60_000L);
  }

  private void disableCreativeAdmin(Player player) {
    setGameMode(player, GameMode.SURVIVAL);
    setFlight(player, false);
  }

  private void stabilizeAfterTeleport(Player player) {
    player.setVelocity(new Vector(0.0, 0.0, 0.0));
    stabilize(player);
  }

  private void grantProtection(Player player, long millis) {
    protectedUntil.put(player.getUniqueId(), System.currentTimeMillis() + millis);
  }

  private boolean isProtected(Player player) {
    Long until = protectedUntil.get(player.getUniqueId());
    if (until == null) {
      return false;
    }
    if (until < System.currentTimeMillis()) {
      protectedUntil.remove(player.getUniqueId());
      return false;
    }
    return true;
  }

  private boolean isOnAirplane(Location location) {
    if (location.getWorld() == null || !WORLD_NAME.equals(location.getWorld().getName())) {
      return false;
    }

    return Math.abs(location.getBlockX() - PLANE_CENTER_X) <= PLANE_RADIUS_X
        && Math.abs(location.getBlockZ() - PLANE_CENTER_Z) <= PLANE_RADIUS_Z
        && location.getY() >= PLANE_MIN_Y
        && location.getY() <= PLANE_MAX_Y;
  }

  private boolean isBelowAirplaneColumn(Location location) {
    return location.getWorld() != null
        && WORLD_NAME.equals(location.getWorld().getName())
        && Math.abs(location.getBlockX() - PLANE_CENTER_X) <= FALL_TRACK_RADIUS_X
        && Math.abs(location.getBlockZ() - PLANE_CENTER_Z) <= FALL_TRACK_RADIUS_Z
        && location.getY() < PLANE_MIN_Y;
  }

  private boolean shouldInterceptAirplaneFall(Player player, Location location) {
    return isInAirplaneFallColumn(location)
        && location.getY() <= SPAWN_BLOCK_Y - FALL_TRIGGER_BLOCKS_BELOW_PLANE
        && isFalling(player);
  }

  private boolean isFalling(Player player) {
    return !player.isOnGround()
        && (player.getVelocity().getY() < -0.05 || player.getFallDistance() > 0.2f);
  }

  private boolean isInAirplaneFallColumn(Location location) {
    return location.getWorld() != null
        && WORLD_NAME.equals(location.getWorld().getName())
        && Math.abs(location.getBlockX() - PLANE_CENTER_X) <= FALL_TRACK_RADIUS_X
        && Math.abs(location.getBlockZ() - PLANE_CENTER_Z) <= FALL_TRACK_RADIUS_Z
        && location.getY() < PLANE_MAX_Y;
  }

  private boolean shouldTeleportFallingPlayer(Location location) {
    if (location.getWorld() == null || !WORLD_NAME.equals(location.getWorld().getName())) {
      return false;
    }

    if (location.getY() <= PLANE_MIN_Y - FALL_TRIGGER_BLOCKS_BELOW_PLANE) {
      return true;
    }

    int groundY = location.getWorld().getHighestBlockYAt(location);
    return location.getY() <= groundY + FALL_BACKUP_BLOCKS_ABOVE_GROUND;
  }

  private boolean isNearOldSpawn(Location location) {
    if (location.getWorld() == null || !WORLD_NAME.equals(location.getWorld().getName())) {
      return false;
    }

    return Math.abs(location.getBlockX() - OLD_SPAWN_X) <= OLD_SPAWN_RADIUS
        && Math.abs(location.getBlockZ() - OLD_SPAWN_Z) <= OLD_SPAWN_RADIUS
        && location.getY() < PLANE_MIN_Y;
  }

  private boolean isUnsafeSpawnColumn(Location location) {
    if (location.getWorld() == null || !WORLD_NAME.equals(location.getWorld().getName())) {
      return false;
    }

    return Math.abs(location.getBlockX() - PLANE_CENTER_X) <= 8
        && Math.abs(location.getBlockZ() - PLANE_CENTER_Z) <= 8
        && location.getY() < SPAWN_BLOCK_Y - 4;
  }

  private Location spawnLocation(World world) {
    return new Location(world, SPAWN_BLOCK_X + 0.5, SPAWN_BLOCK_Y, SPAWN_BLOCK_Z + 0.5, 90.0f, 0.0f);
  }

  private boolean requirePermission(CommandSender sender, String permission) {
    if (sender.hasPermission(permission)) {
      return true;
    }

    sender.sendMessage("Нет прав: " + permission);
    sender.sendMessage("Для админ-команд выдай OP или permission " + permission + ".");
    return false;
  }

  private boolean canUseTargetedPlayerCommand(CommandSender sender, Player target, String selfPermission, String targetPermission) {
    if (sender.equals(target)) {
      return requirePermission(sender, selfPermission);
    }
    return requirePermission(sender, targetPermission);
  }

  private Player resolveTarget(CommandSender sender, String[] args, int index, String targetPermission) {
    if (args.length > index) {
      if (!requirePermission(sender, targetPermission)) {
        return null;
      }

      Player target = Bukkit.getPlayerExact(args[index]);
      if (target == null) {
        target = Bukkit.getPlayer(args[index]);
      }
      if (target == null) {
        sender.sendMessage("Игрок не найден: " + args[index]);
        return null;
      }
      return target;
    }

    if (sender instanceof Player player) {
      return player;
    }

    sender.sendMessage("Укажи игрока.");
    return null;
  }

  private GameMode parseGameMode(String input) {
    return switch (input.toLowerCase(Locale.ROOT)) {
      case "0", "s", "survival", "выживание" -> GameMode.SURVIVAL;
      case "1", "c", "creative", "креатив" -> GameMode.CREATIVE;
      case "2", "a", "adventure", "приключение" -> GameMode.ADVENTURE;
      case "3", "sp", "spectator", "spectate", "наблюдатель" -> GameMode.SPECTATOR;
      default -> null;
    };
  }

  private World commandWorld(CommandSender sender) {
    if (sender instanceof Player player) {
      return player.getWorld();
    }
    return Bukkit.getWorld(WORLD_NAME);
  }

  private String joinArgs(String[] args, int start) {
    StringBuilder message = new StringBuilder();
    for (int i = start; i < args.length; i += 1) {
      if (message.length() > 0) {
        message.append(' ');
      }
      message.append(args[i]);
    }
    return message.toString();
  }

  private List<String> completeGameMode(String[] args) {
    if (args.length == 1) {
      return startsWith(List.of("survival", "creative", "adventure", "spectator"), args[0]);
    }
    if (args.length == 2) {
      return onlinePlayerNames(args[1]);
    }
    return List.of();
  }

  private List<String> completeAdmin67(String[] args) {
    if (args.length == 1) {
      return startsWith(
          List.of("help", "on", "off", "status", "spawn", "rtp", "heal", "feed", "fly", "creative", "survival", "day", "night", "sun", "rain", "broadcast"),
          args[0]);
    }
    if (args.length == 2 && List.of("spawn", "rtp", "heal", "feed", "fly", "creative", "survival").contains(args[0].toLowerCase(Locale.ROOT))) {
      return onlinePlayerNames(args[1]);
    }
    return List.of();
  }

  private List<String> onlinePlayerNames(String token) {
    List<String> names = new ArrayList<>();
    for (Player player : Bukkit.getOnlinePlayers()) {
      names.add(player.getName());
    }
    return startsWith(names, token);
  }

  private List<String> startsWith(List<String> values, String token) {
    String loweredToken = token.toLowerCase(Locale.ROOT);
    List<String> matches = new ArrayList<>();
    for (String value : values) {
      if (value.toLowerCase(Locale.ROOT).startsWith(loweredToken)) {
        matches.add(value);
      }
    }
    return matches;
  }
}
