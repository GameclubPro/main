package ru.flexcraft.playersync;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.StringJoiner;
import java.util.UUID;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Statistic;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.EntityEquipment;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

public final class FlexPlayerSyncPlugin extends JavaPlugin implements Listener, TabExecutor {
  private HttpClient httpClient;
  private URI apiUri;
  private String apiToken;
  private boolean debug;
  private int joinDelayTicks;
  private BukkitTask periodicTask;

  @Override
  public void onEnable() {
    saveDefaultConfig();
    loadSettings();
    Bukkit.getPluginManager().registerEvents(this, this);
    getCommand("flexsync").setExecutor(this);
    getCommand("flexsync").setTabCompleter(this);
    schedulePeriodicSync();
    getLogger().info("FlexPlayerSync enabled.");
  }

  @Override
  public void onDisable() {
    if (periodicTask != null) {
      periodicTask.cancel();
      periodicTask = null;
    }
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (!sender.hasPermission("flex.playersync.admin")) {
      sender.sendMessage("Нет прав.");
      return true;
    }

    String action = args.length > 0 ? args[0].toLowerCase(Locale.ROOT) : "push";
    switch (action) {
      case "reload" -> {
        reloadConfig();
        loadSettings();
        schedulePeriodicSync();
        sender.sendMessage("FlexPlayerSync: конфиг перезагружен.");
      }
      case "push" -> {
        pushOnlinePlayers(true);
        sender.sendMessage("FlexPlayerSync: отправка игроков запущена.");
      }
      default -> sender.sendMessage("Используйте /flexsync reload или /flexsync push.");
    }
    return true;
  }

  @Override
  public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
    if (args.length != 1 || !sender.hasPermission("flex.playersync.admin")) {
      return List.of();
    }

    String prefix = args[0].toLowerCase(Locale.ROOT);
    return List.of("reload", "push").stream().filter((value) -> value.startsWith(prefix)).toList();
  }

  @EventHandler(priority = EventPriority.MONITOR)
  public void onPlayerJoin(PlayerJoinEvent event) {
    Player player = event.getPlayer();
    Bukkit.getScheduler().runTaskLater(this, () -> {
      if (player.isOnline()) {
        pushPlayer(player, true);
      }
    }, joinDelayTicks);
  }

  @EventHandler(priority = EventPriority.MONITOR)
  public void onPlayerQuit(PlayerQuitEvent event) {
    pushPlayer(event.getPlayer(), false);
  }

  private void loadSettings() {
    String url = getConfig().getString("api-url", "https://flex-craft.ru/api/game/player/snapshot");
    apiUri = URI.create(url);
    apiToken = getConfig().getString("api-token", "").trim();
    debug = getConfig().getBoolean("debug", false);
    joinDelayTicks = Math.max(1, getConfig().getInt("sync-on-join-delay-seconds", 4)) * 20;
    int connectTimeout = Math.max(2, getConfig().getInt("connect-timeout-seconds", 6));
    httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(connectTimeout)).build();

    if (apiToken.isEmpty()) {
      getLogger().warning("api-token is empty. Player snapshots will not be sent.");
    }
  }

  private void schedulePeriodicSync() {
    if (periodicTask != null) {
      periodicTask.cancel();
    }

    int intervalSeconds = Math.max(15, getConfig().getInt("sync-interval-seconds", 120));
    periodicTask = Bukkit.getScheduler().runTaskTimer(this, () -> pushOnlinePlayers(true), intervalSeconds * 20L, intervalSeconds * 20L);
  }

  private void pushOnlinePlayers(boolean online) {
    for (Player player : Bukkit.getOnlinePlayers()) {
      pushPlayer(player, online);
    }
  }

  private void pushPlayer(Player player, boolean online) {
    if (apiToken.isEmpty()) {
      return;
    }

    Map<String, Object> snapshot = createSnapshot(player, online);
    Bukkit.getScheduler().runTaskAsynchronously(this, () -> sendSnapshot(player.getName(), snapshot));
  }

  private Map<String, Object> createSnapshot(Player player, boolean online) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("nickname", player.getName());
    payload.put("minecraftUuid", player.getUniqueId().toString());
    payload.put("online", online);
    payload.put("location", locationToMap(player.getLocation()));
    payload.put("inventory", inventoryToList(player.getInventory().getStorageContents()));
    payload.put("enderChest", inventoryToList(player.getEnderChest().getContents()));
    payload.put("equipment", equipmentToMap(player.getEquipment()));
    payload.put("stats", statsToMap(player));
    return payload;
  }

  private Map<String, Object> locationToMap(Location location) {
    Map<String, Object> result = new LinkedHashMap<>();
    World world = location.getWorld();
    result.put("world", world == null ? "" : world.getName());
    result.put("x", round(location.getX()));
    result.put("y", round(location.getY()));
    result.put("z", round(location.getZ()));
    result.put("yaw", round(location.getYaw()));
    result.put("pitch", round(location.getPitch()));
    return result;
  }

  private List<Object> inventoryToList(ItemStack[] items) {
    List<Object> result = new ArrayList<>();
    for (int slot = 0; slot < items.length; slot += 1) {
      ItemStack item = items[slot];
      if (item == null || item.getType().isAir()) {
        continue;
      }

      Map<String, Object> entry = itemToMap(item);
      entry.put("slot", slot);
      result.add(entry);
    }
    return result;
  }

  private Map<String, Object> equipmentToMap(EntityEquipment equipment) {
    Map<String, Object> result = new LinkedHashMap<>();
    if (equipment == null) {
      return result;
    }

    putEquipment(result, "helmet", equipment.getHelmet());
    putEquipment(result, "chestplate", equipment.getChestplate());
    putEquipment(result, "leggings", equipment.getLeggings());
    putEquipment(result, "boots", equipment.getBoots());
    putEquipment(result, "mainHand", equipment.getItemInMainHand());
    putEquipment(result, "offHand", equipment.getItemInOffHand());
    return result;
  }

  private void putEquipment(Map<String, Object> result, String key, ItemStack item) {
    if (item != null && !item.getType().isAir()) {
      result.put(key, itemToMap(item));
    }
  }

  private Map<String, Object> itemToMap(ItemStack item) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("type", item.getType().name());
    result.put("amount", item.getAmount());

    ItemMeta meta = item.getItemMeta();
    if (meta == null) {
      return result;
    }

    if (meta.hasDisplayName()) {
      result.put("name", meta.getDisplayName());
    }

    if (meta instanceof Damageable damageable && damageable.hasDamage()) {
      result.put("damage", damageable.getDamage());
    }

    if (!meta.getEnchants().isEmpty()) {
      Map<String, Object> enchants = new LinkedHashMap<>();
      for (Map.Entry<Enchantment, Integer> entry : meta.getEnchants().entrySet()) {
        enchants.put(entry.getKey().getKey().toString(), entry.getValue());
      }
      result.put("enchants", enchants);
    }

    if (meta.hasLore()) {
      result.put("lore", trimList(meta.getLore(), 12, 120));
    }

    return result;
  }

  private List<String> trimList(List<String> values, int maxItems, int maxLength) {
    if (values == null || values.isEmpty()) {
      return List.of();
    }

    List<String> result = new ArrayList<>();
    for (String value : values) {
      if (result.size() >= maxItems) {
        break;
      }
      result.add(value.length() > maxLength ? value.substring(0, maxLength) : value);
    }
    return result;
  }

  private Map<String, Object> statsToMap(Player player) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("health", round(player.getHealth()));
    result.put("foodLevel", player.getFoodLevel());
    result.put("level", player.getLevel());
    result.put("exp", round(player.getExp()));
    result.put("gameMode", gameModeName(player.getGameMode()));
    result.put("playTimeTicks", getStatistic(player, Statistic.PLAY_ONE_MINUTE));
    result.put("deaths", getStatistic(player, Statistic.DEATHS));
    result.put("mobKills", getStatistic(player, Statistic.MOB_KILLS));
    result.put("playerKills", getStatistic(player, Statistic.PLAYER_KILLS));
    result.put("walkOneCm", getStatistic(player, Statistic.WALK_ONE_CM));
    return result;
  }

  private int getStatistic(Player player, Statistic statistic) {
    try {
      return player.getStatistic(statistic);
    } catch (RuntimeException error) {
      return 0;
    }
  }

  private String gameModeName(GameMode gameMode) {
    return gameMode == null ? "" : gameMode.name().toLowerCase(Locale.ROOT);
  }

  private double round(double value) {
    return Math.round(value * 100.0D) / 100.0D;
  }

  private void sendSnapshot(String nickname, Map<String, Object> snapshot) {
    try {
      int requestTimeout = Math.max(3, getConfig().getInt("request-timeout-seconds", 12));
      HttpRequest request = HttpRequest.newBuilder(apiUri)
          .timeout(Duration.ofSeconds(requestTimeout))
          .header("Accept", "application/json")
          .header("Content-Type", "application/json")
          .header("Authorization", "Bearer " + apiToken)
          .POST(HttpRequest.BodyPublishers.ofString(toJson(snapshot)))
          .build();
      HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() < 200 || response.statusCode() >= 300) {
        getLogger().warning("Snapshot for " + nickname + " failed: HTTP " + response.statusCode() + " " + response.body());
      } else if (debug) {
        getLogger().info("Snapshot for " + nickname + " sent.");
      }
    } catch (IOException error) {
      getLogger().log(Level.WARNING, "Could not send snapshot for " + nickname + ".", error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      getLogger().log(Level.WARNING, "Snapshot send interrupted for " + nickname + ".", error);
    } catch (RuntimeException error) {
      getLogger().log(Level.WARNING, "Snapshot send failed for " + nickname + ".", error);
    }
  }

  private String toJson(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof String text) {
      return quote(text);
    }
    if (value instanceof Number || value instanceof Boolean) {
      return String.valueOf(value);
    }
    if (value instanceof Map<?, ?> map) {
      StringJoiner joiner = new StringJoiner(",", "{", "}");
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        joiner.add(quote(String.valueOf(entry.getKey())) + ":" + toJson(entry.getValue()));
      }
      return joiner.toString();
    }
    if (value instanceof Collection<?> collection) {
      StringJoiner joiner = new StringJoiner(",", "[", "]");
      for (Object item : collection) {
        joiner.add(toJson(item));
      }
      return joiner.toString();
    }
    if (value instanceof UUID uuid) {
      return quote(uuid.toString());
    }
    return quote(String.valueOf(value));
  }

  private String quote(String value) {
    StringBuilder builder = new StringBuilder(value.length() + 2);
    builder.append('"');
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      switch (character) {
        case '"' -> builder.append("\\\"");
        case '\\' -> builder.append("\\\\");
        case '\b' -> builder.append("\\b");
        case '\f' -> builder.append("\\f");
        case '\n' -> builder.append("\\n");
        case '\r' -> builder.append("\\r");
        case '\t' -> builder.append("\\t");
        default -> {
          if (character < 0x20) {
            builder.append(String.format("\\u%04x", (int) character));
          } else {
            builder.append(character);
          }
        }
      }
    }
    builder.append('"');
    return builder.toString();
  }
}
