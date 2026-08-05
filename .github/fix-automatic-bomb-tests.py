from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}: {old!r}, found {count}")
    path.write_text(text.replace(old, new, 1))


replace_once(
    Path("tests/free-roam-four-finger-guide.test.mjs"),
    'test("two-finger downward swipes no longer disable gestures", () => {\n  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 4, dy: 90, movement: 90}), null);',
    'test("two-finger downward swipes launch the server-authoritative mega-bomb command", () => {\n  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 4, dy: 90, movement: 90}), "mega-bomb");',
)

replace_once(
    Path("tests/free-roam-shop.test.mjs"),
    '''test("automatic ammunition can be purchased before the automatic is found", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 80;
  selectItem(world, 0, "automatic-ammo");
  assert.equal(world.players[0].combat.weapons.automatic, false);
  pulse(world, 0, {shopBuy: true});
  assert.equal(world.players[0].combat.ammo, 30);
  assert.equal(world.freeActivities.credits, 55);
});''',
    '''test("the automatic-ammo slot sells a missing automatic before it sells ammunition", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 120;
  selectItem(world, 0, "automatic-ammo");
  const ammoBefore = world.players[0].combat.ammo;
  assert.equal(world.players[0].combat.weapons.automatic, false);
  pulse(world, 0, {shopBuy: true});
  assert.equal(world.players[0].combat.weapons.automatic, true);
  assert.equal(world.players[0].combat.equipped, "automatic");
  assert.equal(world.players[0].combat.ammo, ammoBefore);
  assert.equal(world.freeActivities.credits, 0);
  assert.ok(drainEvents(world).some(event => event.itemId === "automatic-weapon"));
});''',
)

replace_once(
    Path("tests/free-roam-target-reconnect-v154.test.mjs"),
    r'free-roam-v4\.js\?v=57',
    r'free-roam-v4\.js\?v=58',
)

shop_test = Path("tests/free-roam-shop-automatic-v8.test.mjs")
text = shop_test.read_text()
text = text.replace(
    '  assert.equal(world.events.at(-1).itemId, "automatic-weapon");\n  assert.equal(world.events.at(-1).sourcePlayer, 1);',
    '  const purchase = world.events.find(event => event.itemId === "automatic-weapon");\n  assert.equal(purchase?.type, "shop-purchased");\n  assert.equal(purchase?.sourcePlayer, 1);',
)
text = text.replace(
    '  assert.equal(world.events.at(-1).type, "shop-denied");\n  assert.equal(world.events.at(-1).itemId, "automatic-weapon");',
    '  const denied = world.events.find(event => event.itemId === "automatic-weapon");\n  assert.equal(denied?.type, "shop-denied");',
)
shop_test.write_text(text)
