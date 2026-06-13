export type PlayerId = string;
export type RoomId = string;
export type JoinCode = string;
export type ArtifactId = string;
export type CardId = string;
export type MissionId = string;
export type RoleId = string;
export type PropertyId = string;
export type TradeOfferId = string;
export type ReactionId = string;
export type ContentVersion = string;
export type PhaseTimeouts = Partial<Record<GamePhase, number>>;

export type GamePhase =
  | "lobby"
  | "setup"
  | "dayIncome"
  | "blackMarket"
  | "preview"
  | "cardWindow"
  | "auction"
  | "settlement"
  | "eventWindow"
  | "freeTrade"
  | "finalScoring";

export type AuctionMode = "english" | "dutch" | "sealed" | "bundle";
export type BundleInnerMode = Exclude<AuctionMode, "bundle">;
export type ArtifactCategory =
  | "calligraphy"
  | "bronze"
  | "jewelry"
  | "porcelain"
  | "jade"
  | "book"
  | "coin"
  | "curio"
  | "relic"
  | "evil"
  | "legacy"
  | "lastword"
  | "celebrity";
export type ArtifactTag = "treasure" | "heirloom" | "fake" | "fragile" | "curse" | "anonymous";
export type TrickType = "info" | "bid" | "cash" | "control";

export interface TargetSpec {
  kind: "self" | "player" | "artifact" | "auction" | "global";
  text?: string;
  required?: boolean;
}

export interface EffectSpec {
  type: "revealInfo" | "modifyCash" | "finalValueMultiplier" | "auctionModifier" | "counter" | "custom";
  target: TargetSpec;
  amount?: number;
  multiplier?: number;
  scope?: "private" | "public";
  resolver?: string;
  expires?: "currentArtifact" | "today" | "nextDay" | "finalScoring";
}

export interface ArtifactTemplate {
  id: ArtifactId;
  name: string;
  category: ArtifactCategory;
  categoryLabel?: string;
  series: string;
  rumorMin: number;
  rumorMax: number;
  story: string;
  propertyPool: PropertyId[];
  tagPool?: ArtifactTag[];
  source?: Record<string, unknown>;
}

export interface ArtifactInstance extends ArtifactTemplate {
  trueValue: number;
  properties: PropertyId[];
  tag: ArtifactTag;
  ownerId?: PlayerId;
  dayAcquired?: number;
  acquiredByMode?: AuctionMode;
  purchasePrice?: number;
  packageId?: string;
  revealedTo: PlayerId[];
  peekedBy: PlayerId[];
  privatePeekedBy?: PlayerId[];
}

export interface PropertyDefinition {
  id: PropertyId;
  name: string;
  kind: string;
  effectText: string;
  effects: EffectSpec[];
  source?: Record<string, unknown>;
}

export interface TrickCard {
  id: CardId;
  name: string;
  type: TrickType;
  category?: string;
  cost: number;
  timing?: "cardWindow" | "auction" | "settlement" | "freeTrade";
  timings?: string[];
  target?: TargetSpec;
  description: string;
  effectText?: string;
  effects?: EffectSpec[];
  counterable?: boolean;
}

export interface EventCard extends TrickCard {
  natural?: boolean;
}

export interface RoleSkill {
  id: string;
  name: string;
  kind: string;
  timing: string;
  effectText: string;
  effects: EffectSpec[];
  charges?: number | null;
}

export interface Role {
  id: RoleId;
  name: string;
  skills: RoleSkill[];
  source?: Record<string, unknown>;
}

export interface ActiveEffect {
  id: string;
  sourceCardId?: CardId;
  sourceEventId?: CardId;
  sourceRoleSkillId?: string;
  label: string;
  appliesTo: "finalValue" | "cash" | "auction" | "visibility";
  category?: ArtifactCategory;
  categories?: ArtifactCategory[];
  property?: PropertyId;
  multiplier?: number;
  amount?: number;
  day?: number;
  targetPlayerId?: PlayerId;
  targetArtifactId?: ArtifactId;
  targetMissionId?: MissionId;
  bankSellRate?: number;
  blackMarketLimit?: number;
  blackMarketCostDelta?: number;
  blackMarketBlockTricks?: boolean;
  loanBlocked?: boolean;
  loanRepayment?: number;
  incomeBonus?: number;
  incomeMultiplier?: number;
  bidTaxAmount?: number;
  bidTaxCap?: number;
  perPlayerAmounts?: Record<PlayerId, number>;
  perPlayerCounts?: Record<PlayerId, number>;
  expiresAtPhase?: GamePhase;
  createdBy: PlayerId;
}

export interface MissionCard {
  id: MissionId;
  name: string;
  route?: string;
  description: string;
  condition?: string;
  reputation: number;
  note?: string;
}

export interface MissionResult {
  missionId: MissionId;
  success: boolean;
  reputation: number;
}

export interface RoleRuntime {
  roleId: RoleId;
  skillCharges: Record<string, number>;
}

export interface PlayerState {
  id: PlayerId;
  nickname: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  cash: number;
  loans: number;
  loanRepayments?: number[];
  hand: CardId[];
  events: CardId[];
  artifacts: ArtifactId[];
  missionIds: MissionId[];
  missionId?: MissionId;
  role?: RoleRuntime;
  passed: boolean;
  finalScore?: FinalScore;
  blackMarketBuysToday?: number;
  loansTakenToday?: number;
  kicked?: boolean;
  disconnectedAt?: number;
  automatedAt?: number;
  automatedReason?: string;
  privateLog?: string[];
}

export interface IncomeRollResult {
  playerId: PlayerId;
  nickname: string;
  roll: number;
  reroll?: number;
  amount: number;
}

export interface DutchAuctionState {
  startPrice: number;
  currentPrice: number;
  step: number;
  tickMs: number;
  startedAt: number;
}

export interface AuctionState {
  id?: string;
  artifactIds: ArtifactId[];
  mode: AuctionMode;
  bundleInnerMode?: BundleInnerMode;
  currentArtifactIndex: number;
  status: "choosing" | "open" | "tieBreak" | "closed";
  currentBid: number;
  currentBidderId?: PlayerId;
  minimumIncrement: number;
  passedPlayerIds: PlayerId[];
  sealedBids: Record<PlayerId, number>;
  sealedBidRounds?: Record<PlayerId, number>;
  bidCounts?: Record<PlayerId, number>;
  highestBids?: Record<PlayerId, number>;
  tieBreakPlayerIds?: PlayerId[];
  dutch?: DutchAuctionState;
}

export interface TradeAssetSet {
  cash?: number;
  artifactIds?: ArtifactId[];
  cardIds?: CardId[];
}

export interface TradeOffer {
  id: TradeOfferId;
  fromPlayerId: PlayerId;
  toPlayerId: PlayerId;
  give: TradeAssetSet;
  receive: TradeAssetSet;
  status: "pending" | "accepted" | "declined" | "cancelled";
  version: number;
  day: number;
  message?: string;
}

export interface PendingReaction {
  id: ReactionId;
  sourceActionId: string;
  sourcePlayerId: PlayerId;
  eligiblePlayerIds: PlayerId[];
  sourceCardId?: CardId;
  targetArtifactId?: ArtifactId;
  targetPlayerId?: PlayerId;
  passedPlayerIds?: PlayerId[];
  countered: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface DelayedCardEffect {
  id: string;
  sourcePlayerId: PlayerId;
  sourceCardId: CardId;
  targetArtifactId?: ArtifactId;
  targetPlayerId?: PlayerId;
  remainingSettlements: number;
  createdAt: number;
}

export interface GameStats {
  auctionWinsByMode: Record<string, number>;
  auctionWinCount: Record<PlayerId, number>;
  auctionSpend: Record<PlayerId, number>;
  auctionWinBid200: Record<PlayerId, number>;
  auctionWinsAfterDay7: Record<PlayerId, number>;
  belowRumorMinWins: Record<PlayerId, number>;
  firstBidWins: Record<PlayerId, number>;
  closeWins: Record<PlayerId, number>;
  loansTaken: Record<PlayerId, number>;
  playerTradeCount: Record<PlayerId, number>;
  profitableFlipCount: Record<PlayerId, number>;
  sellToBankCount: Record<PlayerId, number>;
  trickCardsPlayed: Record<PlayerId, number>;
  infoTricksPlayed: Record<PlayerId, number>;
  commissionPeeksByViewer: Record<PlayerId, number>;
  commissionPeekedByTarget: Record<PlayerId, number>;
  eventCardsPlayed: Record<PlayerId, number>;
  blackMarketCardsBought: Record<PlayerId, number>;
  commissionEarned: Record<PlayerId, number>;
  hostedSoldCount: Record<PlayerId, number>;
  hostedPassInCount: Record<PlayerId, number>;
  hostedTotalSales: Record<PlayerId, number>;
  hostedAboveCeilingCount: Record<PlayerId, number>;
  hostedBelowFloorCount: Record<PlayerId, number>;
  hostedOver200Count: Record<PlayerId, number>;
  selfBoughtPassInCount: Record<PlayerId, number>;
}

export interface GameState {
  roomId: RoomId;
  joinCode: JoinCode;
  contentVersion?: ContentVersion;
  hostPlayerId?: PlayerId;
  phase: GamePhase;
  day: number;
  maxDays: number;
  players: PlayerState[];
  artifacts: Record<ArtifactId, ArtifactInstance>;
  deck: ArtifactId[];
  trickDeck: CardId[];
  eventDeck: CardId[];
  discardPile: CardId[];
  missions: Record<MissionId, MissionCard>;
  roles?: Record<RoleId, Role>;
  activeEffects: ActiveEffect[];
  pendingReaction?: PendingReaction;
  delayedCardEffects: DelayedCardEffect[];
  tradeOffers: TradeOffer[];
  stats: GameStats;
  currentHostId?: PlayerId;
  phaseStartedAt?: number;
  phaseDeadlineAt?: number;
  phaseTimeouts?: PhaseTimeouts;
  paused?: boolean;
  pausedAt?: number;
  pausedRemainingMs?: number;
  closedAt?: number;
  closedBy?: PlayerId;
  todayArtifactIds: ArtifactId[];
  auction?: AuctionState;
  lastIncomeRolls?: IncomeRollResult[];
  lastMessage?: string;
  log: string[];
  actionIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface PublicArtifactView {
  id: ArtifactId;
  name: string;
  category?: ArtifactCategory;
  categoryLabel?: string;
  series?: string;
  story?: string;
  rumorMin?: number;
  rumorMax?: number;
  ownerId?: PlayerId;
  dayAcquired?: number;
  purchasePrice?: number;
  tag?: ArtifactTag;
  properties?: PropertyDefinition[];
  trueValue?: number;
  tagLabel?: string;
}

export interface PlayerPublicView {
  id: PlayerId;
  nickname: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  cash: number;
  loans: number;
  artifactCount: number;
  handCount: number;
  eventCount: number;
  isHost: boolean;
  isOwner: boolean;
  passed: boolean;
  roleName?: string;
  kicked?: boolean;
  automatedAt?: number;
  automatedReason?: string;
  revealedHand?: TrickCard[];
  revealedEvents?: EventCard[];
  revealedMissions?: MissionCard[];
  artifacts?: PublicArtifactView[];
  finalScore?: FinalScore;
}

export interface PlayerPrivateView extends PlayerPublicView {
  hand: TrickCard[];
  events: EventCard[];
  artifacts: PublicArtifactView[];
  missions: MissionCard[];
  mission?: MissionCard;
  role?: Role;
}

export interface PlayerReactionView {
  id: ReactionId;
  sourcePlayerId: PlayerId;
  sourceCardId?: CardId;
  expiresAt: number;
}

export interface PlayerView {
  roomId: RoomId;
  joinCode: JoinCode;
  selfId: PlayerId;
  phase: GamePhase;
  day: number;
  maxDays: number;
  currentHostId?: PlayerId;
  phaseStartedAt?: number;
  phaseDeadlineAt?: number;
  phaseTimeoutMs?: number;
  phaseTimeouts?: PhaseTimeouts;
  paused?: boolean;
  players: PlayerPublicView[];
  self: PlayerPrivateView;
  todayArtifacts: PublicArtifactView[];
  auction?: Omit<AuctionState, "sealedBids"> & {
    sealedSubmittedPlayerIds: PlayerId[];
    ownSealedBid?: number;
    visibleSealedBids?: Record<PlayerId, number>;
  };
  pendingReaction?: PlayerReactionView;
  tradeOffers: TradeOffer[];
  canStart: boolean;
  canAdvance: boolean;
  canSetAuction: boolean;
  canManageRoom: boolean;
  activeEffects: ActiveEffect[];
  lastMessage?: string;
  log: string[];
  privateLog: string[];
  lastIncomeRolls?: IncomeRollResult[];
  catalog: {
    tricks: TrickCard[];
    events: EventCard[];
    missions: MissionCard[];
    roles: Role[];
  };
}

export interface FinalScore {
  reputation: number;
  cashRep: number;
  artifactRep: number;
  categoryRep: number;
  setRep: number;
  missionRep: number;
  propertyRep: number;
  loanPenalty: number;
  artifactValue: number;
  tieBreakers: { artifactValue: number; cash: number; highestArtifactValue: number };
  missionResults: MissionResult[];
}

export type RuleErrorCode =
  | "BAD_PHASE"
  | "NOT_OWNER"
  | "NOT_HOST"
  | "NOT_ELIGIBLE"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "SESSION_INVALID"
  | "BID_TOO_LOW"
  | "CASH_LOW"
  | "AUCTION_CLOSED"
  | "CARD_NOT_OWNED"
  | "BAD_TARGET"
  | "PENDING_REACTION"
  | "VERSION_CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_ACTION";

export type ClientToServerEvents = {
  "room:create": (payload: { nickname: string }, ack: Ack<{ view: PlayerView; sessionToken: string }>) => void;
  "room:join": (payload: { joinCode: string; nickname: string }, ack: Ack<{ view: PlayerView; sessionToken: string }>) => void;
  "room:resume": (payload: { roomId: string; playerId: string; sessionToken: string }, ack: Ack<{ view: PlayerView }>) => void;
  "player:ready": (payload: { ready: boolean }, ack: Ack<{ view: PlayerView }>) => void;
  "room:start": (payload: {}, ack: Ack<{ view: PlayerView }>) => void;
  "phase:advance": (payload: {}, ack: Ack<{ view: PlayerView }>) => void;
  "blackMarket:buy": (payload: { kind: "trick" | "event" }, ack: Ack<{ view: PlayerView }>) => void;
  "host:setAuction": (payload: { mode: AuctionMode; startingBid?: number; bundleInnerMode?: BundleInnerMode }, ack: Ack<{ view: PlayerView }>) => void;
  "bid:place": (payload: { amount: number }, ack: Ack<{ view: PlayerView }>) => void;
  "bid:pass": (payload: {}, ack: Ack<{ view: PlayerView }>) => void;
  "dutch:stop": (payload: {}, ack: Ack<{ view: PlayerView }>) => void;
  "sealedBid:submit": (payload: { amount: number }, ack: Ack<{ view: PlayerView }>) => void;
  "card:play": (payload: { cardId: CardId; targetArtifactId?: ArtifactId; targetPlayerId?: PlayerId }, ack: Ack<{ view: PlayerView }>) => void;
  "role:skill": (
    payload: { skillId: string; targetArtifactId?: ArtifactId; targetPlayerId?: PlayerId; targetMissionId?: MissionId; invalidateMission?: boolean },
    ack: Ack<{ view: PlayerView }>
  ) => void;
  "reaction:respond": (payload: { reactionId: ReactionId; cardId?: CardId; targetPlayerId?: PlayerId; response: "counter" | "pass" }, ack: Ack<{ view: PlayerView }>) => void;
  "trade:offer": (payload: { toPlayerId: PlayerId; give: TradeAssetSet; receive: TradeAssetSet; message?: string }, ack: Ack<{ view: PlayerView }>) => void;
  "trade:respond": (payload: { tradeOfferId: TradeOfferId; accept: boolean; version: number }, ack: Ack<{ view: PlayerView }>) => void;
  "bank:sell": (payload: { artifactId: ArtifactId }, ack: Ack<{ view: PlayerView }>) => void;
  "loan:take": (payload: {}, ack: Ack<{ view: PlayerView }>) => void;
  "loan:repay": (payload: {}, ack: Ack<{ view: PlayerView }>) => void;
  "room:transferOwner": (payload: { playerId: PlayerId }, ack: Ack<{ view: PlayerView }>) => void;
  "room:kick": (payload: { playerId: PlayerId }, ack: Ack<{ view: PlayerView }>) => void;
  "room:setTimeouts": (payload: { timeouts: PhaseTimeouts }, ack: Ack<{ view: PlayerView }>) => void;
  "room:setPaused": (payload: { paused: boolean }, ack: Ack<{ view: PlayerView }>) => void;
  "room:close": (payload: {}, ack: Ack<{}>) => void;
};

export type ServerToClientEvents = {
  "room:update": (view: PlayerView) => void;
  "room:error": (payload: { message: string; code?: RuleErrorCode }) => void;
  "reaction:opened": (payload: PlayerReactionView) => void;
};

export type Ack<T> = (response: ({ ok: true } & T) | { ok: false; error: string; code?: RuleErrorCode; actionIndex?: number }) => void;

export interface ServerAction {
  type:
    | "CREATE_PLAYER"
    | "SET_READY"
    | "START_GAME"
    | "ADVANCE_PHASE"
    | "BUY_BLACK_MARKET"
    | "SET_AUCTION"
    | "PLACE_BID"
    | "PASS_BID"
    | "DUTCH_STOP"
    | "SUBMIT_SEALED_BID"
    | "PLAY_CARD"
    | "USE_ROLE_SKILL"
    | "RESPOND_REACTION"
    | "CREATE_TRADE_OFFER"
    | "RESPOND_TRADE_OFFER"
    | "SELL_TO_BANK"
    | "TAKE_LOAN"
    | "REPAY_LOAN"
    | "SET_CONNECTED"
    | "AUTO_ADVANCE_OFFLINE"
    | "TRANSFER_OWNER"
    | "KICK_PLAYER"
    | "SET_PHASE_TIMEOUTS"
    | "SET_PAUSED"
    | "CLOSE_ROOM"
    | "PHASE_TIMEOUT_AUTO";
  playerId: PlayerId;
  payload?: unknown;
  actionId?: string;
}

export interface ActionLog {
  actionIndex: number;
  actionId: string;
  roomId: RoomId;
  actorId: PlayerId;
  type: ServerAction["type"];
  payload: unknown;
  resultSummary: string;
  createdAt: number;
}

export interface RoomSnapshot {
  id: string;
  roomId: RoomId;
  actionIndex: number;
  state: GameState;
  contentVersion?: ContentVersion;
  createdAt: number;
}
