import { CONTENT_VERSION, generatedContent } from "./generated/content.js";
import type {
  ArtifactCategory,
  ArtifactTag,
  ArtifactTemplate,
  EventCard,
  MissionCard,
  PropertyDefinition,
  Role,
  TrickCard
} from "./types.js";

export { CONTENT_VERSION, generatedContent };

export const CATEGORY_LABELS: Record<ArtifactCategory, string> = {
  calligraphy: "字画",
  bronze: "青铜",
  jewelry: "珠宝",
  porcelain: "瓷器",
  jade: "玉器",
  book: "古籍",
  coin: "钱币",
  curio: "奇物",
  relic: "灵器",
  evil: "邪物",
  legacy: "遗物",
  lastword: "绝笔",
  celebrity: "名人旧物"
};

export const TAG_LABELS: Record<ArtifactTag, string> = {
  treasure: "聚宝",
  heirloom: "传世",
  fake: "赝品",
  fragile: "易损",
  curse: "诅咒",
  anonymous: "无名"
};

export const GAME_CONSTANTS = {
  minPlayers: 3,
  maxPlayers: 5,
  maxDays: 10,
  startingCash: 500,
  incomeDieSides: 6,
  incomePerPip: 10,
  hostCommissionRate: 0.2,
  bankSellRate: 0.8,
  loanAmount: 100,
  loanRepayment: 120,
  blackMarketDays: [3, 6, 9],
  blackMarketLimit: 2,
  trickCost: 30,
  eventCost: 50,
  eventHandLimit: 3,
  englishIncrement: 10,
  dutchStep: 10,
  dutchTickMs: 3000,
  naturalEventChance: 0.2
} as const;

export const PROPERTIES = generatedContent.properties as unknown as PropertyDefinition[];
export const ROLES = generatedContent.roles as unknown as Role[];

export const ARTIFACT_TEMPLATES = (generatedContent.artifacts as unknown as ArtifactTemplate[]).map((artifact) => ({
  ...artifact,
  tagPool: artifact.propertyPool.filter((property): property is ArtifactTag =>
    ["treasure", "heirloom", "fake", "fragile", "curse", "anonymous"].includes(property)
  )
}));

export const TRICK_CARDS = (generatedContent.tricks as unknown as Array<Omit<TrickCard, "description"> & { effectText: string }>).map(
  (card) => ({
    ...card,
    description: card.effectText
  })
) as TrickCard[];

export const EVENT_CARDS = (generatedContent.events as unknown as Array<Omit<EventCard, "description" | "type"> & { effectText: string }>).map(
  (card) => ({
    ...card,
    type: "control" as const,
    cost: 0,
    description: card.effectText,
    timing: "settlement" as const
  })
) as EventCard[];

export const MISSIONS = generatedContent.missions as unknown as MissionCard[];
export const allCards = [...TRICK_CARDS, ...EVENT_CARDS];
