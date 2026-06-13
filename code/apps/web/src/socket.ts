import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, PlayerView, ServerToClientEvents } from "@auctioneer/shared";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const serverUrl = import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);

export function createGameSocket(): GameSocket {
  return io(serverUrl, {
    transports: ["websocket", "polling"],
    autoConnect: true
  });
}

export interface SessionInfo {
  roomId: string;
  playerId: string;
  sessionToken: string;
}

export function saveSession(session: SessionInfo): void {
  localStorage.setItem("auctioneer.session", JSON.stringify(session));
}

export function loadSession(): SessionInfo | undefined {
  const raw = localStorage.getItem("auctioneer.session");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SessionInfo;
  } catch {
    return undefined;
  }
}

export function clearSession(): void {
  localStorage.removeItem("auctioneer.session");
}

export function summarizeView(view?: PlayerView): string {
  if (!view) return JSON.stringify({ mode: "no-room" });
  return JSON.stringify({
    mode: "room",
    room: view.joinCode,
    phase: view.phase,
    day: view.day,
    self: {
      nickname: view.self.nickname,
      cash: view.self.cash,
      loans: view.self.loans,
      role: view.self.role?.name,
      roleName: view.self.roleName,
      roleSkills: view.self.role?.skills.map((skill) => ({ name: skill.name, kind: skill.kind })),
      artifacts: view.self.artifacts.map((artifact) => ({
        name: artifact.name,
        tag: artifact.tagLabel,
        value: artifact.trueValue,
        purchasePrice: artifact.purchasePrice
      })),
      privateLog: view.privateLog.slice(-6)
    },
    players: view.players.map((player) => ({
      nickname: player.nickname,
      ready: player.ready,
      cash: player.cash,
      artifacts: player.artifactCount,
      hand: player.handCount,
      events: player.eventCount,
      roleName: player.roleName,
      isHost: player.isHost,
      passed: player.passed,
      score: player.finalScore?.reputation
    })),
    lastIncomeRolls: view.lastIncomeRolls?.map((roll) => ({
      nickname: roll.nickname,
      roll: roll.roll,
      reroll: roll.reroll,
      amount: roll.amount
    })),
    todayArtifacts: view.todayArtifacts.map((artifact) => ({
      name: artifact.name,
      category: artifact.category,
      rumor: artifact.rumorMin === undefined ? "hidden" : `${artifact.rumorMin}-${artifact.rumorMax}`,
      tag: artifact.tagLabel ?? "hidden"
    })),
    auction: view.auction
      ? {
          mode: view.auction.mode,
          status: view.auction.status,
          currentBid: view.auction.currentBid,
          bidder: view.auction.currentBidderId,
          submitted: view.auction.sealedSubmittedPlayerIds,
          visibleSealedBids: view.auction.visibleSealedBids
        }
      : undefined,
    log: view.log.slice(-3)
  });
}
