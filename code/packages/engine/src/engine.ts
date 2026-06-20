import {
  ARTIFACT_TEMPLATES,
  CATEGORY_LABELS,
  CONTENT_VERSION,
  EVENT_CARDS,
  GAME_CONSTANTS,
  MISSIONS,
  PROPERTIES,
  ROLES,
  TAG_LABELS,
  TRICK_CARDS,
  allCards,
  type ArtifactCategory,
  type ArtifactId,
  type ArtifactInstance,
  type ArtifactTag,
  type IncomeRollResult,
  type AuctionMode,
  type BundleInnerMode,
  type ActiveEffect,
  type CardId,
  type ChoiceResolution,
  type DelayedCardEffect,
  type EventCard,
  type FinalScore,
  type GameState,
  type MissionCard,
  type PlayerId,
  type PlayerState,
  type PlayerView,
  type PhaseTimeouts,
  type PropertyDefinition,
  type PublicArtifactView,
  type Role,
  type ServerAction,
  type TradeAssetSet,
  type TradeOffer,
  type TrickCard
} from "@auctioneer/shared";
import { clone, makeId, makeRng, pick, shuffled } from "./utils.js";

type MutableGame = GameState;

export interface CreateRoomOptions {
  roomId: string;
  joinCode: string;
  now?: number;
}

const trickById = new Map(TRICK_CARDS.map((card) => [card.id, card]));
const eventById = new Map(EVENT_CARDS.map((card) => [card.id, card]));
const cardById = new Map(allCards.map((card) => [card.id, card]));
const missionById = new Map(MISSIONS.map((mission) => [mission.id, mission]));
const propertyById = new Map(PROPERTIES.map((property) => [property.id, property]));
const roleById = new Map(ROLES.map((role) => [role.id, role]));
const DEFAULT_PHASE_TIMEOUTS: PhaseTimeouts = {
  dayIncome: 120_000,
  blackMarket: 120_000,
  preview: 120_000,
  cardWindow: 120_000,
  auction: 120_000,
  settlement: 90_000,
  eventWindow: 90_000,
  freeTrade: 180_000
};

function roundToTen(value: number): number {
  return Math.max(0, Math.round(value / 10) * 10);
}

function ceilToTen(value: number): number {
  return Math.max(0, Math.ceil(value / 10) * 10);
}

function randomTenInRange(min: number, max: number, rng: () => number): number {
  const low = ceilToTen(min);
  const high = Math.max(0, Math.floor(max / 10) * 10);
  if (low > high) return roundToTen((min + max) / 2);
  const steps = Math.floor((high - low) / 10) + 1;
  return low + Math.floor(rng() * steps) * 10;
}

function isFakeArtifactTemplate(artifact: ArtifactInstance): boolean {
  return artifact.properties.includes("fake") || artifact.tag === "fake";
}

function artifactSettlementValueForPlayer(state: GameState, player: PlayerState, artifact: ArtifactInstance, acquiredDay?: number): number {
  const originalDayAcquired = artifact.dayAcquired;
  if (acquiredDay !== undefined) artifact.dayAcquired = acquiredDay;
  const value = roundToTen(adjustedArtifactValueForPlayer(state, player, artifact, state.activeEffects));
  artifact.dayAcquired = originalDayAcquired;
  return value;
}

function lockArtifactSettlementValue(state: MutableGame, artifact: ArtifactInstance, owner: PlayerState, acquiredDay?: number): void {
  artifact.lockedSettlementValue = artifactSettlementValueForPlayer(state, owner, artifact, acquiredDay);
}

function assignArtifactToPlayer(
  state: MutableGame,
  owner: PlayerState,
  artifact: ArtifactInstance,
  options: {
    purchasePrice?: number;
    acquiredByMode?: AuctionMode;
    packageId?: string;
    dayAcquired?: number;
  } = {}
): void {
  if (!owner.artifacts.includes(artifact.id)) owner.artifacts.push(artifact.id);
  artifact.ownerId = owner.id;
  artifact.dayAcquired = options.dayAcquired ?? state.day;
  if (options.acquiredByMode !== undefined) artifact.acquiredByMode = options.acquiredByMode;
  if (options.purchasePrice !== undefined) artifact.purchasePrice = options.purchasePrice;
  if (options.packageId !== undefined) artifact.packageId = options.packageId;
  revealArtifactTo(artifact, owner.id);
  lockArtifactSettlementValue(state, artifact, owner, artifact.dayAcquired);
}

function removeArtifactFromPlayer(state: MutableGame, owner: PlayerState, artifact: ArtifactInstance): void {
  owner.artifacts = owner.artifacts.filter((id) => id !== artifact.id);
  artifact.ownerId = undefined;
  artifact.lockedSettlementValue = undefined;
}

export class RuleError extends Error {
  constructor(message: string, public readonly code = "INVALID_ACTION") {
    super(message);
    this.name = "RuleError";
  }
}

export function createRoomState(options: CreateRoomOptions): GameState {
  const now = options.now ?? Date.now();
  return {
    roomId: options.roomId,
    joinCode: options.joinCode,
    contentVersion: CONTENT_VERSION,
    phase: "lobby",
    day: 0,
    maxDays: GAME_CONSTANTS.maxDays,
    players: [],
    artifacts: {},
    deck: [],
    trickDeck: [],
    eventDeck: [],
    discardPile: [],
    missions: Object.fromEntries(MISSIONS.map((mission) => [mission.id, mission])),
    roles: Object.fromEntries(ROLES.map((role) => [role.id, role])),
    activeEffects: [],
    delayedCardEffects: [],
    tradeOffers: [],
    stats: emptyStats(),
    phaseTimeouts: { ...DEFAULT_PHASE_TIMEOUTS },
    todayArtifactIds: [],
    log: ["房间已创建。"],
    actionIndex: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function addPlayer(state: GameState, playerId: PlayerId, nickname: string): GameState {
  const next = clone(state);
  if (next.phase !== "lobby") throw new RuleError("游戏已开始，不能加入。", "BAD_PHASE");
  if (next.players.length >= GAME_CONSTANTS.maxPlayers) throw new RuleError("房间已满。", "ROOM_FULL");
  const cleanName = nickname.trim().slice(0, 16);
  if (!cleanName) throw new RuleError("昵称不能为空。");
  const player: PlayerState = {
    id: playerId,
    nickname: cleanName,
    seat: next.players.length,
      ready: false,
      connected: true,
      cash: GAME_CONSTANTS.startingCash,
      loans: 0,
      loanRepayments: [],
      hand: [],
    events: [],
    artifacts: [],
    missionIds: [],
    privateLog: [],
    passed: false,
    blackMarketBuysToday: 0,
    loansTakenToday: 0
  };
  next.players.push(player);
  next.hostPlayerId ??= playerId;
  next.lastMessage = `${cleanName} 加入了房间。`;
  next.log.push(next.lastMessage);
  stamp(next);
  return next;
}

export function reduceGame(state: GameState, action: ServerAction): GameState {
  const next = clone(state);
  const player = requirePlayer(next, action.playerId);
  if (player.kicked) throw new RuleError("你已被移出房间。", "SESSION_INVALID");
  const previousPhase = next.phase;
  const allowedWhilePaused: ServerAction["type"][] = ["SET_CONNECTED", "SET_PAUSED", "TRANSFER_OWNER", "KICK_PLAYER", "SET_PHASE_TIMEOUTS"];
  if (next.paused && !allowedWhilePaused.includes(action.type)) throw new RuleError("房间已暂停。", "BAD_PHASE");

  switch (action.type) {
    case "SET_CONNECTED": {
      const payload = action.payload as { connected: boolean };
      player.connected = payload.connected;
      if (payload.connected) player.disconnectedAt = undefined;
      else {
        player.disconnectedAt = Date.now();
        handlePlayerDisconnected(next, player);
      }
      next.log.push(`${player.nickname}${payload.connected ? "重新连接" : "离线"}。`);
      break;
    }
    case "AUTO_ADVANCE_OFFLINE":
      autoAdvanceOfflinePlayer(next, player);
      break;
    case "TRANSFER_OWNER": {
      const payload = action.payload as { playerId: PlayerId };
      transferOwner(next, player, payload.playerId);
      break;
    }
    case "KICK_PLAYER": {
      const payload = action.payload as { playerId: PlayerId };
      kickPlayer(next, player, payload.playerId);
      break;
    }
    case "SET_PHASE_TIMEOUTS": {
      const payload = action.payload as { timeouts: PhaseTimeouts };
      setPhaseTimeouts(next, player, payload.timeouts);
      break;
    }
    case "SET_PAUSED": {
      const payload = action.payload as { paused: boolean };
      setPaused(next, player, payload.paused);
      break;
    }
    case "PHASE_TIMEOUT_AUTO":
      autoAdvancePhaseTimeout(next, player);
      break;
    case "SET_READY": {
      assertPhase(next, "lobby");
      const payload = action.payload as { ready: boolean };
      player.ready = payload.ready;
      next.lastMessage = `${player.nickname}${player.ready ? "已准备" : "取消准备"}。`;
      next.log.push(next.lastMessage);
      break;
    }
    case "START_GAME": {
      assertPhase(next, "lobby");
      if (next.hostPlayerId !== action.playerId) throw new RuleError("只有房主可以开始游戏。", "NOT_OWNER");
      const participants = lobbyPlayers(next);
      if (participants.length < GAME_CONSTANTS.minPlayers) throw new RuleError(`至少需要 ${GAME_CONSTANTS.minPlayers} 人。`);
      if (participants.some((candidate) => !candidate.ready && candidate.id !== action.playerId)) throw new RuleError("还有玩家未准备。");
      setupGame(next);
      break;
    }
    case "ADVANCE_PHASE":
      advancePhase(next, player.id);
      break;
    case "BUY_BLACK_MARKET": {
      assertPhase(next, "blackMarket");
      const payload = action.payload as { kind: "trick" | "event" };
      buyBlackMarket(next, player, payload.kind);
      break;
    }
    case "SET_AUCTION": {
      const payload = action.payload as { mode: AuctionMode; startingBid?: number; bundleInnerMode?: BundleInnerMode; dutchStep?: number };
      if (next.phase === "preview") {
        if (next.currentHostId && next.currentHostId !== player.id) {
          throw new RuleError("当前拍卖方式由系统随机生成，只有当前主持人可以确认。", "NOT_HOST");
        }
        setAuction(next, payload.mode, payload.startingBid, payload.bundleInnerMode, payload.dutchStep);
      } else {
        updateAuctionStartingBid(next, player, payload.startingBid ?? 0, payload.dutchStep);
      }
      // 设置起拍价后立即进入拍卖阶段，无需再点"推进"
      if (next.phase === "cardWindow" && next.auction && next.auction.status === "choosing") {
        openAuction(next, player.id);
      }
      break;
    }
    case "PLACE_BID": {
      const payload = action.payload as { amount: number };
      placeBid(next, player, payload.amount);
      break;
    }
    case "PASS_BID":
      passBid(next, player);
      break;
    case "DUTCH_STOP":
      dutchStop(next, player);
      break;
    case "AUCTION_BID_TIMEOUT":
      if (next.auction && next.phase === "auction") {
        const bm = next.auction.mode === "bundle" ? next.auction.bundleInnerMode ?? "english" : next.auction.mode;
        if (bm === "english") checkAuctionBidDeadline(next, (action.payload as { now?: number })?.now);
      }
      break;
    case "SUBMIT_SEALED_BID": {
      const payload = action.payload as { amount: number };
      submitSealedBid(next, player, payload.amount);
      break;
    }
    case "PLAY_CARD": {
      const payload = action.payload as { cardId: string; targetArtifactId?: string; targetPlayerId?: string; amount?: number };
      playCard(next, player, payload);
      break;
    }
    case "USE_ROLE_SKILL": {
      const payload = action.payload as { skillId: string; targetArtifactId?: string; targetPlayerId?: string; targetMissionId?: string; invalidateMission?: boolean };
      useRoleSkill(next, player, payload);
      break;
    }
    case "RESPOND_REACTION": {
      const payload = action.payload as { reactionId: string; cardId?: CardId; targetPlayerId?: PlayerId; response: "counter" | "pass" };
      respondReaction(next, player, payload);
      break;
    }
    case "CREATE_TRADE_OFFER": {
      const payload = action.payload as { toPlayerId: PlayerId; give: TradeAssetSet; receive: TradeAssetSet; message?: string };
      createTradeOffer(next, player, payload);
      break;
    }
    case "RESPOND_TRADE_OFFER": {
      const payload = action.payload as { tradeOfferId: string; accept: boolean; version: number };
      respondTradeOffer(next, player, payload.tradeOfferId, payload.accept, payload.version);
      break;
    }
    case "SELL_TO_BANK": {
      const payload = action.payload as { artifactId: string };
      sellToBank(next, player, payload.artifactId);
      break;
    }
    case "TAKE_LOAN":
      takeLoan(next, player);
      break;
    case "REPAY_LOAN":
      repayLoan(next, player);
      break;
    case "RESOLVE_CHOICE": {
      const payload = action.payload as { effectId: string; choice: ChoiceResolution };
      resolveChoice(next, player, payload);
      break;
    }
    default:
      throw new RuleError("未知操作。");
  }

  next.actionIndex += 1;
  stamp(next, previousPhase);
  return next;
}

function handlePlayerDisconnected(state: MutableGame, player: PlayerState): void {
  if (state.hostPlayerId === player.id) {
    const nextOwner = activePlayers(state).find((candidate) => candidate.id !== player.id && candidate.connected);
    if (nextOwner) {
      state.hostPlayerId = nextOwner.id;
      state.log.push(`${nextOwner.nickname} 接任房主。`);
    }
  }
  if (state.currentHostId === player.id && state.phase !== "auction") {
    state.currentHostId = undefined;
    state.log.push("当前主持人离线，本日改为系统主持。");
  }
}

function autoAdvanceOfflinePlayer(state: MutableGame, player: PlayerState): void {
  if (player.connected) throw new RuleError("玩家仍在线，不能托管。", "NOT_ELIGIBLE");
  if (state.pendingReaction?.eligiblePlayerIds.includes(player.id)) {
    respondReaction(state, player, { reactionId: state.pendingReaction.id, response: "pass" });
    markAutomated(player, "自动放弃反制");
    state.lastMessage = `${player.nickname} 离线，系统已自动放弃反制。`;
    state.log.push(state.lastMessage);
    return;
  }
  if (state.phase !== "auction" || !state.auction) throw new RuleError("当前没有需要托管的操作。", "BAD_PHASE");
  const bidMode = state.auction.mode === "bundle" ? state.auction.bundleInnerMode ?? "english" : state.auction.mode;
  if (bidMode === "english" && state.currentHostId !== player.id && !state.auction.passedPlayerIds.includes(player.id)) {
    passBid(state, player);
    markAutomated(player, "自动退出英式竞拍");
    state.log.push(`${player.nickname} 离线，系统已自动退出英式竞拍。`);
    return;
  }
  if (bidMode === "sealed" && state.currentHostId !== player.id && !Object.prototype.hasOwnProperty.call(state.auction.sealedBids, player.id)) {
    submitSealedBid(state, player, 0);
    markAutomated(player, "自动提交 0 暗标");
    state.log.push(`${player.nickname} 离线，系统已自动提交 0 暗标。`);
    return;
  }
  throw new RuleError("当前没有需要托管的操作。", "BAD_PHASE");
}

function transferOwner(state: MutableGame, actor: PlayerState, targetPlayerId: PlayerId): void {
  assertRoomOwner(state, actor);
  if (actor.id === targetPlayerId) throw new RuleError("你已经是房主。", "BAD_TARGET");
  const target = requirePlayer(state, targetPlayerId);
  if (!target.connected) throw new RuleError("不能转让给离线玩家。", "BAD_TARGET");
  state.hostPlayerId = target.id;
  state.lastMessage = `${actor.nickname} 将房主转让给 ${target.nickname}。`;
  state.log.push(state.lastMessage);
}

function kickPlayer(state: MutableGame, actor: PlayerState, targetPlayerId: PlayerId): void {
  assertRoomOwner(state, actor);
  if (actor.id === targetPlayerId) throw new RuleError("不能踢出自己。", "BAD_TARGET");
  const target = requirePlayer(state, targetPlayerId);
  if (target.kicked) throw new RuleError("玩家已经被移出房间。", "BAD_TARGET");
  if (state.phase === "lobby") {
    state.players = state.players.filter((player) => player.id !== target.id).map((player, index) => ({ ...player, seat: index }));
    if (state.hostPlayerId === target.id) state.hostPlayerId = activePlayers(state)[0]?.id;
    state.lastMessage = `${actor.nickname} 将 ${target.nickname} 移出房间。`;
    state.log.push(state.lastMessage);
    return;
  }
  target.connected = false;
  target.kicked = true;
  target.ready = false;
  target.disconnectedAt = Date.now();
  handlePlayerDisconnected(state, target);
  state.lastMessage = `${actor.nickname} 将 ${target.nickname} 移出房间。`;
  state.log.push(state.lastMessage);
}

function setPhaseTimeouts(state: MutableGame, actor: PlayerState, timeouts: PhaseTimeouts): void {
  assertRoomOwner(state, actor);
  const nextTimeouts: PhaseTimeouts = { ...(state.phaseTimeouts ?? DEFAULT_PHASE_TIMEOUTS) };
  for (const [phase, value] of Object.entries(timeouts) as Array<[keyof PhaseTimeouts, number | undefined]>) {
    if (value === undefined) continue;
    const ms = Math.max(0, Math.min(30 * 60_000, Math.floor(value)));
    nextTimeouts[phase] = ms;
  }
  state.phaseTimeouts = nextTimeouts;
  touchPhaseTimer(state, Date.now(), true);
  state.lastMessage = `${actor.nickname} 更新了阶段倒计时设置。`;
  state.log.push(state.lastMessage);
}

function setPaused(state: MutableGame, actor: PlayerState, paused: boolean): void {
  const now = Date.now();
  if (paused) {
    if (state.paused) return;
    state.paused = true;
    state.pausedAt = now;
    state.pausedRemainingMs = state.phaseDeadlineAt ? Math.max(0, state.phaseDeadlineAt - now) : undefined;
    state.phaseDeadlineAt = undefined;
    state.lastMessage = `${actor.nickname} 暂停了房间。`;
    state.log.push(state.lastMessage);
    return;
  }
  if (!state.paused) return;
  const remaining = state.pausedRemainingMs;
  state.paused = false;
  state.pausedAt = undefined;
  state.pausedRemainingMs = undefined;
  if (remaining !== undefined) state.phaseDeadlineAt = now + remaining;
  state.lastMessage = `${actor.nickname} 恢复了房间。`;
  state.log.push(state.lastMessage);
}

function autoAdvancePhaseTimeout(state: MutableGame, actor: PlayerState): void {
  if (state.paused) throw new RuleError("房间已暂停。", "BAD_PHASE");
  if (!state.phaseDeadlineAt || Date.now() < state.phaseDeadlineAt) throw new RuleError("阶段还未超时。", "BAD_PHASE");
  const previousPhase = state.phase;
  if (state.pendingReaction?.eligiblePlayerIds.length) {
    for (const playerId of [...state.pendingReaction.eligiblePlayerIds]) {
      if (!state.pendingReaction) break;
      const responder = requirePlayer(state, playerId);
      respondReaction(state, responder, { reactionId: state.pendingReaction.id, response: "pass" });
      markAutomated(responder, "阶段超时自动放弃反制");
    }
    state.lastMessage = `${phaseLabel(previousPhase)}超时，系统已自动放弃反制。`;
    state.log.push(state.lastMessage);
    return;
  }
  if (state.phase === "preview") {
    setRandomAuction(state);
    state.lastMessage = `预展超时，系统随机生成${auctionModeLabel(state.auction?.mode ?? "english")}。`;
    state.log.push(state.lastMessage);
    return;
  }
  if (state.phase === "cardWindow") {
    advancePhase(state, actor.id);
    state.lastMessage = "锦囊/事件窗口超时，系统进入竞拍。";
    state.log.push(state.lastMessage);
    return;
  }
  if (state.phase === "auction" && state.auction) {
    const bidMode = state.auction.mode === "bundle" ? state.auction.bundleInnerMode ?? "english" : state.auction.mode;
    if (bidMode === "english") {
      for (const bidder of bidderPlayers(state)) {
        if (state.phase !== "auction") break;
        if (!state.auction?.passedPlayerIds.includes(bidder.id) && bidder.id !== state.auction.currentBidderId) {
          passBid(state, bidder);
          markAutomated(bidder, "阶段超时自动退出英式竞拍");
        }
      }
      // 有当前出价人则按最后出价成交，否则流拍
      if (state.phase === "auction") {
        if (state.auction.currentBidderId) {
          closeAuctionWithWinner(state, state.auction.currentBidderId, state.auction.currentBid);
        } else {
          closeAuctionAsUnsold(state);
        }
      }
    } else if (bidMode === "sealed") {
      for (const bidder of bidderPlayers(state)) {
        if (state.phase !== "auction") break;
        if (!Object.prototype.hasOwnProperty.call(state.auction?.sealedBids ?? {}, bidder.id)) {
          submitSealedBid(state, bidder, 0);
          markAutomated(bidder, "阶段超时自动提交 0 暗标");
        }
      }
      if (state.phase === "auction") closeAuctionAsUnsold(state);
    } else {
      closeAuctionAsUnsold(state, { forbidHostSelfBuy: true });
    }
    state.log.push(`${phaseLabel(previousPhase)}超时，系统完成托管。`);
    return;
  }
  if (canAdvance(state, actor.id) || state.hostPlayerId === actor.id || !state.currentHostId) {
    advancePhase(state, actor.id);
    state.log.push(`${phaseLabel(previousPhase)}超时，系统自动推进。`);
    return;
  }
  throw new RuleError("当前阶段不能自动推进。", "BAD_PHASE");
}

function assertRoomOwner(state: GameState, player: PlayerState): void {
  if (state.hostPlayerId !== player.id) throw new RuleError("只有房主可以管理房间。", "NOT_OWNER");
}

function markAutomated(player: PlayerState, reason: string): void {
  player.automatedAt = Date.now();
  player.automatedReason = reason;
}

function setupGame(state: MutableGame): void {
  const participatingPlayers = lobbyPlayers(state);
  if (participatingPlayers.length < GAME_CONSTANTS.minPlayers) throw new RuleError(`至少需要 ${GAME_CONSTANTS.minPlayers} 人。`);
  const rng = makeRng(`${state.roomId}:${state.joinCode}:${CONTENT_VERSION}`);
  const artifactTemplates = shuffled(ARTIFACT_TEMPLATES, rng);
  const totalFakeMod = todayEffects(state).reduce((sum, e) => sum + (e.fakeProbabilityMod ?? 0), 0);
  const effectiveFakeProb = Math.max(0, Math.min(1, 0.2 + totalFakeMod));
  const artifactEntries = artifactTemplates.map((template): [ArtifactId, ArtifactInstance] => {
    const value = randomTenInRange(template.rumorMin, template.rumorMax, rng);
    const isFake = rng() < effectiveFakeProb;
    const properties = isFake ? ["fake"] : drawProperties(template.propertyPool.filter((id) => id !== "fake"), rng);
    const tag = firstTag(properties);
    return [
      template.id,
      {
        ...template,
        trueValue: value,
        properties,
        tag,
        revealedTo: [],
        peekedBy: [],
        privatePeekedBy: []
      }
    ];
  });
  state.artifacts = Object.fromEntries(artifactEntries);
  state.deck = artifactTemplates.map((template) => template.id);
  state.trickDeck = shuffled(TRICK_CARDS.flatMap((card) => [card.id, card.id]), rng);
  state.eventDeck = shuffled(EVENT_CARDS.flatMap((card) => [card.id]), rng);
  state.discardPile = [];
  state.activeEffects = [];
  state.delayedCardEffects = [];
  state.tradeOffers = [];
  state.pendingReaction = undefined;
  state.stats = emptyStats();
  const missionDeck = shuffled(MISSIONS.map((mission) => mission.id), rng);
  const roleDeck = shuffled(ROLES.map((role) => role.id), rng);

  // 随机确定第一天主持人偏移（让开局主持人不是固定第一个玩家）
  state.startHostOffset = Math.floor(rng() * participatingPlayers.length);
  state.players = participatingPlayers.map((candidate, index) => {
    const role = roleDeck[index % roleDeck.length];
    const missionIds = [missionDeck[index * 2 % missionDeck.length], missionDeck[(index * 2 + 1) % missionDeck.length]].filter(Boolean) as string[];
    const roleDef = role ? roleById.get(role) : undefined;
    return {
      ...candidate,
      seat: index,
      ready: true,
      cash: GAME_CONSTANTS.startingCash,
      loans: 0,
      loanRepayments: [],
      hand: [draw(state.trickDeck), draw(state.trickDeck)].filter(Boolean) as string[],
      events: [draw(state.eventDeck)].filter(Boolean) as string[],
      artifacts: [],
      missionIds,
      missionId: missionIds[0],
      role: role
        ? {
            roleId: role,
            skillCharges: Object.fromEntries(
              (roleDef?.skills ?? [])
                .filter((skill) => typeof skill.charges === "number" || skill.id === "role09_skill03")
                .map((skill) => [skill.id, typeof skill.charges === "number" ? skill.charges : 1])
            )
          }
        : undefined,
      passed: false,
      blackMarketBuysToday: 0,
      loansTakenToday: 0
    };
  });
  for (const player of state.players) {
    if (player.role?.roleId === "role04") {
      player.cash += 150;
      state.log.push(`${player.nickname} 的《千金》生效，开局额外获得 150 银元。`);
    }
  }
  state.day = 1;
  state.phase = "dayIncome";
  state.currentHostId = hostForDay(state, state.day);
  state.todayArtifactIds = [];
  state.auction = undefined;
  state.lastMessage = "游戏开始。第 1 天晨间收入阶段。";
  state.log.push(state.lastMessage);
}

function advancePhase(state: MutableGame, actorId: PlayerId): void {
  if (state.paused) throw new RuleError("房间已暂停。", "BAD_PHASE");
  if (state.pendingReaction) throw new RuleError("等待反制响应。", "PENDING_REACTION");
  if (state.phase === "lobby") throw new RuleError("游戏尚未开始。", "BAD_PHASE");
  if (state.phase === "auction") throw new RuleError("拍卖中不能手动推进。", "BAD_PHASE");

  switch (state.phase) {
    case "dayIncome":
      resolveDayStartEffects(state);
      runIncome(state);
      state.phase = GAME_CONSTANTS.blackMarketDays.includes(state.day as 3 | 6 | 9) ? "blackMarket" : "preview";
      if (state.phase === "blackMarket") resolveBlackMarketStartEffects(state);
      if (state.phase === "preview") preparePreview(state);
      break;
    case "blackMarket":
      resolveFragileProtectionFees(state);
      state.phase = "preview";
      preparePreview(state);
      state.lastMessage = "黑市结束，进入预展。";
      state.log.push(state.lastMessage);
      break;
    case "preview":
      setRandomAuction(state);
      break;
    case "cardWindow": {
      openAuction(state, actorId);
      break;
    }
    case "settlement":
      if (hasRemainingAuctionArtifact(state)) startNextArtifactAuction(state);
      else {
        state.phase = "eventWindow";
        state.lastMessage = "今日拍卖结算完成，进入事件窗口。";
        state.log.push(state.lastMessage);
      }
      break;
    case "eventWindow":
      maybeTriggerNaturalEvent(state);
      state.phase = "freeTrade";
      resolveBuybacks(state);
      if (state.day >= state.maxDays) prepareProp31DonationChoices(state);
      state.lastMessage = "事件窗口结束，进入自由交易。";
      state.log.push(state.lastMessage);
      break;
    case "freeTrade":
      resolveConsignmentListings(state);
      resolveDayEndEffects(state);
      if (state.day >= state.maxDays) {
        finalizeScores(state);
        state.phase = "finalScoring";
        state.lastMessage = "终局结算完成。";
        state.log.push(state.lastMessage);
      } else {
        state.day += 1;
        state.currentHostId = hostForDay(state, state.day);
        state.todayArtifactIds = [];
        state.auction = undefined;
        state.players.forEach((candidate) => {
          candidate.passed = false;
          candidate.blackMarketBuysToday = 0;
          candidate.loansTakenToday = 0;
          candidate.tradesToday = 0;
          resetDailyRoleSkillCharges(candidate);
        });
        expireFinishedEffects(state);
        state.phase = "dayIncome";
        state.lastMessage = `进入第 ${state.day} 天。`;
        state.log.push(state.lastMessage);
      }
      break;
    case "finalScoring":
      throw new RuleError("游戏已经结束。", "BAD_PHASE");
    case "setup":
      state.phase = "dayIncome";
      break;
  }
}

function runIncome(state: MutableGame): void {
  const incomeLogs: string[] = [];
  const incomeRolls: IncomeRollResult[] = [];
  for (const player of state.players) {
    const firstRoll = rollIncomeDie();
    const secondRoll = player.role?.roleId === "role05" ? rollIncomeDie() : undefined;
    const chosenRoll = secondRoll === undefined ? firstRoll : Math.max(firstRoll, secondRoll);
    const multiplier = Math.max(1, ...todayEffects(state, "E28").map((effect) => effect.incomeMultiplier ?? 1));
    const perPip = player.role?.roleId === "role05" && player.cash < 50 ? 15 : GAME_CONSTANTS.incomePerPip;
    let amount = chosenRoll * perPip * multiplier;
    amount += todayEffects(state).reduce((sum, effect) => sum + (effect.incomeBonus ?? 0), 0);
    player.cash += amount;
    incomeRolls.push({ playerId: player.id, nickname: player.nickname, roll: firstRoll, reroll: secondRoll, chosenRoll, amount });
    incomeLogs.push(`${player.nickname}${secondRoll === undefined ? `掷出 ${firstRoll}` : `掷出 ${firstRoll} 和 ${secondRoll}，取较高值 ${chosenRoll}`}，收入 ${amount} 银元`);
  }
  state.lastIncomeRolls = incomeRolls;
  state.lastMessage = `第 ${state.day} 天晨间收入：${incomeLogs.join("；")}。`;
  state.log.push(state.lastMessage);
}

function resolveDayStartEffects(state: MutableGame): void {
  if (hasTodayEffect(state, "E11")) {
    for (const player of state.players) {
      if (player.cash < 100) {
        player.cash += 40;
        state.log.push(`《资金冻结》补助 ${player.nickname} 40 银元。`);
      }
    }
  }
  if (hasTodayEffect(state, "E18")) {
    for (const player of state.players) {
      const payment = Math.min(30, player.cash);
      player.cash -= payment;
    }
    state.log.push("《银根紧缩》生效：每位玩家晨间支付最多 30 银元。");
  }
}

function resolveDayEndEffects(state: MutableGame): void {
  if (hasTodayEffect(state, "E09")) {
    for (const player of state.players) {
      const categoryCount = new Set(player.artifacts.map((id) => requireArtifact(state, id).category)).size;
      if (categoryCount >= 3) {
        player.cash += 30;
        state.log.push(`《收藏展邀约》奖励 ${player.nickname} 30 银元。`);
      }
    }
  }
}

function resolveChoice(state: MutableGame, player: PlayerState, payload: { effectId: string; choice: ChoiceResolution }): void {
  const effectIndex = state.activeEffects.findIndex((e) => e.id === payload.effectId && canResolveChoice(e, player.id));
  if (effectIndex === -1) throw new RuleError("未找到对应的待定选择。", "INVALID_ACTION");
  const effect = state.activeEffects[effectIndex]!;
  if (effect.day !== undefined && effect.day > state.day) throw new RuleError("还未到处理这个选择的时机。", "BAD_PHASE");

  if (effect.choiceType === "C03_buyback") {
    const artifact = requireArtifact(state, effect.targetArtifactId);
    const price = effect.amount ?? 0;
    if (payload.choice === "accept") {
      if (artifact.ownerId) throw new RuleError("该藏品已不在银行，无法回购。", "BAD_TARGET");
      if (player.cash < price) throw new RuleError("现金不足，无法回购。", "CASH_LOW");
      player.cash -= price;
      assignArtifactToPlayer(state, player, artifact, { purchasePrice: price });
      state.log.push(`${player.nickname} 以 ${price} 银元回购《${artifact.name}》。`);
      pushPrivateLog(state, player.id, `你的《回购凭证》生效，以 ${price} 银元买回《${artifact.name}》。`);
    } else {
      pushPrivateLog(state, player.id, `你放弃回购《${artifact.name}》。`);
      state.log.push(`${player.nickname} 放弃回购《${artifact.name}》。`);
    }
    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "C04_listing") {
    const seller = requirePlayer(state, effect.createdBy);
    if (seller.id === player.id) throw new RuleError("不能购买自己的寄售藏品。", "BAD_TARGET");
    const artifact = requireArtifact(state, effect.targetArtifactId);
    const price = effect.amount ?? 0;
    if (artifact.ownerId !== seller.id || !seller.artifacts.includes(artifact.id)) throw new RuleError("寄售藏品已不在卖方手中。", "BAD_TARGET");
    if (payload.choice !== "accept") throw new RuleError("寄售藏品只能选择购买。", "BAD_TARGET");
    if (player.cash < price) throw new RuleError("现金不足，无法购买寄售藏品。", "CASH_LOW");
    player.cash -= price;
    seller.cash += price + 20;
    removeArtifactFromPlayer(state, seller, artifact);
    assignArtifactToPlayer(state, player, artifact, { purchasePrice: price });
    addStat(state.stats.playerTradeCount, seller.id, 1);
    addStat(state.stats.playerTradeCount, player.id, 1);
    state.log.push(`${player.nickname} 买下 ${seller.nickname} 寄售的《${artifact.name}》，${seller.nickname} 额外获得 20 银元寄售奖金。`);
    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "D02_refusal") {
    const attacker = requirePlayer(state, effect.createdBy);
    const artifact = requireArtifact(state, effect.targetArtifactId);
    if (payload.choice === "pay") {
      const penalty = Math.min(effect.amount ?? 20, player.cash);
      player.cash -= penalty;
      attacker.cash += penalty;
      state.log.push(`${player.nickname} 拒绝巧取豪夺，支付 ${penalty} 银元给 ${attacker.nickname}。`);
    } else if (payload.choice === "reveal") {
      for (const candidate of activePlayers(state)) revealArtifactTo(artifact, candidate.id);
      state.log.push(`${player.nickname} 拒绝巧取豪夺，公开展示《${artifact.name}》的属性。`);
    } else {
      throw new RuleError("巧取豪夺拒绝后只能选择付钱或展示属性。", "BAD_TARGET");
    }
    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "E25_protection_fee") {
    const qualifyingArtifacts = playerArtifacts(state, player).filter(
      (a) => ["relic", "evil", "curio"].includes(a.category)
    );

    if (payload.choice === "pay") {
      const fee = qualifyingArtifacts.length * 10;
      const paid = Math.min(fee, player.cash);
      player.cash -= paid;

      if (paid < fee) {
        state.log.push(`${player.nickname} 现金不足，仅支付了 ${paid}/${fee} 银元保护费，灵异藏品仍受 -20% 影响。`);
        // Partial payment = no protection, penalty stays from the global E25 effect
      } else {
        // Full payment: create compensating +25% effects to cancel the global -20%
        for (const artifact of qualifyingArtifacts) {
          if (artifact.dayAcquired === state.day) {
            state.activeEffects.push({
              id: makeId("effect"),
              sourceEventId: "E25",
              label: `灵异恐惧保护费已付 - ${artifact.name}`,
              appliesTo: "finalValue",
              multiplier: 1.25,
              targetArtifactId: artifact.id,
              day: state.day,
              createdBy: player.id
            });
          }
        }
        state.log.push(`${player.nickname} 支付了 ${fee} 银元保护费，灵异藏品不受灵异恐惧影响。`);
      }
    } else {
      // choice === "accept": global -20% effect applies, nothing extra needed
      state.log.push(`${player.nickname} 选择接受灵异恐惧价值 -20%。`);
    }

    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "n1_mystery_buyer") {
    const category = effect.category;
    if (!category) {
      state.activeEffects.splice(effectIndex, 1);
      state.log.push(`${player.nickname} 的神秘收购选择因缺少类别信息已忽略。`);
      return;
    }

    const qualifyingArtifacts = playerArtifacts(state, player).filter(
      (a) => a.category === category
    );

    if (payload.choice === "sell") {
      let totalCash = 0;
      for (const artifact of qualifyingArtifacts) {
        const price = artifact.rumorMax;
        totalCash += price;
        removeArtifactFromPlayer(state, player, artifact);
        pushPrivateLog(state, player.id, `《神秘收购》以 ${price} 银元收购《${artifact.name}》。`);
      }
      player.cash += totalCash;
      state.log.push(`${player.nickname} 选择卖出 ${qualifyingArtifacts.length} 件${categoryLabel(category)}类藏品，获得 ${totalCash} 银元。`);
    } else {
      // choice === "reject"
      player.reputationBonus = (player.reputationBonus ?? 0) + 1;
      state.log.push(`${player.nickname} 拒绝神秘收购，获得 1 声望。`);
    }

    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "role01_skill01_choice") {
    const artifactId = effect.targetArtifactId;
    if (artifactId) {
      const artifact = requireArtifact(state, artifactId);
      if (payload.choice === "rumorRange") {
        if (!artifact.peekedBy.includes(player.id)) artifact.peekedBy.push(player.id);
        pushPrivateLog(state, player.id, `《慧眼》结果：查看《${artifact.name}》的传闻区间为 ${artifact.rumorMin} - ${artifact.rumorMax} 银元。`);
        state.log.push(`${player.nickname} 使用《慧眼》查看《${artifact.name}》的传闻区间。`);
      } else if (payload.choice === "attribute") {
        if (!artifact.revealedTo.includes(player.id)) artifact.revealedTo.push(player.id);
        const propNames = artifact.properties.map((id) => propertyView(id)).filter(isDefined).map((p) => p.name).join("、") || "无";
        pushPrivateLog(state, player.id, `《慧眼》结果：查看《${artifact.name}》的属性为${propNames}。`);
        state.log.push(`${player.nickname} 使用《慧眼》查看《${artifact.name}》的属性。`);
      }
    }
    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "role03_skill02_swap") {
    const initiator = requirePlayer(state, effect.createdBy);
    const myArtifact = requireArtifact(state, effect.targetArtifactId);
    const theirArtifact = requireArtifact(state, effect.additionalTargetArtifactId);
    if (!myArtifact || !theirArtifact) throw new RuleError("以物换物涉及的一件藏品已不存在。", "BAD_TARGET");

    if (payload.choice === "accept") {
      // 双方仍有这些藏品
      if (!initiator.artifacts.includes(myArtifact.id)) throw new RuleError("发起方已没有这件藏品。", "BAD_TARGET");
      if (!player.artifacts.includes(theirArtifact.id)) throw new RuleError("你已没有这件藏品。", "BAD_TARGET");
      // 执行交换
      removeArtifactFromPlayer(state, initiator, myArtifact);
      removeArtifactFromPlayer(state, player, theirArtifact);
      assignArtifactToPlayer(state, initiator, theirArtifact);
      assignArtifactToPlayer(state, player, myArtifact);
      addStat(state.stats.playerTradeCount, initiator.id, 1);
      addStat(state.stats.playerTradeCount, player.id, 1);
      state.log.push(`${initiator.nickname} 与 ${player.nickname} 以物换物成功：《${myArtifact.name}》⇄《${theirArtifact.name}》。`);
    } else {
      state.log.push(`${player.nickname} 拒绝了 ${initiator.nickname} 的以物换物请求。`);
    }
    state.activeEffects.splice(effectIndex, 1);
    return;
  }

  if (effect.choiceType === "prop31_donation") {
    const artifact = requireArtifact(state, effect.targetArtifactId);
    if (payload.choice === "accept") {
      if (!player.artifacts.includes(artifact.id)) throw new RuleError("你没有这件藏品。", "NOT_OWNER");
      removeArtifactFromPlayer(state, player, artifact);
      state.activeEffects.push({
        id: makeId("effect"),
        sourceRoleSkillId: "prop31_donated",
        label: `慈善捐赠：${player.nickname} 已弃置《${artifact.name}》，终局现金按每 30 银元兑换 1 声望。`,
        appliesTo: "cash",
        day: state.day,
        createdBy: player.id
      });
      state.log.push(`${player.nickname} 主动捐赠《${artifact.name}》，终局现金兑换改为每 30 银元 1 声望。`);
    } else {
      pushPrivateLog(state, player.id, `你保留《${artifact.name}》，不触发慈善捐赠。`);
    }
    state.activeEffects.splice(effectIndex, 1);
    return;
  }
}

function canResolveChoice(effect: ActiveEffect, playerId: PlayerId): boolean {
  if (!effect.pendingChoice) return false;
  if (effect.choiceType === "C04_listing") return effect.createdBy !== playerId;
  if (effect.choiceType === "role01_skill01_choice" || effect.choiceType === "I02_upper_lower") return effect.createdBy === playerId;
  return effect.targetPlayerId === playerId;
}

function resolveAllPendingChoices(state: MutableGame): void {
  const pending = state.activeEffects.filter((e) => e.pendingChoice);
  for (const effect of pending) {
    if (effect.choiceType === "E25_protection_fee" && effect.targetPlayerId) {
      const target = state.players.find((p) => p.id === effect.targetPlayerId);
      if (target) {
        state.log.push(`${target.nickname} 未在时限内选择，自动接受灵异恐惧价值 -20%。`);
      }
    }
    if (effect.choiceType === "n1_mystery_buyer" && effect.targetPlayerId) {
      const target = state.players.find((p) => p.id === effect.targetPlayerId);
      if (target) {
        target.reputationBonus = (target.reputationBonus ?? 0) + 1;
        state.log.push(`${target.nickname} 未在时限内选择，自动拒绝神秘收购，获得 1 声望。`);
      }
    }
    if (effect.choiceType === "D02_refusal" && effect.targetPlayerId) {
      const target = state.players.find((p) => p.id === effect.targetPlayerId);
      const attacker = state.players.find((p) => p.id === effect.createdBy);
      if (target && attacker) {
        const penalty = Math.min(effect.amount ?? 20, target.cash);
        target.cash -= penalty;
        attacker.cash += penalty;
        state.log.push(`${target.nickname} 未选择巧取豪夺拒绝代价，自动支付 ${penalty} 银元给 ${attacker.nickname}。`);
      }
    }
    if (effect.choiceType === "C03_buyback" && effect.targetPlayerId) {
      const target = state.players.find((p) => p.id === effect.targetPlayerId);
      if (target && effect.targetArtifactId) {
        const artifact = state.artifacts[effect.targetArtifactId];
        state.log.push(`${target.nickname} 未选择回购，放弃《${artifact?.name ?? effect.targetArtifactId}》。`);
      }
    }
    if (effect.choiceType === "prop31_donation" && effect.targetPlayerId) {
      const target = state.players.find((p) => p.id === effect.targetPlayerId);
      if (target && effect.targetArtifactId) {
        const artifact = state.artifacts[effect.targetArtifactId];
        state.log.push(`${target.nickname} 未选择慈善捐赠，保留《${artifact?.name ?? effect.targetArtifactId}》。`);
      }
    }
    if (effect.choiceType === "role03_skill02_swap" && effect.targetPlayerId) {
      const target = state.players.find((p) => p.id === effect.targetPlayerId);
      const initiator = state.players.find((p) => p.id === effect.createdBy);
      if (target && initiator) {
        state.log.push(`${target.nickname} 超时未回应，${initiator.nickname} 的以物换物请求自动取消。`);
      }
    }
    state.activeEffects = state.activeEffects.filter((e) => e.id !== effect.id);
  }
}

function resolveFragileProtectionFees(state: MutableGame): void {
  const fragileProtectionDelta = todayEffects(state).reduce((sum, effect) => sum + (effect.fragileProtectionDelta ?? 0), 0);
  const baseFee = 5 + fragileProtectionDelta;
  for (const player of state.players) {
    const hasC07Waiver = state.activeEffects.some((effect) => effect.sourceCardId === "C07" && effect.createdBy === player.id && effect.day === state.day);
    for (const artifactId of [...player.artifacts]) {
      const artifact = requireArtifact(state, artifactId);
      if (!artifact.properties.includes("fragile") || player.role?.roleId === "role07") continue;
      if (hasC07Waiver) {
        state.activeEffects = state.activeEffects.filter((effect) => !(effect.sourceCardId === "C07" && effect.createdBy === player.id && effect.day === state.day));
        state.log.push(`${player.nickname} 的《护宝符》生效，免除《${artifact.name}》的易损保护费。`);
        continue;
      }
      const payment = Math.min(baseFee, player.cash);
      player.cash -= payment;
      if (payment < baseFee) {
        removeArtifactFromPlayer(state, player, artifact);
        state.log.push(`《${artifact.name}》的"易损"未付足保护费，被弃置。`);
      } else {
        state.log.push(`${player.nickname} 为《${artifact.name}》支付"易损"保护费 ${baseFee} 银元。`);
      }
    }
  }
}

function resolveBlackMarketStartEffects(state: MutableGame): void {
  const familiarRoute = todayEffects(state, "E06")[0];
  if (familiarRoute) {
    for (const player of state.players) {
      const cardId = draw(state.trickDeck);
      if (cardId) {
        player.hand.push(cardId);
        state.log.push(`《熟人门路》生效，${player.nickname} 免费获得 1 张锦囊。`);
      }
    }
    familiarRoute.blackMarketBlockTricks = true;
  }
  for (const player of state.players) {
    const bonus = playerArtifacts(state, player).filter((artifact) => artifact.properties.includes("prop09")).length * 10;
    if (bonus > 0) {
      player.cash += bonus;
      state.log.push(`${player.nickname} 的"钱能通神"生效，黑市额外获得 ${bonus} 银元。`);
    }
  }
}

function expireFinishedEffects(state: MutableGame): void {
  state.activeEffects = state.activeEffects.filter((effect) => effect.day === undefined || effect.day >= state.day);
}

function totalFakeProbabilityMod(state: GameState): number {
  return todayEffects(state).reduce((sum, e) => sum + (e.fakeProbabilityMod ?? 0), 0);
}

function adjustArtifactFakeStatusForDayEffects(state: MutableGame): void {
  const fakeMod = totalFakeProbabilityMod(state);
  if (fakeMod === 0) return;
  const baseProb = 0.2;
  const effectiveProb = Math.max(0, Math.min(1, baseProb + fakeMod));
  const rng = makeRng(`${state.roomId}:fake:${state.day}`);
  for (const artifactId of state.todayArtifactIds) {
    const artifact = requireArtifact(state, artifactId);
    const isCurrentlyFake = isFakeArtifact(artifact);
    const shouldBeFake = rng() < effectiveProb;
    if (isCurrentlyFake === shouldBeFake) continue;
    if (shouldBeFake) {
      artifact.properties = ["fake"];
      artifact.tag = "fake";
    } else {
      artifact.properties = artifact.properties.filter((p) => p !== "fake");
      if (artifact.properties.length === 0) {
        const pool = (artifact.propertyPool ?? []).filter((id) => id !== "fake");
        artifact.properties = drawProperties(pool, () => rng());
      }
      artifact.tag = firstTag(artifact.properties);
    }
  }
}

function preparePreview(state: MutableGame): void {
  if (state.todayArtifactIds.length === 0) {
    state.todayArtifactIds = [draw(state.deck), draw(state.deck)].filter(Boolean) as ArtifactId[];
  }
  adjustArtifactFakeStatusForDayEffects(state);
  state.currentHostId = hostForDay(state, state.day);
  state.auction = undefined;
  applyPreviewEventEffects(state);
}

function applyPreviewEventEffects(state: MutableGame): void {
  if (hasTodayEffect(state, "E02") && state.todayArtifactIds[0]) {
    const artifact = requireArtifact(state, state.todayArtifactIds[0]);
    for (const player of state.players) {
      if (!artifact.peekedBy.includes(player.id)) artifact.peekedBy.push(player.id);
    }
    state.log.push("《报纸头条》生效：所有人获得第一件拍品的故事线索。");
  }
  if (hasTodayEffect(state, "E19")) {
    for (const artifactId of state.todayArtifactIds) {
      const artifact = requireArtifact(state, artifactId);
      for (const player of state.players) {
        if (!artifact.peekedBy.includes(player.id)) artifact.peekedBy.push(player.id);
      }
    }
    state.log.push("《透明市场》生效：当天拍品传闻区间对所有人公开。");
  }
}

function normalizeDutchStep(step?: number): number {
  if (step === undefined) return GAME_CONSTANTS.dutchStep;
  const nextStep = Math.floor(step);
  if (nextStep <= 0 || nextStep % 10 !== 0) throw new RuleError("荷兰式降价幅度必须是大于 0 的 10 的整数倍。", "INVALID_ACTION");
  return nextStep;
}

function setAuction(state: MutableGame, mode: AuctionMode, startingBid = 0, bundleInnerMode: BundleInnerMode = "english", dutchStep?: number): void {
  if (state.todayArtifactIds.length === 0) preparePreview(state);
  const chosenMode = mode;
  const selectedArtifactIds = chosenMode === "bundle" ? state.todayArtifactIds : [state.todayArtifactIds[0]!];
  const auctionMode = chosenMode === "bundle" ? bundleInnerMode : chosenMode;
  const bidCeiling = auctionBidCeilingForArtifactIds(state, selectedArtifactIds);
  const rng = makeRng(`${state.roomId}:${state.day}:${state.actionIndex}:dutch-start:${chosenMode}:${bundleInnerMode}`);
  const resolvedDutchStep = normalizeDutchStep(dutchStep);
  let clampedBid =
    auctionMode === "dutch"
      ? randomDutchStartingBid(state, selectedArtifactIds, rng)
      : Math.min(bidCeiling, roundToTen(Math.max(0, Math.floor(startingBid))));
  const artifactIds = chosenMode === "bundle" ? state.todayArtifactIds : selectedArtifactIds;
  state.auction = {
    id: makeId("auction"),
    artifactIds,
    mode: chosenMode,
    bundleInnerMode: chosenMode === "bundle" ? bundleInnerMode : undefined,
    currentArtifactIndex: 0,
    status: "choosing",
    currentBid: clampedBid,
    dutchStep: auctionMode === "dutch" ? resolvedDutchStep : undefined,
    minimumIncrement: hasTodayEffect(state, "E20") && auctionMode !== "sealed" ? 30 : GAME_CONSTANTS.englishIncrement,
    passedPlayerIds: [],
    sealedBids: {},
    sealedBidRounds: {},
    bidCounts: {},
    highestBids: {}
  };
  state.players.forEach((candidate) => {
    candidate.passed = false;
  });
  state.phase = "cardWindow";
  state.lastMessage = `今日随机拍卖方式：${auctionModeLabel(chosenMode)}。`;
  state.log.push(state.lastMessage);
}

/**
 * 打开拍卖（cardWindow→auction 阶段转换），荷兰式同时初始化降价计时器
 */
function openAuction(state: MutableGame, actorId: PlayerId): void {
  const auction = requireAuction(state);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (state.currentHostId && actorId === state.currentHostId && bidMode !== "sealed") {
    const ceiling = auctionBidCeilingForArtifactIds(state, currentAuctionArtifacts(state).map((artifact) => artifact.id));
    if (auction.currentBid < 0 || auction.currentBid > ceiling) throw new RuleError("当前起拍价不合法。", "INVALID_ACTION");
  }
  auction.status = "open";
  if (bidMode === "dutch") {
    const startPrice =
      auction.currentBid ||
      randomDutchStartingBid(state, auction.artifactIds, makeRng(`${state.roomId}:${state.day}:${state.actionIndex}:dutch-open`));
    auction.dutch = {
      startPrice,
      currentPrice: startPrice,
      step: auction.dutchStep ?? GAME_CONSTANTS.dutchStep,
      tickMs: GAME_CONSTANTS.dutchTickMs,
      startedAt: Date.now(),
      nextDropAt: Date.now() + GAME_CONSTANTS.dutchTickMs
    };
    auction.currentBid = startPrice;
  }
  state.phase = "auction";
  state.lastMessage = "竞拍开始。";
  state.log.push(state.lastMessage);
}

function setRandomAuction(state: MutableGame): void {
  // 无主持人日强制英式拍卖（系统起拍价=0，加价10银元）
  if (!state.currentHostId) {
    setAuction(state, "english", 0, "english");
    return;
  }
  const rng = makeRng(`${state.roomId}:${state.day}:${state.actionIndex}:auction`);
  const mode = pick<AuctionMode>(["english", "dutch", "sealed", "bundle"], rng);
  const bundleInnerMode = mode === "bundle" ? pick<BundleInnerMode>(["english", "dutch", "sealed"], rng) : "english";
  setAuction(state, mode, 0, bundleInnerMode);
}

function updateAuctionStartingBid(state: MutableGame, player: PlayerState, startingBid: number, dutchStep?: number): void {
  assertPhase(state, "cardWindow");
  const auction = requireAuction(state);
  if (!state.currentHostId || state.currentHostId !== player.id) throw new RuleError("只有当前主持人可以设置起拍价。", "NOT_HOST");
  if (auction.status !== "choosing") throw new RuleError("当前拍卖已经开始，不能再修改起拍价。", "AUCTION_CLOSED");
  const artifactIds = currentAuctionArtifacts(state).map((artifact) => artifact.id);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  const ceiling = auctionBidCeilingForArtifactIds(state, artifactIds);
  const nextBid = Math.max(0, roundToTen(Math.floor(startingBid)));
  if (nextBid > ceiling) throw new RuleError("起拍价不能超过当前拍品价格区间最高值。", "INVALID_ACTION");
  if (bidMode === "sealed") {
    auction.currentBid = 0;
    state.lastMessage = `${player.nickname} 已确认本场为${auctionModeLabel(auction.mode)}，暗标拍卖不设置公开起拍价。`;
    state.log.push(state.lastMessage);
    return;
  }
  auction.currentBid = nextBid;
  if (bidMode === "dutch") {
    auction.dutchStep = normalizeDutchStep(dutchStep);
    auction.dutch = undefined;
    state.lastMessage = `${player.nickname} 将荷兰式起拍价设置为 ${nextBid} 银元。`;
  } else {
    state.lastMessage = `${player.nickname} 将起拍价设置为 ${nextBid} 银元。`;
  }
  state.log.push(state.lastMessage);
}

function randomDutchStartingBid(state: GameState, artifactIds: ArtifactId[], rng: () => number): number {
  const ceiling = auctionBidCeilingForArtifactIds(state, artifactIds);
  const maxStart = ceiling + 50; // 起拍价可至多半高出传闻最高价 50 银元
  // E20 富豪入场：荷兰式起拍价至少为传闻最高值 +30
  const e20Active = todayEffects(state).some((e) => e.sourceEventId === "E20");
  const floor = e20Active ? Math.max(0, ceiling - 30) + 30 : Math.max(0, ceiling - 30);
  return randomTenInRange(Math.min(floor, maxStart), maxStart, rng);
}

function announceEnglishBid(state: MutableGame, player: PlayerState, amount: number): void {
  const names = currentAuctionArtifacts(state).map((artifact) => `《${artifact.name}》`).join("、");
  state.lastMessage = `${player.nickname} 出价 ${amount} 银元，将以 ${amount} 银元买下 ${names}，15 秒内无人加价则成交。`;
  state.log.push(state.lastMessage);
}

function placeBid(state: MutableGame, player: PlayerState, amount: number, now = Date.now()): void {
  assertPhase(state, "auction");
  const auction = requireAuction(state);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (bidMode !== "english") throw new RuleError("当前不是英式拍卖。", "BAD_PHASE");
  if (auction.status !== "open") throw new RuleError("拍卖尚未开始。", "AUCTION_CLOSED");
  assertNonHostBidder(state, player);
  if (isBlockedByCard(state, player, "D07", currentAuctionArtifact(state).id)) throw new RuleError("你本日不能对该藏品出价。", "NOT_ELIGIBLE");
  if (auction.passedPlayerIds.includes(player.id)) throw new RuleError("你已经退出当前竞拍。");
  const nextAmount = Math.floor(amount);
  if (nextAmount % 10 !== 0) throw new RuleError("出价必须为 10 的倍数。", "BID_TOO_LOW");
  const minimumAllowed = auction.currentBidderId ? auction.currentBid + auction.minimumIncrement : auction.currentBid > 0 ? auction.currentBid : auction.minimumIncrement;
  if (nextAmount < minimumAllowed) throw new RuleError(`至少需要出价 ${minimumAllowed}。`, "BID_TOO_LOW");
  const ceiling = auctionBidCeilingForArtifactIds(state, currentAuctionArtifacts(state).map((artifact) => artifact.id));
  if (nextAmount > ceiling) throw new RuleError("当前出价已达到本拍品的主持叫价上限。", "INVALID_ACTION");
  const tax = previewBidTax(state, player);
  if (nextAmount + tax > player.cash) throw new RuleError("现金不足。", "CASH_LOW");
  commitBidTax(state, player, tax);
  if (tax > 0) {
    player.cash -= tax;
    state.log.push(`《竞拍税》生效，${player.nickname} 支付 ${tax} 银元。`);
  }
  recordAuctionBid(auction, player.id, nextAmount);
  bindPendingBidEffect(state, player.id, "B01", currentAuctionArtifact(state).id);
  auction.currentBid = nextAmount;
  auction.currentBidderId = player.id;
  // 英式拍卖 15 秒倒计时：出价后重置倒计时
  auction.bidDeadline = now + 15000;
  announceEnglishBid(state, player, nextAmount);
  pushPrivateLog(state, player.id, `你对《${currentAuctionArtifact(state).name}》出价 ${nextAmount} 银元${tax > 0 ? `，并额外支付竞拍税 ${tax} 银元` : ""}。`);
}

function passBid(state: MutableGame, player: PlayerState): void {
  assertPhase(state, "auction");
  const auction = requireAuction(state);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (bidMode !== "english") throw new RuleError("当前模式不能用英式退出。");
  assertNonHostBidder(state, player);
  if (!auction.passedPlayerIds.includes(player.id)) {
    auction.passedPlayerIds.push(player.id);
    player.passed = true;
  }
  // 不再立即结算——等待 15 秒倒计时（由 AUCTION_BID_TIMEOUT 处理）
  state.lastMessage = `${player.nickname} 退出竞拍。`;
  state.log.push(state.lastMessage);
  const immediate = immediateEnglishResolution(state);
  if (immediate?.winnerId) {
    closeAuctionWithWinner(state, immediate.winnerId, state.auction!.currentBid);
  } else if (immediate?.unsold) {
    closeAuctionAsUnsold(state);
  }
}

/** 英式拍卖 15 秒倒计时到期检查 */
function checkAuctionBidDeadline(state: MutableGame, now = Date.now()): void {
  if (state.phase !== "auction" || !state.auction) return;
  const bidMode = state.auction.mode === "bundle" ? state.auction.bundleInnerMode ?? "english" : state.auction.mode;
  if (bidMode !== "english") return;
  if (state.auction.status !== "open") return;
  if (!state.auction.bidDeadline || now < state.auction.bidDeadline) return;
  // 倒计时到期：有当前出价人则成交，否则流拍
  if (state.auction.currentBidderId) {
    closeAuctionWithWinner(state, state.auction.currentBidderId, state.auction.currentBid);
    state.log.push("英式拍卖倒计时结束，当前最高出价成交。");
  } else {
    closeAuctionAsUnsold(state);
    state.log.push("英式拍卖倒计时结束，无人继续出价，拍品流拍。");
  }
}

export function tickDutchAuction(state: MutableGame, now = Date.now()): void {
  if (state.phase !== "auction" || !state.auction) return;
  const auction = state.auction;
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (bidMode !== "dutch" || auction.status !== "open" || !auction.dutch) return;
  if (now < auction.dutch.nextDropAt) return;
  const nextPrice = Math.max(0, auction.dutch.currentPrice - auction.dutch.step);
  auction.dutch.currentPrice = nextPrice;
  auction.currentBid = nextPrice;
  auction.dutch.startedAt = now;
  auction.dutch.nextDropAt = now + auction.dutch.tickMs;
  if (nextPrice <= 0) {
    state.log.push("荷兰式拍卖价格已降至 0，拍品自动流拍。");
    closeAuctionAsUnsold(state, { forbidHostSelfBuy: true });
    return;
  }
  state.lastMessage = `荷兰式拍卖降价至 ${nextPrice} 银元，5 秒后继续降价。`;
  state.log.push(state.lastMessage);
}

function dutchStop(state: MutableGame, player: PlayerState): void {
  assertPhase(state, "auction");
  const auction = requireAuction(state);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (bidMode !== "dutch") throw new RuleError("当前不是荷兰式拍卖。");
  if (auction.status !== "open") throw new RuleError("拍卖已经结束。", "AUCTION_CLOSED");
  assertNonHostBidder(state, player);
  if (isBlockedByCard(state, player, "D07", currentAuctionArtifact(state).id)) throw new RuleError("你本日不能对该藏品出价。", "NOT_ELIGIBLE");
  const currentPrice = currentDutchPrice(auction);
  if (auction.dutch) auction.dutch.currentPrice = currentPrice;
  auction.currentBid = currentPrice;
  if (currentPrice <= 0) {
    closeAuctionAsUnsold(state, { forbidHostSelfBuy: true });
    return;
  }
  if (currentPrice > player.cash) throw new RuleError("现金不足。", "CASH_LOW");
  recordAuctionBid(auction, player.id, currentPrice);
  pushPrivateLog(state, player.id, `你喊停荷兰式拍卖，以 ${currentPrice} 银元竞买《${currentAuctionArtifacts(state).map((artifact) => artifact.name).join("》《")}》。`);
  closeAuctionWithWinner(state, player.id, currentPrice);
}

function submitSealedBid(state: MutableGame, player: PlayerState, amount: number): void {
  assertPhase(state, "auction");
  const auction = requireAuction(state);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "sealed" : auction.mode;
  if (bidMode !== "sealed") throw new RuleError("当前不是暗标拍卖。");
  assertNonHostBidder(state, player);
  if (auction.status !== "open" && auction.status !== "tieBreak") throw new RuleError("暗标已关闭。", "AUCTION_CLOSED");
  if (auction.status === "tieBreak" && !auction.tieBreakPlayerIds?.includes(player.id)) throw new RuleError("你不在加赛名单中。", "NOT_ELIGIBLE");
  if (isBlockedByCard(state, player, "D07", currentAuctionArtifact(state).id)) throw new RuleError("你本日不能对该藏品出价。", "NOT_ELIGIBLE");
  const baseBid = Math.max(0, Math.floor(amount));
  if (baseBid % 10 !== 0) throw new RuleError("暗标出价必须为 10 的倍数。", "BID_TOO_LOW");
  const sealedBoost = consumeAuctionEffect(state, player.id, "B05", currentAuctionArtifact(state).id)?.amount ?? 0;
  const bid = baseBid + sealedBoost;
  if (baseBid > player.cash) throw new RuleError("现金不足。", "CASH_LOW");
  recordAuctionBid(auction, player.id, bid);
  auction.sealedBids[player.id] = bid;
  auction.sealedBidBoosts ??= {};
  auction.sealedBidBoosts[player.id] = (auction.sealedBidBoosts?.[player.id] ?? 0) + sealedBoost;
  auction.sealedBidRounds![player.id] = auction.status === "tieBreak" ? 2 : 1;
  const sealedTarget = currentAuctionArtifacts(state).map((artifact) => `《${artifact.name}》`).join("、");
  pushPrivateLog(state, player.id, `你对${sealedTarget}提交暗标 ${bid} 银元${sealedBoost > 0 ? `（基础 ${baseBid} + 加封 ${sealedBoost}）` : ""}。`);
  const bidderIds = auction.status === "tieBreak" ? auction.tieBreakPlayerIds ?? [] : bidderPlayers(state).map((candidate) => candidate.id);
  if (bidderIds.every((id) => Object.prototype.hasOwnProperty.call(auction.sealedBids, id))) {
    resolveSealedBids(state, bidderIds);
  } else {
    state.lastMessage = `${player.nickname} 已提交暗标。`;
    state.log.push(state.lastMessage);
  }
}

function resolveSealedBids(state: MutableGame, bidderIds: PlayerId[]): void {
  const auction = requireAuction(state);
  const entries = bidderIds.map((id) => ({ id, amount: auction.sealedBids[id] ?? 0 })).filter((entry) => entry.amount > 0);
  if (entries.length === 0) {
    closeAuctionAsUnsold(state);
    return;
  }
  const highest = Math.max(...entries.map((entry) => entry.amount));
  const tied = entries.filter((entry) => entry.amount === highest);
  if (tied.length === 1) {
    const boost = auction.sealedBidBoosts?.[tied[0]!.id] ?? 0;
    closeAuctionWithWinner(state, tied[0]!.id, tied[0]!.amount - boost);
    delete auction.sealedBidBoosts?.[tied[0]!.id];
    return;
  }
  if (auction.status !== "tieBreak") {
    auction.status = "tieBreak";
    auction.tieBreakPlayerIds = tied.map((entry) => entry.id);
    auction.sealedBids = {};
    auction.sealedBidBoosts = {};
    state.lastMessage = `暗标平局，${auction.tieBreakPlayerIds.length} 名玩家进入追加暗标。`;
    state.log.push(state.lastMessage);
    return;
  }
  const winner = tied.sort((a, b) => seatOf(state, a.id) - seatOf(state, b.id))[0]!;
  const boost = auction.sealedBidBoosts?.[winner.id] ?? 0;
  closeAuctionWithWinner(state, winner.id, winner.amount - boost);
  delete auction.sealedBidBoosts?.[winner.id];
}

function closeAuctionWithWinner(state: MutableGame, winnerId: PlayerId, amount: number): void {
  const auction = requireAuction(state);
  const winner = requirePlayer(state, winnerId);
  if (winner.cash < amount) throw new RuleError("赢家现金不足，请先贷款再出价。", "CASH_LOW");
  winner.cash -= amount;
  const wonArtifacts = currentAuctionArtifacts(state);
  const rumorRange = auctionRumorRangeText(wonArtifacts);
  const secondHighestBid = secondHighestAuctionBid(state, winnerId);
  for (const artifact of wonArtifacts) {
    assignArtifactToPlayer(state, winner, artifact, {
      dayAcquired: state.day,
      acquiredByMode: auction.mode,
      purchasePrice: amount,
      packageId: auction.mode === "bundle" ? auction.id : undefined
    });
    if (artifact.properties.includes("prop15") && winner.cash < 50) {
      addArtifactValueEffect(state, "prop15", artifact.id, "冒险家的奖励：获得时现金低于 50，终局价值 +30%。", 1.3, winner.id);
    }
    if (artifact.properties.includes("prop19") && amount < artifact.rumorMin) {
      addArtifactValueEffect(state, "prop19", artifact.id, "捡漏专家：低于传闻最低价成交，终局价值 +10%。", 1.1, winner.id);
    }
    if (artifact.properties.includes("prop08") && (auction.bidCounts?.[winner.id] ?? 0) === 1) {
      addArtifactValueEffect(state, "prop08", artifact.id, "一见钟情：第一次出价即成功拍得，终局价值 +20%。", 1.2, winner.id);
    }
    if (artifact.properties.includes("prop10")) {
      const rng = makeRng(`${state.roomId}:${state.day}:${state.actionIndex}:prop10`);
      const eligibleDiscards = state.discardPile.filter(id => trickById.has(id));
      const randomCard = eligibleDiscards.length > 0 ? shuffled(eligibleDiscards, rng)[0] : undefined;
      if (randomCard) {
        const cardIndex = state.discardPile.indexOf(randomCard);
        state.discardPile.splice(cardIndex, 1);
        winner.hand.push(randomCard);
        state.log.push(`《${artifact.name}》的"锦囊妙计"生效，${winner.nickname} 从弃牌堆获得 1 张锦囊。`);
      }
    }
    if (hasTodayEffect(state, "E07") && (artifact.properties.includes("fake") || artifact.tag === "fake")) {
      winner.cash += 30;
      state.log.push(`《假货横行》生效，${winner.nickname} 因买到赝品获得 30 银元补偿。`);
    }
    if (winner.role?.roleId === "role08" && amount < artifact.rumorMin) {
      winner.cash += 20;
      state.log.push(`${winner.nickname} 的《奇货》生效，获得 20 银元。`);
    }
  }

  if (state.currentHostId) {
    const host = requirePlayer(state, state.currentHostId);
    const commission = Math.floor(amount * hostCommissionRate(state, host));
    host.cash += commission;
    pushPrivateLog(state, host.id, `你作为主持人收到 ${commission} 银元佣金。`);
    addStat(state.stats.commissionEarned, host.id, commission);
    addStat(state.stats.hostedSoldCount, host.id, wonArtifacts.length);
    addStat(state.stats.hostedTotalSales, host.id, amount);
    if (amount >= 200) addStat(state.stats.hostedOver200Count, host.id, 1);
    for (const artifact of wonArtifacts) {
      if (amount >= artifact.rumorMax) addStat(state.stats.hostedAboveCeilingCount, host.id, 1);
      if (amount <= artifact.rumorMin) addStat(state.stats.hostedBelowFloorCount, host.id, 1);
    }
  }
  addStat(state.stats.auctionWinsByMode, `${winner.id}:${auction.mode}`, 1);
  if (auction.mode === "bundle" && auction.bundleInnerMode) addStat(state.stats.auctionWinsByMode, `${winner.id}:${auction.bundleInnerMode}`, 1);
  addStat(state.stats.auctionWinCount, winner.id, wonArtifacts.length);
  addStat(state.stats.auctionSpend, winner.id, amount);
  if (amount >= 200) addStat(state.stats.auctionWinBid200, winner.id, 1);
  if (state.day >= 7) addStat(state.stats.auctionWinsAfterDay7, winner.id, wonArtifacts.length);
  if (wonArtifacts.some((artifact) => amount < artifact.rumorMin)) addStat(state.stats.belowRumorMinWins, winner.id, wonArtifacts.filter((artifact) => amount < artifact.rumorMin).length);
  if ((auction.bidCounts?.[winner.id] ?? 0) === 1) addStat(state.stats.firstBidWins, winner.id, wonArtifacts.length);
  if (secondHighestBid !== undefined && amount - secondHighestBid <= 20) addStat(state.stats.closeWins, winner.id, 1);
  resolveRoleAuctionEffects(state, winnerId, amount, wonArtifacts.map((artifact) => artifact.id));
  auction.status = "closed";
  state.phase = "settlement";
  state.lastMessage = `${winner.nickname} 以 ${amount} 拍下 ${wonArtifacts.map((artifact) => `《${artifact.name}》`).join("、")}（${rumorRange}）。`;
  state.log.push(state.lastMessage);
  pushPrivateLog(state, winner.id, `你花费 ${amount} 银元买到 ${wonArtifacts.map((artifact) => `《${artifact.name}》`).join("、")}。现金扣除后剩余 ${winner.cash} 银元，终局时藏品价值会按每 50 银元折算声望。`);
  resolveAuctionTriggeredEffects(state, winnerId, amount, wonArtifacts.map((artifact) => artifact.id));
  resolveDelayedCardEffects(state);
}


function closeAuctionAsUnsold(state: MutableGame, options: { forbidHostSelfBuy?: boolean } = {}): void {
  const auction = requireAuction(state);
  const artifacts = currentAuctionArtifacts(state);
  const rumorRange = auctionRumorRangeText(artifacts);
  const host = state.currentHostId ? requirePlayer(state, state.currentHostId) : undefined;
  if (host && !options.forbidHostSelfBuy && auction.mode !== "dutch") {
    const selfBuyPrice = Math.floor(artifacts.reduce((sum, artifact) => sum + artifact.rumorMin, 0) * 0.5);
    if (host.cash >= selfBuyPrice) {
      host.cash -= selfBuyPrice;
      for (const artifact of artifacts) {
        assignArtifactToPlayer(state, host, artifact, {
          dayAcquired: state.day,
          purchasePrice: selfBuyPrice
        });
      }
      addStat(state.stats.selfBoughtPassInCount, host.id, artifacts.length);
      state.lastMessage = `流拍，主持人以 ${selfBuyPrice} 自吞 ${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}（${rumorRange}）。`;
      pushPrivateLog(state, host.id, `你以 ${selfBuyPrice} 银元自吞 ${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}。`);
    } else {
      state.lastMessage = `流拍，${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}弃置（${rumorRange}）。`;
    }
  } else {
    state.lastMessage = `流拍，${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}弃置（${rumorRange}）。`;
  }
  if (host) addStat(state.stats.hostedPassInCount, host.id, artifacts.length);
  auction.status = "closed";
  state.phase = "settlement";
  state.log.push(state.lastMessage);
  resolveAuctionTriggeredEffects(state, undefined, 0, artifacts.map((artifact) => artifact.id));
  resolveDelayedCardEffects(state);
}

function resolveAuctionTriggeredEffects(state: MutableGame, winnerId: PlayerId | undefined, amount: number, artifactIds: ArtifactId[]): void {
  const settledArtifactIds = new Set(artifactIds);
  const removeIds = new Set<string>();
  for (const effect of state.activeEffects) {
    if (effect.day !== state.day) continue;
    if (effect.targetArtifactId && !settledArtifactIds.has(effect.targetArtifactId)) continue;

    if (effect.sourceCardId === "B01" && effect.targetArtifactId) {
      if (effect.createdBy !== winnerId) {
        const player = requirePlayer(state, effect.createdBy);
        const refund = effect.amount ?? 10;
        player.cash += refund;
        pushPrivateLog(state, player.id, `你的《保守出价》生效，返还 ${refund} 银元。`);
      }
      removeIds.add(effect.id);
    }

    if (effect.sourceCardId === "B02") {
      if (winnerId) {
        const player = requirePlayer(state, effect.createdBy);
        const bonus = Math.floor(amount * 0.2);
        player.cash += bonus;
        pushPrivateLog(state, player.id, `你的《坐地分赃》生效，获得 ${bonus} 银元。`);
        if (state.currentHostId) {
          const host = requirePlayer(state, state.currentHostId);
          const hostCommission = Math.floor(amount * hostCommissionRate(state, host));
          host.cash = Math.max(0, host.cash - hostCommission);
          addStat(state.stats.commissionEarned, host.id, -hostCommission);
          pushPrivateLog(state, host.id, `《坐地分赃》生效，本拍品主持佣金被取消。`);
        }
      }
      removeIds.add(effect.id);
    }

    if (effect.sourceCardId === "B08" && winnerId && effect.targetPlayerId === winnerId) {
      const winner = requirePlayer(state, winnerId);
      const watcher = requirePlayer(state, effect.createdBy);
      const payment = Math.min(effect.amount ?? 10, winner.cash);
      winner.cash -= payment;
      watcher.cash += payment;
      pushPrivateLog(state, watcher.id, `你的《雁过拔毛》生效，${winner.nickname} 支付你 ${payment} 银元。`);
      pushPrivateLog(state, winner.id, `你被一个私密效果影响，支付 ${payment} 银元。`);
      removeIds.add(effect.id);
    }

    if (effect.sourceCardId === "B07" && winnerId && state.auction) {
      const lastBid = state.auction.highestBids?.[effect.createdBy] ?? 0;
      if (lastBid > 0 && amount - lastBid >= 40) {
        const bidder = requirePlayer(state, effect.createdBy);
        bidder.cash += 15;
        pushPrivateLog(state, effect.createdBy, `你的《退场有奖》生效，成交价 ${amount} 比你的最后报价 ${lastBid} 高 ${amount - lastBid}，获得 15 银元。`);
      }
      removeIds.add(effect.id);
    }

    if (effect.sourceCardId === "C06" && winnerId && state.auction) {
      const secondHighest = secondHighestAuctionBid(state, winnerId);
      if (secondHighest !== undefined && amount - secondHighest >= 30) {
        const bidder = requirePlayer(state, effect.createdBy);
        bidder.cash += 20;
        pushPrivateLog(state, effect.createdBy, `你的《找零》生效，成交价 ${amount} 比第二高价 ${secondHighest} 高 ${amount - secondHighest}，获得 20 银元。`);
      }
      removeIds.add(effect.id);
    }
  }
  if (removeIds.size > 0) state.activeEffects = state.activeEffects.filter((effect) => !removeIds.has(effect.id));
  resolveAuctionEventEffects(state, winnerId, artifactIds);
}

function resolveAuctionEventEffects(state: MutableGame, winnerId: PlayerId | undefined, artifactIds: ArtifactId[]): void {
  const mysteryBuy = todayEffects(state, "N1")[0];
  if (mysteryBuy && winnerId && artifactIds[0]) {
    const artifact = requireArtifact(state, artifactIds[0]);
    const category = artifact.category;
    // 对每个持有被选中类别藏品的玩家，创建一个 pendingChoice
    for (const p of state.players) {
      const ownedInCategory = p.artifacts.filter((aid) => requireArtifact(state, aid).category === category);
      if (ownedInCategory.length > 0) {
        state.activeEffects.push({
          id: makeId("effect"),
          sourceEventId: "N1",
          label: `神秘收购：${p.nickname} 可选择卖出 ${categoryLabel(category)} 类藏品（按传闻最高价）或拒绝（获得 1 声望）`,
          appliesTo: "auction",
          day: state.day,
          createdBy: mysteryBuy.createdBy,
          targetPlayerId: p.id,
          pendingChoice: true,
          choiceType: "n1_mystery_buyer",
          category
        });
      }
    }
    state.activeEffects = state.activeEffects.filter((effect) => effect.id !== mysteryBuy.id);
  }
}

function resolveRoleAuctionEffects(state: MutableGame, winnerId: PlayerId, amount: number, artifactIds: ArtifactId[]): void {
  // 拍卖师被动：包装——成交价超过100银元时自动获得10银元
  if (state.currentHostId) {
    const host = requirePlayer(state, state.currentHostId);
    if (host.role?.roleId === "role09" && amount > 100) {
      host.cash += 10;
      state.log.push(`${host.nickname} 的《包装》生效，成交价 ${amount} 超过 100 银元，额外获得 10 银元奖金。`);
    }
  }
  for (const player of state.players) {
    if (player.role?.roleId !== "role04") continue;
    if (player.id !== winnerId && (state.auction?.highestBids?.[player.id] ?? 0) > 0) {
      state.activeEffects.push({
        id: makeId("effect"),
        label: `资本：${winnerId} 获得 1 点仇恨。`,
        appliesTo: "cash",
        targetPlayerId: winnerId,
        amount: 1,
        createdBy: player.id
      });
    }
  }
}

function grantIntelBrokerCards(state: MutableGame): void {
  for (const player of state.players) {
    if (player.role?.roleId !== "role06") continue;
    const cardId = draw(state.trickDeck);
    if (cardId) {
      player.hand.push(cardId);
      pushPrivateLog(state, player.id, "你的《密报》生效，获得 1 张锦囊，且后续购买锦囊需要额外支付 10 银元。");
    }
  }
}

function resolveDelayedCardEffects(state: MutableGame): void {
  const remaining: DelayedCardEffect[] = [];
  for (const delayed of state.delayedCardEffects) {
    if (delayed.remainingSettlements > 0) {
      remaining.push({ ...delayed, remainingSettlements: delayed.remainingSettlements - 1 });
      continue;
    }
    const sourcePlayer = state.players.find((candidate) => candidate.id === delayed.sourcePlayerId);
    const sourceCard = cardById.get(delayed.sourceCardId);
    if (!sourcePlayer || !sourceCard) continue;
    try {
      const previousLogLength = state.log.length;
      resolveCardEffect(state, sourcePlayer, sourceCard, {
        targetArtifactId: delayed.targetArtifactId,
        targetPlayerId: delayed.targetPlayerId
      });
      if (state.log.length === previousLogLength) pushPrivateLog(state, sourcePlayer.id, `你被延迟的《${sourceCard.name}》生效。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "目标已失效";
      pushPrivateLog(state, sourcePlayer.id, `延迟的《${sourceCard.name}》未生效：${message}。`);
    }
  }
  state.delayedCardEffects = remaining;
}

function resolveBuybacks(state: MutableGame): void {
  const resolvedIds = new Set<string>();
  for (const effect of state.activeEffects) {
    if (effect.pendingChoice || effect.sourceCardId !== "C03" || effect.day !== state.day || !effect.targetArtifactId || !effect.amount) continue;
    const player = requirePlayer(state, effect.createdBy);
    const artifact = requireArtifact(state, effect.targetArtifactId);
    if (!artifact.ownerId && player.cash >= effect.amount) {
      state.activeEffects.push({
        ...effect,
        id: makeId("effect"),
        label: `回购凭证：是否以 ${effect.amount} 银元买回《${artifact.name}》？`,
        targetPlayerId: player.id,
        pendingChoice: true,
        choiceType: "C03_buyback"
      });
      pushPrivateLog(state, player.id, `《${artifact.name}》可以用 ${effect.amount} 银元回购，请选择是否买回。`);
    } else {
      pushPrivateLog(state, player.id, `《${artifact.name}》的回购机会失效。`);
    }
    resolvedIds.add(effect.id);
  }
  if (resolvedIds.size > 0) state.activeEffects = state.activeEffects.filter((effect) => !resolvedIds.has(effect.id));
}

function resolveConsignmentListings(state: MutableGame): void {
  const resolvedIds = new Set<string>();
  for (const effect of state.activeEffects) {
    if (effect.choiceType !== "C04_listing" || !effect.targetArtifactId || !effect.amount) continue;
    const seller = requirePlayer(state, effect.createdBy);
    const artifact = requireArtifact(state, effect.targetArtifactId);
    if (artifact.ownerId === seller.id && seller.artifacts.includes(artifact.id)) {
      seller.cash += effect.amount + 20;
      removeArtifactFromPlayer(state, seller, artifact);
      addStat(state.stats.sellToBankCount, seller.id, 1);
      state.log.push(`《寄售单》结算：${seller.nickname} 的《${artifact.name}》无人买走，卖给银行获得 ${effect.amount + 20} 银元。`);
    } else {
      pushPrivateLog(state, seller.id, `《寄售单》挂售的藏品已不在你手中，挂售失效。`);
    }
    resolvedIds.add(effect.id);
  }
  if (resolvedIds.size > 0) state.activeEffects = state.activeEffects.filter((effect) => !resolvedIds.has(effect.id));
}

function prepareProp31DonationChoices(state: MutableGame): void {
  for (const player of state.players) {
    if (state.activeEffects.some((effect) => effect.choiceType === "prop31_donation" && effect.targetPlayerId === player.id)) continue;
    if (state.activeEffects.some((effect) => effect.sourceRoleSkillId === "prop31_donated" && effect.createdBy === player.id)) continue;
    const artifact = playerArtifacts(state, player).find((candidate) => candidate.properties.includes("prop31"));
    if (!artifact) continue;
    state.activeEffects.push({
      id: makeId("effect"),
      sourceRoleSkillId: "prop31_donation",
      label: `慈善捐赠：是否弃置《${artifact.name}》，让终局现金按每 30 银元兑换 1 声望？`,
      appliesTo: "cash",
      targetPlayerId: player.id,
      targetArtifactId: artifact.id,
      day: state.day,
      createdBy: player.id,
      pendingChoice: true,
      choiceType: "prop31_donation"
    });
    pushPrivateLog(state, player.id, `《${artifact.name}》带有慈善捐赠：终局前可选择弃置它，让现金按每 30 银元兑换 1 声望。`);
  }
}

function resolveEventEffect(state: MutableGame, player: PlayerState, card: EventCard): void {
  const nextDay = Math.min(state.maxDays, state.day + 1);
  const creator = player.id;
  switch (card.id) {
    case "N1":
      upsertEffect(state, timedEvent("N1", "神秘收购：下一个拍卖日结束后，从当天成交藏品中随机 1 件触发收购。", state.day + 1, creator, "auction"));
      break;
    case "N2":
      upsertEffect(state, timedEvent("N2", "经济回暖：后续 2 天卖银行按 100% 回收。", state.day + 1, creator, "cash", { bankSellRate: 1 }));
      upsertEffect(state, timedEvent("N2", "经济回暖：后续 2 天卖银行按 100% 回收。", state.day + 2, creator, "cash", { bankSellRate: 1 }));
      break;
    case "E01":
      upsertEffect(state, timedEvent(card.id, "市场回暖：下一天成交藏品终局价值 +10%。", nextDay, creator, "finalValue", { multiplier: 1.1 }));
      break;
    case "E02":
      upsertEffect(state, timedEvent(card.id, "报纸头条：下一天预展时公开第一件藏品故事。", nextDay, creator, "visibility"));
      break;
    case "E03":
      upsertEffect(state, timedEvent(card.id, "黑市打折：下一个黑市日购卡价格 -10。", nextBlackMarketDay(state), creator, "cash", { blackMarketCostDelta: -10 }));
      break;
    case "E04":
      for (const candidate of state.players) candidate.cash += 20;
      upsertEffect(state, timedEvent(card.id, "黑市查封：下一个黑市日每人最多买 1 张。", nextBlackMarketDay(state), creator, "cash", { blackMarketLimit: 1 }));
      break;
    case "E05":
      upsertEffect(state, timedEvent(card.id, "稀货流入：下一个黑市日每人购买上限 +1。", nextBlackMarketDay(state), creator, "cash", { blackMarketLimit: GAME_CONSTANTS.blackMarketLimit + 1 }));
      break;
    case "E06":
      upsertEffect(state, timedEvent(card.id, "熟人门路：下一次黑市每人免费获得 1 张锦囊，且不能再买锦囊。", nextBlackMarketDay(state), creator, "cash", { blackMarketBlockTricks: true }));
      break;
    case "E07":
      upsertEffect(state, timedEvent(card.id, "假货横行：下一天买到赝品的买家获得 30 银元补偿。", nextDay, creator, "cash", { fakeProbabilityMod: 0.1 }));
      break;
    case "E08":
      upsertEffect(state, timedEvent(card.id, "鉴定风潮：下一天探查类锦囊需额外支付 10 银元。", nextDay, creator, "cash", { fakeProbabilityMod: -0.1 }));
      break;
    case "E09":
      upsertEffect(state, timedEvent(card.id, "收藏展邀约：下一天结束时，3 类及以上藏品玩家获得 30 银元。", nextDay, creator, "cash"));
      break;
    case "E10":
      upsertEffect(state, timedEvent(card.id, "断舍离：下一天第一次卖银行按 100% 回收。", nextDay, creator, "cash", { bankSellRate: 1, perPlayerCounts: {} }));
      break;
    case "E11":
      upsertEffect(state, timedEvent(card.id, "资金冻结：下一天不能贷款，低现金玩家晨间获得补助。", nextDay, creator, "cash", { loanBlocked: true }));
      break;
    case "E12":
      upsertEffect(state, timedEvent(card.id, "量化宽松：后续 2 天晨间收入 +10。", state.day + 1, creator, "cash", { incomeBonus: 10 }));
      upsertEffect(state, timedEvent(card.id, "量化宽松：后续 2 天晨间收入 +10。", state.day + 2, creator, "cash", { incomeBonus: 10 }));
      break;
    case "E13":
      upsertEffect(state, timedEvent(card.id, "紧缩政策：下一天新贷款改为还 130。", nextDay, creator, "cash", { loanRepayment: 130 }));
      break;
    case "E14":
      upsertEffect(state, timedEvent(card.id, "银行惜售：下一天卖银行按 70% 回收。", nextDay, creator, "cash", { bankSellRate: 0.7 }));
      break;
    case "E15":
      upsertEffect(state, timedEvent(card.id, "银行抢收：下一天卖银行按 100% 回收。", nextDay, creator, "cash", { bankSellRate: 1 }));
      break;
    case "E16":
      upsertEffect(state, timedEvent(card.id, "现金为王：终局现金额外兑换声望最多 +5。", state.maxDays, creator, "cash"));
      break;
    case "E17":
      upsertEffect(state, timedEvent(card.id, "通胀来袭：下一天黑市和新贷款利息 +10，易损保护费 +10。", nextDay, creator, "cash", { blackMarketCostDelta: 10, loanRepayment: 130, fragileProtectionDelta: 10 }));
      break;
    case "E18":
      upsertEffect(state, timedEvent(card.id, "银根紧缩：下一天晨间每位玩家支付最多 30 银元。", nextDay, creator, "cash"));
      break;
    case "E19":
      upsertEffect(state, timedEvent(card.id, "透明市场：下一天预展公开所有拍品传闻区间。", nextDay, creator, "visibility"));
      break;
    case "E20":
      upsertEffect(state, timedEvent(card.id, "富豪入场：下一天英式/打包最低加价 30，荷兰起拍至少传闻最高 +30。", nextDay, creator, "auction"));
      break;
    case "E21":
      upsertEffect(state, timedEvent(card.id, "竞拍税：下一天每人第二次起出价需支付 5 银元，最多 20。", nextDay, creator, "auction", { bidTaxAmount: 5, bidTaxCap: 20, perPlayerAmounts: {}, perPlayerCounts: {} }));
      break;
    case "E22":
      upsertEffect(state, timedEvent(card.id, "古籍复兴：下一天古籍/遗物/绝笔终局价值 +15%。", nextDay, creator, "finalValue", { categories: ["book", "legacy", "lastword"], multiplier: 1.15 }));
      break;
    case "E23":
      upsertEffect(state, timedEvent(card.id, "材质危机：下一天青铜/瓷器/玉器终局价值 -15%。", nextDay, creator, "finalValue", { categories: ["bronze", "porcelain", "jade"], multiplier: 0.85 }));
      break;
    case "E24":
      upsertEffect(state, timedEvent(card.id, "海外热潮：下一天字画/珠宝/钱币终局价值 +15%。", nextDay, creator, "finalValue", { categories: ["calligraphy", "jewelry", "coin"], multiplier: 1.15 }));
      break;
    case "E25": {
      // Create global -20% category effect as fallback for unresolved/auto-accept
      upsertEffect(state, timedEvent(card.id, "灵异恐惧：下一天灵器/邪物/奇物终局价值 -20%。", nextDay, creator, "finalValue", { categories: ["relic", "evil", "curio"], multiplier: 0.8 }));
      // Create per-player pendingChoice effects so the frontend can show a popup
      for (const p of state.players) {
        state.activeEffects.push({
          id: makeId("effect"),
          sourceEventId: card.id,
          label: `灵异恐惧：${p.nickname} 需要选择是否支付保护费（每件 10 银元）`,
          appliesTo: "finalValue",
          day: nextDay,
          createdBy: creator,
          targetPlayerId: p.id,
          pendingChoice: true,
          choiceType: "E25_protection_fee"
        });
      }
      break;
    }
    case "E26": {
      const allCategories: ArtifactCategory[] = ["calligraphy", "bronze", "jewelry", "porcelain", "jade", "book", "coin", "curio", "relic", "evil", "legacy", "lastword", "celebrity"];
      const category = pick(allCategories, makeRng(`${state.roomId}:${state.day}:${card.id}:E26`));
      upsertEffect(state, timedEvent(card.id, `文化禁令：下一天${categoryLabel(category)}类禁止交易和卖银行。`, nextDay, creator, "auction", { category }));
      break;
    }
    case "E27": {
      const allCategories: ArtifactCategory[] = ["calligraphy", "bronze", "jewelry", "porcelain", "jade", "book", "coin", "curio", "relic", "evil", "legacy", "lastword", "celebrity"];
      const category = pick(allCategories, makeRng(`${state.roomId}:${state.day}:${card.id}:E27`));
      upsertEffect(state, timedEvent(card.id, `学术突破：下一天${categoryLabel(category)}类新拍品终局价值 +20%，且赝品基础概率降为 10%。`, nextDay, creator, "finalValue", { category, multiplier: 1.2, fakeProbabilityMod: -0.1 }));
      break;
    }
    case "E28":
      upsertEffect(state, timedEvent(card.id, "丰收晨曦：下一天晨间收入翻倍。", nextDay, creator, "cash", { incomeMultiplier: 2 }));
      break;
    default:
      applyGenericEventEffect(state, player, card, nextDay);
      break;
  }
  state.lastMessage = `${player.nickname} 使用事件《${card.name}》。`;
}

function eventPublicNarrative(card: EventCard): string {
  if (card.id === "E04") return "所有玩家获得 20 银元，下一次黑市每人最多买 1 张。";
  const cashEffect = card.effects?.find((effect) => effect.type === "modifyCash" && typeof effect.amount === "number");
  if (cashEffect) {
    const amount = Math.abs(cashEffect.amount ?? 0);
    return cashEffect.amount! >= 0 ? `所有玩家获得 ${amount} 银元。` : `所有玩家支付 ${amount} 银元。`;
  }
  const summary = card.description.trim().replace(/[。.]?$/, "。");
  return summary || `${card.name}影响了今天的市场。`;
}

function applyGenericEventEffect(state: MutableGame, player: PlayerState, card: EventCard, nextDay: number): void {
  const finalValueEffect = card.effects?.find((effect) => effect.type === "finalValueMultiplier");
  if (finalValueEffect) {
    upsertEffect(state, timedEvent(card.id, `${card.name}：${card.description}`, nextDay, player.id, "finalValue", { multiplier: finalValueEffect.multiplier ?? 1 }));
    return;
  }
  const cashEffect = card.effects?.find((effect) => effect.type === "modifyCash");
  if (cashEffect?.amount) {
    for (const candidate of state.players) candidate.cash += cashEffect.amount;
    return;
  }
  upsertEffect(state, timedEvent(card.id, `${card.name}：${card.description}`, nextDay, player.id, "auction"));
}

function hasRemainingAuctionArtifact(state: GameState): boolean {
  const auction = requireAuction(state);
  if (auction.mode === "bundle") return false;
  return auction.currentArtifactIndex + 1 < auction.artifactIds.length;
}

function startNextArtifactAuction(state: MutableGame): void {
  const auction = requireAuction(state);
  auction.currentArtifactIndex += 1;
  auction.status = "choosing";
  auction.currentBid = 0;
  auction.currentBidderId = undefined;
  auction.passedPlayerIds = [];
  auction.sealedBids = {};
  auction.sealedBidRounds = {};
  auction.bidCounts = {};
  auction.highestBids = {};
  auction.tieBreakPlayerIds = undefined;
  auction.dutch = undefined;
  state.players.forEach((candidate) => {
    candidate.passed = false;
  });
  state.phase = "cardWindow";
  state.lastMessage = "进入下一件藏品的锦囊/事件窗口。";
  state.log.push(state.lastMessage);
}

function buyBlackMarket(state: MutableGame, player: PlayerState, kind: "trick" | "event"): void {
  const boughtToday = player.blackMarketBuysToday ?? 0;
  if (kind === "trick" && todayEffects(state).some((effect) => effect.blackMarketBlockTricks)) throw new RuleError("本次黑市不能购买锦囊。", "NOT_ELIGIBLE");
  const limit = blackMarketLimitFor(state, player);
  if (boughtToday >= limit) throw new RuleError("本次黑市购买次数已达上限。");
  if (kind === "event" && player.events.length >= GAME_CONSTANTS.eventHandLimit) throw new RuleError("事件卡持有已达上限。");
  const baseCost = kind === "trick" ? GAME_CONSTANTS.trickCost : GAME_CONSTANTS.eventCost;
  let cost = baseCost + todayEffects(state).reduce((sum, effect) => sum + (effect.blackMarketCostDelta ?? 0), 0);
  if (player.role?.roleId === "role02") cost -= 10;
  if (player.role?.roleId === "role06" && kind === "trick") cost += 10;
  if (hasTodayEffect(state, "E05") && boughtToday >= GAME_CONSTANTS.blackMarketLimit) cost += 20;
  cost = Math.max(0, cost);
  if (player.cash < cost) throw new RuleError("现金不足。", "CASH_LOW");
  const deck = kind === "trick" ? state.trickDeck : state.eventDeck;
  const cardId = draw(deck);
  if (!cardId) throw new RuleError("牌库已空。");
  player.cash -= cost;
  if (kind === "trick") player.hand.push(cardId);
  else player.events.push(cardId);
  addStat(state.stats.blackMarketCardsBought, player.id, 1);
  player.blackMarketBuysToday = boughtToday + 1;
  const card = kind === "trick" ? trickById.get(cardId) : eventById.get(cardId);
  state.lastMessage = `${player.nickname} 在黑市花 ${cost} 银元购买了 1 张${kind === "trick" ? "锦囊" : "事件卡"}。`;
  state.log.push(state.lastMessage);
  pushPrivateLog(state, player.id, `你在黑市花费 ${cost} 银元买到${kind === "trick" ? "锦囊" : "事件卡"}《${card?.name ?? cardId}》，当前剩余 ${player.cash} 银元。`);
}

function playCard(
  state: MutableGame,
  player: PlayerState,
  payload: { cardId: string; targetArtifactId?: string; targetPlayerId?: string; amount?: number }
): void {
  if (!["cardWindow", "auction", "settlement", "eventWindow", "freeTrade"].includes(state.phase)) throw new RuleError("当前阶段不能使用卡牌。", "BAD_PHASE");
  if (state.pendingReaction) throw new RuleError("等待反制响应。", "PENDING_REACTION");
  const inHand = player.hand.includes(payload.cardId);
  const inEvents = player.events.includes(payload.cardId);
  if (inHand && isBlockedByCard(state, player, "D01")) throw new RuleError("你本日不能使用锦囊。", "NOT_ELIGIBLE");
  if (!inHand && !inEvents) throw new RuleError("你没有这张卡。", "CARD_NOT_OWNED");
  if (inEvents && state.phase !== "eventWindow") throw new RuleError("事件卡只能在事件窗口使用。", "BAD_PHASE");
  const card = cardById.get(payload.cardId);
  if (!card) throw new RuleError("未知卡牌。");
  validateCardPayload(state, player, card, payload);
  if (hasTodayEffect(state, "E08") && card.effects?.some((effect) => effect.type === "revealInfo")) {
    if (player.cash < 10) throw new RuleError("鉴定风潮期间使用探查效果需要额外 10 银元。", "CASH_LOW");
    player.cash -= 10;
  }

  const eligibleCounterPlayers = state.players.filter((candidate) => candidate.id !== player.id && candidate.hand.some((cardId) => cardById.get(cardId)?.category?.includes("反制")));
  consumePlayedCard(state, player, payload.cardId, inHand, inEvents);
  if (card.counterable !== false && eligibleCounterPlayers.length > 0 && !state.pendingReaction && card.category?.includes("干扰")) {
    const previousLastMessage = state.lastMessage;
    state.pendingReaction = {
      id: makeId("reaction"),
      sourceActionId: makeId("action"),
      sourcePlayerId: player.id,
      eligiblePlayerIds: eligibleCounterPlayers.map((candidate) => candidate.id),
      sourceCardId: card.id,
      targetArtifactId: payload.targetArtifactId,
      targetPlayerId: payload.targetPlayerId,
      passedPlayerIds: [],
      countered: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 15000
    };
    state.lastMessage = previousLastMessage;
    pushPrivateLog(state, player.id, playCardPrivateMessage(state, player, card, payload));
    return;
  }

  const previousLogLength = state.log.length;
  const previousLastMessage = state.lastMessage;
  const beforeUse = playerActionSnapshot(state, player);
  pushPrivateLog(state, player.id, playCardPrivateMessage(state, player, card, payload));
  resolveCardEffect(state, player, card, payload);
  const resultMessage = playCardResultPrivateMessage(state, player, card, beforeUse);
  if (resultMessage) pushPrivateLog(state, player.id, resultMessage);
  if (inEvents) {
    const narrative = `今日发生：${eventPublicNarrative(card as EventCard)}`;
    state.log.push(narrative);
    state.lastMessage = narrative;
  }
  state.lastMessage = state.log.length > previousLogLength ? state.log.at(-1) : previousLastMessage;
  resolveSpeculatorScent(state, player, card, payload);
}

function validateCardPayload(
  state: GameState,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string }
): void {
  if (["B08", "D01", "D03", "D04", "D05", "D06"].includes(card.id)) {
    requirePlayer(state, payload.targetPlayerId);
  }
  if (card.id === "D07") {
    requirePlayer(state, payload.targetPlayerId);
    requireArtifact(state, payload.targetArtifactId);
  }
  if (card.id === "D02") {
    const artifact = requireArtifact(state, payload.targetArtifactId);
    if (artifact.ownerId === player.id) throw new RuleError("不能巧取自己的藏品。", "BAD_TARGET");
    requirePlayer(state, artifact.ownerId);
  }
  if (card.id === "C04") {
    requireArtifact(state, payload.targetArtifactId);
  }
  if (card.id === "C08" && state.phase !== "freeTrade") {
    throw new RuleError("牵线人只能在自由交易阶段使用。", "BAD_PHASE");
  }
}

function resolveCardEffect(
  state: MutableGame,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string; amount?: number }
): void {
  const text = card.description;
  if (eventById.has(card.id)) {
    resolveEventEffect(state, player, card as EventCard);
    grantIntelBrokerCards(state);
    return;
  }
  if (card.id === "B01") {
    const artifactId = state.auction?.currentBidderId === player.id ? currentAuctionArtifact(state).id : undefined;
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：若本次出价未赢得拍品，返还 10 银元。`,
      appliesTo: "auction",
      targetArtifactId: artifactId,
      amount: 10,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，等待本次竞价结果。`;
    return;
  }
  if (card.id === "B02") {
    const artifactId = state.auction ? currentAuctionArtifact(state).id : payload.targetArtifactId ?? state.todayArtifactIds[0];
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：当前藏品成交后从银行获得成交价 20%，且主持人不再获得佣金。`,
      appliesTo: "auction",
      targetArtifactId: artifactId,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，成交后可分得一笔银元，主持人佣金将被取消。`;
    return;
  }
  if (card.id === "B04") {
    if (!state.auction || state.phase !== "auction") throw new RuleError("当前没有可流拍的拍品。", "BAD_PHASE");
    if (state.currentHostId === player.id) throw new RuleError("主持人不能使用搅局流拍。", "NOT_ELIGIBLE");
    closeAuctionAsUnsold(state, { forbidHostSelfBuy: true });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，当前拍品流拍。`;
    return;
  }
  if (card.id === "B06") {
    const auction = requireAuction(state);
    const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (state.phase !== "auction" || bidMode !== "english" || auction.status !== "open") throw new RuleError("最后一口只能在英式竞拍中使用。", "BAD_PHASE");
  assertNonHostBidder(state, player);
  if (auction.passedPlayerIds.includes(player.id)) throw new RuleError("你已经退出当前竞拍。");
  if (isBlockedByCard(state, player, "D07", currentAuctionArtifact(state).id)) throw new RuleError("你本日不能对该藏品出价。", "NOT_ELIGIBLE");
  const nextBid = auction.currentBid + 20;
  const ceiling = auctionBidCeilingForArtifactIds(state, currentAuctionArtifacts(state).map((artifact) => artifact.id));
  if (nextBid > ceiling) throw new RuleError("当前出价已达到本拍品的主持叫价上限。", "INVALID_ACTION");
  if (nextBid > player.cash) throw new RuleError("现金不足。", "CASH_LOW");
    // 不调用 recordAuctionBid，避免影响 bidCounts（否则 prop08 一见钟情会误判）
    auction.highestBids = { ...(auction.highestBids ?? {}), [player.id]: Math.max(auction.highestBids?.[player.id] ?? 0, nextBid) };
    auction.currentBid = nextBid;
    auction.currentBidderId = player.id;
    auction.bidDeadline = Date.now() + 15000;
    announceEnglishBid(state, player, nextBid);
    pushPrivateLog(state, player.id, `你使用《${card.name}》，加价到 ${nextBid} 银元。`);
    return;
  }
  if (card.id === "B05") {
    const auction = requireAuction(state);
    const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "sealed" : auction.mode;
    if (bidMode !== "sealed") throw new RuleError("暗标加封只能用于暗标拍卖。", "BAD_PHASE");
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：自己的下一次暗标额外 +20。`,
      appliesTo: "auction",
      targetArtifactId: currentAuctionArtifact(state).id,
      amount: 20,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，下一次暗标额外 +20。`;
    return;
  }
  if (card.id === "B08") {
    const target = requirePlayer(state, payload.targetPlayerId);
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：${target.nickname} 本日拍下藏品时支付你 10 银元。`,
      appliesTo: "auction",
      targetPlayerId: target.id,
      amount: 10,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，盯上了 ${target.nickname}。`;
    return;
  }
  if (card.id === "C01") {
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：下一次卖银行按 100% 回收。`,
      appliesTo: "cash",
      bankSellRate: 1,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，下一次卖银行回收价提高。`;
    return;
  }
  if (card.id === "C03") {
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：下一次卖银行的藏品可在下一天自由阶段回购。`,
      appliesTo: "cash",
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，下一次卖银行将保留回购权。`;
    return;
  }
  if (card.id === "D01" || card.id === "D05" || card.id === "D07") {
    const target = requirePlayer(state, payload.targetPlayerId);
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：${card.description}`,
      appliesTo: "auction",
      targetPlayerId: target.id,
      targetArtifactId: payload.targetArtifactId,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，限制 ${target.nickname} 本日行动。`;
    return;
  }
  if (card.id === "D02") {
    const artifact = requireArtifact(state, payload.targetArtifactId);
    const owner = requirePlayer(state, artifact.ownerId);
    if (owner.id === player.id) throw new RuleError("不能巧取自己的藏品。", "BAD_TARGET");
    const price = Math.floor(artifact.rumorMin * GAME_CONSTANTS.bankSellRate) + 20;
    if (player.cash < price) throw new RuleError("现金不足，无法提出收购。", "CASH_LOW");
    const offer: TradeOffer = {
      id: makeId("trade"),
      fromPlayerId: player.id,
      toPlayerId: owner.id,
      give: { cash: price },
      receive: { artifactIds: [artifact.id] },
      status: "pending",
      version: 1,
      day: state.day,
      message: "D02"
    };
    state.tradeOffers.push(offer);
    state.lastMessage = `${player.nickname} 使用《${card.name}》，向 ${owner.nickname} 强制提出 ${price} 银元收购《${artifact.name}》。`;
    return;
  }
  if (card.id === "D03") {
    const target = requirePlayer(state, payload.targetPlayerId);
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：你可以查看 ${target.nickname} 的锦囊。`,
      appliesTo: "visibility",
      targetPlayerId: target.id,
      day: state.day,
      createdBy: player.id
    });
    pushPrivateLog(state, player.id, `《${card.name}》结果：${target.nickname} 的锦囊为 ${formatCardNames(target.hand, trickById, "无")}。`);
    state.lastMessage = `${player.nickname} 使用《${card.name}》，查看了 ${target.nickname} 的锦囊。`;
    return;
  }
  if (card.id === "D04") {
    const target = requirePlayer(state, payload.targetPlayerId);
    let discarded: string | undefined;
    if (target.hand.length > 0) {
      const randomDiscard = shuffled(target.hand, makeRng(`${state.roomId}:${state.day}:${state.actionIndex}:D04`))[0];
      if (randomDiscard) {
        discarded = randomDiscard;
        target.hand.splice(target.hand.indexOf(discarded), 1);
      }
    }
    state.lastMessage = discarded
      ? `${player.nickname} 使用《${card.name}》，${target.nickname} 弃掉 1 张锦囊。`
      : `${player.nickname} 使用《${card.name}》，${target.nickname} 没有锦囊可弃。`;
    // 向使用方展示对方手牌情况（空手牌也要展示以证明）
    const handStatus = target.hand.length > 0
      ? `手牌：${target.hand.map((cid) => cardById.get(cid)?.name ?? cid).join("、")}`
      : "手牌为空";
    pushPrivateLog(state, player.id, `${target.nickname} 当前${handStatus}。`);
    return;
  }
  if (card.id === "D06") {
    const target = requirePlayer(state, payload.targetPlayerId);
    if (target.cash >= 10) {
      target.cash -= 10;
      state.lastMessage = `${player.nickname} 使用《${card.name}》，${target.nickname} 失去 10 银元。`;
    } else {
      // 现金不足则展示手牌证明无现金，无损失
      const handPreview = target.hand.length > 0
        ? `手牌：${target.hand.map((cid) => cardById.get(cid)?.name ?? cid).join("、")}`
        : "手牌为空";
      pushPrivateLog(state, player.id, `${target.nickname} 现金不足 10 银元，${handPreview}。`);
      state.lastMessage = `${player.nickname} 使用《${card.name}》，${target.nickname} 现金不足，展示手牌证明。`;
    }
    return;
  }
  if (card.id === "B07") {
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: "B07",
      label: `${card.name}：若本次成交价比你的最后报价高 40 以上，获得 15 银元。`,
      appliesTo: "auction",
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，等待竞拍结果。`;
    return;
  }
  if (card.id === "C02") {
    const amount = player.cash < 100 ? 40 : 15;
    player.cash += amount;
    state.lastMessage = `${player.nickname} 使用《${card.name}》，获得 ${amount} 银元。`;
    return;
  }
  if (card.id === "C04") {
    const artifact = requireArtifact(state, payload.targetArtifactId);
    if (!player.artifacts.includes(artifact.id)) throw new RuleError("你没有这件藏品。", "NOT_OWNER");
    const price = Math.max(0, Math.floor(payload.amount ?? artifact.purchasePrice ?? artifact.rumorMin));
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: "C04",
      label: `寄售单：${player.nickname} 公开挂售《${artifact.name}》，定价 ${price} 银元；若被买走，卖方额外获得 20 银元。`,
      appliesTo: "cash",
      targetArtifactId: artifact.id,
      amount: price,
      day: state.day,
      createdBy: player.id,
      pendingChoice: true,
      choiceType: "C04_listing"
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，公开挂售《${artifact.name}》，定价 ${price} 银元。`;
    return;
  }
  if (card.id === "C06") {
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: "C06",
      label: `${card.name}：若本拍品成交价至少比第二高价高 30，获得 20 银元。`,
      appliesTo: "auction",
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，等待竞拍结果。`;
    return;
  }
  if (card.id === "C07") {
    const hasFragile = playerArtifacts(state, player).some((artifact) => artifact.properties.includes("fragile"));
    if (hasFragile) {
      state.activeEffects.push({
        id: makeId("effect"),
        sourceCardId: "C07",
        label: `${card.name}：免除下一次易损保护费。`,
        appliesTo: "cash",
        day: state.day,
        createdBy: player.id
      });
      state.lastMessage = `${player.nickname} 使用《${card.name}》，获得易损保护费豁免。`;
    } else {
      player.cash += 10;
      state.lastMessage = `${player.nickname} 使用《${card.name}》，获得 10 银元。`;
    }
    return;
  }
  if (card.id === "C08") {
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: "C08",
      label: `${card.name}：本阶段下一次玩家交易成功后双方各获得 10 银元。`,
      appliesTo: "cash",
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，等待下一次交易。`;
    return;
  }
  if (card.id === "I02") {
    const artifact = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
    privatelyPeekArtifact(artifact, player.id);
    pushPrivateLog(state, player.id, `《${card.name}》结果：《${artifact.name}》的传闻区间为 ${artifact.rumorMin} - ${artifact.rumorMax} 银元。`);
    if (card.category?.includes("信息")) addStat(state.stats.infoTricksPlayed, player.id, 1);
    state.lastMessage = `${player.nickname} 使用《${card.name}》，获得藏品情报。`;
    return;
  }
  if (text.includes("查看") || card.effects?.some((effect) => effect.type === "revealInfo")) {
    const result = resolveInfoCardResult(state, player, card, payload);
    if (result.peekArtifactId) privatelyPeekArtifact(requireArtifact(state, result.peekArtifactId), player.id);
    pushPrivateLog(state, player.id, `《${card.name}》结果：${result.message}`);
    if (card.category?.includes("信息")) addStat(state.stats.infoTricksPlayed, player.id, 1);
    if (card.id === "I04" || card.id === "I05") recordCommissionPeek(state, player.id, payload.targetPlayerId);
    state.lastMessage = `${player.nickname} 使用《${card.name}》，获得藏品情报。`;
    return;
  }
  if (card.effects?.some((effect) => effect.type === "modifyCash")) {
    const amount = card.effects.find((effect) => effect.type === "modifyCash")?.amount ?? 30;
    player.cash += amount;
    state.lastMessage = `${player.nickname} 使用《${card.name}》，获得 ${amount} 银元。`;
    return;
  }
  if (text.includes("起拍价") && state.auction) {
    state.auction.currentBid = Math.max(0, state.auction.currentBid + (text.includes("+") ? 20 : -20));
    state.lastMessage = `${player.nickname} 使用《${card.name}》，调整起拍价。`;
    return;
  }
  if (text.includes("重新加入") && state.auction) {
    state.auction.passedPlayerIds = state.auction.passedPlayerIds.filter((id) => id !== player.id);
    player.passed = false;
    state.lastMessage = `${player.nickname} 使用《${card.name}》，重新加入竞拍。`;
    return;
  }
  if (card.effects?.some((effect) => effect.type === "finalValueMultiplier")) {
    const effect = card.effects.find((candidate) => candidate.type === "finalValueMultiplier")!;
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：${card.description}`,
      appliesTo: "finalValue",
      multiplier: effect.multiplier ?? 1,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，价值效果已生效。`;
    return;
  }
  state.lastMessage = `${player.nickname} 使用了《${card.name}》。`;
}

function useRoleSkill(
  state: MutableGame,
  player: PlayerState,
  payload: { skillId: string; targetArtifactId?: string; targetPlayerId?: string; targetMissionId?: string }
): void {
  const role = player.role?.roleId ? roleById.get(player.role.roleId) : undefined;
  const skill = role?.skills.find((candidate) => candidate.id === payload.skillId);
  if (!role || !skill) throw new RuleError("你没有这个角色技能。", "NOT_OWNER");
  const charges = player.role?.skillCharges[payload.skillId];
  if (typeof charges === "number" && charges <= 0) throw new RuleError("该技能次数已用完。", "NOT_ELIGIBLE");

  switch (payload.skillId) {
    case "role01_skill01": {
      if (!["preview", "cardWindow", "auction"].includes(state.phase)) throw new RuleError("当前阶段不能使用该探查技能。", "BAD_PHASE");
      const artifact = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
      const existingChoice = state.activeEffects.find(
        (e) => e.sourceRoleSkillId === "role01_skill01" && e.createdBy === player.id && e.targetArtifactId === artifact.id
      );
      if (!existingChoice) {
        state.activeEffects.push({
          id: makeId("effect"),
          sourceRoleSkillId: payload.skillId,
          label: `《${skill.name}》：请选择查看《${artifact.name}》的传闻区间或属性。`,
          appliesTo: "visibility",
          targetArtifactId: artifact.id,
          day: state.day,
          createdBy: player.id,
          pendingChoice: true,
          choiceType: "role01_skill01_choice"
        });
      }
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，待选择查看《${artifact.name}》的信息。`;
      break;
    }
    case "role07_skill01": {
      if (!["preview", "cardWindow", "auction"].includes(state.phase)) throw new RuleError("当前阶段不能使用该探查技能。", "BAD_PHASE");
      const artifact7 = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
      privatelyPeekArtifact(artifact7, player.id);
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，查看了《${artifact7.name}》。`;
      break;
    }
    case "role07_skill03": {
      // 保护已经被改为被动技能「数量最多的类别+1」，自动生效
      throw new RuleError("该技能已改为被动，自动生效。", "INVALID_ACTION");
    }
    case "role01_skill02": {
      if (state.phase !== "blackMarket") throw new RuleError("妙笔只能在黑市日使用。", "BAD_PHASE");
      const artifact = requireArtifact(state, payload.targetArtifactId ?? player.artifacts[0]);
      if (!player.artifacts.includes(artifact.id)) throw new RuleError("只能指定自己的藏品。", "NOT_OWNER");
      const candidates = PROPERTIES.filter((candidate) => !artifact.properties.includes(candidate.id) && !["anonymous"].includes(candidate.id));
      const property = candidates.length ? pick(candidates, makeRng(`${state.roomId}:${player.id}:${artifact.id}:${state.day}:role01_skill02`)) : undefined;
      if (property) artifact.properties.push(property.id);
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，为《${artifact.name}》增加属性。`;
      break;
    }
    case "role03_skill01": {
      if (state.phase !== "finalScoring" && state.day < state.maxDays) throw new RuleError("镇馆之宝只能在终局前后指定。", "BAD_PHASE");
      const artifact = requireArtifact(state, payload.targetArtifactId ?? player.artifacts[0]);
      if (!player.artifacts.includes(artifact.id)) throw new RuleError("只能指定自己的藏品。", "NOT_OWNER");
      state.activeEffects.push({
        id: makeId("effect"),
        sourceRoleSkillId: payload.skillId,
        label: "镇馆之宝：指定藏品终局价值 +30%。",
        appliesTo: "finalValue",
        targetArtifactId: artifact.id,
        multiplier: 1.3,
        createdBy: player.id
      });
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，强化《${artifact.name}》。`;
      break;
    }
    case "role03_skill02": {
      // 以物换物：在自由阶段向别人提出物物交换
      if (state.phase !== "freeTrade") throw new RuleError("以物换物只能在自由阶段使用。", "BAD_PHASE");
      if (!payload.targetPlayerId || !payload.targetArtifactId) throw new RuleError("需要指定目标玩家和对方的藏品。", "BAD_TARGET");
      const swapTarget = requirePlayer(state, payload.targetPlayerId);
      const myArtifact = requireArtifact(state, payload.targetArtifactId);
      if (!player.artifacts.includes(myArtifact.id)) throw new RuleError("你没有这件藏品。", "NOT_OWNER");
      // 对方的藏品 ID 通过 targetArtifactId 传递（前端需要选择自己的藏品后，再选对方的藏品）
      // 对方的藏品 ID 编码在 targetMissionId 中（作为临时传递字段）
      const theirArtifactId = payload.targetMissionId as string | undefined;
      if (!theirArtifactId) throw new RuleError("需要指定对方的藏品。", "BAD_TARGET");
      const theirArtifact = requireArtifact(state, theirArtifactId);
      if (!swapTarget.artifacts.includes(theirArtifact.id)) throw new RuleError("对方没有这件藏品。", "BAD_TARGET");
      if (myArtifact.id === theirArtifact.id) throw new RuleError("不能用自己的藏品换自己。", "BAD_TARGET");
      if (swapTarget.id === player.id) throw new RuleError("不能和自己交换。", "BAD_TARGET");

      const myValue = adjustedArtifactValueForPlayer(state, player, myArtifact, state.activeEffects);
      const theirValue = adjustedArtifactValueForPlayer(state, swapTarget, theirArtifact, state.activeEffects);

      if (myValue >= theirValue) {
        // 强制交换
        removeArtifactFromPlayer(state, player, myArtifact);
        removeArtifactFromPlayer(state, swapTarget, theirArtifact);
        assignArtifactToPlayer(state, player, theirArtifact);
        assignArtifactToPlayer(state, swapTarget, myArtifact);
        addStat(state.stats.playerTradeCount, player.id, 1);
        addStat(state.stats.playerTradeCount, swapTarget.id, 1);
        state.log.push(`${player.nickname} 以《${myArtifact.name}》(价值${myValue}) 强制交换 ${swapTarget.nickname} 的《${theirArtifact.name}》(价值${theirValue})。`);
      } else {
        // 对方的价值更高，创建 pendingChoice 让对方选择是否接受
        state.activeEffects.push({
          id: makeId("effect"),
          sourceRoleSkillId: payload.skillId,
          label: `以物换物：${player.nickname} 想用《${myArtifact.name}》(价值${myValue}) 换你的《${theirArtifact.name}》(价值${theirValue})`,
          appliesTo: "cash",
          targetPlayerId: swapTarget.id,
          targetArtifactId: myArtifact.id,
          additionalTargetArtifactId: theirArtifact.id,
          day: state.day,
          createdBy: player.id,
          pendingChoice: true,
          choiceType: "role03_skill02_swap"
        });
        pushPrivateLog(state, swapTarget.id, `${player.nickname} 想用《${myArtifact.name}》(价值${myValue}) 交换你的《${theirArtifact.name}》(价值${theirValue})，是否同意？`);
        state.log.push(`${player.nickname} 向 ${swapTarget.nickname} 提出以物换物，等待对方回应。`);
      }
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，与 ${swapTarget.nickname} 进行以物换物。`;
      break;
    }
    case "role05_skill01": {
      // 孤注一掷已改为被动技能，不再允许手动触发
      throw new RuleError("孤注一掷是被动技能，无需手动使用。", "INVALID_ACTION");
    }
    case "role05_skill02": {
      // 千术技能 — 后端逻辑完整，依赖的前端入口：
      //   (1) roles.json / content.ts(.js) 中 kind 须为 "主动" 才能渲染按钮
      //   (2) App.tsx canUseRoleSkillFromView 中已加入 phase/mode/bid 检查
      //   (3) 暗标所有人出价可见性已在 getPlayerView 中按 viewer.role.roleId==="role05" 自动处理（passive 部分）
      const auction = requireAuction(state);
      const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "sealed" : auction.mode;
      if (state.phase !== "auction" || bidMode !== "sealed") throw new RuleError("千术只能在暗标拍卖时使用。", "BAD_PHASE");
      if ((player.role?.skillCharges.role05_skill02 ?? 1) <= 0) throw new RuleError("千术本局已修改过暗标。", "NOT_ELIGIBLE");
      if (!Object.prototype.hasOwnProperty.call(auction.sealedBids, player.id)) throw new RuleError("需要先提交自己的暗标。", "NOT_ELIGIBLE");
      const nextBid = Math.min(player.cash, ceilToTen(Math.max(auction.sealedBids[player.id] ?? 0, ...Object.values(auction.sealedBids)) + 10));
      auction.sealedBids[player.id] = nextBid;
      auction.sealedBidRounds![player.id] = (auction.sealedBidRounds?.[player.id] ?? 1) + 1;
      player.role!.skillCharges.role05_skill02 = 0;
      recordAuctionBid(auction, player.id, nextBid);
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，查看暗标并把自己的暗标改为 ${nextBid}。`;
      break;
    }
    case "role06_skill01": {
      if (state.phase !== "blackMarket") throw new RuleError("窃听只能在黑市日使用。", "BAD_PHASE");
      const target = requirePlayer(state, payload.targetPlayerId ?? state.players.find((candidate) => candidate.id !== player.id)?.id);
      state.activeEffects.push({
        id: makeId("effect"),
        sourceRoleSkillId: payload.skillId,
        label: `窃听：你可以查看 ${target.nickname} 的手牌。`,
        appliesTo: "visibility",
        targetPlayerId: target.id,
        day: state.day,
        createdBy: player.id
      });
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，查看 ${target.nickname} 的手牌。`;
      break;
    }
    case "role06_skill03": {
      const target = requirePlayer(state, payload.targetPlayerId ?? state.players.find((candidate) => candidate.id !== player.id)?.id);
      if (player.cash < 50) throw new RuleError("现金不足。", "CASH_LOW");
      player.cash -= 50;
      recordCommissionPeek(state, player.id, target.id);
      // 查看对方两个秘密委托
      const missions = target.missionIds.slice(0, 2).map((id) => state.missions[id]).filter(Boolean);
      const missionText = missions.map((m) => `《${m!.name}》：${m!.description}`).join("；");
      pushPrivateLog(state, player.id, `《黑料》结果：${target.nickname} 的秘密委托：${missionText}`);
      // 创建可见性效果，确保 getPlayerView 填充 revealedMissions 字段
      state.activeEffects.push({
        id: makeId("effect"),
        sourceRoleSkillId: payload.skillId,
        label: `黑料：查看 ${target.nickname} 的秘密委托`,
        appliesTo: "visibility",
        targetPlayerId: target.id,
        day: state.day,
        createdBy: player.id
      });
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，支付 50 银元查看 ${target.nickname} 的两个秘密委托。`;
      break;
    }
    case "role09_skill02": {
      // 包装已被改为被动技能，主持时成交价>100自动触发
      throw new RuleError("该技能已改为被动，自动生效。", "INVALID_ACTION");
    }
    case "role09_skill03": {
      if (state.phase !== "auction") throw new RuleError("暗箱操作只能在竞拍阶段使用。", "BAD_PHASE");
      if (state.currentHostId !== player.id) throw new RuleError("只有当前主持人可以暗箱操作。", "NOT_HOST");
      const auction = requireAuction(state);
      const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
      if (bidMode !== "english") throw new RuleError("暗箱操作只能用于英式或打包英式拍卖。", "BAD_PHASE");
      closeAuctionAsUnsold(state);
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，强行流拍并自吞。`;
      break;
    }
    default:
      if (skill.kind === "被动") throw new RuleError("被动技能会自动生效。", "INVALID_ACTION");
      throw new RuleError("该技能暂未支持主动使用。", "INVALID_ACTION");
  }

  if (typeof charges === "number") player.role!.skillCharges[payload.skillId] = Math.max(0, charges - 1);
  state.log.push(state.lastMessage);
}

function respondReaction(
  state: MutableGame,
  player: PlayerState,
  payload: { reactionId: string; cardId?: CardId; targetPlayerId?: PlayerId; response: "counter" | "pass" }
): void {
  const reaction = state.pendingReaction;
  if (!reaction || reaction.id !== payload.reactionId) throw new RuleError("反制窗口不存在。");
  if (!reaction.eligiblePlayerIds.includes(player.id)) throw new RuleError("你不能响应这个反制窗口。", "NOT_ELIGIBLE");
  if (payload.response === "counter") {
    const counterCardId = payload.cardId ?? player.hand.find((cardId) => cardById.get(cardId)?.category?.includes("反制"));
    if (!counterCardId) throw new RuleError("你没有可用反制牌。", "CARD_NOT_OWNED");
    if (!player.hand.includes(counterCardId)) throw new RuleError("你没有这张反制牌。", "CARD_NOT_OWNED");
    const counterCard = cardById.get(counterCardId);
    if (!counterCard?.category?.includes("反制")) throw new RuleError("这不是反制牌。", "BAD_TARGET");
    player.hand = player.hand.filter((cardId) => cardId !== counterCardId);
    addStat(state.stats.trickCardsPlayed, player.id, 1);

    if (counterCardId === "R01" || counterCardId === "R03") {
      state.delayedCardEffects.push({
        id: makeId("delayed"),
        sourcePlayerId: reaction.sourcePlayerId,
        sourceCardId: reaction.sourceCardId!,
        targetArtifactId: reaction.targetArtifactId,
        targetPlayerId: reaction.targetPlayerId,
        remainingSettlements: counterCardId === "R01" ? 0 : 1,
        createdAt: Date.now()
      });
      state.lastMessage = `${player.nickname} 使用《${counterCard.name}》，将该效果${counterCardId === "R01" ? "延迟到当前拍品结算后" : "推迟到下一件拍品结算后"}。`;
      state.pendingReaction = undefined;
      state.log.push(state.lastMessage);
      return;
    }

    if (counterCardId === "R04" && reaction.targetPlayerId !== player.id) {
      throw new RuleError("水银只能取消对你自己的干扰。", "NOT_ELIGIBLE");
    }

    if (counterCardId === "R05") {
      const nextTarget = requirePlayer(state, payload.targetPlayerId);
      if (nextTarget.id === reaction.sourcePlayerId || nextTarget.id === player.id) throw new RuleError("需要转移给另一名玩家。", "BAD_TARGET");
      const sourcePlayer = requirePlayer(state, reaction.sourcePlayerId);
      const sourceCard = reaction.sourceCardId ? cardById.get(reaction.sourceCardId) : undefined;
      if (!sourceCard) throw new RuleError("待反制卡牌不存在。");
      state.pendingReaction = undefined;
      resolveCardEffect(state, sourcePlayer, sourceCard, {
        targetArtifactId: reaction.targetArtifactId,
        targetPlayerId: nextTarget.id
      });
      state.lastMessage = `${player.nickname} 使用《${counterCard.name}》，将干扰转移给 ${nextTarget.nickname}。`;
      state.log.push(state.lastMessage);
      return;
    }

    reaction.countered = true;
    state.lastMessage = `${player.nickname} 使用《${counterCard.name}》，取消了本次效果。`;
    state.pendingReaction = undefined;
    state.log.push(state.lastMessage);
    return;
  }

  const passedPlayerIds = new Set(reaction.passedPlayerIds ?? []);
  passedPlayerIds.add(player.id);
  reaction.passedPlayerIds = [...passedPlayerIds];
  if (reaction.passedPlayerIds.length < reaction.eligiblePlayerIds.length) {
    state.lastMessage = `${player.nickname} 放弃反制，等待其他玩家响应。`;
    state.log.push(state.lastMessage);
    return;
  }

  const sourcePlayer = requirePlayer(state, reaction.sourcePlayerId);
  const sourceCard = reaction.sourceCardId ? cardById.get(reaction.sourceCardId) : undefined;
  if (!sourceCard) throw new RuleError("待反制卡牌不存在。");
  state.pendingReaction = undefined;
  const previousLogLength = state.log.length;
  resolveCardEffect(state, sourcePlayer, sourceCard, {
    targetArtifactId: reaction.targetArtifactId,
    targetPlayerId: reaction.targetPlayerId
  });
  if (state.log.length === previousLogLength) {
    state.log.push(state.lastMessage ?? `${sourcePlayer.nickname} 的《${sourceCard.name}》生效。`);
  }
}

function createTradeOffer(
  state: MutableGame,
  player: PlayerState,
  payload: { toPlayerId: PlayerId; give: TradeAssetSet; receive: TradeAssetSet; message?: string }
): void {
  assertPhase(state, "freeTrade");
  if (isBlockedByCard(state, player, "D05")) throw new RuleError("你本日不能进行玩家交易。", "NOT_ELIGIBLE");
  if ((player.tradesToday ?? 0) >= GAME_CONSTANTS.maxTradesPerDay) throw new RuleError("你今日已达交易上限（3次）。", "INVALID_ACTION");
  const target = requirePlayer(state, payload.toPlayerId);
  if ((target.tradesToday ?? 0) >= GAME_CONSTANTS.maxTradesPerDay) throw new RuleError("对方今日已达交易上限（3次）。", "INVALID_ACTION");
  assertAssets(player, payload.give);
  assertAssets(target, payload.receive);
  assertTradeAllowedByEvents(state, payload.give);
  assertTradeAllowedByEvents(state, payload.receive);
  const offer: TradeOffer = {
    id: makeId("trade"),
    fromPlayerId: player.id,
    toPlayerId: target.id,
    give: payload.give,
    receive: payload.receive,
    status: "pending",
    version: 1,
    day: state.day,
    message: payload.message
  };
  state.tradeOffers.push(offer);
  state.lastMessage = `${player.nickname} 向 ${target.nickname} 发起交易。`;
  state.log.push(state.lastMessage);
  const detail = tradeOfferDetail(state, offer);
  pushPrivateLog(state, player.id, `你向 ${target.nickname} 发起交易：你给出 ${detail.give}，想获得 ${detail.receive}。`);
  pushPrivateLog(state, target.id, `${player.nickname} 向你发起交易：对方给出 ${detail.give}，想获得 ${detail.receive}。`);
}

function respondTradeOffer(state: MutableGame, player: PlayerState, tradeOfferId: string, accept: boolean, version: number): void {
  assertPhase(state, "freeTrade");
  const offer = state.tradeOffers.find((candidate) => candidate.id === tradeOfferId);
  if (!offer) throw new RuleError("交易不存在。");
  if (offer.toPlayerId !== player.id) throw new RuleError("只有交易对象可以响应。", "NOT_ELIGIBLE");
  if (offer.version !== version || offer.status !== "pending") throw new RuleError("交易状态已变化。", "VERSION_CONFLICT");
  if (!accept) {
    if (offer.message === "D02") {
      const from = requirePlayer(state, offer.fromPlayerId);
      const artifactId = offer.receive.artifactIds?.[0];
      const artifact = artifactId ? requireArtifact(state, artifactId) : undefined;
      if (artifact) {
        state.activeEffects.push({
          id: makeId("effect"),
          sourceCardId: "D02",
          label: `巧取豪夺：${player.nickname} 拒绝收购《${artifact.name}》，请选择支付 20 银元或展示属性。`,
          appliesTo: "cash",
          targetPlayerId: player.id,
          targetArtifactId: artifact.id,
          amount: 20,
          day: state.day,
          createdBy: from.id,
          pendingChoice: true,
          choiceType: "D02_refusal"
        });
      }
      state.lastMessage = `${player.nickname} 拒绝巧取豪夺，等待选择付钱或展示属性。`;
    } else {
      state.lastMessage = `${player.nickname} 拒绝了交易。`;
    }
    offer.status = "declined";
    offer.version += 1;
    state.log.push(state.lastMessage);
    const detail = tradeOfferDetail(state, offer);
    pushPrivateLog(state, player.id, `你拒绝了 ${requirePlayer(state, offer.fromPlayerId).nickname} 的交易：对方给出 ${detail.give}，想获得 ${detail.receive}。`);
    pushPrivateLog(state, offer.fromPlayerId, `${player.nickname} 拒绝了你的交易：你原本给出 ${detail.give}，想获得 ${detail.receive}。`);
    return;
  }
  const from = requirePlayer(state, offer.fromPlayerId);
  const to = requirePlayer(state, offer.toPlayerId);
  assertAssets(from, offer.give);
  assertAssets(to, offer.receive);
  assertTradeAllowedByEvents(state, offer.give);
  assertTradeAllowedByEvents(state, offer.receive);
  recordProfitableTradeFlip(state, from, offer.give, offer.receive);
  recordProfitableTradeFlip(state, to, offer.receive, offer.give);
  transferAssets(state, from, to, offer.give);
  transferAssets(state, to, from, offer.receive);
  applyHotTradeBonus(state, from, offer.give, offer.receive);
  applyHotTradeBonus(state, to, offer.receive, offer.give);
  offer.status = "accepted";
  offer.version += 1;
  from.tradesToday = (from.tradesToday ?? 0) + 1;
  to.tradesToday = (to.tradesToday ?? 0) + 1;
  addStat(state.stats.playerTradeCount, from.id, 1);
  addStat(state.stats.playerTradeCount, to.id, 1);
  if ([...(offer.give.artifactIds ?? []), ...(offer.receive.artifactIds ?? [])].length > 0) {
    if (from.role?.roleId === "role08") from.cash += 10;
    if (to.role?.roleId === "role08") to.cash += 10;
  }
  // 牵线人：本阶段下一次玩家交易成功后双方各获得10银元
  const c08Effect = state.activeEffects.find((effect) => effect.sourceCardId === "C08" && effect.day === state.day);
  if (c08Effect) {
    from.cash += 10;
    to.cash += 10;
    state.activeEffects = state.activeEffects.filter((effect) => effect.id !== c08Effect.id);
    state.log.push(`《牵线人》生效，${from.nickname} 和 ${to.nickname} 各获得 10 银元。`);
  }
  state.lastMessage = `${from.nickname} 与 ${to.nickname} 完成交易。`;
  state.log.push(state.lastMessage);
  const detail = tradeOfferDetail(state, offer);
  pushPrivateLog(state, from.id, `交易完成：你给出 ${detail.give}，从 ${to.nickname} 获得 ${detail.receive}。`);
  pushPrivateLog(state, to.id, `交易完成：你给出 ${detail.receive}，从 ${from.nickname} 获得 ${detail.give}。`);
}

function sellToBank(state: MutableGame, player: PlayerState, artifactId: ArtifactId): void {
  if (!["freeTrade", "blackMarket", "cardWindow", "eventWindow"].includes(state.phase)) throw new RuleError("当前阶段不能卖给银行。", "BAD_PHASE");
  if (isBlockedByCard(state, player, "D05")) throw new RuleError("你本日不能出售给银行。", "NOT_ELIGIBLE");
  if (!player.artifacts.includes(artifactId)) throw new RuleError("你没有这件藏品。", "NOT_OWNER");
  const artifact = requireArtifact(state, artifactId);
  const bannedCategory = todayEffects(state, "E26").find((effect) => effect.category === artifact.category);
  if (bannedCategory) throw new RuleError("该类别今日禁止出售给银行。", "NOT_ELIGIBLE");
  const saleEffect = state.activeEffects.find((effect) => effect.createdBy === player.id && effect.sourceCardId === "C01" && effect.day === state.day);
  const price = bankSellPriceFor(state, player, artifact);
  const buybackVoucher = state.activeEffects.find((effect) => effect.createdBy === player.id && effect.sourceCardId === "C03" && effect.day === state.day && !effect.targetArtifactId);
  player.cash += price;
  removeArtifactFromPlayer(state, player, artifact);
  if (saleEffect) state.activeEffects = state.activeEffects.filter((effect) => effect.id !== saleEffect.id);
  if (buybackVoucher) {
    state.activeEffects = state.activeEffects.filter((effect) => effect.id !== buybackVoucher.id);
    state.activeEffects.push({
      ...buybackVoucher,
      id: makeId("effect"),
      label: `回购凭证：《${artifact.name}》下一天可用 ${price + 20} 银元买回。`,
      targetArtifactId: artifact.id,
      amount: price + 20,
      day: state.day + 1
    });
  }
  if ((artifact.purchasePrice ?? Number.POSITIVE_INFINITY) < price) addStat(state.stats.profitableFlipCount, player.id, 1);
  addStat(state.stats.sellToBankCount, player.id, 1);
  state.lastMessage = `${player.nickname} 将《${artifact.name}》卖给银行，获得 ${price} 银元。`;
  state.log.push(state.lastMessage);
  pushPrivateLog(state, player.id, `你把藏品《${artifact.name}》卖给银行，获得 ${price} 银元，当前剩余 ${player.cash} 银元。`);
}

function takeLoan(state: MutableGame, player: PlayerState): void {
  if (state.phase === "finalScoring" || state.phase === "lobby") throw new RuleError("当前阶段不能贷款。", "BAD_PHASE");
  if (todayEffects(state).some((effect) => effect.loanBlocked)) throw new RuleError("今日不能贷款。", "NOT_ELIGIBLE");
  const loanLimit = dailyLoanLimitFor(state, player);
  if ((player.loansTakenToday ?? 0) >= loanLimit) throw new RuleError("今日贷款次数已达上限。", "NOT_ELIGIBLE");
  const repayment = loanRepaymentFor(state, player);
  player.loans += 1;
  player.loansTakenToday = (player.loansTakenToday ?? 0) + 1;
  player.cash += GAME_CONSTANTS.loanAmount;
  player.loanRepayments = [...(player.loanRepayments ?? []), repayment];
  addStat(state.stats.loansTaken, player.id, 1);
  state.lastMessage = `${player.nickname} 向钱庄借款 ${GAME_CONSTANTS.loanAmount} 银元。`;
  state.log.push(state.lastMessage);
}

function repayLoan(state: MutableGame, player: PlayerState): void {
  if (player.loans <= 0) throw new RuleError("没有贷款需要偿还。");
  const repayments = player.loanRepayments ?? Array.from({ length: player.loans }, () => GAME_CONSTANTS.loanRepayment);
  const repayment = repayments[0] ?? GAME_CONSTANTS.loanRepayment;
  if (player.cash < repayment) throw new RuleError("现金不足。", "CASH_LOW");
  player.cash -= repayment;
  player.loans -= 1;
  player.loanRepayments = repayments.slice(1);
  state.lastMessage = `${player.nickname} 偿还贷款 ${repayment} 银元。`;
  state.log.push(state.lastMessage);
}

function maybeTriggerNaturalEvent(state: MutableGame): void {
  if (state.log.at(-1)?.includes("事件")) return;
  if (Math.random() > GAME_CONSTANTS.naturalEventChance) return;
  const natural = EVENT_CARDS.find((event) => event.natural);
  if (!natural) return;
  state.activeEffects.push({
    id: makeId("effect"),
    sourceEventId: natural.id,
    label: `自然事件：${natural.name}（下一个拍卖日结束后，从当天成交藏品中随机 1 件触发收购）`,
    appliesTo: "auction",
    day: state.day + 1,
    createdBy: state.hostPlayerId ?? state.players[0]!.id
  });
  state.log.push(`触发自然事件《${natural.name}》。`);
  grantIntelBrokerCards(state);
}

function finalizeScores(state: MutableGame): void {
  resolveAllPendingChoices(state);
  for (const player of state.players) {
    const score = calculatePlayerScore(state as GameState, player);
    player.finalScore = score;
    if (player.cash < remainingLoanDebt(player) && player.artifacts.length > 0) {
      const vals = player.artifacts.map((id) => ({ id, v: adjustedArtifactValueForPlayer(state, player, requireArtifact(state, id), state.activeEffects) }));
      const forfeit = vals.sort((a, b) => a.v - b.v)[0]!;
      const art = state.artifacts[forfeit.id];
      if (art) removeArtifactFromPlayer(state, player, art);
      state.log.push(`${player.nickname} 因无力偿还贷款，被没收《${art?.name ?? forfeit.id}》。`);
    }
  }
}

function calculatePlayerScore(state: GameState, player: PlayerState): FinalScore {
  const loanDebt = remainingLoanDebt(player);
  let cashAfterLoan: number;
  let loanPenalty = 0;
  if (player.cash >= loanDebt) {
    cashAfterLoan = player.cash - loanDebt;
  } else {
    const shortfall = loanDebt - player.cash;
    cashAfterLoan = 0;
    if (player.artifacts.length > 0) {
      const vals = player.artifacts.map((id) => ({ id, v: adjustedArtifactValueForPlayer(state, player, requireArtifact(state, id), state.activeEffects) }));
      vals.sort((a, b) => a.v - b.v);
    } else {
      loanPenalty = Math.floor(shortfall / 10);
    }
  }
  const roleEffects = roleFinalValueEffects(state as MutableGame, player);
  const finalEff = [...state.activeEffects, ...roleEffects];
  const artVals = player.artifacts.map((id) => adjustedArtifactValueForPlayer(state, player, requireArtifact(state, id), finalEff));
  const artVal = artVals.reduce((s, v) => s + v, 0);
  const donated = state.activeEffects.some((e) => e.sourceRoleSkillId === "prop31_donated" && e.createdBy === player.id);
  const divisor = donated ? 30 : hasTodayEffect(state, "E16") ? 40 : 50;
  const baseCash = Math.floor(cashAfterLoan / 50);
  const cashRep = divisor < 50 ? baseCash + (divisor === 40 ? Math.min(5, Math.floor(cashAfterLoan / divisor) - baseCash) : Math.floor(cashAfterLoan / divisor) - baseCash) : baseCash;
  const artRep = Math.floor(artVal / 50);
  let catRep = scoreCategoryCollections(state, player);
  const setRep = catRep;
  const mResults = scoreMissions(state, player);
  let mRep = mResults.reduce((s, r) => s + r.reputation, 0);
  if (player.role?.roleId === "role03") mRep = Math.floor(mRep * 1.3);
  let propRep = scorePropertyRep(state, player);
  if (player.role?.roleId === "role07") propRep += Math.floor(new Set(player.artifacts.map((id) => requireArtifact(state, id).category)).size / 3);
  const rPenalty = roleFinalPenalty(state, player);
  const eRep = player.reputationBonus ?? 0;
  const rep = cashRep + artRep + catRep + mRep + propRep + eRep - loanPenalty - rPenalty;
  return {
    reputation: rep, cashRep, cashAfterLoan, cashDivisor: divisor, artifactRep: artRep, categoryRep: catRep, setRep,
    missionRep: mRep, propertyRep: propRep, eventRep: eRep, loanPenalty, loanDebt, rolePenalty: rPenalty,
    artifactValue: artVal,
    tieBreakers: { artifactValue: artVal, cash: cashAfterLoan, highestArtifactValue: Math.max(0, ...artVals) },
    missionResults: mResults
  };
}

function scoreCategoryCollections(state: GameState, player: PlayerState) {
  const counts = new Map<string, number>();
  for (const artifactId of player.artifacts) {
    const artifact = requireArtifact(state, artifactId);
    if (artifact.properties.includes("fake") || artifact.tag === "fake") continue;
    counts.set(artifact.category, (counts.get(artifact.category) ?? 0) + 1);
  }
  // 考古学者被动：数量最多的类别+1
  if (player.role?.roleId === "role07" && counts.size > 0) {
    const maxCategory = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    counts.set(maxCategory, (counts.get(maxCategory) ?? 0) + 1);
  }
  let score = 0;
  for (const count of counts.values()) {
    if (count >= 4) score += 6;
    else if (count >= 3) score += 4;
    else if (count >= 2) score += 2;
  }
  return score;
}

function scoreMissions(state: GameState, player: PlayerState) {
  return (player.missionIds.length ? player.missionIds : player.missionId ? [player.missionId] : []).map((missionId) => {
    const mission = missionById.get(missionId);
    if (!mission) return { missionId, success: false, reputation: 0 };
    const success = evaluateMission(state, player, mission);
    return { missionId, success, reputation: success ? mission.reputation : 0 };
  });
}

function evaluateMission(state: GameState, player: PlayerState, mission: MissionCard): boolean {
  const artifacts = player.artifacts.map((id) => requireArtifact(state, id));
  const values = artifacts.map((artifact) => adjustedArtifactValueForPlayer(state, player, artifact, state.activeEffects, { includeMissionDependentEffects: false }));
  const finalCash = Math.max(0, player.cash - remainingLoanDebt(player));
  const categoryCounts = categoryCountsForArtifacts(state, player, artifacts);
  const fakeCount = artifacts.filter(isFakeArtifact).length;
  const nonFakeCount = artifacts.length - fakeCount;
  const maxValue = Math.max(0, ...values);
  const avgValue = artifacts.length > 0 ? values.reduce((sum, value) => sum + value, 0) / artifacts.length : 0;
  const categoryMission = missionCategory(mission.id);
  if (categoryMission) return (categoryCounts.get(categoryMission) ?? 0) >= 3;

  switch (mission.id) {
    case "W01":
      return artifacts.length >= 4;
    case "W02":
      return artifacts.length <= 2 && maxValue >= 180;
    case "W03":
      return categoryCounts.size >= 5;
    case "W04":
      return Math.max(0, ...categoryCounts.values()) >= 3;
    case "W05":
      return exclusiveCategoryItemCount(state, player) >= 3;
    case "W06":
      return fakeCount >= 3;
    case "W07":
      return artifacts.length > 0 && fakeCount === 0;
    case "W08":
      return artifacts.length === Math.max(...state.players.map((candidate) => candidate.artifacts.length));
    case "W09":
      return finalCash >= 300;
    case "W10":
      return (state.stats.loansTaken[player.id] ?? 0) >= 3 && player.loans === 0;
    case "W11":
      return finalCash <= 30;
    case "W12":
      return artifacts.length >= 5 && (state.stats.auctionSpend[player.id] ?? 0) <= 400;
    case "W13":
      return (state.stats.playerTradeCount[player.id] ?? 0) >= 3;
    case "W14":
      return (state.stats.profitableFlipCount[player.id] ?? 0) >= 1;
    case "W15":
      return (state.stats.blackMarketCardsBought[player.id] ?? 0) >= 3;
    case "W16":
      return player.hand.length + player.events.length >= 4;
    case "W17":
      return (state.stats.belowRumorMinWins[player.id] ?? 0) >= 3;
    case "W18":
      return (state.stats.auctionWinBid200[player.id] ?? 0) >= 1;
    case "W19":
      return (state.stats.auctionWinsByMode[`${player.id}:sealed`] ?? 0) >= 2;
    case "W20":
      return (state.stats.firstBidWins[player.id] ?? 0) >= 3;
    case "W21":
      return (state.stats.closeWins[player.id] ?? 0) >= 2;
    case "W22":
      return (state.stats.auctionWinsAfterDay7[player.id] ?? 0) >= 2;
    case "W23":
      return artifacts.length > 0 && artifacts.length <= 3 && avgValue >= 130;
    case "W24":
      return (state.stats.auctionWinCount[player.id] ?? 0) >= 3;
    case "W25":
      return (state.stats.infoTricksPlayed[player.id] ?? 0) >= 5;
    case "W26":
      return artifacts.filter((artifact) => artifact.peekedBy.length === 0).length >= 3 && artifacts.filter((artifact) => artifact.peekedBy.length === 0).reduce((sum, artifact) => sum + adjustedArtifactValueForPlayer(state, player, artifact, state.activeEffects, { includeMissionDependentEffects: false }), 0) >= 200;
    case "W27":
      return new Set(state.stats.commissionPeekTargetsByViewer?.[player.id] ?? []).size >= 3;
    case "W28":
      return fakeCount >= 2 && nonFakeCount >= 2;
    case "W29":
      return (state.stats.commissionPeekedByTarget[player.id] ?? 0) === 0;
    case "W30":
      return (state.stats.eventCardsPlayed[player.id] ?? 0) >= 2;
    case "W31":
      return (state.stats.infoTricksPlayed[player.id] ?? 0) >= 3;
    case "W32":
      return (state.stats.commissionPeeksByViewer[player.id] ?? 0) >= 1;
    case "W33":
      return (state.stats.commissionEarned[player.id] ?? 0) >= 100;
    case "W34":
      return (state.stats.hostedAboveCeilingCount[player.id] ?? 0) >= 2;
    case "W35":
      return (state.stats.hostedBelowFloorCount[player.id] ?? 0) >= 2;
    case "W36": {
      const hostedTotal = state.stats.hostedTotalSales[player.id] ?? 0;
      return hostedTotal > 0 && hostedTotal === Math.max(...state.players.map((candidate) => state.stats.hostedTotalSales[candidate.id] ?? 0));
    }
    case "W37":
      return (state.stats.selfBoughtPassInCount[player.id] ?? 0) >= 2;
    case "W38": {
      const hostedCount = (state.stats.hostedSoldCount[player.id] ?? 0) + (state.stats.hostedPassInCount[player.id] ?? 0);
      return hostedCount > 0 && (state.stats.hostedPassInCount[player.id] ?? 0) === 0;
    }
    case "W39":
      return (state.stats.hostedOver200Count[player.id] ?? 0) >= 1;
    case "W40": {
      const soldCount = state.stats.hostedSoldCount[player.id] ?? 0;
      return soldCount > 0 && (state.stats.hostedTotalSales[player.id] ?? 0) / soldCount >= 120;
    }
    default:
      return false;
  }
}

function scorePropertyRep(state: GameState, player: PlayerState): number {
  let score = 0;
  const artifacts = playerArtifacts(state, player);
  for (const artifact of artifacts) {
    if (artifact.properties.includes("treasure")) score += 1;
    if (artifact.properties.includes("prop14")) score += unexpectedWindfallRep(state, player, artifact);
    if (artifact.properties.includes("prop31")) score += 0;
  }
  if (artifacts.some((artifact) => artifact.properties.includes("curse")) && artifacts.length <= 3) score -= 5;
  return score;
}

function roleFinalValueEffects(state: GameState, player: PlayerState): ActiveEffect[] {
  const effects: ActiveEffect[] = [];
  if (player.role?.roleId === "role01") {
    const fakeArtifact = player.artifacts.map((id) => requireArtifact(state, id)).find(isFakeArtifact);
    if (fakeArtifact) {
      const currentMultiplier = artifactBaseMultiplier(fakeArtifact);
      effects.push({
        id: "role_fake_value",
        sourceRoleSkillId: "role01_skill03",
        label: "角色技能：一件赝品按原价结算。",
        appliesTo: "finalValue",
        targetArtifactId: fakeArtifact.id,
        multiplier: currentMultiplier > 0 ? 1 / currentMultiplier : 1,
        createdBy: player.id
      });
    }
  }
  return effects;
}

function roleFinalPenalty(state: GameState, player: PlayerState): number {
  const hate = state.activeEffects.filter((effect) => effect.label.includes("资本") && effect.targetPlayerId === player.id).length;
  return hate >= 3 ? 2 : 0;
}

function isFakeArtifact(artifact: ArtifactInstance): boolean {
  return artifact.properties.includes("fake") || artifact.tag === "fake";
}

function missionCategory(missionId: string): ArtifactCategory | undefined {
  const categories: Record<string, ArtifactCategory> = {
    W41: "calligraphy",
    W42: "bronze",
    W43: "jewelry",
    W44: "porcelain",
    W45: "jade",
    W46: "book",
    W47: "coin",
    W48: "curio",
    W49: "relic",
    W50: "evil",
    W51: "legacy",
    W52: "lastword"
  };
  return categories[missionId];
}

function categoryCountsForArtifacts(state: GameState, player: PlayerState, artifacts: ArtifactInstance[]): Map<string, number> {
  const counts = countBy(artifacts.map((artifact) => artifact.category));
  if (player.role?.roleId === "role07" && counts.size > 0) {
    const maxCategory = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    counts.set(maxCategory, (counts.get(maxCategory) ?? 0) + 1);
  }
  return counts;
}

function exclusiveCategoryItemCount(state: GameState, player: PlayerState): number {
  const otherCategories = new Set(
    state.players
      .filter((candidate) => candidate.id !== player.id)
      .flatMap((candidate) => candidate.artifacts.map((id) => requireArtifact(state, id).category))
  );
  return player.artifacts.map((id) => requireArtifact(state, id)).filter((artifact) => !otherCategories.has(artifact.category)).length;
}

function remainingLoanDebt(player: PlayerState): number {
  const repayments = player.loanRepayments ?? Array.from({ length: player.loans }, () => GAME_CONSTANTS.loanRepayment);
  return repayments.slice(0, player.loans).reduce((sum, repayment) => sum + repayment, 0);
}

function adjustedArtifactValue(artifact: ArtifactInstance, currentDay: number, activeEffects: ActiveEffect[] = []): number {
  const propertyMultiplier = artifact.properties.reduce((multiplier, property) => {
    if (property === "fake") return multiplier * 0.3;
    if (property === "treasure") return multiplier * 1.1;
    if (property === "heirloom") return multiplier * (1 + Math.max(0, currentDay - (artifact.dayAcquired ?? currentDay)) * 0.02);
    if (property === "fragile") return multiplier * 0.9;
    if (property === "prop03") return multiplier * 1.1;
    if (property === "prop24") return multiplier * 0.8;
    return multiplier;
  }, artifact.tag === "fake" ? 0.7 : artifact.tag === "treasure" ? 1.15 : artifact.tag === "fragile" ? 0.9 : 1);
  const effectMultiplier = activeEffects.reduce((multiplier, effect) => {
    if (effect.appliesTo !== "finalValue") return multiplier;
    if (effect.targetArtifactId && effect.targetArtifactId !== artifact.id) return multiplier;
    if (effect.category && effect.category !== artifact.category) return multiplier;
    if (effect.categories && !effect.categories.includes(artifact.category)) return multiplier;
    if (effect.property && !artifact.properties.includes(effect.property)) return multiplier;
    if (effect.day !== undefined && effect.day !== artifact.dayAcquired) return multiplier;
    return multiplier * (effect.multiplier ?? 1);
  }, 1);
  return Math.floor(artifact.trueValue * propertyMultiplier * effectMultiplier);
}

function adjustedArtifactValueForPlayer(
  state: GameState,
  player: PlayerState,
  artifact: ArtifactInstance,
  activeEffects: ActiveEffect[] = state.activeEffects,
  options: { includeMissionDependentEffects?: boolean } = { includeMissionDependentEffects: true }
): number {
  if (typeof artifact.lockedSettlementValue === "number") {
    const roleOverride = activeEffects.find(
      (effect) =>
        effect.appliesTo === "finalValue" &&
        effect.sourceRoleSkillId === "role01_skill03" &&
        effect.targetArtifactId === artifact.id &&
        effect.createdBy === player.id
    );
    // 传世（heirloom）需要动态计算每日增长，不能锁死在获取时
    const baseValue = roleOverride ? artifact.trueValue : artifact.lockedSettlementValue;
    const heirloomMultiplier = (artifact.tag === "heirloom" || artifact.properties.includes("heirloom"))
      ? (1 + Math.max(0, state.day - (artifact.dayAcquired ?? state.day)) * 0.02)
      : 1;
    if (!roleOverride && heirloomMultiplier <= 1) return artifact.lockedSettlementValue;
    if (!roleOverride && heirloomMultiplier > 1) return Math.floor(baseValue * heirloomMultiplier);
    // roleOverride继续往下走完整计算
  }
  let multiplier = artifactBaseMultiplier(artifact);
  // 传世动态加成（不在锁定值路径时）
  if (artifact.tag === "heirloom" || artifact.properties.includes("heirloom")) {
    multiplier *= 1 + Math.max(0, state.day - (artifact.dayAcquired ?? state.day)) * 0.02;
  }
  if (!artifact.properties.includes("treasure") && playerArtifacts(state, player).some((owned) => owned.properties.includes("treasure"))) multiplier *= 1.1;
  if (!artifact.properties.includes("prop16") && artifact.peekedBy.length === 0 && playerArtifacts(state, player).some((owned) => owned.properties.includes("prop16"))) multiplier *= 1.08;
  if (artifact.properties.includes("prop03")) multiplier *= 1.1;
  if (artifact.properties.includes("prop05") && artifact.peekedBy.length === 0) multiplier *= 1.15;
  if (artifact.properties.includes("prop06") && playerArtifacts(state, player).filter((owned) => owned.category === artifact.category).length >= 3) multiplier *= 1.2;
  if (artifact.properties.includes("prop07") && Object.values(state.artifacts).filter((candidate) => candidate.ownerId && candidate.category === artifact.category).length <= 2) multiplier *= 1.5;
  if (artifact.properties.includes("prop16") && artifact.peekedBy.length === 0) multiplier *= 1.08;
  if (artifact.properties.includes("prop17")) multiplier *= 1 + new Set(playerArtifacts(state, player).map((owned) => owned.category)).size * 0.08;
  if (artifact.properties.includes("prop20") && player.loans === 0) multiplier *= 1.15;
  if (artifact.properties.includes("prop21") && player.artifacts.length < averageArtifactCount(state)) multiplier *= 1.25;
  if (artifact.properties.includes("prop24")) multiplier *= 0.8;
  if (artifact.properties.includes("prop26") && (artifact.privatePeekedBy?.length ?? 0) > 0) multiplier *= 0.85;
  if (options.includeMissionDependentEffects !== false && playerArtifacts(state, player).some((owned) => owned.properties.includes("prop27")) && scoreMissions(state, player).every((result) => !result.success)) multiplier *= 0.85;
  if (artifact.properties.includes("prop29")) multiplier *= (artifact.dayAcquired ?? 0) >= 3 ? 1.1 : 0.95;
  if (artifact.properties.includes("prop30")) multiplier *= mismatchEstimateMultiplier(state, player, artifact);

  const effectMultiplier = activeEffects.reduce((current, effect) => {
    if (effect.appliesTo !== "finalValue") return current;
    if (effect.targetArtifactId && effect.targetArtifactId !== artifact.id) return current;
    if (effect.category && effect.category !== artifact.category) return current;
    if (effect.categories && !effect.categories.includes(artifact.category)) return current;
    if (effect.property && !artifact.properties.includes(effect.property)) return current;
    if (effect.day !== undefined && effect.day !== artifact.dayAcquired) return current;
    if (player.role?.roleId === "role07" && isNegativeFinalValueEffect(effect)) return current;
    return current * (effect.multiplier ?? 1);
  }, 1);

  return Math.floor(artifact.trueValue * multiplier * effectMultiplier);
}

function artifactBaseMultiplier(artifact: ArtifactInstance): number {
  let multiplier = 1;
  if (artifact.tag === "treasure" || artifact.properties.includes("treasure")) multiplier *= artifact.tag === "treasure" ? 1.15 : 1.1;
  if (artifact.tag === "fake" || artifact.properties.includes("fake")) multiplier *= 0.3;
  if (artifact.tag === "fragile" || artifact.properties.includes("fragile")) multiplier *= 0.9;
  return multiplier;
}

function currentDutchPrice(auction: NonNullable<GameState["auction"]>): number {
  // 直接返回当前已存储的荷兰价，不需要重新计算
  if (!auction.dutch) return Math.max(0, auction.currentBid);
  return Math.max(0, auction.dutch.currentPrice);
}

export function getPlayerView(state: GameState, playerId: PlayerId): PlayerView {
  const self = requirePlayer(state, playerId);
  const isFinal = state.phase === "finalScoring";
  const currentHostId = state.currentHostId;
  const players = state.players.map((player) => {
    const role = player.role?.roleId ? roleById.get(player.role.roleId) : undefined;
    const canSeeHand = state.activeEffects.some(
      (effect) =>
        effect.appliesTo === "visibility" &&
        (effect.sourceCardId === "D03" || effect.sourceRoleSkillId === "role06_skill01") &&
        effect.createdBy === self.id &&
        effect.targetPlayerId === player.id &&
        effect.day === state.day
    );
    const canSeeMissions = state.activeEffects.some(
      (effect) => effect.appliesTo === "visibility" && effect.sourceRoleSkillId === "role06_skill03" && effect.createdBy === self.id && effect.targetPlayerId === player.id && effect.day === state.day
    );
    return {
      id: player.id,
      nickname: player.nickname,
      seat: player.seat,
      ready: player.ready,
      connected: player.connected,
      cash: player.cash,
      loans: player.loans,
      artifactCount: player.artifacts.length,
      handCount: player.hand.length,
      eventCount: player.events.length,
      isHost: player.id === currentHostId,
      isOwner: player.id === state.hostPlayerId,
      passed: player.passed,
      roleName: role?.name,
      kicked: player.kicked,
      automatedAt: player.automatedAt,
      automatedReason: player.automatedReason,
      revealedHand: canSeeHand ? player.hand.map((id) => trickById.get(id)).filter(isDefined) : undefined,
      revealedEvents: canSeeHand ? player.events.map((id) => eventById.get(id)).filter(isDefined) : undefined,
      revealedMissions: canSeeMissions ? player.missionIds.map((id) => state.missions[id]).filter(isDefined) : undefined,
      artifacts: player.artifacts.map((id) => artifactView(state, id, self.id, false, isFinal)),
      tradesToday: player.tradesToday,
      finalScore: player.finalScore
    };
  });

  const selfArtifacts = self.artifacts.map((id) => artifactView(state, id, self.id, true, isFinal));
  const todayArtifacts = state.todayArtifactIds.map((id) => artifactView(state, id, self.id, self.id === currentHostId || !currentHostId, isFinal));
  const role = self.role?.roleId ? roleById.get(self.role.roleId) : undefined;

  return {
    roomId: state.roomId,
    joinCode: state.joinCode,
    selfId: self.id,
    phase: state.phase,
    day: state.day,
    maxDays: state.maxDays,
    currentHostId,
    phaseStartedAt: state.phaseStartedAt,
    phaseDeadlineAt: state.phaseDeadlineAt,
    phaseTimeoutMs: state.phaseTimeouts?.[state.phase],
    phaseTimeouts: state.phaseTimeouts,
    paused: state.paused,
    players,
    self: {
      ...players.find((player) => player.id === self.id)!,
      hand: self.hand.map((id) => trickById.get(id)).filter(Boolean) as TrickCard[],
      events: self.events.map((id) => eventById.get(id)).filter(Boolean) as EventCard[],
      artifacts: selfArtifacts,
      missions: self.missionIds.map((id) => state.missions[id]).filter(isDefined),
      mission: self.missionId ? state.missions[self.missionId] : undefined,
      role,
      loanRepayments: self.loanRepayments,
      roleSkillCharges: self.role?.skillCharges
    },
    todayArtifacts,
    auction: publicAuctionView(state, self.id),
    pendingReaction: reactionView(state, self.id),
    tradeOffers: state.tradeOffers.filter((offer) => offer.fromPlayerId === self.id || offer.toPlayerId === self.id || isFinal),
    canStart:
      state.phase === "lobby" &&
      state.hostPlayerId === self.id &&
      lobbyPlayers(state).length >= GAME_CONSTANTS.minPlayers &&
      lobbyPlayers(state).every((player) => player.ready || player.id === self.id),
    canSetAuction: state.phase === "preview" && (!state.currentHostId || state.currentHostId === self.id),
    canAdvance: canAdvance(state, self.id),
    canManageRoom: state.hostPlayerId === self.id,
    activeEffects: state.activeEffects.filter((effect) => isEffectVisibleTo(effect, self.id, isFinal)),
    lastMessage: publicLastMessage(state),
    log: publicLogForView(state.log).slice(-12),
    privateLog: (self.privateLog ?? []).slice(-24),
    projectedScore: isFinal ? undefined : calculatePlayerScore(state, self),
    lastIncomeRolls: state.lastIncomeRolls,
    catalog: {
      tricks: TRICK_CARDS,
      events: EVENT_CARDS,
      missions: MISSIONS,
      roles: ROLES
    }
  };
}

function artifactView(state: GameState, artifactId: ArtifactId, viewerId: PlayerId, canSeeHostLayer: boolean, isFinal: boolean): PublicArtifactView {
  const artifact = requireArtifact(state, artifactId);
  const canSeeSecret = isFinal || artifact.ownerId === viewerId || artifact.revealedTo.includes(viewerId);
  const canSeeRumor = canSeeHostLayer || canSeeSecret || isFinal || artifact.peekedBy.includes(viewerId);
  const owner = artifact.ownerId ? state.players.find((player) => player.id === artifact.ownerId) : undefined;
  return {
    id: artifact.id,
    name: artifact.name,
    category: artifact.category,
    categoryLabel: artifact.categoryLabel,
    series: artifact.series,
    story: canSeeRumor ? artifact.story : undefined,
    rumorMin: canSeeRumor ? artifact.rumorMin : undefined,
    rumorMax: canSeeRumor ? artifact.rumorMax : undefined,
    ownerId: artifact.ownerId,
    dayAcquired: artifact.dayAcquired,
    purchasePrice: artifact.ownerId === viewerId || isFinal ? artifact.purchasePrice : undefined,
    lockedSettlementValue: artifact.ownerId === viewerId || isFinal ? artifact.lockedSettlementValue : undefined,
    tag: canSeeSecret ? artifact.tag : undefined,
    properties: canSeeSecret ? artifact.properties.map((id) => propertyView(id)).filter(isDefined) : undefined,
    trueValue: isFinal || artifact.ownerId === viewerId ? roundToTen(owner ? adjustedArtifactValueForPlayer(state, owner, artifact) : adjustedArtifactValue(artifact, state.day, state.activeEffects)) : undefined,
    tagLabel: canSeeSecret ? TAG_LABELS[artifact.tag] : undefined
  };
}

function publicAuctionView(state: GameState, viewerId: PlayerId): PlayerView["auction"] {
  if (!state.auction) return undefined;
  const { sealedBids, ...publicAuction } = state.auction;
  if (publicAuction.dutch) {
    const currentPrice = currentDutchPrice(state.auction);
    publicAuction.currentBid = currentPrice;
    publicAuction.dutch = { ...publicAuction.dutch, currentPrice };
  }
  const viewer = state.players.find((player) => player.id === viewerId);
  return {
    ...publicAuction,
    sealedSubmittedPlayerIds: Object.keys(sealedBids),
    ownSealedBid: sealedBids[viewerId],
    visibleSealedBids: viewer?.role?.roleId === "role05" ? sealedBids : undefined
  };
}

function reactionView(state: GameState, viewerId: PlayerId) {
  const reaction = state.pendingReaction;
  if (!reaction || !reaction.eligiblePlayerIds.includes(viewerId)) return undefined;
  return {
    id: reaction.id,
    sourcePlayerId: reaction.sourcePlayerId,
    expiresAt: reaction.expiresAt
  };
}

function canAdvance(state: GameState, playerId: PlayerId): boolean {
  if (state.paused) return false;
  if (state.pendingReaction) return false;
  if (state.phase === "auction" || state.phase === "finalScoring" || state.phase === "lobby") return false;
  if (state.phase === "preview") return true;
  if (state.phase === "cardWindow") return true;
  return state.hostPlayerId === playerId || state.currentHostId === playerId || !state.currentHostId;
}

function phaseLabel(phase: GameState["phase"]): string {
  const labels: Record<GameState["phase"], string> = {
    lobby: "大厅",
    setup: "设置",
    dayIncome: "晨间收入",
    blackMarket: "黑市",
    preview: "预展",
    cardWindow: "锦囊/事件窗口",
    auction: "竞拍",
    settlement: "结算",
    eventWindow: "事件窗口",
    freeTrade: "自由交易",
    finalScoring: "终局"
  };
  return labels[phase];
}

function isEffectVisibleTo(effect: ActiveEffect, viewerId: PlayerId, isFinal: boolean): boolean {
  if (effect.pendingChoice && effect.choiceType === "C04_listing") return true;
  if (effect.pendingChoice && canResolveChoice(effect, viewerId)) return true;
  if (effect.pendingChoice && effect.createdBy === viewerId) return true;
  if (!isFinal && (effect.sourceCardId || effect.sourceEventId)) return effect.createdBy === viewerId;
  if (isFinal || effect.appliesTo !== "visibility") return true;
  if (effect.sourceCardId === "D03" || effect.sourceRoleSkillId === "role06_skill01" || effect.sourceRoleSkillId === "role06_skill03") {
    return effect.createdBy === viewerId;
  }
  return true;
}

function hostForDay(state: GameState, day: number): PlayerId | undefined {
  const players = activePlayers(state);
  if (players.length === 0) return undefined;
  // 2 人局：轮流当主持人，第一天随机
  if (players.length === 2) {
    const offset = state.startHostOffset ?? 0;
    return players[(offset + day - 1) % 2]?.id;
  }
  // 6 人局：前 6 天轮流，后 4 天无主持人
  if (players.length === 6 && day >= 7) return undefined;
  // 3 人局：第 10 天无主持人
  if (players.length === 3 && day === 10) return undefined;
  // 4 人局：第 9-10 天无主持人
  if (players.length === 4 && day >= 9) return undefined;
  const offset = state.startHostOffset ?? 0;
  const index = (offset + day - 1) % players.length;
  return players[index]?.id;
}

function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((candidate) => !candidate.kicked);
}

function lobbyPlayers(state: GameState): PlayerState[] {
  return activePlayers(state).filter((candidate) => candidate.connected);
}

function currentAuctionArtifacts(state: GameState): ArtifactInstance[] {
  const auction = requireAuction(state);
  const ids = auction.mode === "bundle" ? auction.artifactIds : [auction.artifactIds[auction.currentArtifactIndex]];
  return ids.filter(Boolean).map((id) => requireArtifact(state, id));
}

function currentAuctionArtifact(state: GameState): ArtifactInstance {
  return currentAuctionArtifacts(state)[0]!;
}

function auctionBidCeilingForArtifactIds(state: GameState, artifactIds: ArtifactId[]): number {
  return Math.max(
    0,
    artifactIds.reduce((sum, artifactId) => sum + requireArtifact(state, artifactId).rumorMax, 0)
  );
}

function auctionRumorRangeText(artifacts: ArtifactInstance[]): string {
  const floor = artifacts.reduce((sum, artifact) => sum + artifact.rumorMin, 0);
  const ceiling = artifacts.reduce((sum, artifact) => sum + artifact.rumorMax, 0);
  return `价格区间 ${floor} - ${ceiling} 银元`;
}

function recordAuctionBid(auction: NonNullable<GameState["auction"]>, playerId: PlayerId, amount: number): void {
  auction.bidCounts = { ...(auction.bidCounts ?? {}), [playerId]: (auction.bidCounts?.[playerId] ?? 0) + 1 };
  auction.highestBids = { ...(auction.highestBids ?? {}), [playerId]: Math.max(auction.highestBids?.[playerId] ?? 0, amount) };
}

function secondHighestAuctionBid(state: GameState, winnerId: PlayerId): number | undefined {
  const auction = requireAuction(state);
  const otherBids = Object.entries(auction.highestBids ?? {})
    .filter(([id]) => id !== winnerId)
    .map(([, amount]) => amount)
    .filter((amount) => amount > 0)
    .sort((a, b) => b - a);
  return otherBids[0];
}

function drawProperties(pool: string[], rng: () => number): string[] {
  const unique = [...new Set(pool)];
  const count = rng() < 0.5 ? 1 : 2;
  return shuffled(unique, rng).slice(0, count);
}

function firstTag(properties: string[]): ArtifactTag {
  const known = properties.find((property): property is ArtifactTag => ["treasure", "heirloom", "fake", "fragile", "curse", "anonymous"].includes(property));
  return known ?? "anonymous";
}

function bidderPlayers(state: GameState): PlayerState[] {
  return activePlayers(state).filter((candidate) => candidate.id !== state.currentHostId);
}

function immediateEnglishResolution(state: GameState): { winnerId?: PlayerId; unsold?: boolean } | undefined {
  if (state.phase !== "auction" || !state.auction) return undefined;
  const bidMode = state.auction.mode === "bundle" ? state.auction.bundleInnerMode ?? "english" : state.auction.mode;
  if (bidMode !== "english" || state.auction.status !== "open") return undefined;
  const bidderIds = bidderPlayers(state).map((candidate) => candidate.id);
  if (state.auction.currentBidderId) {
    const challengers = bidderIds.filter((id) => id !== state.auction!.currentBidderId && !state.auction!.passedPlayerIds.includes(id));
    if (challengers.length === 0) return { winnerId: state.auction.currentBidderId };
    return undefined;
  }
  if (bidderIds.length > 0 && bidderIds.every((id) => state.auction!.passedPlayerIds.includes(id))) return { unsold: true };
  return undefined;
}

function assertNonHostBidder(state: GameState, player: PlayerState): void {
  if (state.currentHostId === player.id) throw new RuleError("主持人不能竞拍自己主持的藏品。", "NOT_ELIGIBLE");
}

function consumePlayedCard(state: MutableGame, player: PlayerState, cardId: string, inHand: boolean, inEvents: boolean): void {
  if (inHand) {
    player.hand.splice(player.hand.indexOf(cardId), 1);
    state.discardPile.push(cardId);
    addStat(state.stats.trickCardsPlayed, player.id, 1);
  }
  if (inEvents) {
    player.events.splice(player.events.indexOf(cardId), 1);
    state.discardPile.push(cardId);
    addStat(state.stats.eventCardsPlayed, player.id, 1);
  }
}

function isBlockedByCard(state: GameState, player: PlayerState, sourceCardId: string, artifactId?: ArtifactId): boolean {
  return state.activeEffects.some((effect) => {
    if (effect.sourceCardId !== sourceCardId) return false;
    if (effect.targetPlayerId !== player.id) return false;
    if (effect.day !== state.day) return false;
    if (effect.targetArtifactId && artifactId && effect.targetArtifactId !== artifactId) return false;
    return true;
  });
}

function bindPendingBidEffect(state: MutableGame, playerId: PlayerId, sourceCardId: string, artifactId: ArtifactId): void {
  const effect = state.activeEffects.find((candidate) => candidate.sourceCardId === sourceCardId && candidate.createdBy === playerId && candidate.day === state.day && !candidate.targetArtifactId);
  if (effect) effect.targetArtifactId = artifactId;
}

function consumeAuctionEffect(state: MutableGame, playerId: PlayerId, sourceCardId: string, artifactId: ArtifactId): ActiveEffect | undefined {
  const effect = state.activeEffects.find(
    (candidate) => candidate.sourceCardId === sourceCardId && candidate.createdBy === playerId && candidate.day === state.day && (!candidate.targetArtifactId || candidate.targetArtifactId === artifactId)
  );
  if (!effect) return undefined;
  state.activeEffects = state.activeEffects.filter((candidate) => candidate.id !== effect.id);
  return effect;
}

function todayEffects(state: GameState, sourceId?: string): ActiveEffect[] {
  return state.activeEffects.filter((effect) => {
    if (effect.day !== state.day) return false;
    if (!sourceId) return true;
    return effect.sourceEventId === sourceId || effect.sourceCardId === sourceId;
  });
}

function hasTodayEffect(state: GameState, sourceId: string): boolean {
  return todayEffects(state, sourceId).length > 0;
}

function upsertEffect(state: MutableGame, effect: ActiveEffect): void {
  state.activeEffects = state.activeEffects.filter(
    (candidate) => !(candidate.sourceEventId === effect.sourceEventId && candidate.sourceCardId === effect.sourceCardId && candidate.day === effect.day && candidate.label === effect.label)
  );
  state.activeEffects.push(effect);
}

function timedEvent(
  sourceEventId: CardId,
  label: string,
  day: number,
  createdBy: PlayerId,
  appliesTo: ActiveEffect["appliesTo"],
  extra: Partial<ActiveEffect> = {}
): ActiveEffect {
  return {
    id: makeId("effect"),
    sourceEventId,
    label,
    appliesTo,
    day,
    createdBy,
    ...extra
  };
}

function nextBlackMarketDay(state: GameState): number {
  return GAME_CONSTANTS.blackMarketDays.find((day) => day > state.day) ?? GAME_CONSTANTS.blackMarketDays.at(-1)!;
}

function blackMarketLimitFor(state: GameState, player: PlayerState): number {
  const baseWithBonus =
    GAME_CONSTANTS.blackMarketLimit +
    (playerArtifacts(state, player).some((artifact) => artifact.properties.includes("prop13")) ? 1 : 0) +
    (player.role?.roleId === "role02" ? 1 : 0);
  const eventLimit = todayEffects(state).reduce<number>((limit, effect) => {
    if (effect.blackMarketLimit === undefined) return limit;
    if (effect.blackMarketLimit < GAME_CONSTANTS.blackMarketLimit) return Math.min(limit, effect.blackMarketLimit);
    return Math.max(limit, effect.blackMarketLimit);
  }, baseWithBonus);
  return eventLimit;
}

function bankSellRateFor(state: GameState, player: PlayerState, artifact?: ArtifactInstance): number {
  const eventRate = todayEffects(state)
    .map((effect) => effect.bankSellRate)
    .filter((rate): rate is number => typeof rate === "number")
    .at(-1);
  const firstSaleEffect = todayEffects(state, "E10")[0];
  if (firstSaleEffect) {
    const counts = firstSaleEffect.perPlayerCounts ?? {};
    if ((counts[player.id] ?? 0) === 0) {
      firstSaleEffect.perPlayerCounts = { ...counts, [player.id]: 1 };
      return 1;
    }
  }
  if (eventRate !== undefined) return eventRate;
  if (player.role?.roleId === "role02") return 1;
  if (artifact?.properties.includes("prop11")) return 1.1;
  return GAME_CONSTANTS.bankSellRate;
}

function bankSellPriceFor(state: GameState, player: PlayerState, artifact: ArtifactInstance): number {
  const saleEffect = state.activeEffects.find((effect) => effect.createdBy === player.id && effect.sourceCardId === "C01" && effect.day === state.day);
  const rate = saleEffect?.bankSellRate ?? bankSellRateFor(state, player, artifact);
  const propertyPenalty = artifact.properties.includes("prop25") ? 0.8 : 1;
  const firstSaleEffect = todayEffects(state, "E10")[0];
  if (firstSaleEffect) {
    const counts = firstSaleEffect.perPlayerCounts ?? {};
    if ((counts[player.id] ?? 0) === 0) {
      firstSaleEffect.perPlayerCounts = { ...counts, [player.id]: 1 };
      return Math.floor((artifact.purchasePrice ?? artifact.rumorMin) * propertyPenalty);
    }
  }
  return Math.floor(artifact.rumorMin * rate * propertyPenalty);
}

function loanRepaymentFor(state: GameState, player: PlayerState): number {
  const eventRepayment = todayEffects(state)
    .map((effect) => effect.loanRepayment)
    .filter((repayment): repayment is number => typeof repayment === "number")
    .at(-1);
  if (playerArtifacts(state, player).some((artifact) => artifact.properties.includes("prop12"))) return Math.min(eventRepayment ?? GAME_CONSTANTS.loanRepayment, 110);
  return eventRepayment ?? GAME_CONSTANTS.loanRepayment;
}

function dailyLoanLimitFor(state: GameState, player: PlayerState): number {
  return 1 + (player.role?.roleId === "role04" ? 1 : 0) + (playerArtifacts(state, player).some((artifact) => artifact.properties.includes("prop12")) ? 1 : 0);
}

function hostCommissionRate(state: GameState, host: PlayerState): number {
  let rate: number = GAME_CONSTANTS.hostCommissionRate;
  if (host.role?.roleId === "role09") rate = 0.3;
  if (playerArtifacts(state, host).some((artifact) => artifact.properties.includes("prop18"))) rate += 0.05;
  return rate;
}

function previewBidTax(state: GameState, player: PlayerState): number {
  const effect = todayEffects(state, "E21")[0];
  if (!effect) return 0;
  const counts = effect.perPlayerCounts ?? {};
  const paid = effect.perPlayerAmounts ?? {};
  const count = counts[player.id] ?? 0;
  const alreadyPaid = paid[player.id] ?? 0;
  if (count === 0) return 0;
  return Math.min(effect.bidTaxAmount ?? 5, Math.max(0, (effect.bidTaxCap ?? 20) - alreadyPaid));
}

function commitBidTax(state: MutableGame, player: PlayerState, tax: number): void {
  const effect = todayEffects(state, "E21")[0];
  if (!effect) return;
  const counts = effect.perPlayerCounts ?? {};
  const paid = effect.perPlayerAmounts ?? {};
  effect.perPlayerCounts = { ...counts, [player.id]: (counts[player.id] ?? 0) + 1 };
  effect.perPlayerAmounts = { ...paid, [player.id]: (paid[player.id] ?? 0) + tax };
}

function assertTradeAllowedByEvents(state: GameState, assets: TradeAssetSet): void {
  for (const artifactId of assets.artifactIds ?? []) {
    const artifact = requireArtifact(state, artifactId);
    if (todayEffects(state, "E26").some((effect) => effect.category === artifact.category)) {
      throw new RuleError("该类别今日禁止玩家交易。", "NOT_ELIGIBLE");
    }
  }
}

function recordCommissionPeek(state: MutableGame, viewerId: PlayerId, targetPlayerId?: PlayerId): void {
  if (!targetPlayerId || targetPlayerId === viewerId) return;
  addStat(state.stats.commissionPeeksByViewer, viewerId, 1);
  state.stats.commissionPeekTargetsByViewer ??= {};
  const targets = new Set(state.stats.commissionPeekTargetsByViewer[viewerId] ?? []);
  targets.add(targetPlayerId);
  state.stats.commissionPeekTargetsByViewer[viewerId] = [...targets];
  addStat(state.stats.commissionPeekedByTarget, targetPlayerId, 1);
}

function recordProfitableTradeFlip(state: MutableGame, seller: PlayerState, soldAssets: TradeAssetSet, receivedAssets: TradeAssetSet): void {
  const receivedCash = receivedAssets.cash ?? 0;
  if (receivedCash <= 0) return;
  for (const artifactId of soldAssets.artifactIds ?? []) {
    const artifact = requireArtifact(state, artifactId);
    if ((artifact.purchasePrice ?? Number.POSITIVE_INFINITY) < receivedCash) addStat(state.stats.profitableFlipCount, seller.id, 1);
  }
}

function applyHotTradeBonus(state: MutableGame, seller: PlayerState, soldAssets: TradeAssetSet, receivedAssets: TradeAssetSet): void {
  const cash = receivedAssets.cash ?? 0;
  if (cash <= 0) return;
  for (const artifactId of soldAssets.artifactIds ?? []) {
    const artifact = requireArtifact(state, artifactId);
    if (!artifact.properties.includes("prop04")) continue;
    const bonus = Math.min(30, Math.floor(cash * 0.2));
    seller.cash += bonus;
    state.log.push(`${seller.nickname} 出售《${artifact.name}》的"热门"生效，银行补贴 ${bonus} 银元。`);
  }
}

function addArtifactValueEffect(
  state: MutableGame,
  sourceRoleSkillId: string,
  artifactId: ArtifactId,
  label: string,
  multiplier: number,
  createdBy: PlayerId
): void {
  if (state.activeEffects.some((effect) => effect.sourceRoleSkillId === sourceRoleSkillId && effect.targetArtifactId === artifactId && effect.label === label)) return;
  state.activeEffects.push({
    id: makeId("effect"),
    sourceRoleSkillId,
    label,
    appliesTo: "finalValue",
    targetArtifactId: artifactId,
    multiplier,
    createdBy
  });
}

function resolveSpeculatorScent(
  state: MutableGame,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string }
): void {
  if (player.role?.roleId !== "role08" || eventById.has(card.id)) return;
  if (!["cardWindow", "eventWindow"].includes(state.phase)) return;
  const charges = player.role.skillCharges.role08_skill03 ?? 1;
  if (charges <= 0) return;
  player.role.skillCharges.role08_skill03 = charges - 1;
  if (makeRng(`${state.roomId}:${player.id}:${state.day}:${state.actionIndex}:role08_skill03`)() >= 0.5) {
    state.log.push(`${player.nickname} 的《嗅觉》未触发额外锦囊。`);
    return;
  }
  const nextCardId = draw(state.trickDeck);
  if (!nextCardId) return;
  const nextCard = trickById.get(nextCardId);
  if (!nextCard) return;
  state.discardPile.push(nextCardId);
  try {
    resolveCardEffect(state, player, nextCard, payload);
    state.log.push(`${player.nickname} 的《嗅觉》触发，额外翻出并执行《${nextCard.name}》。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "目标不合法";
    state.log.push(`${player.nickname} 的《嗅觉》翻出《${nextCard.name}》，但未生效：${message}。`);
  }
}

function resetDailyRoleSkillCharges(player: PlayerState): void {
  if (!player.role) return;
  const role = roleById.get(player.role.roleId);
  if (!role) return;
  for (const skill of role.skills) {
    if (typeof skill.charges !== "number") continue;
    if (skill.id === "role09_skill03") continue;
    if (skill.timing.includes("每天")) player.role.skillCharges[skill.id] = skill.charges;
  }
}

function averageArtifactCount(state: GameState): number {
  return state.players.reduce((sum, player) => sum + player.artifacts.length, 0) / Math.max(1, state.players.length);
}

function deterministicDie(seed: string): number {
  return Math.floor(makeRng(seed)() * 6) + 1;
}

function unexpectedWindfallRep(state: GameState, player: PlayerState, artifact: ArtifactInstance): number {
  const roll = deterministicDie(`${state.roomId}:${player.id}:${artifact.id}:prop14`);
  if (roll <= 2) return 0;
  if (roll <= 4) return 1;
  return 2;
}

function mismatchEstimateMultiplier(state: GameState, player: PlayerState, artifact: ArtifactInstance): number {
  const roll = deterministicDie(`${state.roomId}:${player.id}:${artifact.id}:prop30`);
  if (roll <= 2) return 0.7;
  if (roll <= 4) return 1.1;
  return 1.4;
}

function isNegativeFinalValueEffect(effect: ActiveEffect): boolean {
  return effect.appliesTo === "finalValue" && (effect.multiplier ?? 1) < 1;
}

function playerArtifacts(state: GameState, player: PlayerState): ArtifactInstance[] {
  return player.artifacts.map((id) => requireArtifact(state, id));
}

function categoryLabel(category: ArtifactCategory): string {
  const labels: Record<ArtifactCategory, string> = {
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
  return labels[category];
}

function assertAssets(player: PlayerState, assets: TradeAssetSet): void {
  if ((assets.cash ?? 0) > player.cash) throw new RuleError("交易现金不足。", "CASH_LOW");
  for (const id of assets.artifactIds ?? []) if (!player.artifacts.includes(id)) throw new RuleError("交易藏品不属于玩家。", "NOT_OWNER");
  for (const id of assets.cardIds ?? []) if (!player.hand.includes(id) && !player.events.includes(id)) throw new RuleError("交易卡牌不属于玩家。", "NOT_OWNER");
}

function tradeOfferDetail(state: GameState, offer: TradeOffer): { give: string; receive: string } {
  return {
    give: formatTradeAssetSet(state, offer.give),
    receive: formatTradeAssetSet(state, offer.receive)
  };
}

function formatTradeAssetSet(state: GameState, assets: TradeAssetSet): string {
  const parts: string[] = [];
  if (assets.cash && assets.cash > 0) parts.push(`${assets.cash} 银元`);
  for (const artifactId of assets.artifactIds ?? []) {
    const artifact = state.artifacts[artifactId];
    parts.push(artifact ? `藏品《${artifact.name}》` : `藏品 ${artifactId}`);
  }
  for (const cardId of assets.cardIds ?? []) {
    const card = cardById.get(cardId);
    parts.push(card ? `${eventById.has(cardId) ? "事件卡" : "锦囊"}《${card.name}》` : `卡牌 ${cardId}`);
  }
  return parts.length ? parts.join("、") : "无";
}

function transferAssets(state: MutableGame, from: PlayerState, to: PlayerState, assets: TradeAssetSet): void {
  if (assets.cash) {
    from.cash -= assets.cash;
    to.cash += assets.cash;
  }
  for (const id of assets.artifactIds ?? []) {
    const artifact = requireArtifact(state, id);
    removeArtifactFromPlayer(state, from, artifact);
    assignArtifactToPlayer(state, to, artifact);
  }
  for (const id of assets.cardIds ?? []) {
    if (from.hand.includes(id)) {
      from.hand = from.hand.filter((cardId) => cardId !== id);
      to.hand.push(id);
    } else {
      from.events = from.events.filter((cardId) => cardId !== id);
      to.events.push(id);
    }
  }
}

function revealArtifactTo(artifact: ArtifactInstance, playerId: PlayerId): void {
  if (!artifact.revealedTo.includes(playerId)) artifact.revealedTo.push(playerId);
}

function privatelyPeekArtifact(artifact: ArtifactInstance, playerId: PlayerId): void {
  revealArtifactTo(artifact, playerId);
  if (!artifact.peekedBy.includes(playerId)) artifact.peekedBy.push(playerId);
  artifact.privatePeekedBy = [...new Set([...(artifact.privatePeekedBy ?? []), playerId])];
}

function propertyView(id: string): PropertyDefinition | undefined {
  if (id === "fake") {
    return {
      id: "fake",
      name: "赝品",
      kind: "负面",
      effectText: "终局价值 x30%，不计入类别收藏奖励。",
      effects: [{ type: "finalValueMultiplier", target: { kind: "artifact" }, multiplier: 0.3 }]
    };
  }
  return propertyById.get(id);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function draw(deck: string[]): string | undefined {
  return deck.shift();
}

function rollIncomeDie(): number {
  return Math.floor(Math.random() * GAME_CONSTANTS.incomeDieSides) + 1;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function seatOf(state: GameState, playerId: PlayerId): number {
  return requirePlayer(state, playerId).seat;
}

function requirePlayer(state: GameState, playerId: PlayerId | undefined): PlayerState {
  if (!playerId) throw new RuleError("目标玩家不存在。", "BAD_TARGET");
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new RuleError("玩家不存在。");
  return player;
}

function requireArtifact(state: GameState, artifactId: ArtifactId | undefined): ArtifactInstance {
  if (!artifactId) throw new RuleError("藏品不存在。");
  const artifact = state.artifacts[artifactId];
  if (!artifact) throw new RuleError("藏品不存在。");
  return artifact;
}

function requireAuction(state: GameState) {
  if (!state.auction) throw new RuleError("当前没有拍卖。");
  return state.auction;
}

function assertPhase(state: GameState, phase: GameState["phase"]): void {
  if (state.phase !== phase) throw new RuleError(`当前不是${phase}阶段。`, "BAD_PHASE");
}

function stamp(state: MutableGame, previousPhase?: GameState["phase"]): void {
  const now = Date.now();
  state.updatedAt = now;
  if (previousPhase === undefined || previousPhase !== state.phase || state.phaseStartedAt === undefined) touchPhaseTimer(state, now, true);
}

function touchPhaseTimer(state: MutableGame, now = Date.now(), force = false): void {
  if (!force && state.phaseStartedAt && state.phaseDeadlineAt) return;
  state.phaseStartedAt = now;
  const timeout = state.phaseTimeouts?.[state.phase];
  state.phaseDeadlineAt = timeout && timeout > 0 ? now + timeout : undefined;
}

function emptyStats() {
  return {
    auctionWinsByMode: {},
    auctionWinCount: {},
    auctionSpend: {},
    auctionWinBid200: {},
    auctionWinsAfterDay7: {},
    belowRumorMinWins: {},
    firstBidWins: {},
    closeWins: {},
    loansTaken: {},
    playerTradeCount: {},
    profitableFlipCount: {},
    sellToBankCount: {},
    trickCardsPlayed: {},
    infoTricksPlayed: {},
    commissionPeeksByViewer: {},
    commissionPeekTargetsByViewer: {},
    commissionPeekedByTarget: {},
    eventCardsPlayed: {},
    blackMarketCardsBought: {},
    commissionEarned: {},
    hostedSoldCount: {},
    hostedPassInCount: {},
    hostedTotalSales: {},
    hostedAboveCeilingCount: {},
    hostedBelowFloorCount: {},
    hostedOver200Count: {},
    selfBoughtPassInCount: {}
  };
}

function addStat(target: Record<string, number>, key: string, amount: number): void {
  target[key] = (target[key] ?? 0) + amount;
}

function pushPrivateLog(state: MutableGame, playerId: PlayerId, message: string): void {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return;
  player.privateLog = [...(player.privateLog ?? []), message].slice(-80);
}

function publicLastMessage(state: GameState): string | undefined {
  if (state.lastMessage && isSafePublicLog(state.lastMessage)) return state.lastMessage;
  return publicLogForView(state.log).at(-1);
}

function publicLogForView(log: string[]): string[] {
  return log.filter(isSafePublicLog);
}

function isSafePublicLog(message: string): boolean {
  if (message.includes("使用《") || message.includes("使用事件《") || message.includes("触发自然事件《")) return false;
  if (message.includes("生效") && message.includes("《")) return false;
  if (message.includes("延迟的《")) return false;
  return true;
}

function resolveInfoCardResult(
  state: MutableGame,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string }
): { message: string; peekArtifactId?: ArtifactId } {
  if (card.id === "I12") {
    const ranking = [...activePlayers(state)]
      .sort((a, b) => b.cash - a.cash || a.seat - b.seat)
      .map((candidate, index) => `${index + 1}. ${candidate.nickname}`);
    return { message: `当前现金排名：${ranking.join(" / ")}。` };
  }
  if (card.id === "I04" || card.id === "I05") {
    const target = requirePlayer(state, payload.targetPlayerId);
    const missions = target.missionIds.map((id) => state.missions[id]).filter(isDefined);
    if (missions.length === 0) return { message: `${target.nickname} 没有秘密委托。` };
    const first = missions[0]!;
    if (card.id === "I04") {
      return { message: `${target.nickname} 的委托线索：${first.route ?? first.name}。` };
    }
    const detail = `${first.name}：${first.description}（奖励 ${first.reputation} 声望）`;
    return { message: `${target.nickname} 的委托线索：${detail}。` };
  }
  if (card.id === "I08") {
    const artifact = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
    return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻区间最低值为 ${artifact.rumorMin} 银元。` };
  }
  if (card.id === "I09") {
    const nextArtifacts = state.deck.slice(0, 2).map((id) => requireArtifact(state, id));
    return {
      message: nextArtifacts.length
        ? `下一天预展可能出现：${nextArtifacts.map((artifact) => `《${artifact.name}》(${artifact.rumorMin}-${artifact.rumorMax} 银元，属性 ${formatPropertyNames(artifact.properties)})`).join("、")}。`
        : "牌库中没有可预告的藏品。"
    };
  }

  const artifact = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
  if (card.id === "I01") return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻上限${artifact.rumorMax >= 200 ? "大于等于" : "低于"} 200。` };
  if (card.id === "I02") return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻区间：${artifact.rumorMin} - ${artifact.rumorMax} 银元。` };
  if (card.id === "I06") return { peekArtifactId: artifact.id, message: `《${artifact.name}》完整属性：${formatPropertyNames(artifact.properties)}。` };
  if (card.id === "I07" || card.id === "I10") return { peekArtifactId: artifact.id, message: `《${artifact.name}》完整属性：${formatPropertyNames(artifact.properties)}。` };
  if (card.id === "I11" || card.id === "I14") return { peekArtifactId: artifact.id, message: `《${artifact.name}》${artifact.properties.includes("fake") || artifact.tag === "fake" ? "是" : "不是"}赝品。` };
  if (card.id === "I13" || card.id === "I15" || card.id === "B03") return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻区间：${artifact.rumorMin} - ${artifact.rumorMax} 银元。` };
  if (card.id === "C04") return { peekArtifactId: artifact.id, message: `你公开挂售《${artifact.name}》；若本阶段被买走，成交价由玩家定价，卖方额外获得 20 银元。` };
  return { peekArtifactId: artifact.id, message: `《${artifact.name}》情报：传闻 ${artifact.rumorMin} - ${artifact.rumorMax} 银元，属性倾向 ${propertyTendency(artifact)}。` };
}

function propertyTendency(artifact: ArtifactInstance): string {
  const kinds = new Set(artifact.properties.map((id) => propertyView(id)?.kind).filter(isDefined));
  if (kinds.size === 0) return "无属性";
  if (kinds.has("负面")) return "负面";
  if (kinds.has("特殊")) return "特殊";
  if (kinds.has("增益")) return "增益";
  return [...kinds].join("/");
}

function formatPropertyNames(propertyIds: string[]): string {
  const names = propertyIds.map((id) => propertyView(id)?.name ?? id);
  return names.length ? names.join("、") : "无属性";
}

function formatCardNames<T extends { name: string }>(cardIds: string[], lookup: Map<string, T>, emptyText: string): string {
  const names = cardIds.map((id) => lookup.get(id)?.name ?? id);
  return names.length ? names.map((name) => `《${name}》`).join("、") : emptyText;
}

function playerActionSnapshot(state: GameState, player: PlayerState) {
  return {
    cash: player.cash,
    hand: [...player.hand],
    events: [...player.events],
    artifacts: [...player.artifacts],
    tradeOfferCount: state.tradeOffers.length
  };
}

function playCardPrivateMessage(
  state: GameState,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string }
): string {
  const parts = [`你使用了${eventById.has(card.id) ? "事件卡" : "锦囊"}《${card.name}》`];
  if (card.cost) parts.push(`花费 ${card.cost} 银元`);
  if (payload.targetPlayerId) {
    const target = state.players.find((candidate) => candidate.id === payload.targetPlayerId);
    if (target) parts.push(`目标玩家：${target.nickname}`);
  }
  if (payload.targetArtifactId) {
    const artifact = state.artifacts[payload.targetArtifactId];
    if (artifact) parts.push(`目标藏品：《${artifact.name}》`);
  }
  return `${parts.join("，")}。`;
}

function playCardResultPrivateMessage(
  state: GameState,
  player: PlayerState,
  card: TrickCard | EventCard,
  before: ReturnType<typeof playerActionSnapshot>
): string | undefined {
  const parts: string[] = [];
  const cashDelta = player.cash - before.cash;
  if (cashDelta > 0) parts.push(`获得 ${cashDelta} 银元`);
  if (cashDelta < 0) parts.push(`支付 ${Math.abs(cashDelta)} 银元`);

  const newTricks = player.hand.filter((cardId) => !before.hand.includes(cardId));
  const newEvents = player.events.filter((cardId) => !before.events.includes(cardId));
  const newArtifacts = player.artifacts.filter((artifactId) => !before.artifacts.includes(artifactId));
  if (newTricks.length > 0) parts.push(`获得锦囊 ${formatCardNames(newTricks, trickById, "无")}`);
  if (newEvents.length > 0) parts.push(`获得事件卡 ${formatCardNames(newEvents, eventById, "无")}`);
  for (const artifactId of newArtifacts) {
    const artifact = state.artifacts[artifactId];
    if (artifact) parts.push(`获得藏品《${artifact.name}》`);
  }

  const newOffers = state.tradeOffers.slice(before.tradeOfferCount).filter((offer) => offer.fromPlayerId === player.id);
  for (const offer of newOffers) {
    const detail = tradeOfferDetail(state, offer);
    const target = state.players.find((candidate) => candidate.id === offer.toPlayerId);
    parts.push(`向 ${target?.nickname ?? "目标玩家"} 发起交易：你给出 ${detail.give}，想获得 ${detail.receive}`);
  }

  if (parts.length === 0 && eventById.has(card.id)) parts.push(card.description.trim().replace(/[。.]?$/, ""));
  return parts.length ? `《${card.name}》结果：${parts.join("；")}。` : undefined;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function auctionModeLabel(mode: AuctionMode): string {
  if (mode === "english") return "英式拍卖";
  if (mode === "dutch") return "荷兰式拍卖";
  if (mode === "sealed") return "暗标拍卖";
  return "打包拍卖";
}
