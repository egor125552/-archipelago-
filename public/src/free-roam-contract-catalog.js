"use strict";

const normalNames = [
  "коробки с медицинскими фильтрами", "запасные линзы для маяка", "радиостанция береговой службы",
  "аккумуляторы аварийного освещения", "комплект спасательных жилетов", "свёрнутая рыболовная сеть",
  "ящик консервов", "судовой компас", "насосные шланги", "набор латунных клапанов",
  "метеорологические датчики", "водяные фильтры", "генераторные ремни", "бухта буксировочного троса",
  "комплект свечей зажигания", "запасные прожекторные лампы", "холодильный компрессор",
  "коробка навигационных карт", "ящик герметика", "портативный эхолот", "ремонтный набор для рации",
  "комплект сигнальных флажков", "корабельный огнетушитель", "полевой набор инструментов",
  "запасные трюмные поплавки", "коробка крепёжных болтов", "рулон водостойкого кабеля",
  "судовая аптечка", "запасной штурвал", "комплект береговых прожекторов", "ящик рыболовных крючков",
  "складной аварийный трап", "судовой барометр", "помпа для питьевой воды", "комплект радиомаяка",
  "ящик сухих пайков",
];

const salvageNames = [
  "повреждённый гребной винт", "секция якорной цепи", "медная обмотка генератора",
  "корпус судового насоса", "латунный распределительный блок", "свинцовый балласт", "стальной вал",
  "обломок лебёдки", "редуктор старого катера", "алюминиевая секция мачты", "кабельный барабан",
  "разбитый стартер", "топливная рампа", "блок цилиндров", "рама аккумуляторного отсека",
  "бронзовый подшипниковый узел", "лопасть судового винта", "корпус редуктора", "фрагмент бронеплиты",
  "стальная муфта вала", "медный теплообменник", "корпус старой радиостанции", "чугунный маховик",
  "секция рулевого механизма", "разбитая якорная лебёдка", "алюминиевый бак", "латунный клапанный коллектор",
  "рамка дизельного генератора", "судовой кардан", "опора мачты", "корпус водомёта", "стальная дверь машинного отсека",
];

const dangerousNames = [
  "повреждённый банковский сейф", "контейнер конфискованного оружия", "ящик сигнальных ракет",
  "нестабильные топливные баллоны", "защищённый радиопередатчик", "чёрный ящик пропавшего судна",
  "контейнер дефицитных лекарств", "дипломатический кейс", "зашифрованный навигационный терминал",
  "экспериментальный двигатель", "армейский аккумуляторный блок", "касса портовой администрации",
  "документы контрабандистов", "аварийный резерв драгоценных деталей", "контейнер спутниковой связи",
  "ящик редких электронных модулей", "портовый реестр нелегальных рейсов", "контейнер бронебойных деталей",
  "прототип силового насоса", "защищённый архив береговой охраны", "кейс с кодами навигационных буёв",
  "ящик дорогих оптических приборов", "контейнер реактивов для маяка", "секретный журнал маршрутов",
  "кассета экспериментальных аккумуляторов", "ящик деталей военного радара", "запечатанный контейнер казначейства",
  "прототип бесшумного водомёта",
];

function traitsFor(category, index) {
  const traitSets = category === "normal"
    ? [[], ["fragile"], ["waterSensitive"], ["floating"], ["heavy"]]
    : category === "salvage"
      ? [["heavy", "sinking"], ["sinking"], ["heavy", "sinking", "twoSlots"]]
      : [["tracked"], ["tracked", "fragile"], ["tracked", "waterSensitive"], ["tracked", "unstable"], ["tracked", "heavy", "twoSlots"]];
  return traitSets[index % traitSets.length];
}

function build(category, names) {
  return names.map((name, index) => {
    const traits = traitsFor(category, index);
    const dangerous = category === "dangerous";
    const salvage = category === "salvage";
    return Object.freeze({
      id: `${category}-${String(index + 1).padStart(2, "0")}`,
      category,
      name,
      label: name,
      rarity: dangerous ? "rare" : salvage ? "uncommon" : index % 5 === 0 ? "uncommon" : "common",
      weight: traits.includes("heavy") ? 7 : salvage ? 5 : dangerous ? 4 : 2 + (index % 3),
      slots: traits.includes("twoSlots") ? 2 : 1,
      traits: Object.freeze([...traits]),
      creditReward: dangerous ? 180 + (index % 6) * 28 : salvage ? 95 + (index % 6) * 16 : 60 + (index % 7) * 10,
      scrapReward: salvage ? 2 + (index % 5) : dangerous && index % 7 === 0 ? 1 : 0,
      threat: dangerous ? 2 + (index % 4) : salvage ? 1 + (index % 3) : index % 8 === 0 ? 1 : 0,
      extractionSeconds: salvage ? 2.5 + (index % 4) * 1.4 : 0,
      bonus: dangerous
        ? ["30 патронов автомата", "24 патрона пистолета", "ремонтная пластина", "аварийная канистра"][index % 4]
        : index % 9 === 0 ? "12 патронов пистолета" : null,
      description: salvage
        ? `Тяжёлая судовая деталь: ${name}. Её нужно физически отделить от обломков и доставить к причалу.`
        : dangerous
          ? `Опасный и отслеживаемый груз: ${name}. После погрузки вероятно вооружённое преследование.`
          : `Реальный портовый груз: ${name}. Доставь его целым к торговому причалу.`,
    });
  });
}

export const NORMAL_CONTRACT_CARGO = Object.freeze(build("normal", normalNames));
export const SALVAGE_CONTRACT_CARGO = Object.freeze(build("salvage", salvageNames));
export const DANGEROUS_CONTRACT_CARGO = Object.freeze(build("dangerous", dangerousNames));
export const CONTRACT_CARGO_CATALOG = Object.freeze([
  ...NORMAL_CONTRACT_CARGO,
  ...SALVAGE_CONTRACT_CARGO,
  ...DANGEROUS_CONTRACT_CARGO,
]);
export const CONTRACT_CARGO_BY_ID = new Map(CONTRACT_CARGO_CATALOG.map(item => [item.id, item]));

export function cargoDefinition(id) {
  return CONTRACT_CARGO_BY_ID.get(id) || null;
}

export function catalogForCategory(category) {
  if (category === "salvage") return SALVAGE_CONTRACT_CARGO;
  if (category === "dangerous") return DANGEROUS_CONTRACT_CARGO;
  return NORMAL_CONTRACT_CARGO;
}
