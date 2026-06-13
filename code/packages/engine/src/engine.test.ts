import { describe, expect, it } from "vitest";
import {
  EVENT_CARDS,
  type ArtifactCategory,
  type CardId,
  type GameState,
  type PlayerId,
  type PlayerState,
  type RoleId,
  type ServerAction
} from "@auctioneer/shared";
import { addPlayer, createRoomState, getPlayerView, reduceGame } from "./engine.js";
import { makeJoinCode } from "./utils.js";

function startedRoom() {
  let state = createRoomState({ roomId: "room_test", joinCode: "ABCDE", now: 1 });
  for (const id of ["p1", "p2", "p3", "p4"]) {
    state = addPlayer(state, id, id.toUpperCase());
    state = reduceGame(state, { type: "SET_READY", playerId: id, payload: { ready: true } });
  }
  state = reduceGame(state, { type: "START_GAME", playerId: "p1", payload: {} });
  state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
  return state;
}

const missionCategories: Record<string, ArtifactCategory> = {
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

function finishWithMission(missionId: string, configure: (state: GameState, player: PlayerState) => void) {
  let state = startedRoom();
  const player = state.players.find((candidate) => candidate.id === "p2")!;
  player.missionIds = [missionId];
  player.missionId = missionId;
  player.cash = 100;
  player.loans = 0;
  player.loanRepayments = [];
  player.hand = [];
  player.events = [];
  player.artifacts = [];
  configure(state, player);
  state.phase = "freeTrade";
  state.day = state.maxDays;
  state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: state.currentHostId ?? state.hostPlayerId ?? "p1", payload: {} });
  return state.players.find((candidate) => candidate.id === "p2")!.finalScore!.missionResults[0]!;
}

function giveArtifacts(
  state: GameState,
  player: PlayerState,
  specs: Array<{
    category?: ArtifactCategory;
    value?: number;
    fake?: boolean;
    rumorMin?: number;
    rumorMax?: number;
    purchasePrice?: number;
    peeked?: boolean;
  }>
) {
  const artifacts = Object.values(state.artifacts);
  specs.forEach((spec, index) => {
    const artifact = artifacts[index]!;
    artifact.ownerId = player.id;
    artifact.category = spec.category ?? "calligraphy";
    artifact.trueValue = spec.value ?? 100;
    artifact.rumorMin = spec.rumorMin ?? 50;
    artifact.rumorMax = spec.rumorMax ?? Math.max(artifact.rumorMin + 20, artifact.trueValue);
    artifact.purchasePrice = spec.purchasePrice;
    artifact.properties = spec.fake ? ["fake"] : [];
    artifact.tag = spec.fake ? "fake" : "anonymous";
    artifact.peekedBy = spec.peeked ? ["p3"] : [];
    artifact.privatePeekedBy = spec.peeked ? ["p3"] : [];
    artifact.revealedTo = [player.id];
    player.artifacts.push(artifact.id);
  });
}

function setRole(player: PlayerState, roleId: RoleId, charges: Record<string, number> = {}) {
  player.role = { roleId, skillCharges: charges };
}

function action(state: GameState, playerId: PlayerId, type: ServerAction["type"], payload: unknown = {}): GameState {
  return reduceGame(state, { type, playerId, payload });
}

function expectActionError(state: GameState, playerId: PlayerId, type: ServerAction["type"], payload: unknown, message: string | RegExp) {
  expect(() => reduceGame(state, { type, playerId, payload })).toThrow(message);
}

function driveOneAuction(state: GameState, mode: "sealed" | "english" | "dutch" | "bundle", bidBase: number): GameState {
  const host = state.currentHostId ?? state.hostPlayerId ?? state.players[0]!.id;
  const bundleInnerMode = mode === "bundle" ? "sealed" : undefined;
  state = action(state, host, "SET_AUCTION", { mode, startingBid: mode === "dutch" ? Math.max(80, bidBase + 60) : 0, bundleInnerMode });
  state = action(state, state.players.find((player) => player.id !== state.currentHostId)!.id, "ADVANCE_PHASE");
  if (mode === "english") {
    const bidders = state.players.filter((player) => player.id !== state.currentHostId);
    const opener = bidders.find((player) => player.cash >= Math.max(10, Math.min(bidBase, player.cash))) ?? bidders[0]!;
    state = action(state, opener.id, "PLACE_BID", { amount: Math.max(10, Math.min(bidBase, opener.cash)) });
    for (const bidder of bidders.filter((candidate) => candidate.id !== opener.id)) {
      if (state.phase === "auction") state = action(state, bidder.id, "PASS_BID");
    }
    if (state.phase === "auction") state = action(state, opener.id, "PASS_BID");
  } else if (mode === "dutch") {
    state.auction!.dutch!.startedAt -= 60_000;
    const bidder = state.players.filter((player) => player.id !== state.currentHostId).sort((a, b) => b.cash - a.cash)[0]!;
    state = action(state, bidder.id, "DUTCH_STOP");
  } else {
    const bidderIds = state.players.filter((player) => player.id !== state.currentHostId).map((player) => player.id);
    bidderIds.forEach((playerId, index) => {
      if (state.phase === "auction") state = action(state, playerId, "SUBMIT_SEALED_BID", { amount: index === 0 ? bidBase : Math.max(0, bidBase - 20 - index) });
    });
    if (state.phase === "auction" && state.auction?.status === "tieBreak") {
      const finalists = [...(state.auction.tieBreakPlayerIds ?? [])];
      finalists.forEach((playerId, index) => {
        if (state.phase === "auction") state = action(state, playerId, "SUBMIT_SEALED_BID", { amount: Math.max(0, bidBase + finalists.length - index) });
      });
    }
  }
  return state;
}

function resolveAnyOpenAuction(state: GameState, bidBase: number): GameState {
  const auction = state.auction;
  if (!auction || state.phase !== "auction") return state;
  const bidMode = auction.mode === "bundle" ? auction.bundleInnerMode ?? "english" : auction.mode;
  const bidders = state.players.filter((player) => player.id !== state.currentHostId);
  if (bidMode === "english") {
    const minimum = auction.currentBid + auction.minimumIncrement;
    const opener = bidders.find((player) => player.cash >= minimum) ?? bidders[0]!;
    const openingBid = Math.min(opener.cash, Math.max(minimum, Math.min(bidBase, opener.cash)));
    if (!auction.currentBidderId) {
      if (openingBid >= minimum) state = action(state, opener.id, "PLACE_BID", { amount: openingBid });
    }
    for (const bidder of bidders) {
      if (state.phase === "auction" && bidder.id !== state.auction?.currentBidderId) state = action(state, bidder.id, "PASS_BID");
    }
    return state;
  }
  if (bidMode === "dutch") {
    if (state.auction?.dutch) state.auction.dutch.startedAt -= 60_000;
    return action(state, bidders.sort((a, b) => b.cash - a.cash)[0]!.id, "DUTCH_STOP");
  }
  const requiredBidderIds = auction.status === "tieBreak" ? [...(auction.tieBreakPlayerIds ?? [])] : bidders.map((player) => player.id);
  for (const [index, playerId] of requiredBidderIds.entries()) {
    if (state.phase !== "auction") break;
    if (Object.prototype.hasOwnProperty.call(state.auction?.sealedBids ?? {}, playerId)) continue;
    const player = state.players.find((candidate) => candidate.id === playerId)!;
    const wanted = auction.status === "tieBreak" ? Math.max(1, bidBase + requiredBidderIds.length - index) : index === 0 ? bidBase : Math.max(0, bidBase - 20 - index);
    const amount = Math.max(0, Math.min(wanted, player.cash));
    state = action(state, playerId, "SUBMIT_SEALED_BID", { amount });
  }
  return state;
}

function driveFullTenDayGame(seedRoomId = "room_long_auto"): GameState {
  let state = createRoomState({ roomId: seedRoomId, joinCode: "9999", now: 1 });
  for (const id of ["p1", "p2", "p3", "p4"]) {
    state = addPlayer(state, id, id.toUpperCase());
    state = action(state, id, "SET_READY", { ready: true });
  }
  state = action(state, "p1", "START_GAME");
  let guard = 0;
  while (state.phase !== "finalScoring" && guard < 240) {
    guard += 1;
    const actor = state.currentHostId ?? state.hostPlayerId ?? "p1";
    if (state.phase === "dayIncome") {
      const gambler = state.players.find((player) => player.role?.roleId === "role05" && (player.role.skillCharges.role05_skill01 ?? 0) > 0);
      if (gambler) state = action(state, gambler.id, "USE_ROLE_SKILL", { skillId: "role05_skill01" });
      state = action(state, actor, "ADVANCE_PHASE");
    } else if (state.phase === "blackMarket") {
      const buyer = state.players.find((player) => player.cash >= 30)!;
      state = action(state, buyer.id, "BUY_BLACK_MARKET", { kind: "trick" });
      state = action(state, actor, "ADVANCE_PHASE");
    } else if (state.phase === "preview") {
      const host = state.currentHostId ?? state.hostPlayerId ?? "p1";
      const hostPlayer = state.players.find((player) => player.id === host)!;
      if (hostPlayer.role?.roleId === "role09" && (hostPlayer.role.skillCharges.role09_skill02 ?? 0) > 0) {
        state = action(state, host, "USE_ROLE_SKILL", { skillId: "role09_skill02", targetArtifactId: state.todayArtifactIds[0] });
      }
      const modes = ["sealed", "english", "dutch", "bundle"] as const;
      const mode = modes[(state.day - 1) % modes.length]!;
      state = driveOneAuction(state, mode, 40 + state.day * 5);
    } else if (state.phase === "settlement") {
      state = action(state, actor, "ADVANCE_PHASE");
    } else if (state.phase === "eventWindow") {
      const eventPlayer = state.players.find((player) => player.events.length > 0);
      if (eventPlayer) {
        state = action(state, eventPlayer.id, "PLAY_CARD", { cardId: eventPlayer.events[0] });
      }
      state = action(state, actor, "ADVANCE_PHASE");
    } else if (state.phase === "freeTrade") {
      const seller = state.players.find((player) => player.artifacts.length > 0);
      const buyer = seller ? state.players.find((player) => player.id !== seller.id && player.cash >= 10) : undefined;
      if (seller && buyer) {
        const existingOfferIds = new Set(state.tradeOffers.map((offer) => offer.id));
        state = action(state, seller.id, "CREATE_TRADE_OFFER", {
          toPlayerId: buyer.id,
          give: { artifactIds: [seller.artifacts[0]] },
          receive: { cash: 10 }
        });
        const offer = state.tradeOffers.find((candidate) => !existingOfferIds.has(candidate.id) && candidate.fromPlayerId === seller.id && candidate.toPlayerId === buyer.id);
        if (offer) state = action(state, buyer.id, "RESPOND_TRADE_OFFER", { tradeOfferId: offer.id, accept: true, version: offer.version });
      }
      state = action(state, actor, "ADVANCE_PHASE");
    } else if (state.phase === "cardWindow") {
      state = action(state, state.players.find((player) => player.id !== state.currentHostId)!.id, "ADVANCE_PHASE");
    } else if (state.phase === "auction") {
      state = resolveAnyOpenAuction(state, 40 + state.day * 5);
    } else {
      state = action(state, actor, "ADVANCE_PHASE");
    }
  }
  if (guard >= 240) throw new Error(`Long game driver exceeded guard at ${state.phase} day ${state.day}.`);
  return state;
}

function assertNoSecretArtifactLeak(view: ReturnType<typeof getPlayerView>, state: GameState, viewerId: PlayerId): void {
  for (const artifact of view.todayArtifacts) {
    const source = state.artifacts[artifact.id]!;
    const ownerId = source.ownerId;
    const canSeeSecret = state.phase === "finalScoring" || ownerId === viewerId || source.revealedTo.includes(viewerId);
    if (!canSeeSecret) {
      expect(artifact.trueValue, `${viewerId} should not see true value for ${artifact.id}`).toBeUndefined();
      expect(artifact.properties, `${viewerId} should not see properties for ${artifact.id}`).toBeUndefined();
      expect(artifact.tag, `${viewerId} should not see tag for ${artifact.id}`).toBeUndefined();
    }
  }
  const ownSealedBid = state.auction?.sealedBids[viewerId];
  if (state.auction && view.self.role?.id !== "role05") {
    expect(view.auction?.visibleSealedBids, `${viewerId} should not see all sealed bids`).toBeUndefined();
    expect(view.auction?.ownSealedBid).toBe(ownSealedBid);
  }
}

function assertOtherPlayerSecretsHidden(view: ReturnType<typeof getPlayerView>, viewerId: PlayerId): void {
  for (const player of view.players) {
    if (player.id === viewerId) continue;
    expect(player.revealedHand, `${viewerId} should not see ${player.id} hand by default`).toBeUndefined();
    expect(player.revealedEvents, `${viewerId} should not see ${player.id} events by default`).toBeUndefined();
    expect(player.revealedMissions, `${viewerId} should not see ${player.id} missions by default`).toBeUndefined();
  }
}

function configureSuccessfulMission(state: GameState, player: PlayerState, missionId: string): void {
  const category = missionCategories[missionId];
  if (category) {
    giveArtifacts(state, player, [{ category }, { category }, { category }]);
    return;
  }
  switch (missionId) {
    case "W01":
      giveArtifacts(state, player, [{}, {}, {}, {}]);
      break;
    case "W02":
      giveArtifacts(state, player, [{ value: 180 }]);
      break;
    case "W03":
      giveArtifacts(state, player, [
        { category: "calligraphy" },
        { category: "bronze" },
        { category: "jewelry" },
        { category: "porcelain" },
        { category: "jade" }
      ]);
      break;
    case "W04":
      giveArtifacts(state, player, [{ category: "book" }, { category: "book" }, { category: "book" }, { category: "book" }]);
      break;
    case "W05":
      giveArtifacts(state, player, [{ category: "coin" }, { category: "curio" }, { category: "relic" }]);
      break;
    case "W06":
      giveArtifacts(state, player, [{ fake: true }, { fake: true }, { fake: true }]);
      break;
    case "W07":
      giveArtifacts(state, player, [{}]);
      break;
    case "W08":
      giveArtifacts(state, player, [{}, {}, {}]);
      break;
    case "W09":
      player.cash = 300;
      break;
    case "W10":
      state.stats.loansTaken[player.id] = 3;
      player.loans = 0;
      break;
    case "W11":
      player.cash = 30;
      break;
    case "W12":
      giveArtifacts(state, player, [{}, {}, {}, {}, {}]);
      state.stats.auctionSpend[player.id] = 400;
      break;
    case "W13":
      state.stats.playerTradeCount[player.id] = 3;
      break;
    case "W14":
      state.stats.profitableFlipCount[player.id] = 1;
      break;
    case "W15":
      state.stats.blackMarketCardsBought[player.id] = 3;
      break;
    case "W16":
      player.hand = ["I01", "I02"];
      player.events = ["E01", "E02"];
      break;
    case "W17":
      state.stats.belowRumorMinWins[player.id] = 3;
      break;
    case "W18":
      state.stats.auctionWinBid200[player.id] = 1;
      break;
    case "W19":
      state.stats.auctionWinsByMode[`${player.id}:sealed`] = 2;
      break;
    case "W20":
      state.stats.firstBidWins[player.id] = 3;
      break;
    case "W21":
      state.stats.closeWins[player.id] = 2;
      break;
    case "W22":
      state.stats.auctionWinsAfterDay7[player.id] = 2;
      break;
    case "W23":
      giveArtifacts(state, player, [{ value: 130 }, { value: 140 }]);
      break;
    case "W24":
      state.stats.auctionWinCount[player.id] = 3;
      break;
    case "W25":
      state.stats.infoTricksPlayed[player.id] = 5;
      break;
    case "W26":
      giveArtifacts(state, player, [{ value: 80 }, { value: 70 }, { value: 60 }]);
      break;
    case "W27":
      state.stats.commissionPeeksByViewer[player.id] = 3;
      break;
    case "W28":
      giveArtifacts(state, player, [{ fake: true }, { fake: true }, {}, {}]);
      break;
    case "W29":
      state.stats.commissionPeekedByTarget[player.id] = 0;
      break;
    case "W30":
      state.stats.eventCardsPlayed[player.id] = 2;
      break;
    case "W31":
      state.stats.infoTricksPlayed[player.id] = 3;
      break;
    case "W32":
      state.stats.commissionPeeksByViewer[player.id] = 1;
      break;
    case "W33":
      state.stats.commissionEarned[player.id] = 100;
      break;
    case "W34":
      state.stats.hostedAboveCeilingCount[player.id] = 2;
      break;
    case "W35":
      state.stats.hostedBelowFloorCount[player.id] = 2;
      break;
    case "W36":
      state.stats.hostedTotalSales[player.id] = 300;
      state.stats.hostedTotalSales.p3 = 100;
      break;
    case "W37":
      state.stats.selfBoughtPassInCount[player.id] = 2;
      break;
    case "W38":
      state.stats.hostedSoldCount[player.id] = 1;
      state.stats.hostedPassInCount[player.id] = 0;
      break;
    case "W39":
      state.stats.hostedOver200Count[player.id] = 1;
      break;
    case "W40":
      state.stats.hostedSoldCount[player.id] = 2;
      state.stats.hostedTotalSales[player.id] = 240;
      break;
    default:
      throw new Error(`missing mission test setup for ${missionId}`);
  }
}

function configureFailedMission(state: GameState, player: PlayerState, missionId: string): void {
  if (missionId === "W08") {
    const rival = state.players.find((candidate) => candidate.id === "p3")!;
    giveArtifacts(state, rival, [{}]);
  }
  if (missionId === "W29") {
    state.stats.commissionPeekedByTarget[player.id] = 1;
  }
}

describe("auctioneer engine", () => {
  it("prevents host from bidding on hosted artifacts", () => {
    let state = startedRoom();
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "english", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    expect(() =>
      reduceGame(state, { type: "PLACE_BID", playerId: "p1", payload: { amount: 10 } })
    ).toThrow("主持人不能竞拍");
  });

  it("closes english auction and assigns artifact to winner", () => {
    let state = startedRoom();
    const cashBeforeAuction = state.players.find((player) => player.id === "p2")!.cash;
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "english", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 80 } });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p3", payload: {} });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p4", payload: {} });
    const winner = state.players.find((player) => player.id === "p2")!;
    expect(state.phase).toBe("settlement");
    expect(winner.artifacts).toHaveLength(1);
    expect(winner.cash).toBe(cashBeforeAuction - 80);
  });

  it("gives each player independent dice income", () => {
    const state = startedRoom();
    for (const player of state.players) {
      expect(player.cash).toBeGreaterThanOrEqual(510);
      expect(player.cash).toBeLessThanOrEqual(560);
    }
    expect(state.lastMessage).toContain("掷出");
  });

  it("generates easy four digit numeric room codes", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(makeJoinCode()).toMatch(/^\d{4}$/);
    }
  });

  it("keeps hidden artifact tags out of other player views", () => {
    let state = startedRoom();
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "english", startingBid: 0 } });
    const hostView = getPlayerView(state, "p1");
    const bidderView = getPlayerView(state, "p2");
    expect(hostView.todayArtifacts[0]?.rumorMin).toBeTypeOf("number");
    expect(hostView.todayArtifacts[0]?.tag).toBeUndefined();
    expect(bidderView.todayArtifacts[0]?.rumorMin).toBeUndefined();
    expect(bidderView.todayArtifacts[0]?.tag).toBeUndefined();
  });

  it("resolves sealed bids by highest amount and seat tie breaker", () => {
    let state = startedRoom();
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "sealed", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p2", payload: { amount: 90 } });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p3", payload: { amount: 90 } });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p4", payload: { amount: 40 } });
    expect(state.auction?.status).toBe("tieBreak");
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p2", payload: { amount: 90 } });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p3", payload: { amount: 90 } });
    expect(state.phase).toBe("settlement");
    expect(state.players.find((player) => player.id === "p2")?.artifacts).toHaveLength(1);
  });

  it("supports dutch stop with a decreasing server price", () => {
    let state = startedRoom();
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "dutch", startingBid: 100 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state.auction!.dutch!.startedAt -= 6000;
    const cashBefore = state.players.find((player) => player.id === "p2")!.cash;
    state = reduceGame(state, { type: "DUTCH_STOP", playerId: "p2", payload: {} });
    expect(state.phase).toBe("settlement");
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(cashBefore - 80);
  });

  it("awards both preview artifacts in a bundle auction", () => {
    let state = startedRoom();
    const artifactIds = Object.keys(state.artifacts).slice(0, 2);
    state.todayArtifactIds = artifactIds;
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "bundle", bundleInnerMode: "english", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 80 } });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p3", payload: {} });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p4", payload: {} });
    expect(state.players.find((player) => player.id === "p2")?.artifacts).toEqual(artifactIds);
  });

  it("moves assets through accepted player trades", () => {
    let state = startedRoom();
    const artifact = Object.values(state.artifacts)[0]!;
    const seller = state.players.find((player) => player.id === "p2")!;
    artifact.ownerId = seller.id;
    seller.artifacts.push(artifact.id);
    state.phase = "freeTrade";
    state = reduceGame(state, {
      type: "CREATE_TRADE_OFFER",
      playerId: "p2",
      payload: { toPlayerId: "p3", give: { artifactIds: [artifact.id] }, receive: { cash: 30 } }
    });
    state = reduceGame(state, {
      type: "RESPOND_TRADE_OFFER",
      playerId: "p3",
      payload: { tradeOfferId: state.tradeOffers[0]!.id, accept: true, version: 1 }
    });
    expect(state.players.find((player) => player.id === "p3")?.artifacts).toContain(artifact.id);
    expect(state.players.find((player) => player.id === "p2")?.artifacts).not.toContain(artifact.id);
  });

  it("delays interference card effects until reactions resolve", () => {
    let state = startedRoom();
    const attacker = state.players.find((player) => player.id === "p2")!;
    const target = state.players.find((player) => player.id === "p3")!;
    attacker.hand.push("D06");
    target.hand.push("R02");
    const cashBefore = target.cash;
    state.phase = "freeTrade";
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "D06", targetPlayerId: "p3" } });
    expect(state.pendingReaction).toBeDefined();
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(cashBefore);
    state = reduceGame(state, { type: "RESPOND_REACTION", playerId: "p3", payload: { reactionId: state.pendingReaction!.id, response: "counter" } });
    expect(state.pendingReaction).toBeUndefined();
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(cashBefore);
  });

  it("resolves remaining custom bid trick effects", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    p2.hand.push("B01", "B02", "B08");
    const p2CashBefore = p2.cash;
    const p3CashBefore = p3.cash;

    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "english", startingBid: 0 } });
    const targetArtifactId = state.todayArtifactIds[0]!;
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "B01" } });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "B02", targetArtifactId } });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "B08", targetPlayerId: "p3" } });
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 80 } });
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p3", payload: { amount: 100 } });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p4", payload: {} });

    expect(state.phase).toBe("settlement");
    expect(state.players.find((player) => player.id === "p3")?.artifacts).toContain(targetArtifactId);
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(p2CashBefore + 10 + 10 + 10);
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(p3CashBefore - 100 - 10);
  });

  it("applies sealed bid boost only when the boosted bid wins", () => {
    let state = startedRoom();
    const bidder = state.players.find((player) => player.id === "p2")!;
    bidder.hand.push("B05");
    const cashBefore = bidder.cash;

    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "sealed", startingBid: 0 } });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "B05" } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p2", payload: { amount: 90 } });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p3", payload: { amount: 95 } });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p4", payload: { amount: 30 } });

    expect(state.phase).toBe("settlement");
    expect(state.players.find((player) => player.id === "p2")?.artifacts).toHaveLength(1);
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(cashBefore - 100);
  });

  it("creates a next-day buyback after 回购凭证 bank sale", () => {
    let state = startedRoom();
    const player = state.players.find((candidate) => candidate.id === "p2")!;
    const artifact = Object.values(state.artifacts)[0]!;
    artifact.ownerId = player.id;
    artifact.rumorMin = 100;
    player.artifacts.push(artifact.id);
    player.hand.push("C03");
    state.phase = "freeTrade";
    const cashBefore = player.cash;

    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "C03" } });
    state = reduceGame(state, { type: "SELL_TO_BANK", playerId: "p2", payload: { artifactId: artifact.id } });
    expect(state.players.find((candidate) => candidate.id === "p2")?.cash).toBe(cashBefore + 80);
    expect(state.players.find((candidate) => candidate.id === "p2")?.artifacts).not.toContain(artifact.id);

    state.phase = "eventWindow";
    state.day += 1;
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
    expect(state.phase).toBe("freeTrade");
    expect(state.players.find((candidate) => candidate.id === "p2")?.artifacts).toContain(artifact.id);
    expect(state.players.find((candidate) => candidate.id === "p2")?.cash).toBe(cashBefore + 80 - 100);
  });

  it("resolves 巧取豪夺 and 搜身 through trade and private views", () => {
    let state = startedRoom();
    const attacker = state.players.find((player) => player.id === "p2")!;
    const owner = state.players.find((player) => player.id === "p3")!;
    const artifact = Object.values(state.artifacts)[0]!;
    artifact.ownerId = owner.id;
    artifact.rumorMin = 100;
    owner.artifacts.push(artifact.id);
    state.players.find((player) => player.id === "p1")!.hand = [];
    owner.hand = ["I01"];
    state.players.find((player) => player.id === "p4")!.hand = [];
    attacker.hand.push("D02", "D03");
    const ownerCashBefore = owner.cash;

    state.phase = "freeTrade";
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "D02", targetArtifactId: artifact.id } });
    expect(state.tradeOffers).toHaveLength(1);
    state = reduceGame(state, {
      type: "RESPOND_TRADE_OFFER",
      playerId: "p3",
      payload: { tradeOfferId: state.tradeOffers[0]!.id, accept: false, version: 1 }
    });
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(ownerCashBefore - 20);
    expect(state.players.find((player) => player.id === "p2")?.cash).toBeGreaterThan(attacker.cash);

    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "D03", targetPlayerId: "p3" } });
    const attackerView = getPlayerView(state, "p2");
    const otherView = getPlayerView(state, "p4");
    expect(attackerView.players.find((player) => player.id === "p3")?.revealedHand?.map((card) => card.id)).toContain("I01");
    expect(otherView.players.find((player) => player.id === "p3")?.revealedHand).toBeUndefined();
  });

  it("supports distinct reaction cards for delay and redirect", () => {
    let state = startedRoom();
    const attacker = state.players.find((player) => player.id === "p2")!;
    const target = state.players.find((player) => player.id === "p3")!;
    attacker.hand.push("D06", "D06");
    target.hand.push("R01");
    const targetCashBefore = target.cash;

    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "english", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "D06", targetPlayerId: "p3" } });
    state = reduceGame(state, { type: "RESPOND_REACTION", playerId: "p3", payload: { reactionId: state.pendingReaction!.id, cardId: "R01", response: "counter" } });
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(targetCashBefore);
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 80 } });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p3", payload: {} });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p4", payload: {} });
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(targetCashBefore - 10);

    state.phase = "freeTrade";
    state.players.find((player) => player.id === "p3")!.hand.push("R05");
    const redirected = state.players.find((player) => player.id === "p4")!;
    const redirectedCashBefore = redirected.cash;
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "D06", targetPlayerId: "p3" } });
    state = reduceGame(state, {
      type: "RESPOND_REACTION",
      playerId: "p3",
      payload: { reactionId: state.pendingReaction!.id, cardId: "R05", targetPlayerId: "p4", response: "counter" }
    });
    expect(state.players.find((player) => player.id === "p4")?.cash).toBe(redirectedCashBefore - 10);
  });

  it("applies a generated final value event effect to artifact value", () => {
    let state = startedRoom();
    const valueEvent = EVENT_CARDS.find((card) => card.effects?.some((effect) => effect.type === "finalValueMultiplier" && effect.multiplier === 0.8))!;
    const artifact = Object.values(state.artifacts)[0]!;
    artifact.trueValue = 100;
    artifact.category = "relic";
    artifact.tag = "anonymous";
    artifact.properties = [];
    state.todayArtifactIds = [artifact.id];
    const caster = state.players.find((player) => player.id === "p2")!;
    caster.events.push(valueEvent.id);

    state.phase = "eventWindow";
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: valueEvent.id } });
    expect(state.activeEffects).toHaveLength(1);
    state.day += 1;
    state.currentHostId = "p1";
    state.phase = "preview";
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "english", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 80 } });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p3", payload: {} });
    state = reduceGame(state, { type: "PASS_BID", playerId: "p4", payload: {} });

    const view = getPlayerView(state, "p2");
    expect(view.self.artifacts[0]?.trueValue).toBe(80);
    expect(view.activeEffects[0]?.label).toContain(valueEvent.name);
  });

  it("applies black market event modifiers on the next black market day", () => {
    let state = startedRoom();
    const player = state.players.find((candidate) => candidate.id === "p2")!;
    player.events.push("E03", "E05", "E06");
    state.phase = "eventWindow";

    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "E03" } });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "E05" } });
    state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId: "E06" } });

    while (!(state.day === 3 && state.phase === "blackMarket")) {
      const actor = state.hostPlayerId ?? "p1";
      if (state.phase === "preview") state = reduceGame(state, { type: "SET_AUCTION", playerId: state.currentHostId ?? actor, payload: { mode: "sealed", startingBid: 0 } });
      else if (state.phase === "cardWindow") state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
      else if (state.phase === "auction") {
        for (const bidder of state.players.filter((candidate) => candidate.id !== state.currentHostId)) {
          if (state.phase === "auction") state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: bidder.id, payload: { amount: 0 } });
        }
      } else state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: actor, payload: {} });
    }

    const cashBefore = state.players.find((candidate) => candidate.id === "p2")!.cash;
    expect(state.players.find((candidate) => candidate.id === "p2")!.hand.length).toBeGreaterThanOrEqual(3);
    expect(() => reduceGame(state, { type: "BUY_BLACK_MARKET", playerId: "p2", payload: { kind: "trick" } })).toThrow("不能购买锦囊");
    state = reduceGame(state, { type: "BUY_BLACK_MARKET", playerId: "p2", payload: { kind: "event" } });
    expect(state.players.find((candidate) => candidate.id === "p2")?.cash).toBe(cashBefore - 40);
  });

  it("applies economy events to bank sales, loans, income, and bid taxes", () => {
    let state = startedRoom();
    const player = state.players.find((candidate) => candidate.id === "p2")!;
    const artifact = Object.values(state.artifacts)[0]!;
    artifact.ownerId = player.id;
    artifact.rumorMin = 100;
    player.artifacts.push(artifact.id);
    player.events.push("E15", "E13", "E21", "E28");
    state.phase = "eventWindow";
    const cashBeforeEvents = player.cash;

    for (const cardId of ["E15", "E13", "E21", "E28"]) {
      state = reduceGame(state, { type: "PLAY_CARD", playerId: "p2", payload: { cardId } });
    }
    state.day += 1;
    state.phase = "freeTrade";
    state = reduceGame(state, { type: "SELL_TO_BANK", playerId: "p2", payload: { artifactId: artifact.id } });
    expect(state.players.find((candidate) => candidate.id === "p2")?.cash).toBe(cashBeforeEvents + 100);

    state = reduceGame(state, { type: "TAKE_LOAN", playerId: "p2", payload: {} });
    expect(state.players.find((candidate) => candidate.id === "p2")?.loanRepayments?.[0]).toBe(130);

    state.phase = "dayIncome";
    const cashBeforeIncome = state.players.find((candidate) => candidate.id === "p2")!.cash;
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
    expect(state.players.find((candidate) => candidate.id === "p2")!.cash - cashBeforeIncome).toBeGreaterThanOrEqual(20);

    state.phase = "auction";
    state.currentHostId = "p1";
    state.auction = {
      id: "auction_test",
      artifactIds: [Object.keys(state.artifacts)[1]!],
      mode: "english",
      currentArtifactIndex: 0,
      status: "open",
      currentBid: 0,
      minimumIncrement: 10,
      passedPlayerIds: [],
      sealedBids: {},
      sealedBidRounds: {}
    };
    const cashBeforeBids = state.players.find((candidate) => candidate.id === "p2")!.cash;
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 10 } });
    state = reduceGame(state, { type: "PLACE_BID", playerId: "p2", payload: { amount: 20 } });
    expect(state.players.find((candidate) => candidate.id === "p2")?.cash).toBe(cashBeforeBids - 5);
  });

  it("applies role active skills without leaking hidden information", () => {
    let state = startedRoom();
    const spy = state.players.find((player) => player.id === "p2")!;
    const target = state.players.find((player) => player.id === "p3")!;
    setRole(spy, "role06");
    target.hand = ["I01"];
    target.events = ["E01"];
    state.phase = "blackMarket";

    state = reduceGame(state, { type: "USE_ROLE_SKILL", playerId: "p2", payload: { skillId: "role06_skill01", targetPlayerId: "p3" } });
    const spyView = getPlayerView(state, "p2");
    const otherView = getPlayerView(state, "p4");
    expect(spyView.players.find((player) => player.id === "p3")?.revealedHand?.map((card) => card.id)).toEqual(["I01"]);
    expect(spyView.players.find((player) => player.id === "p3")?.revealedEvents?.map((card) => card.id)).toEqual(["E01"]);
    expect(otherView.players.find((player) => player.id === "p3")?.revealedHand).toBeUndefined();

    state.phase = "freeTrade";
    const cashBefore = state.players.find((player) => player.id === "p2")!.cash;
    state = reduceGame(state, { type: "USE_ROLE_SKILL", playerId: "p2", payload: { skillId: "role06_skill03", targetPlayerId: "p3" } });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(cashBefore - 30);
    expect(getPlayerView(state, "p2").players.find((player) => player.id === "p3")?.revealedMissions?.length).toBeGreaterThan(0);
    expect(getPlayerView(state, "p4").players.find((player) => player.id === "p3")?.revealedMissions).toBeUndefined();
  });

  it("lets gambler see sealed bids and modify their sealed bid once", () => {
    let state = startedRoom();
    const gambler = state.players.find((player) => player.id === "p2")!;
    setRole(gambler, "role05", { role05_skill01: 1, role05_skill02: 1 });
    state = reduceGame(state, { type: "SET_AUCTION", playerId: "p1", payload: { mode: "sealed", startingBid: 0 } });
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p2", payload: { amount: 80 } });
    state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: "p3", payload: { amount: 100 } });

    expect(getPlayerView(state, "p2").auction?.visibleSealedBids).toMatchObject({ p2: 80, p3: 100 });
    expect(getPlayerView(state, "p4").auction?.visibleSealedBids).toBeUndefined();
    state = reduceGame(state, { type: "USE_ROLE_SKILL", playerId: "p2", payload: { skillId: "role05_skill02" } });
    expect(getPlayerView(state, "p2").auction?.ownSealedBid).toBe(101);
    expect(() => reduceGame(state, { type: "USE_ROLE_SKILL", playerId: "p2", payload: { skillId: "role05_skill02" } })).toThrow();
  });

  it("queues gambler reroll for morning income instead of granting cash immediately", () => {
    let state = startedRoom();
    const gambler = state.players.find((player) => player.id === "p2")!;
    setRole(gambler, "role05", { role05_skill01: 1 });
    state.phase = "dayIncome";
    const cashBeforeSkill = gambler.cash;
    state = reduceGame(state, { type: "USE_ROLE_SKILL", playerId: "p2", payload: { skillId: "role05_skill01" } });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(cashBeforeSkill);
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBeGreaterThan(cashBeforeSkill);
    expect(state.activeEffects.some((effect) => effect.sourceRoleSkillId === "role05_skill01")).toBe(false);
  });

  it("applies property rules for bank sales, loans, trades, and black market", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const [bankItem, loanItem, tradeItem, fragileItem, blackMarketItem] = Object.values(state.artifacts);
    bankItem!.ownerId = p2.id;
    bankItem!.rumorMin = 100;
    bankItem!.properties = ["prop11", "prop25"];
    bankItem!.tag = "anonymous";
    loanItem!.ownerId = p2.id;
    loanItem!.properties = ["prop12"];
    loanItem!.tag = "anonymous";
    tradeItem!.ownerId = p2.id;
    tradeItem!.properties = ["prop04"];
    tradeItem!.tag = "anonymous";
    fragileItem!.ownerId = p2.id;
    fragileItem!.properties = ["fragile"];
    fragileItem!.tag = "fragile";
    blackMarketItem!.ownerId = p2.id;
    blackMarketItem!.properties = ["prop09", "prop13"];
    blackMarketItem!.tag = "anonymous";
    p2.artifacts = [bankItem!.id, loanItem!.id, tradeItem!.id, fragileItem!.id, blackMarketItem!.id];
    p2.cash = 200;

    state.phase = "freeTrade";
    state = reduceGame(state, { type: "SELL_TO_BANK", playerId: "p2", payload: { artifactId: bankItem!.id } });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(288);
    state = reduceGame(state, { type: "TAKE_LOAN", playerId: "p2", payload: {} });
    expect(state.players.find((player) => player.id === "p2")?.loanRepayments?.[0]).toBe(110);
    state = reduceGame(state, { type: "TAKE_LOAN", playerId: "p2", payload: {} });
    expect(state.players.find((player) => player.id === "p2")?.loans).toBe(2);

    state = reduceGame(state, {
      type: "CREATE_TRADE_OFFER",
      playerId: "p2",
      payload: { toPlayerId: "p3", give: { artifactIds: [tradeItem!.id] }, receive: { cash: 100 } }
    });
    const cashBeforeTrade = state.players.find((player) => player.id === "p2")!.cash;
    state = reduceGame(state, {
      type: "RESPOND_TRADE_OFFER",
      playerId: "p3",
      payload: { tradeOfferId: state.tradeOffers[0]!.id, accept: true, version: 1 }
    });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(cashBeforeTrade + 100 + 20);

    state.day = 3;
    state.phase = "dayIncome";
    const cashBeforeBlackMarket = state.players.find((player) => player.id === "p2")!.cash;
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
    expect(state.phase).toBe("blackMarket");
    expect(state.players.find((player) => player.id === "p2")!.cash).toBeGreaterThanOrEqual(cashBeforeBlackMarket + 10);
    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
    expect(state.players.find((player) => player.id === "p2")?.artifacts).toContain(fragileItem!.id);
  });

  it("applies final value property rules precisely enough for scoring", () => {
    let state = startedRoom();
    const player = state.players.find((candidate) => candidate.id === "p2")!;
    player.cash = 0;
    player.loans = 0;
    player.loanRepayments = [];
    player.missionIds = [];
    player.missionId = undefined;
    player.artifacts = [];
    giveArtifacts(state, player, [
      { value: 100, category: "calligraphy" },
      { value: 100, category: "bronze" },
      { value: 100, category: "jewelry" },
      { value: 100, category: "porcelain" },
      { value: 100, category: "jade" }
    ]);
    const owned = player.artifacts.map((id) => state.artifacts[id]!);
    owned[0]!.properties = ["treasure"];
    owned[1]!.properties = ["prop03", "prop05", "prop16"];
    owned[2]!.properties = ["prop17"];
    owned[3]!.properties = ["prop24"];
    owned[4]!.properties = ["prop26"];
    owned[4]!.privatePeekedBy = ["p3"];
    state.phase = "freeTrade";
    state.day = state.maxDays;

    state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p1", payload: {} });
    const score = state.players.find((candidate) => candidate.id === "p2")!.finalScore!;
    expect(score.artifactValue).toBe(629);
  });

  it("evaluates all 52 mission cards by explicit mission id rules", () => {
    for (let index = 1; index <= 52; index += 1) {
      const missionId = `W${String(index).padStart(2, "0")}`;
      const result = finishWithMission(missionId, (state, player) => configureSuccessfulMission(state, player, missionId));
      expect(result, missionId).toMatchObject({ missionId, success: true });
    }
  });

  it("rejects high-risk failed mission fixtures for all 52 mission cards", () => {
    for (let index = 1; index <= 52; index += 1) {
      const missionId = `W${String(index).padStart(2, "0")}`;
      const result = finishWithMission(missionId, (state, player) => configureFailedMission(state, player, missionId));
      expect(result, missionId).toMatchObject({ missionId, success: false, reputation: 0 });
    }
  });

  it("final scoring includes loans and missions without rerandomizing artifacts", () => {
    let state = startedRoom();
    state = reduceGame(state, { type: "TAKE_LOAN", playerId: "p2", payload: {} });
    while (state.phase !== "finalScoring") {
      if (state.phase === "preview") {
        const host = state.currentHostId ?? state.hostPlayerId ?? "p1";
        state = reduceGame(state, { type: "SET_AUCTION", playerId: host, payload: { mode: "sealed", startingBid: 0 } });
      } else if (state.phase === "cardWindow") {
        state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: "p2", payload: {} });
      } else if (state.phase === "auction") {
        for (const player of state.players.filter((player) => player.id !== state.currentHostId)) {
          if (state.phase === "auction") {
            state = reduceGame(state, { type: "SUBMIT_SEALED_BID", playerId: player.id, payload: { amount: 0 } });
          }
        }
      } else {
        const actor = state.hostPlayerId ?? "p1";
        state = reduceGame(state, { type: "ADVANCE_PHASE", playerId: actor, payload: {} });
      }
    }
    expect(state.players.every((player) => player.finalScore)).toBe(true);
    expect(state.players.find((player) => player.id === "p2")?.loans).toBe(1);
  });

  it("automates a complete deterministic 10 day long game through final scoring", () => {
    const originalRandom = Math.random;
    const run = (roomId: string) => {
      let index = 0;
      const sequence = [0.11, 0.42, 0.73, 0.24, 0.95, 0.36, 0.67, 0.18];
      Math.random = () => sequence[index++ % sequence.length]!;
      try {
        return driveFullTenDayGame(roomId);
      } finally {
        Math.random = originalRandom;
      }
    };
    const first = run("room_long_auto");
    const second = run("room_long_auto");
    const summary = (state: GameState) =>
      state.players.map((player) => ({
        id: player.id,
        cash: player.cash,
        loans: player.loans,
        artifacts: player.artifacts.length,
        reputation: player.finalScore?.reputation,
        artifactValue: player.finalScore?.artifactValue,
        missionResults: player.finalScore?.missionResults
      }));

    expect(first.phase).toBe("finalScoring");
    expect(first.day).toBe(10);
    expect(first.pendingReaction).toBeUndefined();
    expect(first.players.every((player) => player.finalScore)).toBe(true);
    expect(Object.values(first.stats.auctionWinCount).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(summary(first)).toEqual(summary(second));
  });

  it("fuzzes hidden information views across auction, reaction, role visibility, and final reveal", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const p4 = state.players.find((player) => player.id === "p4")!;
    setRole(p2, "role05", { role05_skill02: 1 });
    setRole(p4, "role06");
    p2.hand.push("D06");
    p3.hand = ["R02"];
    p4.hand = [];
    p3.events.push("E01");
    p3.missionIds = ["W01", "W02"];
    p3.missionId = "W01";

    state = action(state, "p1", "SET_AUCTION", { mode: "sealed", startingBid: 0 });
    state = action(state, "p2", "ADVANCE_PHASE");
    state = action(state, "p2", "SUBMIT_SEALED_BID", { amount: 80 });
    state = action(state, "p3", "SUBMIT_SEALED_BID", { amount: 60 });
    let gamblerView = getPlayerView(state, "p2");
    const ordinaryView = getPlayerView(state, "p4");
    expect(gamblerView.auction?.visibleSealedBids).toMatchObject({ p2: 80, p3: 60 });
    expect(ordinaryView.auction?.visibleSealedBids).toBeUndefined();
    expect(ordinaryView.auction?.ownSealedBid).toBeUndefined();
    assertNoSecretArtifactLeak(ordinaryView, state, "p4");

    state.phase = "freeTrade";
    state = action(state, "p2", "PLAY_CARD", { cardId: "D06", targetPlayerId: "p3" });
    expect(getPlayerView(state, "p3").pendingReaction).toBeDefined();
    expect(getPlayerView(state, "p2").pendingReaction).toBeUndefined();
    expect(getPlayerView(state, "p4").pendingReaction).toBeUndefined();
    state = action(state, "p3", "RESPOND_REACTION", { reactionId: state.pendingReaction!.id, response: "counter" });

    state.phase = "blackMarket";
    state = action(state, "p4", "USE_ROLE_SKILL", { skillId: "role06_skill01", targetPlayerId: "p3" });
    const spyHandView = getPlayerView(state, "p4");
    const outsiderHandView = getPlayerView(state, "p2");
    expect(spyHandView.players.find((player) => player.id === "p3")?.revealedHand).toHaveLength(0);
    expect(spyHandView.players.find((player) => player.id === "p3")?.revealedEvents?.map((card) => card.id)).toContain("E01");
    expect(outsiderHandView.players.find((player) => player.id === "p3")?.revealedHand).toBeUndefined();
    expect(outsiderHandView.activeEffects.some((effect) => effect.sourceRoleSkillId === "role06_skill01")).toBe(false);

    state.phase = "freeTrade";
    state.players.find((player) => player.id === "p4")!.cash = 100;
    state = action(state, "p4", "USE_ROLE_SKILL", { skillId: "role06_skill03", targetPlayerId: "p3" });
    const spyMissionView = getPlayerView(state, "p4");
    const outsiderMissionView = getPlayerView(state, "p2");
    expect(spyMissionView.players.find((player) => player.id === "p3")?.revealedMissions?.map((mission) => mission.id)).toEqual(["W01", "W02"]);
    expect(outsiderMissionView.players.find((player) => player.id === "p3")?.revealedMissions).toBeUndefined();
    expect(outsiderMissionView.activeEffects.some((effect) => effect.sourceRoleSkillId === "role06_skill03")).toBe(false);

    for (const player of state.players) {
      const view = getPlayerView(state, player.id);
      if (player.id !== "p4") assertOtherPlayerSecretsHidden(view, player.id);
      assertNoSecretArtifactLeak(view, state, player.id);
    }

    state.phase = "freeTrade";
    state.day = state.maxDays;
    state = action(state, "p1", "ADVANCE_PHASE");
    gamblerView = getPlayerView(state, "p2");
    expect(gamblerView.todayArtifacts.every((artifact) => artifact.trueValue !== undefined && artifact.properties !== undefined && artifact.tag !== undefined)).toBe(true);
  });

  it("rejects role skill failure paths and preserves one-time role boundaries", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const p4 = state.players.find((player) => player.id === "p4")!;
    const artifact = Object.values(state.artifacts)[0]!;
    artifact.ownerId = p2.id;
    p2.artifacts.push(artifact.id);

    setRole(p2, "role02");
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role02_skill01" }, "被动技能会自动生效");

    setRole(p2, "role01");
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role01_skill02", targetArtifactId: artifact.id }, "妙笔只能在黑市日使用");
    state.phase = "blackMarket";
    const nonOwnedArtifact = Object.values(state.artifacts).find((candidate) => candidate.id !== artifact.id)!;
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role01_skill02", targetArtifactId: nonOwnedArtifact.id }, "只能指定自己的藏品");

    setRole(p2, "role06");
    p2.cash = 20;
    state.phase = "freeTrade";
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role06_skill03", targetPlayerId: "p3" }, "现金不足");

    setRole(p2, "role09", { role09_skill02: 1, role09_skill03: 1 });
    state.phase = "preview";
    state.currentHostId = "p3";
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role09_skill02", targetArtifactId: state.todayArtifactIds[0] }, "包装只能在自己主持");
    state.currentHostId = "p2";
    state = action(state, "p2", "USE_ROLE_SKILL", { skillId: "role09_skill02", targetArtifactId: state.todayArtifactIds[0] });
    expect(state.players.find((player) => player.id === "p2")?.role?.skillCharges.role09_skill02).toBe(0);
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role09_skill02", targetArtifactId: state.todayArtifactIds[0] }, "该技能次数已用完");

    state = action(state, "p2", "SET_AUCTION", { mode: "sealed", startingBid: 0 });
    state = action(state, "p3", "ADVANCE_PHASE");
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role09_skill03" }, "暗箱操作只能用于英式");
    state.phase = "preview";
    state.currentHostId = "p2";
    state = action(state, "p2", "SET_AUCTION", { mode: "english", startingBid: 0 });
    state = action(state, "p3", "ADVANCE_PHASE");
    state = action(state, "p2", "USE_ROLE_SKILL", { skillId: "role09_skill03" });
    expect(state.players.find((player) => player.id === "p2")?.role?.skillCharges.role09_skill03).toBe(0);
    state.phase = "auction";
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role09_skill03" }, "该技能次数已用完");

    setRole(state.players.find((player) => player.id === "p4")!, "role05", { role05_skill02: 1 });
    state.phase = "auction";
    state.currentHostId = "p1";
    state.auction = {
      id: "auction_role05",
      artifactIds: [state.todayArtifactIds[0]!],
      mode: "sealed",
      currentArtifactIndex: 0,
      status: "open",
      currentBid: 0,
      minimumIncrement: 10,
      passedPlayerIds: [],
      sealedBids: {},
      sealedBidRounds: {},
      bidCounts: {},
      highestBids: {}
    };
    expectActionError(state, "p4", "USE_ROLE_SKILL", { skillId: "role05_skill02" }, "需要先提交自己的暗标");
    state = action(state, "p4", "SUBMIT_SEALED_BID", { amount: 10 });
    state = action(state, "p4", "USE_ROLE_SKILL", { skillId: "role05_skill02" });
    expectActionError(state, "p4", "USE_ROLE_SKILL", { skillId: "role05_skill02" }, "该技能次数已用完");
  });

  it("covers role boundary matrix for passive skills, targets, resets, and hidden views", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const ownArtifact = Object.values(state.artifacts)[0]!;
    const otherArtifact = Object.values(state.artifacts)[1]!;
    ownArtifact.ownerId = p2.id;
    p2.artifacts.push(ownArtifact.id);
    otherArtifact.ownerId = p3.id;
    p3.artifacts.push(otherArtifact.id);

    setRole(p2, "role03");
    state.phase = "freeTrade";
    state.day = 3;
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role03_skill01", targetArtifactId: ownArtifact.id }, "镇馆之宝只能在终局前后指定");
    state.day = state.maxDays;
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role03_skill01", targetArtifactId: otherArtifact.id }, "只能指定自己的藏品");

    setRole(p2, "role04");
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role04_skill02" }, "被动技能会自动生效");

    setRole(p2, "role07", { role07_skill01: 1 });
    state.phase = "freeTrade";
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role07_skill01", targetArtifactId: ownArtifact.id }, "当前阶段不能使用该探查技能");
    state.phase = "preview";
    state = action(state, "p2", "USE_ROLE_SKILL", { skillId: "role07_skill01", targetArtifactId: ownArtifact.id });
    expect(state.players.find((player) => player.id === "p2")?.role?.skillCharges.role07_skill01).toBe(0);
    state.phase = "freeTrade";
    state.day = 4;
    state = action(state, "p1", "ADVANCE_PHASE");
    expect(state.players.find((player) => player.id === "p2")?.role?.skillCharges.role07_skill01).toBe(1);

    setRole(state.players.find((player) => player.id === "p2")!, "role08", { role08_skill01: 1, role08_skill03: 1 });
    state.phase = "dayIncome";
    expectActionError(state, "p2", "USE_ROLE_SKILL", { skillId: "role08_skill02" }, "被动技能会自动生效");

    setRole(state.players.find((player) => player.id === "p2")!, "role06");
    state.phase = "freeTrade";
    state.players.find((player) => player.id === "p2")!.cash = 100;
    state.players.find((player) => player.id === "p3")!.missionIds = ["W01", "W02"];
    state = action(state, "p2", "USE_ROLE_SKILL", { skillId: "role06_skill03", targetPlayerId: "p3", targetMissionId: "W02", invalidateMission: true });
    expect(state.players.find((player) => player.id === "p3")?.missionIds).toEqual(["W01"]);
    expect(getPlayerView(state, "p4").players.find((player) => player.id === "p3")?.revealedMissions).toBeUndefined();
  });

  it("covers property failure paths and multi-property boundary combinations", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const [bankItem, plainItem, fragileItem, protectedFragile, privateRumor, publicRumor] = Object.values(state.artifacts);
    p2.artifacts = [];
    for (const artifact of [bankItem, plainItem, fragileItem, protectedFragile, privateRumor, publicRumor]) {
      artifact!.ownerId = p2.id;
      artifact!.rumorMin = 100;
      artifact!.trueValue = 100;
      artifact!.category = "calligraphy";
      artifact!.tag = "anonymous";
      artifact!.properties = [];
      artifact!.revealedTo = [p2.id];
      artifact!.peekedBy = [];
      artifact!.privatePeekedBy = [];
      p2.artifacts.push(artifact!.id);
    }
    bankItem!.properties = ["prop11", "prop25"];
    plainItem!.properties = ["prop25"];
    fragileItem!.properties = ["fragile"];
    protectedFragile!.properties = ["fragile"];
    privateRumor!.properties = ["prop26"];
    publicRumor!.properties = ["prop26"];
    p2.cash = 0;
    state.phase = "freeTrade";

    state = action(state, "p2", "SELL_TO_BANK", { artifactId: bankItem!.id });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(88);
    state = action(state, "p2", "SELL_TO_BANK", { artifactId: plainItem!.id });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(152);

    state.players.find((player) => player.id === "p2")!.cash = 0;
    state.day = 3;
    state.phase = "blackMarket";
    state = action(state, "p1", "ADVANCE_PHASE");
    expect(state.players.find((player) => player.id === "p2")?.artifacts).not.toContain(fragileItem!.id);

    state.players.find((player) => player.id === "p2")!.role = { roleId: "role07", skillCharges: {} };
    state.players.find((player) => player.id === "p2")!.artifacts.push(protectedFragile!.id);
    protectedFragile!.ownerId = "p2";
    state.day = 6;
    state.phase = "blackMarket";
    state = action(state, "p1", "ADVANCE_PHASE");
    expect(state.players.find((player) => player.id === "p2")?.artifacts).toContain(protectedFragile!.id);

    state.phase = "freeTrade";
    const privateValueBefore = getPlayerView(state, "p2").self.artifacts.find((artifact) => artifact.id === privateRumor!.id)?.trueValue;
    state.players.find((player) => player.id === "p3")!.hand.push("I01");
    state = action(state, "p3", "PLAY_CARD", { cardId: "I01", targetArtifactId: privateRumor!.id });
    const privateValueAfter = getPlayerView(state, "p2").self.artifacts.find((artifact) => artifact.id === privateRumor!.id)?.trueValue;
    publicRumor!.peekedBy = ["p3"];
    publicRumor!.privatePeekedBy = [];
    const publicValueAfter = getPlayerView(state, "p2").self.artifacts.find((artifact) => artifact.id === publicRumor!.id)?.trueValue;
    expect(privateValueBefore).toBe(100);
    expect(privateValueAfter).toBe(85);
    expect(publicValueAfter).toBe(100);

    const hotItem = Object.values(state.artifacts).find((artifact) => !p2.artifacts.includes(artifact.id) && artifact.ownerId === undefined)!;
    hotItem.ownerId = p2.id;
    hotItem.rumorMin = 100;
    hotItem.purchasePrice = 20;
    hotItem.properties = ["prop04"];
    state.players.find((player) => player.id === "p2")!.artifacts.push(hotItem.id);
    state.players.find((player) => player.id === "p2")!.cash = 0;
    state.players.find((player) => player.id === "p3")!.cash = 100;
    state.phase = "freeTrade";
    expectActionError(state, "p2", "CREATE_TRADE_OFFER", { toPlayerId: "p3", give: { artifactIds: [hotItem.id] }, receive: { cash: 200 } }, "交易现金不足");
    state = action(state, "p2", "CREATE_TRADE_OFFER", { toPlayerId: "p3", give: { artifactIds: [hotItem.id] }, receive: { cash: 100 } });
    state = action(state, "p3", "RESPOND_TRADE_OFFER", { tradeOfferId: state.tradeOffers.at(-1)!.id, accept: true, version: 1 });
    expect(state.players.find((player) => player.id === "p2")?.cash).toBe(120);
  });

  it("covers additional high-risk property combination outcomes", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const p4 = state.players.find((player) => player.id === "p4")!;
    const [loanItem, blackMarketItem, discardItem, commissionItem, curseItem, fakeItem] = Object.values(state.artifacts);
    p2.artifacts = [];
    for (const artifact of [loanItem, blackMarketItem, discardItem, curseItem, fakeItem]) {
      artifact!.ownerId = p2.id;
      artifact!.rumorMin = 100;
      artifact!.rumorMax = 150;
      artifact!.trueValue = 100;
      artifact!.category = "calligraphy";
      artifact!.tag = "anonymous";
      artifact!.properties = [];
      artifact!.revealedTo = [p2.id];
      p2.artifacts.push(artifact!.id);
    }

    loanItem!.properties = ["prop12"];
    blackMarketItem!.properties = ["prop13"];
    setRole(p2, "role04");
    state.activeEffects.push({
      id: "test_e13",
      sourceEventId: "E13",
      label: "紧缩政策：下一天新贷款改为借 100 还 130。",
      appliesTo: "cash",
      loanRepayment: 130,
      day: state.day,
      createdBy: "p1"
    });
    state.phase = "freeTrade";
    state = action(state, "p2", "TAKE_LOAN");
    state = action(state, "p2", "TAKE_LOAN");
    state = action(state, "p2", "TAKE_LOAN");
    expect(state.players.find((player) => player.id === "p2")?.loanRepayments).toEqual([110, 110, 110]);
    expectActionError(state, "p2", "TAKE_LOAN", {}, "今日贷款次数已达上限");

    setRole(state.players.find((player) => player.id === "p2")!, "role02");
    state.phase = "blackMarket";
    state.players.find((player) => player.id === "p2")!.blackMarketBuysToday = 1;
    state.activeEffects.push({
      id: "test_e04",
      sourceEventId: "E04",
      label: "黑市查封：下一个黑市日每人最多买 1 张。",
      appliesTo: "cash",
      blackMarketLimit: 1,
      day: state.day,
      createdBy: "p1"
    });
    expectActionError(state, "p2", "BUY_BLACK_MARKET", { kind: "event" }, "本次黑市购买次数已达上限");

    state.activeEffects = state.activeEffects.filter((effect) => effect.id !== "test_e04");
    state.activeEffects.push({
      id: "test_e05",
      sourceEventId: "E05",
      label: "稀货流入：下一个黑市日每人购买上限 +1。",
      appliesTo: "cash",
      blackMarketLimit: 3,
      day: state.day,
      createdBy: "p1"
    });
    state.players.find((player) => player.id === "p2")!.blackMarketBuysToday = 0;
    state.players.find((player) => player.id === "p2")!.cash = 500;
    state = action(state, "p2", "BUY_BLACK_MARKET", { kind: "trick" });
    state = action(state, "p2", "BUY_BLACK_MARKET", { kind: "trick" });
    state = action(state, "p2", "BUY_BLACK_MARKET", { kind: "trick" });
    state = action(state, "p2", "BUY_BLACK_MARKET", { kind: "trick" });
    expectActionError(state, "p2", "BUY_BLACK_MARKET", { kind: "trick" }, "本次黑市购买次数已达上限");

    const discardItemId = discardItem!.id;
    state.artifacts[discardItemId]!.properties = ["prop10"];
    state.artifacts[discardItemId]!.ownerId = undefined;
    state.players.find((player) => player.id === "p2")!.artifacts = state.players.find((player) => player.id === "p2")!.artifacts.filter((id) => id !== discardItemId);
    state.discardPile = ["E01", "I01"];
    state.todayArtifactIds = [discardItemId];
    state.currentHostId = "p1";
    state.phase = "preview";
    state = action(state, "p1", "SET_AUCTION", { mode: "english", startingBid: 0 });
    state = action(state, "p2", "ADVANCE_PHASE");
    state = action(state, "p2", "PLACE_BID", { amount: 80 });
    state = action(state, "p3", "PASS_BID");
    state = action(state, "p4", "PASS_BID");
    expect(state.players.find((player) => player.id === "p2")?.hand).toContain("I01");
    expect(state.discardPile).toEqual(["E01"]);

    const commissionItemId = commissionItem!.id;
    state.artifacts[commissionItemId]!.ownerId = "p3";
    state.artifacts[commissionItemId]!.properties = ["prop18"];
    state.players.find((player) => player.id === "p3")!.artifacts = [commissionItemId];
    setRole(state.players.find((player) => player.id === "p3")!, "role09");
    state.phase = "preview";
    state.currentHostId = "p3";
    state.todayArtifactIds = [Object.values(state.artifacts).find((artifact) => artifact.ownerId === undefined)!.id];
    const hostCashBefore = state.players.find((player) => player.id === "p3")!.cash;
    state = action(state, "p3", "SET_AUCTION", { mode: "english", startingBid: 0 });
    state = action(state, "p2", "ADVANCE_PHASE");
    state = action(state, "p2", "PLACE_BID", { amount: 100 });
    state = action(state, "p4", "PASS_BID");
    state = action(state, "p2", "PASS_BID");
    expect(state.players.find((player) => player.id === "p3")?.cash).toBe(hostCashBefore + 35);
    expect(state.players.find((player) => player.id === "p3")?.privateLog?.at(-1)).toContain("你作为主持人收到 35 银元佣金。");

    const cursedResult = finishWithMission("W01", (missionState, player) => {
      giveArtifacts(missionState, player, [{ value: 100 }, { value: 100 }]);
      const owned = player.artifacts.map((id) => missionState.artifacts[id]!);
      owned[0]!.properties = ["prop27"];
      owned[1]!.properties = [];
    });
    expect(cursedResult.success).toBe(false);

    let scoreState = startedRoom();
    const scorer = scoreState.players.find((player) => player.id === "p2")!;
    scorer.cash = 0;
    scorer.loanRepayments = [];
    scorer.missionIds = [];
    scorer.role = { roleId: "role01", skillCharges: {} };
    giveArtifacts(scoreState, scorer, [{ value: 100, fake: true }]);
    scoreState.phase = "freeTrade";
    scoreState.day = scoreState.maxDays;
    scoreState = action(scoreState, "p1", "ADVANCE_PHASE");
    expect(scoreState.players.find((player) => player.id === "p2")?.finalScore?.artifactValue).toBe(100);

    expect(p4.id).toBe("p4");
  });

  it("covers trick target, mode, counter, and blocking failure matrix", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const p3 = state.players.find((player) => player.id === "p3")!;
    const targetArtifact = Object.values(state.artifacts)[0]!;
    targetArtifact.ownerId = p3.id;
    p3.artifacts.push(targetArtifact.id);
    p2.hand.push("D06", "D03", "D07", "B05", "B06", "B04", "D01", "D05");

    expectActionError(state, "p2", "PLAY_CARD", { cardId: "D06", targetPlayerId: "p3" }, "当前阶段不能使用卡牌");
    state.phase = "freeTrade";
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "D06" }, "目标玩家不存在");
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "D03" }, "目标玩家不存在");
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "D07" }, "目标玩家不存在");
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "D02", targetArtifactId: targetArtifact.id }, "你没有这张卡");

    state.phase = "preview";
    state.currentHostId = "p1";
    state = action(state, "p1", "SET_AUCTION", { mode: "english", startingBid: 0 });
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "B05" }, "暗标加封只能用于暗标拍卖");
    state = action(state, "p2", "ADVANCE_PHASE");
    state.players.find((player) => player.id === "p2")!.cash = 0;
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "B06" }, "现金不足");
    state.players.find((player) => player.id === "p2")!.cash = 500;
    state.currentHostId = "p2";
    expectActionError(state, "p2", "PLAY_CARD", { cardId: "B04" }, "主持人不能使用搅局流拍");

    state = startedRoom();
    state.phase = "freeTrade";
    state.players.find((player) => player.id === "p1")!.hand = [];
    state.players.find((player) => player.id === "p3")!.hand = [];
    state.players.find((player) => player.id === "p4")!.hand = [];
    state.players.find((player) => player.id === "p2")!.hand.push("D01", "D05", "D07");
    state = action(state, "p2", "PLAY_CARD", { cardId: "D01", targetPlayerId: "p3" });
    state.players.find((player) => player.id === "p3")!.hand.push("C02");
    expectActionError(state, "p3", "PLAY_CARD", { cardId: "C02" }, "你本日不能使用锦囊");

    const sellItem = Object.values(state.artifacts)[0]!;
    sellItem.ownerId = "p3";
    sellItem.rumorMin = 100;
    state.players.find((player) => player.id === "p3")!.artifacts.push(sellItem.id);
    state = action(state, "p2", "PLAY_CARD", { cardId: "D05", targetPlayerId: "p3" });
    expectActionError(state, "p3", "SELL_TO_BANK", { artifactId: sellItem.id }, "你本日不能出售给银行");
    expectActionError(state, "p3", "CREATE_TRADE_OFFER", { toPlayerId: "p4", give: { artifactIds: [sellItem.id] }, receive: { cash: 10 } }, "你本日不能进行玩家交易");

    state = startedRoom();
    state.phase = "preview";
    state.currentHostId = "p1";
    state.todayArtifactIds = [Object.values(state.artifacts)[0]!.id];
    state = action(state, "p1", "SET_AUCTION", { mode: "english", startingBid: 0 });
    state.players.find((player) => player.id === "p1")!.hand = [];
    state.players.find((player) => player.id === "p3")!.hand = [];
    state.players.find((player) => player.id === "p4")!.hand = [];
    state.players.find((player) => player.id === "p2")!.hand.push("D07");
    state = action(state, "p2", "PLAY_CARD", { cardId: "D07", targetPlayerId: "p3", targetArtifactId: state.todayArtifactIds[0] });
    state = action(state, "p2", "ADVANCE_PHASE");
    expectActionError(state, "p3", "PLACE_BID", { amount: 80 }, "你本日不能对该藏品出价");

    state = startedRoom();
    state.phase = "freeTrade";
    state.players.find((player) => player.id === "p2")!.hand.push("D06");
    state.players.find((player) => player.id === "p3")!.hand.push("R05");
    state = action(state, "p2", "PLAY_CARD", { cardId: "D06", targetPlayerId: "p3" });
    expectActionError(state, "p3", "RESPOND_REACTION", { reactionId: state.pendingReaction!.id, cardId: "R05", targetPlayerId: "p2", response: "counter" }, "需要转移给另一名玩家");
  });

  it("writes concrete private results for info cards", () => {
    let state = startedRoom();
    const p2 = state.players.find((player) => player.id === "p2")!;
    const targetArtifact = state.todayArtifactIds[0]!;
    state.artifacts[targetArtifact]!.properties = ["prop24"];
    state.artifacts[targetArtifact]!.tag = "anonymous";
    p2.hand.push("I06", "I12");
    state.phase = "cardWindow";
    state.players.find((player) => player.id === "p1")!.cash = 40;
    state.players.find((player) => player.id === "p2")!.cash = 120;
    state.players.find((player) => player.id === "p3")!.cash = 90;
    state.players.find((player) => player.id === "p4")!.cash = 60;

    state = action(state, "p2", "PLAY_CARD", { cardId: "I06", targetArtifactId: targetArtifact });
    expect(state.players.find((player) => player.id === "p2")?.privateLog?.at(-1)).toContain("属性倾向：负面");
    state = action(state, "p2", "PLAY_CARD", { cardId: "I12" });
    expect(state.players.find((player) => player.id === "p2")?.privateLog?.at(-1)).toContain("当前现金排名：1. P2 / 2. P3 / 3. P4 / 4. P1");
  });

  it("restricts event cards to the event window and publishes event outcomes without the user name", () => {
    let state = startedRoom();
    const player = state.players.find((candidate) => candidate.id === "p2")!;
    player.events.push("E04");
    state.phase = "cardWindow";

    expectActionError(state, "p2", "PLAY_CARD", { cardId: "E04" }, "事件卡只能在事件窗口使用");

    state.phase = "eventWindow";
    state = action(state, "p2", "PLAY_CARD", { cardId: "E04" });

    expect(state.players.find((candidate) => candidate.id === "p2")?.privateLog?.at(-1)).toContain("你使用了事件卡《黑市查封》");
    expect(state.log.at(-1)).toBe("今日发生：所有玩家获得 20 银元，下一次黑市每人最多买 1 张。");
    expect(state.log.at(-1)).not.toContain("P2");
    expect(getPlayerView(state, "p3").log.at(-1)).toBe("今日发生：所有玩家获得 20 银元，下一次黑市每人最多买 1 张。");
  });

  it("allows any player to pause and resume the room", () => {
    let state = startedRoom();
    state = action(state, "p2", "SET_PAUSED", { paused: true });

    expect(state.paused).toBe(true);
    expect(state.log.at(-1)).toContain("P2 暂停了房间。");

    state = action(state, "p3", "SET_PAUSED", { paused: false });
    expect(state.paused).toBe(false);
    expect(state.log.at(-1)).toContain("P3 恢复了房间。");
  });

  it("hands off owner and system-hosts the day when the current host disconnects", () => {
    let state = startedRoom();
    state.phase = "preview";
    state.currentHostId = "p1";
    state.hostPlayerId = "p1";

    state = action(state, "p1", "SET_CONNECTED", { connected: false });

    expect(state.hostPlayerId).toBe("p2");
    expect(state.currentHostId).toBeUndefined();
    expect(getPlayerView(state, "p2").canSetAuction).toBe(true);
    expect(getPlayerView(state, "p2").canAdvance).toBe(true);

    state = action(state, "p2", "ADVANCE_PHASE");
    expect(state.phase).toBe("cardWindow");
    expect(["english", "dutch", "sealed", "bundle"]).toContain(state.auction?.mode);
  });

  it("auto-advances offline blockers in auction and reaction windows", () => {
    let state = startedRoom();
    state.phase = "preview";
    state.currentHostId = "p1";
    state = action(state, "p1", "SET_AUCTION", { mode: "english", startingBid: 0 });
    state = action(state, "p2", "ADVANCE_PHASE");
    state = action(state, "p2", "PLACE_BID", { amount: 80 });
    state = action(state, "p3", "SET_CONNECTED", { connected: false });
    state = action(state, "p3", "AUTO_ADVANCE_OFFLINE");
    expect(state.auction?.passedPlayerIds).toContain("p3");
    expectActionError(state, "p4", "AUTO_ADVANCE_OFFLINE", {}, "玩家仍在线");

    state = startedRoom();
    state.phase = "preview";
    state.currentHostId = "p1";
    state = action(state, "p1", "SET_AUCTION", { mode: "sealed", startingBid: 0 });
    state = action(state, "p2", "ADVANCE_PHASE");
    state = action(state, "p3", "SET_CONNECTED", { connected: false });
    state = action(state, "p3", "AUTO_ADVANCE_OFFLINE");
    expect(state.auction?.sealedBids.p3).toBe(0);

    state = startedRoom();
    state.phase = "freeTrade";
    state.players.find((player) => player.id === "p2")!.hand.push("D06");
    state.players.find((player) => player.id === "p3")!.hand.push("R04");
    state.players.find((player) => player.id === "p4")!.hand = [];
    state = action(state, "p2", "PLAY_CARD", { cardId: "D06", targetPlayerId: "p3" });
    state = action(state, "p3", "SET_CONNECTED", { connected: false });
    state = action(state, "p3", "AUTO_ADVANCE_OFFLINE");
    expect(state.pendingReaction).toBeUndefined();
  });
});
