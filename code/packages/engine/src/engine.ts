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
      const participants = activePlayers(next);
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
      assertPhase(next, "preview");
      const payload = action.payload as { mode: AuctionMode; startingBid?: number; bundleInnerMode?: BundleInnerMode };
      setAuction(next, payload.mode, payload.startingBid, payload.bundleInnerMode);
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
    case "SUBMIT_SEALED_BID": {
      const payload = action.payload as { amount: number };
      submitSealedBid(next, player, payload.amount);
      break;
    }
    case "PLAY_CARD": {
      const payload = action.payload as { cardId: string; targetArtifactId?: string; targetPlayerId?: string };
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
      if (state.phase === "auction") closeAuctionAsUnsold(state);
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
  const participatingPlayers = activePlayers(state);
  if (participatingPlayers.length < GAME_CONSTANTS.minPlayers) throw new RuleError(`至少需要 ${GAME_CONSTANTS.minPlayers} 人。`);
  const rng = makeRng(`${state.roomId}:${state.joinCode}:${CONTENT_VERSION}`);
  const artifactTemplates = shuffled(ARTIFACT_TEMPLATES, rng);
  const artifactEntries = artifactTemplates.map((template): [ArtifactId, ArtifactInstance] => {
    const value = template.rumorMin + Math.floor(rng() * (template.rumorMax - template.rumorMin + 1));
    const isFake = rng() < 0.2;
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
      const auction = requireAuction(state);
      const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
      auction.status = "open";
      if (bidMode === "dutch") {
        const startPrice = auction.currentBid || Math.max(...auction.artifactIds.map((id) => requireArtifact(state, id).rumorMax));
        auction.dutch = {
          startPrice,
          currentPrice: startPrice,
          step: GAME_CONSTANTS.dutchStep,
          tickMs: GAME_CONSTANTS.dutchTickMs,
          startedAt: Date.now()
        };
        auction.currentBid = startPrice;
      }
      state.phase = "auction";
      state.lastMessage = "竞拍开始。";
      state.log.push(state.lastMessage);
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
      state.lastMessage = "事件窗口结束，进入自由交易。";
      state.log.push(state.lastMessage);
      break;
    case "freeTrade":
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
    let roll = rollIncomeDie();
    const gamblerReroll = todayEffects(state).find((effect) => effect.sourceRoleSkillId === "role05_skill01" && effect.createdBy === player.id);
    const reroll = gamblerReroll ? rollIncomeDie() : undefined;
    if (reroll !== undefined) roll = Math.max(roll, reroll);
    const multiplier = Math.max(1, ...todayEffects(state, "E28").map((effect) => effect.incomeMultiplier ?? 1));
    const perPip = player.role?.roleId === "role05" && player.cash < 50 ? 15 : GAME_CONSTANTS.incomePerPip;
    let amount = roll * perPip * multiplier;
    amount += todayEffects(state).reduce((sum, effect) => sum + (effect.incomeBonus ?? 0), 0);
    player.cash += amount;
    incomeRolls.push({ playerId: player.id, nickname: player.nickname, roll, reroll, amount });
    incomeLogs.push(`${player.nickname}${reroll === undefined ? `掷出 ${roll}` : `掷出 ${roll}（重掷 ${reroll}，取高）`}，+${amount}`);
  }
  state.lastIncomeRolls = incomeRolls;
  state.activeEffects = state.activeEffects.filter((effect) => effect.sourceRoleSkillId !== "role05_skill01" || effect.day !== state.day);
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

function resolveFragileProtectionFees(state: MutableGame): void {
  for (const player of state.players) {
    for (const artifactId of [...player.artifacts]) {
      const artifact = requireArtifact(state, artifactId);
      if (!artifact.properties.includes("fragile") || player.role?.roleId === "role07") continue;
      const payment = Math.min(5, player.cash);
      player.cash -= payment;
      if (payment < 5) {
        player.artifacts = player.artifacts.filter((id) => id !== artifact.id);
        artifact.ownerId = undefined;
        state.log.push(`《${artifact.name}》的“易损”未付足保护费，被弃置。`);
      } else {
        state.log.push(`${player.nickname} 为《${artifact.name}》支付“易损”保护费 5 银元。`);
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
      state.log.push(`${player.nickname} 的“钱能通神”生效，黑市额外获得 ${bonus} 银元。`);
    }
  }
}

function expireFinishedEffects(state: MutableGame): void {
  state.activeEffects = state.activeEffects.filter((effect) => effect.day === undefined || effect.day >= state.day);
}

function preparePreview(state: MutableGame): void {
  if (state.todayArtifactIds.length === 0) {
    state.todayArtifactIds = [draw(state.deck), draw(state.deck)].filter(Boolean) as ArtifactId[];
  }
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
  if (hasTodayEffect(state, "E27") && state.todayArtifactIds[0]) {
    const category = requireArtifact(state, state.todayArtifactIds[0]).category;
    upsertEffect(state, {
      id: makeId("effect"),
      sourceEventId: "E27",
      label: `学术突破：${categoryLabel(category)}类当天新拍品终局价值 +20%。`,
      appliesTo: "finalValue",
      category,
      multiplier: 1.2,
      day: state.day,
      createdBy: state.hostPlayerId ?? state.players[0]!.id
    });
  }
}

function setAuction(state: MutableGame, mode: AuctionMode, startingBid = 0, bundleInnerMode: BundleInnerMode = "english"): void {
  if (state.todayArtifactIds.length === 0) preparePreview(state);
  const chosenMode = mode;
  const selectedArtifactIds = chosenMode === "bundle" ? state.todayArtifactIds : state.todayArtifactIds;
  let clampedBid = Math.max(0, Math.floor(startingBid));
  const auctionMode = chosenMode === "bundle" ? bundleInnerMode : chosenMode;
  if (auctionMode === "dutch" && hasTodayEffect(state, "E20")) {
    const minDutchPrice = Math.max(...selectedArtifactIds.map((id) => requireArtifact(state, id).rumorMax)) + (hasTodayEffect(state, "E20") ? 30 : 0);
    clampedBid = Math.max(clampedBid, minDutchPrice);
  }
  const artifactIds = chosenMode === "bundle" ? state.todayArtifactIds : state.todayArtifactIds;
  state.auction = {
    id: makeId("auction"),
    artifactIds,
    mode: chosenMode,
    bundleInnerMode: chosenMode === "bundle" ? bundleInnerMode : undefined,
    currentArtifactIndex: 0,
    status: "choosing",
    currentBid: clampedBid,
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

function setRandomAuction(state: MutableGame): void {
  const rng = makeRng(`${state.roomId}:${state.day}:${state.actionIndex}:auction`);
  const mode = pick<AuctionMode>(["english", "dutch", "sealed", "bundle"], rng);
  const bundleInnerMode = mode === "bundle" ? pick<BundleInnerMode>(["english", "dutch", "sealed"], rng) : "english";
  const startingBid = mode === "dutch" || (mode === "bundle" && bundleInnerMode === "dutch")
    ? Math.max(...state.todayArtifactIds.map((id) => requireArtifact(state, id).rumorMax))
    : 0;
  setAuction(state, mode, startingBid, bundleInnerMode);
}

function placeBid(state: MutableGame, player: PlayerState, amount: number): void {
  assertPhase(state, "auction");
  const auction = requireAuction(state);
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  if (bidMode !== "english") throw new RuleError("当前不是英式拍卖。", "BAD_PHASE");
  if (auction.status !== "open") throw new RuleError("拍卖尚未开始。", "AUCTION_CLOSED");
  assertNonHostBidder(state, player);
  if (isBlockedByCard(state, player, "D07", currentAuctionArtifact(state).id)) throw new RuleError("你本日不能对该藏品出价。", "NOT_ELIGIBLE");
  if (auction.passedPlayerIds.includes(player.id)) throw new RuleError("你已经退出当前竞拍。");
  const nextAmount = Math.floor(amount);
  if (nextAmount < auction.currentBid + auction.minimumIncrement) throw new RuleError(`至少需要出价 ${auction.currentBid + auction.minimumIncrement}。`, "BID_TOO_LOW");
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
  state.lastMessage = `${player.nickname} 出价 ${nextAmount}。`;
  state.log.push(state.lastMessage);
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
  const activeBidders = bidderPlayers(state).filter((candidate) => !auction.passedPlayerIds.includes(candidate.id));
  if (activeBidders.length <= 1 && auction.currentBidderId) closeAuctionWithWinner(state, auction.currentBidderId, auction.currentBid);
  else if (activeBidders.length === 0 && !auction.currentBidderId) closeAuctionAsUnsold(state);
  else {
    state.lastMessage = `${player.nickname} 退出竞拍。`;
    state.log.push(state.lastMessage);
  }
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
  const sealedBoost = consumeAuctionEffect(state, player.id, "B05", currentAuctionArtifact(state).id)?.amount ?? 0;
  const bid = baseBid + sealedBoost;
  if (bid > player.cash) throw new RuleError("现金不足。", "CASH_LOW");
  recordAuctionBid(auction, player.id, bid);
  auction.sealedBids[player.id] = bid;
  auction.sealedBidRounds![player.id] = auction.status === "tieBreak" ? 2 : 1;
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
    closeAuctionWithWinner(state, tied[0]!.id, tied[0]!.amount);
    return;
  }
  if (auction.status !== "tieBreak") {
    auction.status = "tieBreak";
    auction.tieBreakPlayerIds = tied.map((entry) => entry.id);
    auction.sealedBids = {};
    state.lastMessage = `暗标平局，${auction.tieBreakPlayerIds.length} 名玩家进入追加暗标。`;
    state.log.push(state.lastMessage);
    return;
  }
  const winner = tied.sort((a, b) => seatOf(state, a.id) - seatOf(state, b.id))[0]!;
  closeAuctionWithWinner(state, winner.id, winner.amount);
}

function closeAuctionWithWinner(state: MutableGame, winnerId: PlayerId, amount: number): void {
  const auction = requireAuction(state);
  const winner = requirePlayer(state, winnerId);
  if (winner.cash < amount) throw new RuleError("赢家现金不足，请先贷款再出价。", "CASH_LOW");
  winner.cash -= amount;
  const wonArtifacts = currentAuctionArtifacts(state);
  const secondHighestBid = secondHighestAuctionBid(state, winnerId);
  for (const artifact of wonArtifacts) {
    winner.artifacts.push(artifact.id);
    artifact.ownerId = winner.id;
    artifact.dayAcquired = state.day;
    artifact.acquiredByMode = auction.mode;
    artifact.purchasePrice = amount;
    if (auction.mode === "bundle") artifact.packageId = auction.id;
    revealArtifactTo(artifact, winner.id);
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
      const cardIndex = findLastIndex(state.discardPile, (cardId) => trickById.has(cardId));
      const cardId = cardIndex >= 0 ? state.discardPile.splice(cardIndex, 1)[0] : undefined;
      if (cardId) {
        winner.hand.push(cardId);
        state.log.push(`《${artifact.name}》的“锦囊妙计”生效，${winner.nickname} 从弃牌堆获得 1 张锦囊。`);
      }
    }
    if (hasTodayEffect(state, "E07") && (artifact.properties.includes("fake") || artifact.tag === "fake")) {
      winner.cash += 30;
      state.log.push(`《假货横行》生效，${winner.nickname} 因买到赝品获得 30 银元补偿。`);
    }
    if (winner.role?.roleId === "role08" && amount < artifact.rumorMin && (winner.role.skillCharges.role08_skill01 ?? 1) > 0) {
      winner.role.skillCharges.role08_skill01 = (winner.role.skillCharges.role08_skill01 ?? 1) - 1;
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
  state.lastMessage = `${winner.nickname} 以 ${amount} 拍下 ${wonArtifacts.map((artifact) => `《${artifact.name}》`).join("、")}。`;
  state.log.push(state.lastMessage);
  pushPrivateLog(state, winner.id, `你以 ${amount} 银元买到 ${wonArtifacts.map((artifact) => `《${artifact.name}》`).join("、")}。终局时藏品价值会按每 50 银元折算声望。`);
  resolveAuctionTriggeredEffects(state, winnerId, amount, wonArtifacts.map((artifact) => artifact.id));
  resolveDelayedCardEffects(state);
}

function closeAuctionAsUnsold(state: MutableGame, options: { forbidHostSelfBuy?: boolean } = {}): void {
  const auction = requireAuction(state);
  const artifacts = currentAuctionArtifacts(state);
  const host = state.currentHostId ? requirePlayer(state, state.currentHostId) : undefined;
  if (host && !options.forbidHostSelfBuy && auction.mode !== "dutch") {
    const selfBuyPrice = Math.floor(artifacts.reduce((sum, artifact) => sum + artifact.rumorMin, 0) * 0.5);
    if (host.cash >= selfBuyPrice) {
      host.cash -= selfBuyPrice;
      for (const artifact of artifacts) {
        host.artifacts.push(artifact.id);
        artifact.ownerId = host.id;
        artifact.dayAcquired = state.day;
        artifact.purchasePrice = selfBuyPrice;
        revealArtifactTo(artifact, host.id);
      }
      addStat(state.stats.selfBoughtPassInCount, host.id, artifacts.length);
      state.lastMessage = `流拍，主持人以 ${selfBuyPrice} 自吞 ${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}。`;
      pushPrivateLog(state, host.id, `你以 ${selfBuyPrice} 银元自吞 ${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}。`);
    } else {
      state.lastMessage = `流拍，${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}弃置。`;
    }
  } else {
    state.lastMessage = `流拍，${artifacts.map((artifact) => `《${artifact.name}》`).join("、")}弃置。`;
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
        const bonus = Math.floor(amount * 0.1);
        player.cash += bonus;
        pushPrivateLog(state, player.id, `你的《坐地分赃》生效，获得 ${bonus} 银元。`);
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
  }
  if (removeIds.size > 0) state.activeEffects = state.activeEffects.filter((effect) => !removeIds.has(effect.id));
  resolveAuctionEventEffects(state, winnerId, artifactIds);
}

function resolveAuctionEventEffects(state: MutableGame, winnerId: PlayerId | undefined, artifactIds: ArtifactId[]): void {
  const mysteryBuy = todayEffects(state, "N1")[0];
  if (mysteryBuy && winnerId && artifactIds[0]) {
    const winner = requirePlayer(state, winnerId);
    const artifact = requireArtifact(state, artifactIds[0]);
    if (artifact.ownerId === winner.id) {
      const price = artifact.rumorMax;
      winner.cash += price;
      winner.artifacts = winner.artifacts.filter((id) => id !== artifact.id);
      artifact.ownerId = undefined;
      state.log.push(`《神秘收购》生效，系统以 ${price} 银元收购《${artifact.name}》。`);
    }
    state.activeEffects = state.activeEffects.filter((effect) => effect.id !== mysteryBuy.id);
  }
}

function resolveRoleAuctionEffects(state: MutableGame, winnerId: PlayerId, amount: number, artifactIds: ArtifactId[]): void {
  const auctionArtifactIds = new Set(artifactIds);
  for (const effect of todayEffects(state)) {
    if (effect.sourceCardId || effect.sourceEventId) continue;
    if (!effect.targetArtifactId || !auctionArtifactIds.has(effect.targetArtifactId)) continue;
    if (effect.label.includes("包装") && amount > 100) {
      const host = requirePlayer(state, effect.createdBy);
      host.cash += effect.amount ?? 10;
      state.log.push(`${host.nickname} 的《包装》生效，获得 ${effect.amount ?? 10} 银元。`);
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
      pushPrivateLog(state, player.id, "你的《密报》生效，获得 1 张锦囊。");
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
    if (effect.sourceCardId !== "C03" || effect.day !== state.day || !effect.targetArtifactId || !effect.amount) continue;
    const player = requirePlayer(state, effect.createdBy);
    const artifact = requireArtifact(state, effect.targetArtifactId);
    if (!artifact.ownerId && player.cash >= effect.amount) {
      player.cash -= effect.amount;
      player.artifacts.push(artifact.id);
      artifact.ownerId = player.id;
      revealArtifactTo(artifact, player.id);
      state.log.push(`${player.nickname} 以 ${effect.amount} 银元回购《${artifact.name}》。`);
      pushPrivateLog(state, player.id, `你的《回购凭证》生效，以 ${effect.amount} 银元买回《${artifact.name}》。`);
    } else {
      pushPrivateLog(state, player.id, `《${artifact.name}》的回购机会失效。`);
    }
    resolvedIds.add(effect.id);
  }
  if (resolvedIds.size > 0) state.activeEffects = state.activeEffects.filter((effect) => !resolvedIds.has(effect.id));
}

function resolveEventEffect(state: MutableGame, player: PlayerState, card: EventCard): void {
  const nextDay = Math.min(state.maxDays, state.day + 1);
  const creator = player.id;
  switch (card.id) {
    case "N1":
      upsertEffect(state, timedEvent("N1", "神秘收购：下一拍卖日后系统默认按传闻最高价收购一件成交藏品。", state.day + 1, creator, "auction"));
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
      upsertEffect(state, timedEvent(card.id, "假货横行：下一天买到赝品的买家获得 30 银元补偿。", nextDay, creator, "cash"));
      break;
    case "E08":
      upsertEffect(state, timedEvent(card.id, "鉴定风潮：下一天探查类锦囊需额外支付 10 银元。", nextDay, creator, "cash"));
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
      upsertEffect(state, timedEvent(card.id, "通胀来袭：下一天黑市和新贷款利息 +10。", nextDay, creator, "cash", { blackMarketCostDelta: 10, loanRepayment: 130 }));
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
    case "E25":
      upsertEffect(state, timedEvent(card.id, "灵异恐惧：下一天灵器/邪物/奇物终局价值 -20%。", nextDay, creator, "finalValue", { categories: ["relic", "evil", "curio"], multiplier: 0.8 }));
      break;
    case "E26": {
      const category = state.todayArtifactIds[0] ? requireArtifact(state, state.todayArtifactIds[0]).category : "calligraphy";
      upsertEffect(state, timedEvent(card.id, `文化禁令：下一天${categoryLabel(category)}类禁止交易和卖银行。`, nextDay, creator, "auction", { category }));
      break;
    }
    case "E27":
      upsertEffect(state, timedEvent(card.id, "学术突破：下一天随机一类新拍品终局价值 +20%。", nextDay, creator, "finalValue"));
      break;
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
  pushPrivateLog(state, player.id, `你在黑市花 ${cost} 银元买到${kind === "trick" ? "锦囊" : "事件卡"}《${card?.name ?? cardId}》。`);
}

function playCard(
  state: MutableGame,
  player: PlayerState,
  payload: { cardId: string; targetArtifactId?: string; targetPlayerId?: string }
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
  pushPrivateLog(state, player.id, playCardPrivateMessage(state, player, card, payload));
  resolveCardEffect(state, player, card, payload);
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
}

function resolveCardEffect(
  state: MutableGame,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string }
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
      label: `${card.name}：当前藏品成交后从银行获得成交价 10%。`,
      appliesTo: "auction",
      targetArtifactId: artifactId,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，成交后可分得一笔银元。`;
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
    const nextBid = auction.currentBid + 20;
    if (nextBid > player.cash) throw new RuleError("现金不足。", "CASH_LOW");
    auction.currentBid = nextBid;
    auction.currentBidderId = player.id;
    state.lastMessage = `${player.nickname} 使用《${card.name}》，加价到 ${nextBid}。`;
    return;
  }
  if (card.id === "B05") {
    const auction = requireAuction(state);
    const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "sealed" : auction.mode;
    if (bidMode !== "sealed") throw new RuleError("暗标加封只能用于暗标拍卖。", "BAD_PHASE");
    state.activeEffects.push({
      id: makeId("effect"),
      sourceCardId: card.id,
      label: `${card.name}：自己的下一次暗标额外 +10。`,
      appliesTo: "auction",
      targetArtifactId: currentAuctionArtifact(state).id,
      amount: 10,
      day: state.day,
      createdBy: player.id
    });
    state.lastMessage = `${player.nickname} 使用《${card.name}》，下一次暗标额外 +10。`;
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
    pushPrivateLog(state, player.id, `《${card.name}》结果：${target.nickname} 的锦囊为 ${formatCardNames(target.hand, trickById, "无")}；事件卡为 ${formatCardNames(target.events, eventById, "无")}。`);
    state.lastMessage = `${player.nickname} 使用《${card.name}》，查看了 ${target.nickname} 的锦囊。`;
    return;
  }
  if (card.id === "D04") {
    const target = requirePlayer(state, payload.targetPlayerId);
    const discarded = target.hand.shift();
    state.lastMessage = discarded
      ? `${player.nickname} 使用《${card.name}》，${target.nickname} 弃掉 1 张锦囊。`
      : `${player.nickname} 使用《${card.name}》，${target.nickname} 没有锦囊可弃。`;
    return;
  }
  if (card.id === "D06") {
    const target = requirePlayer(state, payload.targetPlayerId);
    const lost = Math.min(10, target.cash);
    target.cash -= lost;
    state.lastMessage = `${player.nickname} 使用《${card.name}》，${target.nickname} 失去 ${lost} 银元。`;
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
  payload: { skillId: string; targetArtifactId?: string; targetPlayerId?: string; targetMissionId?: string; invalidateMission?: boolean }
): void {
  const role = player.role?.roleId ? roleById.get(player.role.roleId) : undefined;
  const skill = role?.skills.find((candidate) => candidate.id === payload.skillId);
  if (!role || !skill) throw new RuleError("你没有这个角色技能。", "NOT_OWNER");
  const charges = player.role?.skillCharges[payload.skillId];
  if (typeof charges === "number" && charges <= 0) throw new RuleError("该技能次数已用完。", "NOT_ELIGIBLE");

  switch (payload.skillId) {
    case "role01_skill01":
    case "role07_skill01": {
      if (!["preview", "cardWindow", "auction"].includes(state.phase)) throw new RuleError("当前阶段不能使用该探查技能。", "BAD_PHASE");
      const artifact = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
      privatelyPeekArtifact(artifact, player.id);
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，查看了《${artifact.name}》。`;
      break;
    }
    case "role01_skill02": {
      if (state.phase !== "blackMarket") throw new RuleError("妙笔只能在黑市日使用。", "BAD_PHASE");
      const artifact = requireArtifact(state, payload.targetArtifactId ?? player.artifacts[0]);
      if (!player.artifacts.includes(artifact.id)) throw new RuleError("只能指定自己的藏品。", "NOT_OWNER");
      const property = PROPERTIES.find((candidate) => !artifact.properties.includes(candidate.id) && !["anonymous"].includes(candidate.id));
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
    case "role05_skill01": {
      if (state.phase !== "dayIncome") throw new RuleError("孤注一掷只能在晨间收入阶段使用。", "BAD_PHASE");
      state.activeEffects.push({
        id: makeId("effect"),
        sourceRoleSkillId: payload.skillId,
        label: "孤注一掷：今天晨间收入重掷一次并取较高值。",
        appliesTo: "cash",
        day: state.day,
        createdBy: player.id
      });
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，今天晨间收入将重掷并取高。`;
      break;
    }
    case "role05_skill02": {
      const auction = requireAuction(state);
      const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "sealed" : auction.mode;
      if (state.phase !== "auction" || bidMode !== "sealed") throw new RuleError("千术只能在暗标拍卖时使用。", "BAD_PHASE");
      if ((player.role?.skillCharges.role05_skill02 ?? 1) <= 0) throw new RuleError("千术本局已修改过暗标。", "NOT_ELIGIBLE");
      if (!Object.prototype.hasOwnProperty.call(auction.sealedBids, player.id)) throw new RuleError("需要先提交自己的暗标。", "NOT_ELIGIBLE");
      const nextBid = Math.min(player.cash, Math.max(auction.sealedBids[player.id] ?? 0, ...Object.values(auction.sealedBids)) + 1);
      auction.sealedBids[player.id] = nextBid;
      auction.sealedBidRounds![player.id] = (auction.sealedBidRounds?.[player.id] ?? 1) + 1;
      player.role!.skillCharges.role05_skill02 = 0;
      recordAuctionBid(auction, player.id, nextBid);
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，查看暗标并把自己的暗标改为 ${nextBid}。`;
      break;
    }
    case "role06_skill01": {
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
      if (player.cash < 30) throw new RuleError("现金不足。", "CASH_LOW");
      player.cash -= 30;
      recordCommissionPeek(state, player.id, target.id);
      if (payload.invalidateMission) {
        const missionId = payload.targetMissionId ?? target.missionIds[0] ?? target.missionId;
        if (missionId) {
          target.missionIds = target.missionIds.filter((id) => id !== missionId);
          if (target.missionId === missionId) target.missionId = target.missionIds[0];
        }
        state.lastMessage = `${player.nickname} 使用《${skill.name}》，支付 30 银元公开并作废 ${target.nickname} 的 1 张秘密委托。`;
      } else {
        state.activeEffects.push({
          id: makeId("effect"),
          sourceRoleSkillId: payload.skillId,
          label: `黑料：你可以查看 ${target.nickname} 的秘密委托。`,
          appliesTo: "visibility",
          targetPlayerId: target.id,
          day: state.day,
          createdBy: player.id
        });
        state.lastMessage = `${player.nickname} 使用《${skill.name}》，支付 30 银元查看 ${target.nickname} 的秘密委托。`;
      }
      break;
    }
    case "role09_skill02": {
      if (state.phase !== "preview" || state.currentHostId !== player.id) throw new RuleError("包装只能在自己主持的预展阶段使用。", "BAD_PHASE");
      const artifact = requireArtifact(state, payload.targetArtifactId ?? state.todayArtifactIds[0]);
      state.activeEffects.push({
        id: makeId("effect"),
        sourceRoleSkillId: payload.skillId,
        label: `包装：《${artifact.name}》成交价超过 100 时主持人额外 +10。`,
        appliesTo: "auction",
        targetArtifactId: artifact.id,
        amount: 10,
        day: state.day,
        createdBy: player.id
      });
      state.lastMessage = `${player.nickname} 使用《${skill.name}》，包装《${artifact.name}》。`;
      break;
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
  const target = requirePlayer(state, payload.toPlayerId);
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
      const penalty = Math.min(20, player.cash);
      player.cash -= penalty;
      from.cash += penalty;
      state.lastMessage = `${player.nickname} 拒绝巧取豪夺，支付 ${penalty} 银元给 ${from.nickname}。`;
    } else {
      state.lastMessage = `${player.nickname} 拒绝了交易。`;
    }
    offer.status = "declined";
    offer.version += 1;
    state.log.push(state.lastMessage);
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
  addStat(state.stats.playerTradeCount, from.id, 1);
  addStat(state.stats.playerTradeCount, to.id, 1);
  if ([...(offer.give.artifactIds ?? []), ...(offer.receive.artifactIds ?? [])].length > 0) {
    if (from.role?.roleId === "role08") from.cash += 10;
    if (to.role?.roleId === "role08") to.cash += 10;
  }
  state.lastMessage = `${from.nickname} 与 ${to.nickname} 完成交易。`;
  state.log.push(state.lastMessage);
}

function sellToBank(state: MutableGame, player: PlayerState, artifactId: ArtifactId): void {
  if (!["freeTrade", "blackMarket", "cardWindow", "eventWindow"].includes(state.phase)) throw new RuleError("当前阶段不能卖给银行。", "BAD_PHASE");
  if (isBlockedByCard(state, player, "D05")) throw new RuleError("你本日不能出售给银行。", "NOT_ELIGIBLE");
  if (!player.artifacts.includes(artifactId)) throw new RuleError("你没有这件藏品。", "NOT_OWNER");
  const artifact = requireArtifact(state, artifactId);
  const bannedCategory = todayEffects(state, "E26").find((effect) => effect.category === artifact.category);
  if (bannedCategory) throw new RuleError("该类别今日禁止出售给银行。", "NOT_ELIGIBLE");
  const saleEffect = state.activeEffects.find((effect) => effect.createdBy === player.id && effect.sourceCardId === "C01" && effect.day === state.day);
  const rate = saleEffect?.bankSellRate ?? bankSellRateFor(state, player, artifact);
  const propertyPenalty = artifact.properties.includes("prop25") ? 0.8 : 1;
  const price = Math.floor(artifact.rumorMin * rate * propertyPenalty);
  const buybackVoucher = state.activeEffects.find((effect) => effect.createdBy === player.id && effect.sourceCardId === "C03" && effect.day === state.day && !effect.targetArtifactId);
  player.cash += price;
  player.artifacts = player.artifacts.filter((id) => id !== artifactId);
  artifact.ownerId = undefined;
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
    label: `自然事件：${natural.name}`,
    appliesTo: "cash",
    amount: 10,
    day: state.day + 1,
    createdBy: state.hostPlayerId ?? state.players[0]!.id
  });
  state.log.push(`触发自然事件《${natural.name}》。`);
  grantIntelBrokerCards(state);
}

function finalizeScores(state: MutableGame): void {
  for (const player of state.players) {
    const roleAdjustedEffects = roleFinalValueEffects(state, player);
    const finalEffects = [...state.activeEffects, ...roleAdjustedEffects];
    const artifactValues = player.artifacts.map((id) => adjustedArtifactValueForPlayer(state, player, requireArtifact(state, id), finalEffects));
    const artifactValue = artifactValues.reduce((sum, value) => sum + value, 0);
    const loanDebt = remainingLoanDebt(player);
    const cashAfterLoan = Math.max(0, player.cash - loanDebt);
    const cashRepDivisor = playerArtifacts(state, player).some((artifact) => artifact.properties.includes("prop31")) ? 30 : hasTodayEffect(state, "E16") ? 40 : 50;
    const baseCashRep = Math.floor(cashAfterLoan / 50);
    const cashRep = cashRepDivisor < 50 ? baseCashRep + (cashRepDivisor === 40 ? Math.min(5, Math.floor(cashAfterLoan / cashRepDivisor) - baseCashRep) : Math.floor(cashAfterLoan / cashRepDivisor) - baseCashRep) : baseCashRep;
    const artifactRep = Math.floor(artifactValue / 50);
    let categoryRep = scoreCategoryCollections(state, player);
    if (player.role?.roleId === "role03") categoryRep = Math.floor(categoryRep * 1.5);
    const setRep = categoryRep;
    const missionResults = scoreMissions(state, player);
    let missionRep = missionResults.reduce((sum, result) => sum + result.reputation, 0);
    if (player.role?.roleId === "role03") missionRep = Math.floor(missionRep * 1.3);
    let propertyRep = scorePropertyRep(state, player);
    if (player.role?.roleId === "role07") propertyRep += Math.floor(new Set(player.artifacts.map((id) => requireArtifact(state, id).category)).size / 3);
    const rolePenalty = roleFinalPenalty(state, player);
    const loanPenalty = player.cash >= loanDebt ? 0 : player.loans * 2;
    const reputation = cashRep + artifactRep + categoryRep + missionRep + propertyRep - loanPenalty - rolePenalty;
    player.finalScore = {
      reputation,
      cashRep,
      artifactRep,
      categoryRep,
      setRep,
      missionRep,
      propertyRep,
      loanPenalty,
      artifactValue,
      tieBreakers: {
        artifactValue,
        cash: cashAfterLoan,
        highestArtifactValue: Math.max(0, ...artifactValues)
      },
      missionResults
    };
  }
}

function scoreCategoryCollections(state: GameState, player: PlayerState): number {
  const counts = new Map<string, number>();
  for (const artifactId of player.artifacts) {
    const artifact = requireArtifact(state, artifactId);
    if (artifact.properties.includes("fake") || artifact.tag === "fake") continue;
    counts.set(artifact.category, (counts.get(artifact.category) ?? 0) + 1);
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
  const categoryCounts = countBy(artifacts.map((artifact) => artifact.category));
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
      return Math.max(0, ...categoryCounts.values()) >= 4;
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
      return (state.stats.commissionPeeksByViewer[player.id] ?? 0) >= 3;
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
  if (player.role?.roleId === "role01" || player.role?.roleId === "role07") {
    const fakeArtifact = player.artifacts.map((id) => requireArtifact(state, id)).find(isFakeArtifact);
    if (fakeArtifact) {
      const currentMultiplier = artifactBaseMultiplier(fakeArtifact, state.day);
      effects.push({
        id: "role_fake_value",
        sourceRoleSkillId: player.role.roleId === "role01" ? "role01_skill03" : "role07_skill03",
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
  let multiplier = artifactBaseMultiplier(artifact, state.day);
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

function artifactBaseMultiplier(artifact: ArtifactInstance, currentDay: number): number {
  let multiplier = 1;
  if (artifact.tag === "treasure" || artifact.properties.includes("treasure")) multiplier *= artifact.tag === "treasure" ? 1.15 : 1.1;
  if (artifact.tag === "heirloom" || artifact.properties.includes("heirloom")) multiplier *= 1 + Math.max(0, currentDay - (artifact.dayAcquired ?? currentDay)) * 0.02;
  if (artifact.tag === "fake" || artifact.properties.includes("fake")) multiplier *= 0.3;
  if (artifact.tag === "fragile" || artifact.properties.includes("fragile")) multiplier *= 0.9;
  return multiplier;
}

function currentDutchPrice(auction: NonNullable<GameState["auction"]>, now = Date.now()): number {
  if (!auction.dutch) return Math.max(0, auction.currentBid);
  const elapsedTicks = Math.max(0, Math.floor((now - auction.dutch.startedAt) / auction.dutch.tickMs));
  return Math.max(0, auction.dutch.startPrice - elapsedTicks * auction.dutch.step);
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
      role
    },
    todayArtifacts,
    auction: publicAuctionView(state, self.id),
    pendingReaction: reactionView(state, self.id),
    tradeOffers: state.tradeOffers.filter((offer) => offer.fromPlayerId === self.id || offer.toPlayerId === self.id || isFinal),
    canStart:
      state.phase === "lobby" &&
      state.hostPlayerId === self.id &&
      activePlayers(state).length >= GAME_CONSTANTS.minPlayers &&
      activePlayers(state).every((player) => player.ready || player.id === self.id),
    canSetAuction: state.phase === "preview" && (!state.currentHostId || state.currentHostId === self.id),
    canAdvance: canAdvance(state, self.id),
    canManageRoom: state.hostPlayerId === self.id,
    activeEffects: state.activeEffects.filter((effect) => isEffectVisibleTo(effect, self.id, isFinal)),
    lastMessage: publicLastMessage(state),
    log: publicLogForView(state.log).slice(-12),
    privateLog: (self.privateLog ?? []).slice(-24),
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
    tag: canSeeSecret ? artifact.tag : undefined,
    properties: canSeeSecret ? artifact.properties.map((id) => propertyView(id)).filter(isDefined) : undefined,
    trueValue: isFinal || artifact.ownerId === viewerId ? (owner ? adjustedArtifactValueForPlayer(state, owner, artifact) : adjustedArtifactValue(artifact, state.day, state.activeEffects)) : undefined,
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
  if (players.length === 3 && day === 10) return undefined;
  if (players.length === 4 && day >= 9) return undefined;
  const index = (day - 1) % players.length;
  return players[index]?.id;
}

function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((candidate) => !candidate.kicked);
}

function currentAuctionArtifacts(state: GameState): ArtifactInstance[] {
  const auction = requireAuction(state);
  const ids = auction.mode === "bundle" ? auction.artifactIds : [auction.artifactIds[auction.currentArtifactIndex]];
  return ids.filter(Boolean).map((id) => requireArtifact(state, id));
}

function currentAuctionArtifact(state: GameState): ArtifactInstance {
  return currentAuctionArtifacts(state)[0]!;
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
    state.log.push(`${seller.nickname} 出售《${artifact.name}》的“热门”生效，银行补贴 ${bonus} 银元。`);
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

function transferAssets(state: MutableGame, from: PlayerState, to: PlayerState, assets: TradeAssetSet): void {
  if (assets.cash) {
    from.cash -= assets.cash;
    to.cash += assets.cash;
  }
  for (const id of assets.artifactIds ?? []) {
    from.artifacts = from.artifacts.filter((artifactId) => artifactId !== id);
    to.artifacts.push(id);
    const artifact = requireArtifact(state, id);
    artifact.ownerId = to.id;
    revealArtifactTo(artifact, to.id);
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
    const detail = card.id === "I04" ? first.route ?? first.name : `${first.name}：${first.description}（奖励 ${first.reputation} 声望）`;
    return { message: `${target.nickname} 的委托线索：${detail}。` };
  }
  if (card.id === "I08") {
    const auction = requireAuction(state);
    const prepared = bidderPlayers(state).filter((candidate) => !Object.prototype.hasOwnProperty.call(auction.sealedBids, candidate.id)).length;
    return { message: `本次暗标仍有 ${prepared} 名玩家尚未提交或准备出价。` };
  }
  if (card.id === "I09") {
    const nextArtifacts = state.deck.slice(0, 2).map((id) => requireArtifact(state, id));
    return {
      message: nextArtifacts.length
        ? `下一天预展可能出现：${nextArtifacts.map((artifact) => `《${artifact.name}》（${CATEGORY_LABELS[artifact.category]}）`).join("、")}。`
        : "牌库中没有可预告的藏品。"
    };
  }

  const artifact = requireArtifact(state, payload.targetArtifactId ?? currentAuctionArtifacts(state)[0]?.id ?? state.todayArtifactIds[0]);
  if (card.id === "I01") return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻上限${artifact.rumorMax >= 200 ? "大于等于" : "低于"} 200。` };
  if (card.id === "I02") return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻下限 ${artifact.rumorMin}，上限 ${artifact.rumorMax}。` };
  if (card.id === "I03") {
    const artifacts = state.todayArtifactIds.map((id) => requireArtifact(state, id));
    const categories = artifacts.map((candidate) => CATEGORY_LABELS[candidate.category]);
    const sameCategory = new Set(artifacts.map((candidate) => candidate.category)).size <= 1;
    return { peekArtifactId: artifact.id, message: `今日拍品类别：${categories.join(" / ")}；${sameCategory ? "属于同类别" : "不属于同类别"}。` };
  }
  if (card.id === "I06") return { peekArtifactId: artifact.id, message: `《${artifact.name}》属性倾向：${propertyTendency(artifact)}。` };
  if (card.id === "I07" || card.id === "I10") return { peekArtifactId: artifact.id, message: `《${artifact.name}》完整属性：${formatPropertyNames(artifact.properties)}。` };
  if (card.id === "I11" || card.id === "I14") return { peekArtifactId: artifact.id, message: `《${artifact.name}》${artifact.properties.includes("fake") || artifact.tag === "fake" ? "是" : "不是"}赝品。` };
  if (card.id === "I13" || card.id === "I15" || card.id === "B03") return { peekArtifactId: artifact.id, message: `《${artifact.name}》传闻区间：${artifact.rumorMin} - ${artifact.rumorMax} 银元。` };
  if (card.id === "C04") return { peekArtifactId: artifact.id, message: `你公开挂售《${artifact.name}》；若本阶段被买走，卖方额外获得 20 银元。` };
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

function playCardPrivateMessage(
  state: GameState,
  player: PlayerState,
  card: TrickCard | EventCard,
  payload: { targetArtifactId?: string; targetPlayerId?: string }
): string {
  const parts = [`你使用了${eventById.has(card.id) ? "事件卡" : "锦囊"}《${card.name}》`];
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
