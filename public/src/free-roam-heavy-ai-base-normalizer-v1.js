"use strict";

/**
 * Базовая V162 по-прежнему рассчитывает попадания и стрельбу тяжёлого катера,
 * но не имеет права владеть его перемещением или уничтожать броневую оболочку
 * как весь катер. Этот нормализатор возвращает физический снимок перед тем,
 * как единый контроллер V1 выполнит ровно один шаг движения.
 *
 * Важно: модуль не меняет phase, destination, repairSystem и другие решения ИИ.
 */
export function normalizeHeavyBaseStepV1(world) {
  const state = world.freeHeavyAiControllerV1;
  const frame = state?.frame;
  const snapshot = frame?.boat;
  const boat = world.freeHeavyPursuer?.boat;
  if (!snapshot?.ref || !boat || boat !== snapshot.ref) return false;

  // V162 может уже передвинуть тяжёлый катер. Единый контроллер должен получить
  // исходную позицию и сам выполнить единственный физический шаг этого кадра.
  boat.x = snapshot.x;
  boat.y = snapshot.y;
  boat.heading = snapshot.heading;
  boat.speed = snapshot.speed;

  // В обычном бою выбор безопасной точки должен быть детерминированным.
  // Иначе служебный serial слегка меняет оценку одинаковых точек каждый кадр,
  // и катер может беспричинно перекладывать руль между двумя маршрутами.
  if (state?.heavy?.phase === "combat") state.serial = 0;

  const heavy = state.heavy;
  const armourWasAlive = !heavy?.armourBreached && Number(snapshot.hull) > 0;
  const armourWasDestroyed = Number(boat.hull) <= 0 || boat.destroyed || boat.active === false;
  if (!armourWasAlive || !armourWasDestroyed) return true;

  // reconcileHeavyDamage должен увидеть событие уничтожения брони и превратить
  // её во внутренний корпус. Минимальное положительное hull нужно только затем,
  // чтобы текущий фильтр живого катера не выбросил объект до reconcile.
  boat.hull = Math.max(0.0001, Number(boat.hull) || 0);
  boat.active = true;
  boat.destroyed = false;
  if (world.freeHeavyPursuer) world.freeHeavyPursuer.active = true;
  return true;
}
