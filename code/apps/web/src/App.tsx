import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  Backpack,
  BadgeCheck,
  Banknote,
  BookOpen,
  Check,
  Coins,
  Crown,
  Eye,
  Gavel,
  Handshake,
  History,
  Pause,
  Play,
  RefreshCw,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Timer,
  UserMinus,
  X
} from "lucide-react";
import type { AuctionMode, ClientToServerEvents, EventCard, GamePhase, PhaseTimeouts, PlayerView, PublicArtifactView, RoleSkill, TrickCard } from "@auctioneer/shared";
import { CATEGORY_LABELS, TAG_LABELS } from "@auctioneer/shared";
import { clearSession, createGameSocket, loadSession, saveSession, summarizeView, type GameSocket } from "./socket";

gsap.registerPlugin(useGSAP);

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };
type PlayableCard = TrickCard | EventCard;
type TargetMode = "none" | "player" | "artifact" | "ownedArtifact" | "playerArtifact" | "playerAuctionArtifact" | "playerMission";
type TargetRequest =
  | { kind: "card"; card: PlayableCard; defaultArtifactId?: string }
  | { kind: "role"; skill: RoleSkill };
type AppNotice =
  | { kind: "auction"; id: string; title: string }
  | { kind: "purchase"; id: string; artifacts: PublicArtifactView[] }
  | { kind: "commission"; id: string; message: string };

const phaseLabels: Record<PlayerView["phase"], string> = {
  lobby: "大厅",
  setup: "设置",
  dayIncome: "晨间收入",
  blackMarket: "黑市",
  preview: "预展",
  cardWindow: "锦囊/事件",
  auction: "竞拍",
  settlement: "结算",
  eventWindow: "事件窗口",
  freeTrade: "自由交易",
  finalScoring: "终局"
};

const configurableTimeoutPhases: GamePhase[] = ["dayIncome", "blackMarket", "preview", "cardWindow", "auction", "settlement", "eventWindow", "freeTrade"];

export function App() {
  const appRef = useRef<HTMLElement | null>(null);
  const socketRef = useRef<GameSocket | null>(null);
  const [view, setView] = useState<PlayerView>();
  const [nickname, setNickname] = useState("玩家");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [bidAmount, setBidAmount] = useState(10);
  const [sealedAmount, setSealedAmount] = useState(0);
  const [targetRequest, setTargetRequest] = useState<TargetRequest>();
  const [confirmCard, setConfirmCard] = useState<PlayableCard>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scoreboardOpen, setScoreboardOpen] = useState(false);
  const [backpackOpen, setBackpackOpen] = useState(false);
  const [incomeRollsOpen, setIncomeRollsOpen] = useState(false);
  const [roleRevealOpen, setRoleRevealOpen] = useState(false);
  const [notices, setNotices] = useState<AppNotice[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected" | "recovering" | "failed">("connecting");
  const [now, setNow] = useState(Date.now());
  const seenAuctionNoticeRef = useRef<Set<string>>(new Set());
  const seenArtifactIdsRef = useRef<Set<string> | undefined>(undefined);
  const incomeRollPhaseRef = useRef<GamePhase | undefined>(undefined);
  const previousPrivateLogRef = useRef<string[]>([]);
  const notice = notices[0];
  function enqueueNotice(nextNotice: AppNotice) {
    setNotices((current) => (current.some((item) => item.id === nextNotice.id) ? current : [...current, nextNotice]));
  }
  function closeNotice() {
    setNotices((current) => current.slice(1));
  }

  useEffect(() => {
    const socket = createGameSocket();
    socketRef.current = socket;
    socket.on("room:update", (nextView) => {
      if (nextView.self.kicked) {
        clearSession();
        setView(undefined);
        setConnectionStatus("failed");
        setError("你已被房主移出房间。");
        return;
      }
      setView(nextView);
      setConnectionStatus(socket.connected ? "connected" : "connecting");
      setError("");
    });
    socket.on("room:error", (payload) => {
      if (payload.code === "SESSION_INVALID") {
        clearSession();
        setView(undefined);
        setConnectionStatus("failed");
        setSettingsOpen(false);
      setScoreboardOpen(false);
      setBackpackOpen(false);
      setIncomeRollsOpen(false);
      setRoleRevealOpen(false);
        setTargetRequest(undefined);
        setConfirmCard(undefined);
        setNotices([]);
        setJoinCode("");
      }
      setError(payload.message);
    });
    const resume = () => {
      const session = loadSession();
      if (!session) {
        setConnectionStatus(socket.connected ? "connected" : "connecting");
        return;
      }
      setConnectionStatus("recovering");
      socket.emit("room:resume", session, (response) => {
      if (response.ok) {
        setView(response.view);
        setError("");
        setConnectionStatus("connected");
        } else {
          clearSession();
          setView(undefined);
          setConnectionStatus("failed");
          setError(`恢复失败：${response.error}`);
        }
      });
    };
    socket.on("connect", resume);
    socket.on("disconnect", () => setConnectionStatus("disconnected"));
    socket.on("connect_error", () => setConnectionStatus("failed"));
    if (socket.connected) resume();
    return () => {
      socket.off("connect", resume);
      socket.off("room:error");
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    window.render_game_to_text = () => summarizeView(view);
    window.advanceTime = () => summarizeView(view);
  }, [view]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (view?.phase === "dayIncome" && view.self.role && !localStorage.getItem(`auctioneer.roleReveal.${view.roomId}.${view.selfId}`)) {
      setRoleRevealOpen(true);
      localStorage.setItem(`auctioneer.roleReveal.${view.roomId}.${view.selfId}`, "1");
    }
  }, [view?.phase, view?.roomId, view?.selfId, view?.self.role?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && view) {
        event.preventDefault();
        setScoreboardOpen(true);
        return;
      }
      if (event.key.toLowerCase() === "b" && view && !isTypingTarget(event.target)) {
        event.preventDefault();
        setBackpackOpen(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        setScoreboardOpen(false);
        return;
      }
      if (event.key.toLowerCase() === "b" && !isTypingTarget(event.target)) {
        event.preventDefault();
        setBackpackOpen(false);
      }
    };
    const closeOverlays = () => {
      setScoreboardOpen(false);
      setBackpackOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", closeOverlays);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", closeOverlays);
    };
  }, [view]);

  useEffect(() => {
    if (!view) {
      seenArtifactIdsRef.current = undefined;
      seenAuctionNoticeRef.current = new Set();
      previousPrivateLogRef.current = [];
      setBackpackOpen(false);
      setIncomeRollsOpen(false);
      setNotices([]);
      return;
    }
    seenArtifactIdsRef.current = new Set(view.self.artifacts.map((artifact) => artifact.id));
    seenAuctionNoticeRef.current = new Set();
    previousPrivateLogRef.current = view.privateLog;
    setBackpackOpen(false);
    setIncomeRollsOpen(false);
    setNotices([]);
  }, [view?.roomId, view?.selfId]);

  useEffect(() => {
    if (!view) return;
    const artifactIds = new Set(view.self.artifacts.map((artifact) => artifact.id));
    if (!seenArtifactIdsRef.current) {
      seenArtifactIdsRef.current = artifactIds;
      return;
    }
    const previous = seenArtifactIdsRef.current;
    const newArtifacts = view.self.artifacts.filter((artifact) => !previous.has(artifact.id) && artifact.purchasePrice !== undefined);
    seenArtifactIdsRef.current = artifactIds;
    if (newArtifacts.length === 0) return;
    enqueueNotice({
      kind: "purchase",
      id: `purchase:${view.roomId}:${view.selfId}:${newArtifacts.map((artifact) => artifact.id).join(",")}`,
      artifacts: newArtifacts
    });
  }, [view?.roomId, view?.selfId, view?.self.artifacts]);

  useEffect(() => {
    if (!view?.auction || view.phase !== "cardWindow") return;
    const key = `${view.roomId}:${view.day}:${view.auction.id}:${view.auction.mode}:${view.auction.bundleInnerMode ?? ""}`;
    if (seenAuctionNoticeRef.current.has(key)) return;
    seenAuctionNoticeRef.current.add(key);
    enqueueNotice({
      kind: "auction",
      id: `auction:${key}`,
      title: `今天是${auctionModeLabel(view.auction.mode, view.auction.bundleInnerMode)}拍卖`
    });
  }, [view?.roomId, view?.day, view?.phase, view?.auction?.id, view?.auction?.mode, view?.auction?.bundleInnerMode]);

  useEffect(() => {
    if (!view) return;
    const newItems = appendedLogItems(previousPrivateLogRef.current, view.privateLog);
    previousPrivateLogRef.current = view.privateLog;
    for (const item of newItems) {
      if (!item.includes("作为主持人收到") || !item.includes("佣金")) continue;
      enqueueNotice({
        kind: "commission",
        id: `commission:${view.roomId}:${view.selfId}:${Date.now()}:${Math.random()}`,
        message: item
      });
    }
  }, [view?.roomId, view?.selfId, view?.privateLog]);

  useGSAP(
    () => {
      if (!backpackOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".backpack-panel", { autoAlpha: 0, y: -14, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.2, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [backpackOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!notice || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".notice-modal", { autoAlpha: 0, y: 18, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.24, ease: "back.out(1.35)", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [notice?.id], revertOnUpdate: true }
  );

  useEffect(() => {
    if (scoreboardOpen) setBackpackOpen(false);
  }, [scoreboardOpen]);

  useEffect(() => {
    if (backpackOpen) setScoreboardOpen(false);
  }, [backpackOpen]);

  useEffect(() => {
    if (!view) return;
    setScoreboardOpen(false);
    setBackpackOpen(false);
    setTargetRequest(undefined);
    setConfirmCard(undefined);
  }, [view?.phase, view?.day]);

  useEffect(() => {
    if (!view) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (notice) closeNotice();
      else setBackpackOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [view, notice]);

  const currentArtifact = useMemo(() => {
    if (!view?.auction) return view?.todayArtifacts[0];
    const artifactId = view.auction.artifactIds[view.auction.currentArtifactIndex];
    return view.todayArtifacts.find((artifact) => artifact.id === artifactId);
  }, [view]);
  const incomeRollSignature = useMemo(
    () => view?.lastIncomeRolls?.map((roll) => `${roll.playerId}:${roll.roll}:${roll.reroll ?? ""}:${roll.amount}`).join("|") ?? "",
    [view?.lastIncomeRolls]
  );

  useEffect(() => {
    if (!view || !incomeRollSignature) return;
    incomeRollPhaseRef.current = view.phase;
    setIncomeRollsOpen(true);
    const timer = window.setTimeout(() => setIncomeRollsOpen(false), 3200);
    return () => window.clearTimeout(timer);
  }, [view?.roomId, view?.day, incomeRollSignature]);

  useEffect(() => {
    if (!view || !incomeRollPhaseRef.current) return;
    if (view.phase !== incomeRollPhaseRef.current) setIncomeRollsOpen(false);
  }, [view?.phase, view?.day]);

  useGSAP(
    () => {
      if (!view || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(
        ".motion-panel",
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.32, stagger: 0.035, ease: "power2.out", overwrite: "auto" }
      );
    },
    { scope: appRef, dependencies: [view?.roomId], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!view || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".phase-chip", { scale: 0.98 }, { scale: 1, duration: 0.18, ease: "power1.out", overwrite: "auto" });
      gsap.fromTo(".artifact-card.current", { y: 8, scale: 0.99 }, { y: 0, scale: 1, duration: 0.26, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [view?.phase, view?.day], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!scoreboardOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".scoreboard-panel", { autoAlpha: 0, y: -18, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.18, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [scoreboardOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!roleRevealOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".role-reveal-modal", { autoAlpha: 0, y: 18, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: "back.out(1.4)", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [roleRevealOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!incomeRollsOpen || !view?.lastIncomeRolls?.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".dice-card", { autoAlpha: 0, y: -8, rotation: -10 }, { autoAlpha: 1, y: 0, rotation: 0, duration: 0.34, stagger: 0.05, ease: "back.out(1.8)", overwrite: "auto" });
      gsap.fromTo(".dice-face", { rotation: -180, scale: 0.72 }, { rotation: 0, scale: 1, duration: 0.5, stagger: 0.04, ease: "elastic.out(1, 0.55)", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [incomeRollSignature, incomeRollsOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!view || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(".public-log-list p:first-child", { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.2, ease: "power2.out", overwrite: "auto" });
      gsap.fromTo(".mini-card", { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.22, stagger: 0.02, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [view?.log.at(-1), view?.self.hand.length, view?.self.events.length], revertOnUpdate: true }
  );

  const call = <T,>(event: keyof ClientToServerEvents, payload: unknown) => {
    const socket = socketRef.current;
    if (!socket) return;
    setError("");
    (socket.emit as unknown as (
      event: string,
      payload: unknown,
      ack: (response: Ack<T & { view?: PlayerView; sessionToken?: string }>) => void
    ) => void)(event, payload, (response) => {
      if (!response.ok) {
        setError(response.error);
        return;
      }
      if (response.view) {
        setView(response.view);
        setConnectionStatus(socket.connected ? "connected" : "connecting");
        setError("");
      }
      if (response.sessionToken && response.view) {
        saveSession({
          roomId: response.view.roomId,
          playerId: response.view.selfId,
          sessionToken: response.sessionToken
        });
      }
    });
  };

  const createRoom = () => call<{ view: PlayerView; sessionToken: string }>("room:create", { nickname });
  const joinRoom = () => call<{ view: PlayerView; sessionToken: string }>("room:join", { nickname, joinCode });
  const resetSession = () => {
    clearSession();
    setView(undefined);
    setError("");
    setConnectionStatus(socketRef.current?.connected ? "connected" : "connecting");
  };
  const updateJoinCode = (value: string) => setJoinCode(value.replace(/\D/g, "").slice(0, 4));

  if (!view) {
    return (
      <main className="entry-screen">
        <section className="entry-panel">
          <div>
            <p className="eyebrow">Online MVP</p>
            <h1>拍卖师法则</h1>
            <p className="intro">实时好友房，轮流主持、竞拍奇珍、终局翻牌。</p>
          </div>
          <label>
            昵称
            <input value={nickname} maxLength={16} onChange={(event) => setNickname(event.target.value)} />
          </label>
          <div className="entry-actions">
            <button className="primary" onClick={createRoom}>
              <Gavel size={18} /> 创建房间
            </button>
          </div>
          <div className="join-row">
            <input
              placeholder="4位房间码"
              inputMode="numeric"
              maxLength={4}
              value={joinCode}
              onChange={(event) => updateJoinCode(event.target.value)}
            />
            <button onClick={joinRoom}>
              <Play size={18} /> 加入
            </button>
          </div>
          {connectionStatus === "recovering" && <p className="status-text">正在恢复上一局...</p>}
          {connectionStatus === "disconnected" && <p className="status-text">连接已断开，正在等待重连。</p>}
          {connectionStatus === "failed" && <button onClick={resetSession}>清除旧会话</button>}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${view.paused ? "is-paused" : ""}`} ref={appRef}>
      <header className="topbar motion-panel">
        <div className="room-code">
          <span>房间码</span>
          <strong>{view.joinCode}</strong>
        </div>
        <div className="phase-chip">
          <strong>游戏天数</strong>
          <span>第 {view.day || 0}/{view.maxDays} 天</span>
        </div>
        <PhaseTimer view={view} now={now} />
        <div className="host-chip">
          <span>主持</span>
          <strong>{view.players.find((player) => player.id === view.currentHostId)?.nickname ?? "系统"}</strong>
        </div>
        {connectionStatus !== "connected" && <div className={`connection-pill ${connectionStatus}`}>{connectionLabel(connectionStatus)}</div>}
        <div className="top-actions">
          {view.phase === "lobby" && (
            <>
              <button onClick={() => call("player:ready", { ready: !view.self.ready })}>
                <Check size={18} /> {view.self.ready ? "取消准备" : "准备"}
              </button>
              <button className="primary" disabled={!view.canStart} onClick={() => call("room:start", {})}>
                <Play size={18} /> 开始
              </button>
            </>
          )}
          {view.canAdvance && (
            <button className="primary" onClick={() => call("phase:advance", {})}>
              <RefreshCw size={18} /> 推进阶段
            </button>
          )}
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="设置">
            <Settings size={18} />
          </button>
        </div>
      </header>

      <section className="play-screen">
        <aside className="left-rail motion-panel">
          <RoleSkillsPanel view={view} call={call} openTargetRequest={setTargetRequest} />
          <LogPanel title="我的操作" icon={<History size={16} />} log={view.privateLog} emptyText="还没有私密操作。" />
        </aside>

        <section className="table-zone motion-panel">
          {view.paused && <div className="pause-banner"><Pause size={18} /> 房间已暂停</div>}
          {error && <div className="error-bar">{error}</div>}
          <ControlPanel
            view={view}
            bidAmount={bidAmount}
            sealedAmount={sealedAmount}
            setBidAmount={setBidAmount}
            setSealedAmount={setSealedAmount}
            call={call}
          />
          <DiceRollPanel view={view} visible={incomeRollsOpen} />
          <ArtifactBoard artifacts={view.todayArtifacts} currentArtifact={currentArtifact} />
          <PublicPool view={view} currentArtifact={currentArtifact} />
          <ActiveEffectsPanel view={view} />
          <AutomationNotice view={view} now={now} />
        </section>

        <aside className="right-rail motion-panel">
          <SelfPanel
            view={view}
            currentArtifact={currentArtifact}
            call={call}
            openTargetRequest={setTargetRequest}
            openConfirmCard={setConfirmCard}
          />
        </aside>
      </section>

      {scoreboardOpen && <ScoreboardOverlay view={view} />}
      {backpackOpen && <BackpackOverlay view={view} call={call} onClose={() => setBackpackOpen(false)} />}
      <TradeOfferModal view={view} call={call} />
      {notice && <NoticeModal notice={notice} onClose={closeNotice} />}
      {roleRevealOpen && <RoleRevealModal view={view} onClose={() => setRoleRevealOpen(false)} />}
      {settingsOpen && <SettingsModal view={view} call={call} onClose={() => setSettingsOpen(false)} />}
      {confirmCard && (
        <CardConfirmModal
          card={confirmCard}
          onClose={() => setConfirmCard(undefined)}
          onConfirm={() => {
            const cardId = confirmCard.id;
            setConfirmCard(undefined);
            call("card:play", { cardId });
          }}
        />
      )}
      {targetRequest && (
        <TargetModal
          view={view}
          request={targetRequest}
          currentArtifact={currentArtifact}
          onClose={() => setTargetRequest(undefined)}
          onConfirm={(event, payload) => {
            setTargetRequest(undefined);
            call(event, payload);
          }}
        />
      )}
    </main>
  );
}

function PhaseTimer({ view, now }: { view: PlayerView; now: number }) {
  if (!view.phaseDeadlineAt || !view.phaseTimeoutMs) return null;
  const remainingMs = Math.max(0, view.phaseDeadlineAt - now);
  const totalMs = Math.max(1, view.phaseTimeoutMs);
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  return (
    <div className={`timer-pill ${remainingMs <= 10_000 ? "urgent" : ""}`}>
      <div>
        <Timer size={16} />
        <strong>{formatRemaining(remainingMs)}</strong>
      </div>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function RoomAdminPanel({ view, call }: { view: PlayerView; call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void }) {
  const [targetId, setTargetId] = useState(view.players.find((player) => player.id !== view.selfId)?.id ?? "");
  const [timeoutSecondsByPhase, setTimeoutSecondsByPhase] = useState<Record<string, number>>(() => timeoutSecondsFromView(view));
  const target = targetId || view.players.find((player) => player.id !== view.selfId)?.id || "";

  useEffect(() => {
    setTimeoutSecondsByPhase(timeoutSecondsFromView(view));
  }, [view.phaseTimeouts]);

  const updateTimeout = (phase: GamePhase, value: number) => {
    setTimeoutSecondsByPhase((current) => ({ ...current, [phase]: Number.isFinite(value) ? value : 0 }));
  };
  const timeoutPayload: PhaseTimeouts = Object.fromEntries(
    configurableTimeoutPhases.map((phase) => [phase, Math.max(0, Math.floor(timeoutSecondsByPhase[phase] ?? 0)) * 1000])
  ) as PhaseTimeouts;

  return (
    <div className="panel admin-panel">
      <h3>房主管理</h3>
      <label>
        目标玩家
        <select value={target} onChange={(event) => setTargetId(event.target.value)}>
          {view.players
            .filter((player) => player.id !== view.selfId)
            .map((player) => (
              <option key={player.id} value={player.id}>
                {player.nickname}{player.connected ? "" : "（离线）"}
              </option>
            ))}
        </select>
      </label>
      <div className="admin-actions">
        <button disabled={!target} onClick={() => call("room:transferOwner", { playerId: target })}>
          <Crown size={18} /> 转让
        </button>
        <button disabled={!target} onClick={() => call("room:kick", { playerId: target })}>
          <UserMinus size={18} /> 踢出
        </button>
      </div>
      <div className="timeout-grid">
        {configurableTimeoutPhases.map((phase) => (
          <label key={phase}>
            {phaseLabels[phase]}
            <input
              type="number"
              min={0}
              max={1800}
              step={10}
              value={timeoutSecondsByPhase[phase] ?? 0}
              onChange={(event) => updateTimeout(phase, Number(event.target.value))}
            />
          </label>
        ))}
      </div>
      <button onClick={() => call("room:setTimeouts", { timeouts: timeoutPayload })}>
        <Timer size={18} /> 应用阶段配置
      </button>
    </div>
  );
}

function timeoutSecondsFromView(view: PlayerView): Record<string, number> {
  return Object.fromEntries(
    configurableTimeoutPhases.map((phase) => {
      const ms = view.phaseTimeouts?.[phase] ?? (phase === "freeTrade" ? 180_000 : phase === "settlement" || phase === "eventWindow" ? 90_000 : 120_000);
      return [phase, Math.round(ms / 1000)];
    })
  );
}

function AutomationNotice({ view, now }: { view: PlayerView; now: number }) {
  const automated = view.players.filter((player) => player.id !== view.selfId && player.automatedAt && now - player.automatedAt < 60_000);
  const selfAutomated = view.self.automatedAt && now - view.self.automatedAt < 60_000 ? view.self : undefined;
  if (automated.length === 0 && !selfAutomated) return null;
  return (
    <section className="panel automation-panel">
      <h3>托管提示</h3>
      {selfAutomated && <p>你离线期间系统已托管：{selfAutomated.automatedReason ?? "自动操作"}。</p>}
      {automated.map((player) => (
        <p key={player.id}>{player.nickname} 已由系统托管：{player.automatedReason ?? "自动操作"}。</p>
      ))}
    </section>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function connectionLabel(status: "connecting" | "connected" | "disconnected" | "recovering" | "failed"): string {
  if (status === "connecting") return "正在连接";
  if (status === "recovering") return "正在恢复";
  if (status === "disconnected") return "连接断开";
  if (status === "failed") return "连接异常";
  return "已连接";
}

function ActiveEffectsPanel({ view }: { view: PlayerView }) {
  if (view.activeEffects.length === 0) return null;
  return (
    <section className="panel effects-panel">
      <h3>生效效果</h3>
      {view.activeEffects.map((effect) => (
        <p key={effect.id}>{effect.label}</p>
      ))}
    </section>
  );
}

function PlayerList({ view }: { view: PlayerView }) {
  return (
    <div className="panel">
      <h3>玩家</h3>
      <div className="player-list">
        {view.players.map((player) => (
          <div className="player-row" key={player.id}>
            <div>
              <strong>{player.nickname}</strong>
              <span>{playerStatusLabel(player)}</span>
            </div>
            <div className="player-stats">
              <span><Coins size={14} /> {player.cash}</span>
              <span><Scale size={14} /> {player.artifactCount}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreboardOverlay({ view }: { view: PlayerView }) {
  const sorted = [...view.players].sort((a, b) => (a.id === view.selfId ? -1 : b.id === view.selfId ? 1 : a.seat - b.seat));
  const missions = view.self.missions.length ? view.self.missions : view.self.mission ? [view.self.mission] : [];
  return (
    <div className="scoreboard-layer" aria-label="玩家信息">
      <section className="scoreboard-panel">
        <header>
          <div>
            <p className="eyebrow">Tab</p>
            <h3>玩家信息</h3>
          </div>
          <span>松开 Tab 关闭</span>
        </header>
        <div className="scoreboard-grid">
          {sorted.map((player) => (
            <article className={`scoreboard-row ${player.id === view.selfId ? "self" : ""}`} key={player.id}>
              <div>
                <strong>{player.nickname}{player.id === view.selfId ? " · 你" : ""}</strong>
                <span>{player.roleName ?? "未分配角色"}</span>
              </div>
              <span>{playerStatusLabel(player)}</span>
              <span><Coins size={15} /> {player.cash}</span>
              <span><Scale size={15} /> {player.artifactCount}</span>
              <span><ScrollText size={15} /> {player.handCount}</span>
              <span><BookOpen size={15} /> {player.eventCount}</span>
            </article>
          ))}
        </div>
        <section className="scoreboard-missions" aria-label="我的秘密委托">
          <header>
            <p className="eyebrow">我的秘密委托</p>
            <span>仅自己可见</span>
          </header>
          <div className="mission-strip">
            {missions.length === 0 && <p className="empty-text">开局后会显示你的委托。</p>}
            {missions.map((mission) => (
              <article className="mission-item compact" key={mission.id}>
                <p>{mission.name}</p>
                <strong className="mission-reward">完成奖励 +{mission.reputation} 声望</strong>
                <small>{mission.description}</small>
              </article>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function RoleRevealModal({ view, onClose }: { view: PlayerView; onClose: () => void }) {
  const role = view.self.role;
  if (!role) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal role-reveal-modal" role="dialog" aria-modal="true" aria-label="角色揭示">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">角色揭示</p>
            <h3>恭喜你抽到了 {role.name}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="role-reveal-body">
          {role.skills.map((skill) => (
            <div className="mini-card" key={skill.id}>
              <strong>{skill.name} · {skill.kind}</strong>
              <span>{skill.effectText}</span>
            </div>
          ))}
        </div>
        <footer className="target-actions">
          <button className="primary" onClick={onClose}>
            <Check size={18} /> 知道了
          </button>
        </footer>
      </section>
    </div>
  );
}

function RoleSkillsPanel({
  view,
  call,
  openTargetRequest
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  openTargetRequest: (request: TargetRequest) => void;
}) {
  const role = view.self.role;
  return (
    <section className="panel role-skill-panel">
      <div>
        <p className="eyebrow">角色</p>
        <h3>{role?.name ?? view.self.roleName ?? "未分配角色"}</h3>
      </div>
      {role ? (
        <div className="role-skill-grid">
          {role.skills.map((skill) => (
            <article className="role-skill-card" key={skill.id}>
              <strong>{skill.name} · {skill.kind}</strong>
              <span>{skill.effectText}</span>
              {skill.kind === "主动" && (
                <button
                  data-target-mode={targetModeForRoleSkill(skill.id)}
                  disabled={!canUseRoleSkillFromView(view, skill)}
                  onClick={() =>
                    targetModeForRoleSkill(skill.id) === "none"
                      ? call("role:skill", { skillId: skill.id })
                      : openTargetRequest({ kind: "role", skill })
                  }
                >
                  <Eye size={18} /> 使用
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-text">开局后会显示你的角色和技能。</p>
      )}
    </section>
  );
}

function playerStatusLabel(player: PlayerView["players"][number]): string {
  if (player.kicked) return "已移出";
  const role = player.isHost ? "主持人" : player.ready ? "已准备" : "等待";
  return player.connected ? role : `${role} · 离线`;
}

function ControlPanel({
  view,
  bidAmount,
  sealedAmount,
  setBidAmount,
  setSealedAmount,
  call
}: {
  view: PlayerView;
  bidAmount: number;
  sealedAmount: number;
  setBidAmount: (value: number) => void;
  setSealedAmount: (value: number) => void;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
}) {
  if (view.phase === "finalScoring") return <FinalScores view={view} />;
  const auctionBidMode = view.auction?.mode === "bundle" ? view.auction.bundleInnerMode ?? "english" : view.auction?.mode;

  return (
    <section className="panel action-panel">
      <div>
        <p className="eyebrow">行动</p>
        <h3>{view.lastMessage ?? "等待玩家操作"}</h3>
      </div>

      {view.pendingReaction && (
        <div className="reaction-strip">
          <strong>反制窗口已打开</strong>
          <button className="primary" onClick={() => call("reaction:respond", { reactionId: view.pendingReaction?.id, response: "counter" })}>
            <ShieldCheck size={18} /> 反制
          </button>
          <button onClick={() => call("reaction:respond", { reactionId: view.pendingReaction?.id, response: "pass" })}>
            <X size={18} /> 放弃
          </button>
        </div>
      )}

      {view.phase === "blackMarket" && (
        <div className="button-grid">
          <button onClick={() => call("blackMarket:buy", { kind: "trick" })}>
            <ShoppingBag size={18} /> 买锦囊 30
          </button>
          <button onClick={() => call("blackMarket:buy", { kind: "event" })}>
            <ShoppingBag size={18} /> 买事件 50
          </button>
        </div>
      )}

      {view.phase === "preview" && (
        <div className="hint-strip">
          <Gavel size={18} />
          <span>推进后系统会随机生成今日拍卖方式。</span>
        </div>
      )}

      {(view.phase === "cardWindow" || view.phase === "eventWindow") && (
        <div className="hint-strip">
          <ShieldCheck size={18} />
          <span>可在右侧锦囊/事件卡区选择手牌，确认后再使用。</span>
        </div>
      )}

      {view.phase === "auction" && auctionBidMode === "english" && (
        <div className="auction-controls">
          <strong>当前价：{view.auction?.currentBid ?? 0}</strong>
          <input type="number" value={bidAmount} onChange={(event) => setBidAmount(Number(event.target.value))} />
          <button className="primary" onClick={() => call("bid:place", { amount: bidAmount })}>
            <Gavel size={18} /> 出价
          </button>
          <button onClick={() => call("bid:pass", {})}>退出</button>
        </div>
      )}

      {view.phase === "auction" && auctionBidMode === "dutch" && (
        <div className="auction-controls">
          <strong>当前荷兰价：{view.auction?.dutch?.currentPrice ?? view.auction?.currentBid ?? 0}</strong>
          <button className="primary" onClick={() => call("dutch:stop", {})}>
            <Gavel size={18} /> 喊停
          </button>
        </div>
      )}

      {view.phase === "auction" && auctionBidMode === "sealed" && (
        <div className="auction-controls">
          <strong>暗标已提交：{view.auction?.sealedSubmittedPlayerIds.length ?? 0}</strong>
          {view.auction?.visibleSealedBids && (
            <small>{Object.entries(view.auction.visibleSealedBids).map(([playerId, amount]) => `${view.players.find((player) => player.id === playerId)?.nickname ?? playerId}:${amount}`).join(" / ")}</small>
          )}
          <input type="number" value={sealedAmount} onChange={(event) => setSealedAmount(Number(event.target.value))} />
          <button className="primary" onClick={() => call("sealedBid:submit", { amount: sealedAmount })}>
            <BadgeCheck size={18} /> 提交暗标
          </button>
        </div>
      )}

      {view.phase === "freeTrade" && <TradePanel view={view} call={call} />}
    </section>
  );
}

function DiceRollPanel({ view, visible }: { view: PlayerView; visible: boolean }) {
  const rolls = view.lastIncomeRolls;
  if (!visible || !rolls?.length) return null;
  return (
    <section className="panel dice-panel" aria-label="晨间掷骰结果">
      <div>
        <p className="eyebrow">晨间收入</p>
        <h3>掷骰结果</h3>
      </div>
      <div className="dice-grid">
        {rolls.map((roll) => (
          <article className={`dice-card ${roll.playerId === view.selfId ? "self" : ""}`} key={roll.playerId}>
            <DiceFace value={roll.roll} />
            <div>
              <strong>{roll.nickname}</strong>
              <span>{roll.reroll === undefined ? `掷出 ${roll.roll}` : `初掷 ${roll.roll}，重掷 ${roll.reroll}，取高`}</span>
              <b>+{roll.amount} 银元</b>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DiceFace({ value }: { value: number }) {
  const dots = diceDots[Math.max(1, Math.min(6, value))] ?? diceDots[1]!;
  return (
    <span className="dice-face" aria-label={`${value} 点`}>
      {dots.map((dot) => (
        <i key={dot} className={`dot dot-${dot}`} />
      ))}
    </span>
  );
}

const diceDots: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9]
};

function ArtifactBoard({ artifacts, currentArtifact }: { artifacts: PublicArtifactView[]; currentArtifact?: PublicArtifactView }) {
  return (
    <section className="artifact-grid">
      {artifacts.map((artifact) => (
        <article className={`artifact-card ${artifact.id === currentArtifact?.id ? "current" : ""}`} key={artifact.id}>
          <span>{artifact.series ?? "未知系列"}</span>
          <h3>{artifact.name}</h3>
          <p>{artifact.category ? CATEGORY_LABELS[artifact.category] : "类别隐藏"}</p>
          <p>{artifact.rumorMin === undefined ? "传闻区间隐藏" : `${artifact.rumorMin} - ${artifact.rumorMax} 银元`}</p>
          <p>到手价（成交价）：{artifact.purchasePrice ?? "未成交"}{artifact.purchasePrice === undefined ? "" : " 银元"}</p>
          <p>{artifact.tag ? TAG_LABELS[artifact.tag] : "标签隐藏"}</p>
          {artifact.story && <small>{artifact.story}</small>}
        </article>
      ))}
    </section>
  );
}

function TradePanel({ view, call }: { view: PlayerView; call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void }) {
  const otherPlayers = view.players.filter((player) => player.id !== view.selfId);
  const [targetId, setTargetId] = useState("");
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState(0);
  const [artifactId, setArtifactId] = useState("");
  const targetPlayerId = targetId || otherPlayers[0]?.id;
  const selectedTarget = view.players.find((player) => player.id === targetPlayerId);
  const artifactOptions = mode === "buy" ? selectedTarget?.artifacts ?? [] : view.self.artifacts;
  const selectedArtifactId = artifactOptions.some((artifact) => artifact.id === artifactId) ? artifactId : artifactOptions[0]?.id ?? "";
  const nameOf = (playerId: string) => view.players.find((player) => player.id === playerId)?.nickname ?? "玩家";

  useEffect(() => {
    setArtifactId((current) => (artifactOptions.some((artifact) => artifact.id === current) ? current : artifactOptions[0]?.id ?? ""));
  }, [mode, targetPlayerId, artifactOptions]);

  return (
    <div className="trade-panel">
      <div className="trade-builder">
        <label className="trade-step-card">
          1. 选择玩家
          <select value={targetPlayerId ?? ""} onChange={(event) => setTargetId(event.target.value)}>
            {otherPlayers.map((player) => (
              <option key={player.id} value={player.id}>{player.nickname}</option>
            ))}
          </select>
        </label>
        <div className="trade-step-card">
          <span>2. 交易方向</span>
          <div className="segmented-control">
            <button className={mode === "buy" ? "selected" : ""} onClick={() => setMode("buy")}>买入</button>
            <button className={mode === "sell" ? "selected" : ""} onClick={() => setMode("sell")}>卖出</button>
          </div>
        </div>
        <label className="trade-step-card">
          3. 选择商品
          <select value={selectedArtifactId} onChange={(event) => setArtifactId(event.target.value)}>
            {artifactOptions.length === 0 && <option value="">没有可交易藏品</option>}
            {artifactOptions.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>{artifact.name}</option>
            ))}
          </select>
        </label>
        <label className="trade-step-card">
          4. 输入价格
          <input type="number" min={0} value={price} onChange={(event) => setPrice(Number(event.target.value))} />
        </label>
        <button
          className="primary"
          disabled={!targetPlayerId || !selectedArtifactId || price <= 0}
          onClick={() =>
            call("trade:offer", {
              toPlayerId: targetPlayerId,
              give: mode === "buy" ? { cash: price } : { artifactIds: [selectedArtifactId] },
              receive: mode === "buy" ? { artifactIds: [selectedArtifactId] } : { cash: price },
              message: mode === "buy" ? "buy" : "sell"
            })
          }
        >
          <Handshake size={18} /> 发起交易
        </button>
      </div>
      {view.tradeOffers.length > 0 && (
        <div className="trade-list">
          {view.tradeOffers.map((offer) => (
            <div className="trade-offer" key={offer.id}>
              <strong>{nameOf(offer.fromPlayerId)} → {nameOf(offer.toPlayerId)}</strong>
              <span>
                给 {formatTradeAssets(offer.give, view)} / 要 {formatTradeAssets(offer.receive, view)} · {tradeStatusLabel(offer.status)}
              </span>
              {offer.status === "pending" && offer.toPlayerId === view.selfId && (
                <div className="trade-actions">
                  <button className="primary" onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: true, version: offer.version })}>
                    <Check size={18} /> 接受
                  </button>
                  <button onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: false, version: offer.version })}>
                    <X size={18} /> 拒绝
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TradeOfferModal({ view, call }: { view: PlayerView; call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void }) {
  const offer = view.tradeOffers.find((candidate) => candidate.status === "pending" && candidate.toPlayerId === view.selfId);
  if (!offer) return null;
  const fromName = view.players.find((player) => player.id === offer.fromPlayerId)?.nickname ?? "玩家";
  return (
    <div className="modal-backdrop trade-offer-backdrop" role="presentation">
      <section className="target-modal compact-modal trade-offer-modal" role="dialog" aria-modal="true" aria-label="交易请求">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">交易请求</p>
            <h3>{fromName} 发来交易</h3>
          </div>
        </header>
        <div className="trade-offer-detail">
          <p>对方给你：<strong>{formatTradeAssets(offer.give, view)}</strong></p>
          <p>对方想要：<strong>{formatTradeAssets(offer.receive, view)}</strong></p>
        </div>
        <footer className="target-actions">
          <button onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: false, version: offer.version })}>
            <X size={18} /> 拒绝
          </button>
          <button className="primary" onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: true, version: offer.version })}>
            <Check size={18} /> 同意
          </button>
        </footer>
      </section>
    </div>
  );
}

function TargetModal({
  view,
  request,
  currentArtifact,
  onClose,
  onConfirm
}: {
  view: PlayerView;
  request: TargetRequest;
  currentArtifact?: PublicArtifactView;
  onClose: () => void;
  onConfirm: (event: keyof ClientToServerEvents, payload: unknown) => void;
}) {
  const mode = request.kind === "card" ? targetModeForCard(request.card) : targetModeForRoleSkill(request.skill.id);
  const otherPlayers = view.players.filter((player) => player.id !== view.selfId);
  const [targetPlayerId, setTargetPlayerId] = useState(otherPlayers[0]?.id ?? "");
  const artifactOptions = artifactTargetsFor(view, mode, request.kind === "card" ? request.defaultArtifactId : currentArtifact?.id, targetPlayerId);
  const [targetArtifactId, setTargetArtifactId] = useState(artifactOptions[0]?.id ?? "");
  const missions = missionTargetsFor(view, targetPlayerId);
  const [targetMissionId, setTargetMissionId] = useState(missions[0]?.id ?? "");
  const [invalidateMission, setInvalidateMission] = useState(false);

  useEffect(() => {
    setTargetPlayerId((current) => current || otherPlayers[0]?.id || "");
  }, [otherPlayers]);

  useEffect(() => {
    setTargetArtifactId((current) => (artifactOptions.some((artifact) => artifact.id === current) ? current : artifactOptions[0]?.id ?? ""));
  }, [artifactOptions]);

  useEffect(() => {
    setTargetMissionId((current) => (missions.some((mission) => mission.id === current) ? current : missions[0]?.id ?? ""));
  }, [missions]);

  const title = request.kind === "card" ? request.card.name : request.skill.name;
  const needsPlayer = mode === "player" || mode === "playerArtifact" || mode === "playerAuctionArtifact" || mode === "playerMission";
  const needsArtifact = mode === "artifact" || mode === "ownedArtifact" || mode === "playerArtifact" || mode === "playerAuctionArtifact";
  const needsMission = mode === "playerMission";
  const canConfirm = (!needsPlayer || Boolean(targetPlayerId)) && (!needsArtifact || Boolean(targetArtifactId));
  const confirm = () => {
    if (!canConfirm) return;
    if (request.kind === "card") {
      onConfirm("card:play", {
        cardId: request.card.id,
        targetPlayerId: needsPlayer ? targetPlayerId : undefined,
        targetArtifactId: needsArtifact ? targetArtifactId : undefined
      });
      return;
    }
    onConfirm("role:skill", {
      skillId: request.skill.id,
      targetPlayerId: needsPlayer ? targetPlayerId : undefined,
      targetArtifactId: needsArtifact ? targetArtifactId : undefined,
      targetMissionId: needsMission && targetMissionId ? targetMissionId : undefined,
      invalidateMission: request.skill.id === "role06_skill03" ? invalidateMission : undefined
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal" role="dialog" aria-modal="true" aria-label={`选择目标 ${title}`}>
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">选择目标</p>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="target-grid">
          {needsPlayer && (
            <label>
              目标玩家
              <select value={targetPlayerId} onChange={(event) => setTargetPlayerId(event.target.value)}>
                {otherPlayers.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.nickname}
                  </option>
                ))}
              </select>
            </label>
          )}

          {needsArtifact && (
            <label>
              目标藏品
              <select value={targetArtifactId} onChange={(event) => setTargetArtifactId(event.target.value)}>
                {artifactOptions.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {artifact.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {request.kind === "role" && request.skill.id === "role06_skill03" && (
            <label>
              黑料处理
              <select value={invalidateMission ? "invalidate" : "view"} onChange={(event) => setInvalidateMission(event.target.value === "invalidate")}>
                <option value="view">只查看</option>
                <option value="invalidate">公开作废</option>
              </select>
            </label>
          )}

          {needsMission && invalidateMission && (
            <label>
              目标委托
              <select value={targetMissionId} onChange={(event) => setTargetMissionId(event.target.value)}>
                {missions.map((mission) => (
                  <option key={mission.id} value={mission.id}>
                    {mission.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {needsArtifact && artifactOptions.length === 0 && <p className="target-empty">没有可选藏品。</p>}
        {needsPlayer && otherPlayers.length === 0 && <p className="target-empty">没有可选玩家。</p>}
        {needsMission && invalidateMission && missions.length === 0 && <p className="target-empty">当前没有已知委托可选。</p>}

        <footer className="target-actions">
          <button onClick={onClose}>
            <X size={18} /> 取消
          </button>
          <button className="primary" disabled={!canConfirm} onClick={confirm}>
            <Check size={18} /> 确认
          </button>
        </footer>
      </section>
    </div>
  );
}

function SelfPanel({
  view,
  currentArtifact,
  call,
  openTargetRequest,
  openConfirmCard
}: {
  view: PlayerView;
  currentArtifact?: PublicArtifactView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  openTargetRequest: (request: TargetRequest) => void;
  openConfirmCard: (card: PlayableCard) => void;
}) {
  const playCard = (card: PlayableCard) => {
    if (targetModeForCard(card) === "none") openConfirmCard(card);
    else openTargetRequest({ kind: "card", card, defaultArtifactId: currentArtifact?.id });
  };

  return (
    <>
      <div className="panel card-command-panel">
        <div className="card-command-head">
          <h3>手牌</h3>
          <div className="resource-stack">
            <span><Coins size={15} /> {view.self.cash}</span>
            <span><Banknote size={15} /> {view.self.loans}</span>
            <span><Backpack size={15} /> B</span>
          </div>
        </div>
        <div className="button-grid compact-actions">
          <button onClick={() => call("loan:take", {})}>
            <Banknote size={18} /> 借 100
          </button>
          <button disabled={view.self.loans <= 0} onClick={() => call("loan:repay", {})}>
            <Check size={18} /> 还 120
          </button>
        </div>
      </div>
      <div className="panel card-list">
        <h3>锦囊</h3>
        {view.self.hand.length === 0 && <p className="empty-text">暂无锦囊。</p>}
        {view.self.hand.map((card, index) => (
          <div className="mini-card" key={`${card.id}-${index}`}>
            <strong>{card.name}</strong>
            <span>{card.description}</span>
            <button data-target-mode={targetModeForCard(card)} disabled={!canUseCardFromView(view, card)} onClick={() => playCard(card)}>
              <Eye size={18} /> 使用
            </button>
          </div>
        ))}
      </div>
      <div className="panel card-list">
        <h3>事件卡</h3>
        {view.self.events.length === 0 && <p className="empty-text">暂无事件卡。</p>}
        {view.self.events.map((card, index) => (
          <div className="mini-card event-card" key={`${card.id}-${index}`}>
            <strong>{card.name}</strong>
            <span>{card.description}</span>
            <button data-target-mode={targetModeForCard(card)} disabled={!canUseCardFromView(view, card)} onClick={() => playCard(card)}>
              <Eye size={18} /> 使用
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function NoticeModal({ notice, onClose }: { notice: AppNotice; onClose: () => void }) {
  if (notice.kind === "auction") {
    return (
      <div className="modal-backdrop notice-backdrop" role="presentation">
        <section className="target-modal compact-modal notice-modal auction-mode-modal" role="dialog" aria-modal="true" aria-label="今日拍卖方式">
          <header className="target-modal-header">
            <div>
              <p className="eyebrow">今日拍卖</p>
              <h3>{notice.title}</h3>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>
          <p className="notice-copy">拍卖方式由系统随机生成，本日主持人不能手动选择。</p>
          <footer className="target-actions">
            <button className="primary" onClick={onClose}>
              <Check size={18} /> 知道了
            </button>
          </footer>
        </section>
      </div>
    );
  }

  if (notice.kind === "commission") {
    return (
      <div className="modal-backdrop notice-backdrop" role="presentation">
        <section className="target-modal compact-modal notice-modal commission-modal" role="dialog" aria-modal="true" aria-label="主持佣金">
          <header className="target-modal-header">
            <div>
              <p className="eyebrow">主持收益</p>
              <h3>佣金到账</h3>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>
          <p className="notice-copy">{notice.message}</p>
          <footer className="target-actions">
            <button className="primary" onClick={onClose}>
              <Check size={18} /> 收到
            </button>
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-backdrop notice-backdrop" role="presentation">
      <section className="target-modal purchase-modal notice-modal" role="dialog" aria-modal="true" aria-label="成交结果">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">成交</p>
            <h3>恭喜你买到了 {notice.artifacts.map((artifact) => `《${artifact.name}》`).join("、")}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="purchase-grid">
          {notice.artifacts.map((artifact) => (
            <ArtifactDetailCard artifact={artifact} compact={false} key={artifact.id} />
          ))}
        </div>
        <footer className="target-actions">
          <button className="primary" onClick={onClose}>
            <Check size={18} /> 知道了
          </button>
        </footer>
      </section>
    </div>
  );
}

function BackpackOverlay({
  view,
  call,
  onClose
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  onClose: () => void;
}) {
  return (
    <div className="backpack-layer" aria-label="我的背包">
      <section className="backpack-panel">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">B 背包</p>
            <h3>我的藏品</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {view.self.artifacts.length === 0 ? (
          <p className="empty-text">你还没有买到藏品。</p>
        ) : (
          <div className="backpack-grid">
            {view.self.artifacts.map((artifact) => (
              <div className="backpack-item" key={artifact.id}>
                <ArtifactDetailCard artifact={artifact} compact />
                <button onClick={() => call("bank:sell", { artifactId: artifact.id })}>卖银行</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ArtifactDetailCard({ artifact, compact }: { artifact: PublicArtifactView; compact: boolean }) {
  const properties = artifact.properties ?? [];
  return (
    <article className={`artifact-detail-card ${compact ? "compact" : ""}`}>
      <div className="artifact-detail-head">
        <span>{artifact.categoryLabel ?? (artifact.category ? CATEGORY_LABELS[artifact.category] : "类别未知")}</span>
        <strong>{artifact.name}</strong>
      </div>
      <div className="artifact-detail-facts">
        <span>成交价/到手价 {artifact.purchasePrice ?? "?"} 银元</span>
        <span>实际价格 {artifact.trueValue ?? "?"} 银元</span>
        <span>{artifact.tagLabel ?? "属性标签未知"}</span>
      </div>
      {artifact.story && <p>{artifact.story}</p>}
      <div className="property-list">
        {properties.length === 0 && <small>暂无可见属性。</small>}
        {properties.map((property) => (
          <div className="property-chip" key={property.id}>
            <strong>{property.name}</strong>
            <small>{property.effectText}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function PublicPool({ view, currentArtifact }: { view: PlayerView; currentArtifact?: PublicArtifactView }) {
  const auctionMode = view.auction ? auctionModeLabel(view.auction.mode, view.auction.bundleInnerMode) : "未生成";
  return (
    <section className="panel public-pool">
      <div className="public-head">
        <h3><ScrollText size={16} /> 公共池</h3>
        <span>{phaseLabels[view.phase]} · {auctionMode}</span>
      </div>
      <div className="public-summary">
        <div>
          <span>当前拍品</span>
          <strong>{currentArtifact?.name ?? "等待预展"}</strong>
        </div>
        <div>
          <span>公开价格</span>
          <strong>{currentArtifact?.purchasePrice ? `${currentArtifact.purchasePrice} 银元` : "未成交"}</strong>
        </div>
      </div>
      <div className="public-log-list">
        {view.log.length === 0 && <p className="empty-text">暂无公开行动。</p>}
        {view.log.map((item, index) => (
          <p key={`${item}-${index}`}>{item}</p>
        ))}
      </div>
    </section>
  );
}

function CardConfirmModal({ card, onClose, onConfirm }: { card: PlayableCard; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal compact-modal" role="dialog" aria-modal="true" aria-label={`确认使用 ${card.name}`}>
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">确认使用</p>
            <h3>{card.name}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <p>{card.description}</p>
        <footer className="target-actions">
          <button onClick={onClose}>
            <X size={18} /> 取消
          </button>
          <button className="primary" onClick={onConfirm}>
            <Check size={18} /> 确认使用
          </button>
        </footer>
      </section>
    </div>
  );
}

function SettingsModal({
  view,
  call,
  onClose
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  onClose: () => void;
}) {
  const [confirmCloseRoom, setConfirmCloseRoom] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">设置</p>
            <h3>房间与教程</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="settings-actions">
          <button
            className={view.paused ? "" : "primary"}
            onClick={() => call("room:setPaused", { paused: !view.paused })}
          >
            {view.paused ? <Play size={18} /> : <Pause size={18} />}
            {view.paused ? "恢复" : "暂停"}
          </button>
          <button className="danger-button" onClick={() => setConfirmCloseRoom(true)}>
            <X size={18} /> 退出房间
          </button>
          <span>所有玩家都可以暂停或恢复；房主额外拥有管理配置。</span>
        </div>
        <section className="shortcut-help">
          <div>
            <strong>Tab</strong>
            <span>按住查看玩家信息和自己的秘密委托。</span>
          </div>
          <div>
            <strong>B</strong>
            <span>按住查看背包、藏品成交价、实际价格和属性。</span>
          </div>
        </section>
        {confirmCloseRoom && (
          <section className="leave-room-panel">
            <strong>确认退出房间？</strong>
            <p>这会让所有玩家离开当前房间，旧房间不能继续，需要重新创建房间。</p>
            <div className="settings-actions">
              <button onClick={() => setConfirmCloseRoom(false)}>
                <X size={18} /> 取消
              </button>
              <button className="danger-button" onClick={() => call("room:close", {})}>
                <Check size={18} /> 确认退出
              </button>
            </div>
          </section>
        )}
        {view.canManageRoom && <RoomAdminPanel view={view} call={call} />}
        <section className="tutorial-panel">
          <h3><BookOpen size={18} /> 新手教程</h3>
          <p>每一天先获得收入，再预展拍品；推进预展后系统随机决定拍卖方式。</p>
          <p>买到藏品时记录的是成交价，不是声望；终局才按现金和藏品价值每 50 银元折算声望。</p>
          <p>锦囊和事件卡在右侧手牌区分开显示，使用前会先确认；有目标的卡需要先选玩家或藏品。</p>
          <p>按住 Tab 查看玩家信息和自己的秘密委托；按住 B 查看自己的背包和藏品详情，松开按键即关闭。</p>
          <p>公共池只展示阶段、拍卖、成交和公开信息；自己的用牌、黑市购买和目标会在“我的操作”里显示。</p>
        </section>
      </section>
    </div>
  );
}

function LogPanel({
  title,
  icon,
  log,
  emptyText = "暂无记录。"
}: {
  title: string;
  icon: ReactNode;
  log: string[];
  emptyText?: string;
}) {
  return (
    <section className="panel log-panel">
      <h3>{icon}{title}</h3>
      {log.length === 0 && <p className="empty-text">{emptyText}</p>}
      {log.map((item, index) => (
        <p key={`${item}-${index}`}>{item}</p>
      ))}
    </section>
  );
}

function FinalScores({ view }: { view: PlayerView }) {
  const ranked = [...view.players].sort((a, b) => (b.finalScore?.reputation ?? 0) - (a.finalScore?.reputation ?? 0));
  return (
    <section className="panel final-panel">
      <h3>终局排名</h3>
      {ranked.map((player, index) => (
        <div className="score-row" key={player.id}>
          <strong>{index + 1}. {player.nickname}</strong>
          <span>{player.finalScore?.reputation ?? 0} 声望</span>
        </div>
      ))}
    </section>
  );
}

function formatTradeAssets(assets: PlayerView["tradeOffers"][number]["give"], view: PlayerView): string {
  const parts: string[] = [];
  if (assets.cash) parts.push(`${assets.cash} 银元`);
  for (const id of assets.artifactIds ?? []) {
    parts.push(findArtifactName(view, id));
  }
  if (assets.cardIds?.length) parts.push(`${assets.cardIds.length} 张卡`);
  return parts.length ? parts.join("、") : "无";
}

function findArtifactName(view: PlayerView, artifactId: string): string {
  const pools = [view.self.artifacts, view.todayArtifacts, ...view.players.map((player) => player.artifacts ?? [])];
  return pools.flat().find((artifact) => artifact.id === artifactId)?.name ?? "藏品";
}

function targetModeForCard(card: PlayableCard): TargetMode {
  if (card.id === "D02") return "playerArtifact";
  if (card.id === "D07") return "playerAuctionArtifact";
  if (["D01", "D03", "D04", "D05", "D06", "B08", "I04", "I05"].includes(card.id)) return "player";
  if (["I08", "I09", "I12"].includes(card.id)) return "none";
  if (card.target?.kind === "player") return "player";
  if (card.target?.kind === "artifact") return card.type === "cash" ? "ownedArtifact" : "artifact";
  if (card.effects?.some((effect) => effect.type === "revealInfo" && effect.target.kind === "artifact")) return "artifact";
  return "none";
}

function targetModeForRoleSkill(skillId: string): TargetMode {
  if (skillId === "role01_skill02" || skillId === "role03_skill01") return "ownedArtifact";
  if (skillId === "role01_skill01" || skillId === "role07_skill01" || skillId === "role09_skill02") return "artifact";
  if (skillId === "role06_skill01") return "player";
  if (skillId === "role06_skill03") return "playerMission";
  return "none";
}

function canUseCardFromView(view: PlayerView, card: PlayableCard): boolean {
  if (isEventCard(view, card) && view.phase !== "eventWindow") return false;
  const mode = targetModeForCard(card);
  if (mode === "none") return true;
  if (mode === "player") return view.players.some((player) => player.id !== view.selfId);
  if (mode === "artifact") return view.todayArtifacts.length > 0 || view.self.artifacts.length > 0;
  if (mode === "ownedArtifact") return view.self.artifacts.length > 0;
  if (mode === "playerAuctionArtifact") return view.todayArtifacts.length > 0 && view.players.some((player) => player.id !== view.selfId);
  if (mode === "playerArtifact") return view.players.some((player) => player.id !== view.selfId && (player.artifacts?.length ?? player.artifactCount) > 0);
  return true;
}

function isEventCard(view: PlayerView, card: PlayableCard): card is EventCard {
  return view.self.events.some((eventCard) => eventCard.id === card.id);
}

function canUseRoleSkillFromView(view: PlayerView, skill: RoleSkill): boolean {
  const mode = targetModeForRoleSkill(skill.id);
  if (mode === "none") return true;
  if (mode === "player" || mode === "playerMission") return view.players.some((player) => player.id !== view.selfId);
  if (mode === "ownedArtifact") return view.self.artifacts.length > 0;
  return view.todayArtifacts.length > 0 || view.self.artifacts.length > 0;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

function appendedLogItems(previous: string[], current: string[]): string[] {
  if (current.length === 0) return [];
  const maxOverlap = Math.min(previous.length, current.length);
  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    const previousTail = previous.slice(previous.length - overlap);
    const currentHead = current.slice(0, overlap);
    if (previousTail.every((item, index) => item === currentHead[index])) {
      return current.slice(overlap);
    }
  }
  return current;
}

function artifactTargetsFor(view: PlayerView, mode: TargetMode, preferredArtifactId?: string, targetPlayerId?: string): PublicArtifactView[] {
  const pool =
    mode === "ownedArtifact"
      ? view.self.artifacts
      : mode === "playerAuctionArtifact"
        ? view.todayArtifacts
      : mode === "playerArtifact"
        ? visibleArtifactsForPlayer(view, targetPlayerId)
        : [...view.todayArtifacts, ...view.self.artifacts];
  return uniqueArtifacts(pool, preferredArtifactId);
}

function visibleArtifactsForPlayer(view: PlayerView, targetPlayerId?: string): PublicArtifactView[] {
  if (!targetPlayerId || targetPlayerId === view.selfId) return view.self.artifacts;
  const player = view.players.find((candidate) => candidate.id === targetPlayerId);
  return uniqueArtifacts(player?.artifacts ?? []);
}

function uniqueArtifacts(artifacts: PublicArtifactView[], preferredArtifactId?: string): PublicArtifactView[] {
  const seen = new Set<string>();
  const unique = artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
  if (!preferredArtifactId) return unique;
  const preferred = unique.find((artifact) => artifact.id === preferredArtifactId);
  return preferred ? [preferred, ...unique.filter((artifact) => artifact.id !== preferred.id)] : unique;
}

function missionTargetsFor(view: PlayerView, targetPlayerId?: string) {
  if (targetPlayerId === view.selfId) return view.self.missions;
  return view.players.find((player) => player.id === targetPlayerId)?.revealedMissions ?? [];
}

function tradeStatusLabel(status: PlayerView["tradeOffers"][number]["status"]): string {
  if (status === "pending") return "待回应";
  if (status === "accepted") return "已成交";
  if (status === "declined") return "已拒绝";
  return "已取消";
}

function auctionModeLabel(mode: AuctionMode, bundleInnerMode?: Exclude<AuctionMode, "bundle">): string {
  if (mode === "english") return "英式";
  if (mode === "dutch") return "荷兰式";
  if (mode === "sealed") return "暗标";
  return `打包/${bundleInnerMode === "dutch" ? "荷兰式" : bundleInnerMode === "sealed" ? "暗标" : "英式"}`;
}

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms?: number) => string;
  }
}
